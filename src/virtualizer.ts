// src/virtualizer.ts
import { Context, Session, Logger } from 'koishi'
import { BotManager } from './bot-manager'
import type { BotPersonaConfig } from './types'
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Session 虚拟化器
 * 通过 Proxy 包装 Session 对象和配置对象，实现多 bot 隔离
 */
export class SessionVirtualizer {
  private readonly logger: Logger
  private readonly originalDatabaseGet: typeof Context.prototype.database.get
  private readonly debugEnabled: boolean
  private readonly botPrompts: Map<string, string>
  private readonly botReasonerModels: Map<string, { model: string; baseURL?: string; apiKey?: string[] }>
  private readonly botNotReasonerModels: Map<string, { model: string; baseURL?: string; apiKey?: string[] }>
  private readonly botFavorabilityConfigs: Map<string, BotPersonaConfig['favorabilityConfig']>
  private readonly botMoodConfigs: Map<string, BotPersonaConfig['moodConfig']>
  // 导出 asyncContext 让中间件可以使用
  readonly asyncContext = new AsyncLocalStorage<string>()
  private originalAPIClient: any
  private originalSATConfig: any

  // APIClient 缓存：按 botId 缓存实例，配置变更时自动失效
  private apiClientCache: Map<string, { client: any; configHash: string }> = new Map()
  private apiClientConfigVersions: Map<string, string> = new Map()

  // 配置拦截统计：用于聚合日志输出
  private configInterceptStats: Map<string, Set<string>> = new Map()
  private lastAccessBotId = ''
  private interceptFlushTimer: NodeJS.Timeout | null = null

  constructor(
    private ctx: Context,
    private botManager: BotManager
  ) {
    this.logger = ctx.logger('satori-ai-charon')
    this.originalDatabaseGet = ctx.database.get.bind(ctx.database)
    this.debugEnabled = botManager['options']?.debug || false
    this.botPrompts = new Map()
    this.botReasonerModels = new Map()
    this.botNotReasonerModels = new Map()
    this.botFavorabilityConfigs = new Map()
    this.botMoodConfigs = new Map()
  }

  /**
   * 计算配置哈希值，用于检测配置变更
   */
  private getConfigHash(botId: string): string {
    const reasonerConfig = this.botReasonerModels.get(botId)
    const notReasonerConfig = this.botNotReasonerModels.get(botId)

    // 对配置进行标准化后生成哈希（忽略 undefined 值和顺序）
    const normalized = {
      reasoner: reasonerConfig ? {
        model: reasonerConfig.model,
        baseURL: reasonerConfig.baseURL || null,
        apiKey: reasonerConfig.apiKey || null,
      } : null,
      notReasoner: notReasonerConfig ? {
        model: notReasonerConfig.model,
        baseURL: notReasonerConfig.baseURL || null,
        apiKey: notReasonerConfig.apiKey || null,
      } : null,
    }

    return JSON.stringify(normalized)
  }

  /**
   * 使 APIClient 缓存失效
   * 在配置变更时调用
   */
  private invalidateAPIClientCache(botId: string): void {
    this.apiClientCache.delete(botId)
    this.apiClientConfigVersions.delete(botId)
    this.debug(`Bot ${botId} 的 APIClient 缓存已失效`)
  }

  /**
   * 设置 bot 的提示词（人设）
   */
  setBotPrompt(botId: string, prompt: string): void {
    this.botPrompts.set(botId, prompt)
    this.debug(`设置 Bot ${botId} 的提示词`)
  }

  /**
   * 设置 bot 的深度思考模型配置
   * 配置变更时自动失效 APIClient 缓存
   */
  setBotReasonerModel(botId: string, config: { model: string; baseURL?: string; apiKey?: string[] }): void {
    this.botReasonerModels.set(botId, config)
    this.invalidateAPIClientCache(botId)
    this.debug(`设置 Bot ${botId} 的深度思考模型: ${config.model}`)
  }

  /**
   * 设置 bot 的非思考模型配置
   * 配置变更时自动失效 APIClient 缓存
   */
  setBotNotReasonerModel(botId: string, config: { model: string; baseURL?: string; apiKey?: string[] }): void {
    this.botNotReasonerModels.set(botId, config)
    this.invalidateAPIClientCache(botId)
    this.debug(`设置 Bot ${botId} 的非思考模型: ${config.model}`)
  }

  /**
   * 设置 bot 的好感度配置
   */
  setBotFavorabilityConfig(botId: string, config: BotPersonaConfig['favorabilityConfig']): void {
    this.botFavorabilityConfigs.set(botId, config)
    this.debug(`设置 Bot ${botId} 的好感度配置`)
  }

  /**
   * 设置 bot 的心情配置
   */
  setBotMoodConfig(botId: string, config: BotPersonaConfig['moodConfig']): void {
    this.botMoodConfigs.set(botId, config)
    this.debug(`设置 Bot ${botId} 的心情配置`)
  }

  /**
   * 跟踪配置访问（用于检测 botId 变化）
   */
  private trackConfigAccess(botId: string): void {
    if (this.lastAccessBotId && this.lastAccessBotId !== botId) {
      // botId 变化，立即输出之前的统计
      this.flushConfigInterceptStats(this.lastAccessBotId)
    }
    this.lastAccessBotId = botId
  }

  /**
   * 跟踪配置拦截（延迟聚合输出）
   */
  private trackConfigIntercept(botId: string, prop: string): void {
    if (!this.configInterceptStats.has(botId)) {
      this.configInterceptStats.set(botId, new Set())
    }
    this.configInterceptStats.get(botId)!.add(prop)

    // 延迟输出，聚合同一 bot 的多次配置访问
    if (this.interceptFlushTimer) {
      clearTimeout(this.interceptFlushTimer)
    }
    this.interceptFlushTimer = setTimeout(() => {
      this.flushConfigInterceptStats(botId)
    }, 50)
  }

  /**
   * 输出配置拦截统计（聚合日志）
   */
  private flushConfigInterceptStats(botId: string): void {
    const props = this.configInterceptStats.get(botId)
    if (!props || props.size === 0) return

    const count = props.size
    this.logger.info(`[CONFIG] Bot ${botId} 好感度/心情配置已应用 (${count}项)`)

    // 清空统计
    this.configInterceptStats.delete(botId)
  }

  /**
   * 创建虚拟化的 Session
   * 通过 Proxy 拦截 userId 和 channelId 属性访问
   */
  createVirtualSession(session: Session, botId: string): Session {
    const prefix = `sat_${botId}_`
    const shouldVirtualizeChannelId = this.botManager.shouldVirtualizeChannelId()
    const botPrompts = this.botPrompts  // 闭包引用

    this.debug(`创建虚拟化 Session: botId=${botId}, virtualizeChannelId=${shouldVirtualizeChannelId}`)

    // 使用 Proxy 包装 session
    return new Proxy(session, {
      get(target, prop: string) {
        // userId 总是虚拟化（隔离用户数据、好感度、记忆文件）
        if (prop === 'userId') {
          return prefix + target.userId
        }

        // channelId 根据配置决定是否虚拟化（隔离群常识、并发计数）
        if (prop === 'channelId') {
          if (shouldVirtualizeChannelId) {
            return prefix + target.channelId
          }
          return target.channelId
        }

        // selfId 必须保持原始值（multi-bot-controller 需要用它判断 assignee）
        if (prop === 'selfId') {
          return target.selfId
        }

        // 添加内部属性，用于获取 botId
        if (prop === '__charonBotId') {
          return botId
        }

        // 添加提示词覆盖属性
        if (prop === '__charonPrompt') {
          return botPrompts.get(botId)
        }

        // 其他属性直接返回原值
        return target[prop]
      },

      set(target, prop: string, value: any) {
        // 拦截属性设置，确保虚拟化后的值也能正确处理
        if (prop === 'userId') {
          // 还原真实 userId 再设置
          const realUserId = value.replace(new RegExp(`^${prefix}`), '')
          target.userId = realUserId
          return true
        }

        if (prop === 'channelId' && shouldVirtualizeChannelId) {
          const realChannelId = value.replace(new RegExp(`^${prefix}`), '')
          target.channelId = realChannelId
          return true
        }

        target[prop] = value
        return true
      }
    }) as any
  }

  /**
   * 从虚拟化的 userId 还原真实 userId
   */
  resolveRealUserId(virtualUserId: string): string {
    const match = virtualUserId.match(/^sat_[^_]+_(.+)$/)
    return match ? match[1] : virtualUserId
  }

  /**
   * 从虚拟化的 channelId 还原真实 channelId
   */
  resolveRealChannelId(virtualChannelId: string): string {
    const match = virtualChannelId.match(/^sat_[^_]+_(.+)$/)
    return match ? match[1] : virtualChannelId
  }

  /**
   * 从虚拟化的 userId 提取 botId
   */
  extractBotId(virtualUserId: string): string {
    const match = virtualUserId.match(/^sat_([^_]+)_.+$/)
    return match ? match[1] : ''
  }

  /**
   * 包装数据库 get 方法，拦截对 p_system 表的查询
   * 将虚拟化的 userId 映射回真实的 userId，并添加 botId 过滤
   */
  wrapDatabaseGet(): void {
    const self = this

    this.ctx.database.get = function(table, query, ...args) {
      // 只拦截 p_system 表的查询
      if (table === 'p_system' && query?.userid) {
        const virtualUserId = query.userid

        // 检查是否是虚拟化的 userId
        const botId = self.extractBotId(virtualUserId)
        if (botId) {
          const realUserId = self.resolveRealUserId(virtualUserId)

          self.logger.info(`数据库查询转换: ${virtualUserId} -> { realUserId: ${realUserId}, botId: ${botId} }`)

          // 返回修改后的查询
          return self.originalDatabaseGet(table, {
            ...query,
            userid: undefined, // 移除原始查询条件
            realUserId: realUserId,
            botId: botId,
          }, ...args)
        }
      }

      // 其他查询正常处理
      return self.originalDatabaseGet(table, query, ...args)
    }

    this.logger.info('数据库 get 方法已包装，支持多 bot 数据隔离')
  }

  /**
   * 恢复原始的数据库 get 方法
   */
  unwrapDatabaseGet(): void {
    this.ctx.database.get = this.originalDatabaseGet
    this.logger.info('数据库 get 方法已恢复')
  }

  /**
   * 获取当前 async 上下文中的 botId
   */
  private getCurrentBotId(): string {
    const botId = this.asyncContext.getStore() || ''
    // 只在首次获取时记录，避免日志过多
    if (botId && !this['loggedBotId']) {
      this.logger.info(`[GET BOT ID] 从 asyncContext 获取到 botId: ${botId}`)
      this['loggedBotId'] = true
    }
    return botId
  }

  /**
   * 包装 satori-ai 的 SAT 实例
   * 使用 monkey-patch 直接修改原始实例，确保所有现有引用都能使用我们的包装逻辑
   */
  wrapSATInstance(satInstance: any): any {
    const self = this

    // 保存原始的 config 对象
    this.originalSATConfig = satInstance.config

    // 保存原始的 APIClient
    this.originalAPIClient = satInstance.apiClient
    this.logger.info('[API CLIENT] 原始 APIClient 已保存')

    // 创建配置属性映射表，用于统一处理好感度、心情等配置属性
    // key: 属性名, value: { configMap: 配置Map, desc: 日志描述 }
    const configPropertyMap = new Map<string, { configMap: Map<string, any>; desc: string }>([
      // 好感度属性
      ['prompt_0', { configMap: this.botFavorabilityConfigs, desc: '好感度设定' }],
      ['favorability_div_1', { configMap: this.botFavorabilityConfigs, desc: '好感度分界线' }],
      ['prompt_1', { configMap: this.botFavorabilityConfigs, desc: '好感度设定' }],
      ['favorability_div_2', { configMap: this.botFavorabilityConfigs, desc: '好感度分界线' }],
      ['prompt_2', { configMap: this.botFavorabilityConfigs, desc: '好感度设定' }],
      ['favorability_div_3', { configMap: this.botFavorabilityConfigs, desc: '好感度分界线' }],
      ['prompt_3', { configMap: this.botFavorabilityConfigs, desc: '好感度设定' }],
      ['favorability_div_4', { configMap: this.botFavorabilityConfigs, desc: '好感度分界线' }],
      ['prompt_4', { configMap: this.botFavorabilityConfigs, desc: '好感度设定' }],
      // 心情属性
      ['mood_prompt_0', { configMap: this.botMoodConfigs, desc: '心情设定' }],
      ['mood_div_1', { configMap: this.botMoodConfigs, desc: '心情分界线' }],
      ['mood_prompt_1', { configMap: this.botMoodConfigs, desc: '心情设定' }],
      ['mood_div_2', { configMap: this.botMoodConfigs, desc: '心情分界线' }],
      ['mood_prompt_2', { configMap: this.botMoodConfigs, desc: '心情设定' }],
    ])

    // 包装 config 对象，拦截各种配置属性访问
    const wrappedConfig = new Proxy(this.originalSATConfig, {
      get(target, prop: string) {
        const currentBotId = self.getCurrentBotId()

        const originalValue = target[prop]
        let returnValue = originalValue

        // 如果没有当前 botId，返回原始配置
        if (!currentBotId) {
          return returnValue
        }

        // 聚合配置访问统计
        self.trackConfigAccess(currentBotId)

        const reasonerConfig = self.botReasonerModels.get(currentBotId)
        const notReasonerConfig = self.botNotReasonerModels.get(currentBotId)

        // 拦截深度思考模型名称
        if (prop === 'appointModel') {
          if (reasonerConfig?.model) {
            returnValue = reasonerConfig.model
            self.logger.info(`[CONFIG] 模型: ${returnValue}`)
          }
        }

        // 拦截深度思考模型的 API 地址
        else if (prop === 'baseURL') {
          if (reasonerConfig?.baseURL) {
            returnValue = reasonerConfig.baseURL
            self.logger.info(`[CONFIG] API地址: ${returnValue}`)
          }
        }

        // 拦截深度思考模型的 API Key
        else if (prop === 'key') {
          if (reasonerConfig?.apiKey) {
            returnValue = reasonerConfig.apiKey
            self.logger.info(`[CONFIG] API密钥: ${returnValue.length}个`)
          }
        }

        // 拦截非思考模型名称
        else if (prop === 'not_reasoner_LLM' && notReasonerConfig?.model) {
          returnValue = notReasonerConfig.model
          self.logger.info(`[CONFIG] 非思考模型: ${returnValue}`)
        }

        // 拦截非思考模型的 API 地址
        else if (prop === 'not_reasoner_LLM_URL' && notReasonerConfig?.baseURL) {
          returnValue = notReasonerConfig.baseURL
          self.logger.info(`[CONFIG] 非思考API地址: ${returnValue}`)
        }

        // 拦截非思考模型的 API Key
        else if (prop === 'not_reasoner_LLM_key' && notReasonerConfig?.apiKey) {
          returnValue = notReasonerConfig.apiKey
          self.logger.info(`[CONFIG] 非思考API密钥: ${returnValue.length}个`)
        }

        // 拦截 prompt 属性 - 返回配置的 prompt
        else if (prop === 'prompt') {
          const botPrompt = self.botPrompts.get(currentBotId)
          if (botPrompt) {
            returnValue = botPrompt
            self.logger.info(`[CONFIG] 人设提示词: ${botPrompt.slice(0, 30)}...(${botPrompt.length}字符)`)
          }
        }

        // 统一拦截好感度、心情等配置属性（聚合输出）
        else {
          const mapping = configPropertyMap.get(prop)
          if (mapping) {
            const botConfig = mapping.configMap.get(currentBotId)
            if (botConfig && botConfig[prop] !== undefined) {
              returnValue = botConfig[prop]
              // 记录到统计中，延迟输出
              self.trackConfigIntercept(currentBotId, prop)
            }
          }
        }

        return returnValue
      }
    })

    // 使用 Object.defineProperty 替换 config 属性，确保所有访问都经过我们的 Proxy
    Object.defineProperty(satInstance, 'config', {
      get() {
        return wrappedConfig
      },
      set(value) {
        // 如果 satori-ai 尝试设置新的 config，我们也要包装它
        self.originalSATConfig = value
        self.logger.info('[CONFIG] config 被重新设置，已更新原始配置引用')
      },
      enumerable: true,
      configurable: true,
    })
    this.logger.info('[CONFIG WRAP] satInstance.config 已通过 defineProperty 替换')

    // 验证包装是否成功
    const testConfig = satInstance.config.prompt
    this.logger.info(`[CONFIG WRAP] 测试访问 satInstance.config.prompt: ${typeof testConfig}="${testConfig?.toString().slice(0, 50) || 'undefined'}"`)

    // 使用 Object.defineProperty 包装 apiClient 属性
    Object.defineProperty(satInstance, 'apiClient', {
      get() {
        const botId = self.getCurrentBotId()

        // 如果没有 botId 上下文，返回原始 apiClient（兼容其他调用）
        if (!botId) {
          return self.originalAPIClient
        }

        // 计算当前配置的哈希值
        const currentConfigHash = self.getConfigHash(botId)

        // 检查缓存是否存在且配置未变更
        const cached = self.apiClientCache.get(botId)
        if (cached && cached.configHash === currentConfigHash) {
          return cached.client
        }

        // 返回一个包装的 apiClient，其 chat 方法会使用 bot 特定的配置
        const wrappedAPIClient = new Proxy(self.originalAPIClient, {
          get(target, method: string) {
            // 直接返回非方法属性
            if (typeof target[method] !== 'function') {
              return target[method]
            }

            // 对于所有方法，包装调用以使用正确的配置
            if (method === 'chat') {
              return function(...args: any[]) {
                const reasonerConfig = self.botReasonerModels.get(botId)
                const notReasonerConfig = self.botNotReasonerModels.get(botId)

                // 如果没有特殊配置，使用原始 apiClient
                if (!reasonerConfig && !notReasonerConfig) {
                  return target.chat.apply(target, args)
                }

                // 动态构建 APIConfig
                const originalConfig = self.originalSATConfig
                const dynamicConfig: any = {
                  baseURL: reasonerConfig?.baseURL || originalConfig.baseURL,
                  keys: reasonerConfig?.apiKey || originalConfig.key,
                  appointModel: reasonerConfig?.model || originalConfig.appointModel,
                  not_reasoner_LLM_URL: notReasonerConfig?.baseURL || originalConfig.not_reasoner_LLM_URL,
                  not_reasoner_LLM: notReasonerConfig?.model || originalConfig.not_reasoner_LLM,
                  not_reasoner_LLM_key: notReasonerConfig?.apiKey || originalConfig.not_reasoner_LLM_key,
                  use_not_reasoner_LLM_length: originalConfig.use_not_reasoner_LLM_length,
                  auxiliary_LLM_URL: originalConfig.auxiliary_LLM_URL,
                  auxiliary_LLM: originalConfig.auxiliary_LLM,
                  auxiliary_LLM_key: originalConfig.auxiliary_LLM_key,
                  maxRetryTimes: originalConfig.maxRetryTimes,
                  retry_delay_time: originalConfig.retry_delay_time,
                  temperature: originalConfig.temperature,
                  frequency_penalty: originalConfig.frequency_penalty,
                  presence_penalty: originalConfig.presence_penalty,
                  reasoning_content: originalConfig.log_reasoning_content,
                  max_output_tokens: originalConfig.max_output_tokens,
                }

                // 创建一个新的 APIClient 实例
                const APIClientClass = Object.getPrototypeOf(target).constructor
                const dynamicAPIClient = new APIClientClass(self.ctx, dynamicConfig)

                // 缓存新创建的 APIClient
                self.apiClientCache.set(botId, {
                  client: dynamicAPIClient,
                  configHash: currentConfigHash,
                })

                // 使用 asyncContext.run 确保 chat 调用时 botId 上下文存在
                // 这样 dynamicAPIClient 内部访问 config 时能正确获取 bot 特定配置
                return self.asyncContext.run(botId, () => {
                  return dynamicAPIClient.chat.apply(dynamicAPIClient, args)
                })
              }
            }

            // 其他方法直接返回原始方法
            return target[method]
          }
        })

        // 将包装后的 client 也存入缓存（用于非 chat 方法的调用）
        self.apiClientCache.set(botId, {
          client: wrappedAPIClient,
          configHash: currentConfigHash,
        })

        return wrappedAPIClient
      },
      enumerable: true,
      configurable: true,
    })
    this.logger.info('[API CLIENT WRAP] satInstance.apiClient 已通过 defineProperty 替换')

    // Monkey-patch 关键方法，确保它们能够从 session 中提取 botId
    const methodsToWrap = [
      'generateResponse',
      'getChatResponse',
      'handleSatCommand',
      'buildMessages',
      'buildSystemPrompt',
    ]

    for (const methodName of methodsToWrap) {
      if (typeof satInstance[methodName] === 'function') {
        const originalMethod = satInstance[methodName]
        satInstance[methodName] = function(...args: any[]) {
          // 尝试从参数中查找 session
          let sessionBotId = ''

          for (const arg of args) {
            if (arg && typeof arg === 'object' && 'userId' in arg && 'selfId' in arg) {
              sessionBotId = self.botManager.getBotId(arg.platform || '', arg.selfId || '')
              if (sessionBotId) {
                self.logger.info(`[METHOD PATCH] ${methodName}(), 从 session 提取 botId: ${sessionBotId}`)
                break
              }
            }
          }

          // 如果从 session 中找到了 botId，使用 AsyncLocalStorage 设置上下文
          if (sessionBotId) {
            return self.asyncContext.run(sessionBotId, () => {
              self.logger.info(`[METHOD PATCH] ${methodName}() asyncContext.run 设置 botId: ${sessionBotId}`)
              return originalMethod.apply(this, args)
            })
          }

          // 没有找到 botId，直接调用
          return originalMethod.apply(this, args)
        }
        self.logger.info(`[METHOD PATCH] ${methodName}() 已被 monkey-patch`)
      }
    }

    this.logger.info('[SAT INSTANCE] Monkey-patch 完成')

    // 返回原始实例（已经被 monkey-patch 修改）
    return satInstance
  }

  /**
   * 输出调试日志
   */
  private debug(...args: unknown[]): void {
    if (this.debugEnabled) {
      this.logger.debug(args)
    }
  }
}
