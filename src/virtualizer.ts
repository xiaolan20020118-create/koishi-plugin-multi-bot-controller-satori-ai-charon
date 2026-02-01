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

  // 配置访问日志聚合
  private configAccessLog: Map<string, number> = new Map()
  private lastConfigAccessKey = ''
  private lastConfigAccessCount = 0

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
   * 设置 bot 的提示词（人设）
   */
  setBotPrompt(botId: string, prompt: string): void {
    this.botPrompts.set(botId, prompt)
    this.debug(`设置 Bot ${botId} 的提示词`)
  }

  /**
   * 设置 bot 的深度思考模型配置
   */
  setBotReasonerModel(botId: string, config: { model: string; baseURL?: string; apiKey?: string[] }): void {
    this.botReasonerModels.set(botId, config)
    this.debug(`设置 Bot ${botId} 的深度思考模型: ${config.model}`)
  }

  /**
   * 设置 bot 的非思考模型配置
   */
  setBotNotReasonerModel(botId: string, config: { model: string; baseURL?: string; apiKey?: string[] }): void {
    this.botNotReasonerModels.set(botId, config)
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
   * 从 Session 提取 botId（支持虚拟化后的 session）
   */
  extractBotIdFromSession(session: Session): string {
    // 首先检查内部属性
    if ((session as any).__charonBotId) {
      return (session as any).__charonBotId
    }
    // 从 userId 提取
    if (session.userId) {
      return this.extractBotId(session.userId)
    }
    return ''
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

        const reasonerConfig = self.botReasonerModels.get(currentBotId)
        const notReasonerConfig = self.botNotReasonerModels.get(currentBotId)

        // 聚合日志：记录配置访问
        const accessKey = `${currentBotId}:${String(prop)}`
        const currentCount = self.configAccessLog.get(accessKey) || 0
        self.configAccessLog.set(accessKey, currentCount + 1)

        // 当访问的属性发生变化时，输出之前属性的聚合统计
        if (self.lastConfigAccessKey && self.lastConfigAccessKey !== accessKey) {
          const prevCount = self.configAccessLog.get(self.lastConfigAccessKey) || 0
          if (prevCount > 1) {
            const [botId, prop] = self.lastConfigAccessKey.split(':')
            self.logger.info(`[CONFIG ACCESS] ${botId}.${prop} accessed ${prevCount} times`)
          }
          self.configAccessLog.set(self.lastConfigAccessKey, 0)
        }
        self.lastConfigAccessKey = accessKey

        // 拦截深度思考模型名称
        if (prop === 'appointModel') {
          if (reasonerConfig?.model) {
            returnValue = reasonerConfig.model
            self.logger.info(`[CONFIG INTERCEPT] prop=appointModel -> ${returnValue}`)
          }
        }

        // 拦截深度思考模型的 API 地址
        else if (prop === 'baseURL') {
          if (reasonerConfig?.baseURL) {
            returnValue = reasonerConfig.baseURL
            self.logger.info(`[CONFIG INTERCEPT] prop=baseURL -> ${returnValue}`)
          }
        }

        // 拦截深度思考模型的 API Key
        else if (prop === 'key') {
          if (reasonerConfig?.apiKey) {
            returnValue = reasonerConfig.apiKey
            self.logger.info(`[CONFIG INTERCEPT] prop=key -> [${returnValue.length} keys]`)
          }
        }

        // 拦截非思考模型名称
        else if (prop === 'not_reasoner_LLM' && notReasonerConfig?.model) {
          returnValue = notReasonerConfig.model
          self.logger.info(`[CONFIG INTERCEPT] prop=not_reasoner_LLM -> ${returnValue}`)
        }

        // 拦截非思考模型的 API 地址
        else if (prop === 'not_reasoner_LLM_URL' && notReasonerConfig?.baseURL) {
          returnValue = notReasonerConfig.baseURL
          self.logger.info(`[CONFIG INTERCEPT] prop=not_reasoner_LLM_URL -> ${returnValue}`)
        }

        // 拦截非思考模型的 API Key
        else if (prop === 'not_reasoner_LLM_key' && notReasonerConfig?.apiKey) {
          returnValue = notReasonerConfig.apiKey
          self.logger.info(`[CONFIG INTERCEPT] prop=not_reasoner_LLM_key -> [${returnValue.length} keys]`)
        }

        // 拦截 prompt 属性 - 返回配置的 prompt
        else if (prop === 'prompt') {
          const botPrompt = self.botPrompts.get(currentBotId)
          if (botPrompt) {
            returnValue = botPrompt
            self.logger.info(`[CONFIG INTERCEPT] prop=prompt -> 返回配置的 prompt (${botPrompt.length} chars)`)
          }
        }

        // 拦截好感度配置属性
        const favorabilityConfig = self.botFavorabilityConfigs.get(currentBotId)
        if (favorabilityConfig) {
          if (prop === 'prompt_0' && favorabilityConfig.prompt_0 !== undefined) {
            returnValue = favorabilityConfig.prompt_0
            self.logger.info(`[CONFIG INTERCEPT] prop=prompt_0 -> 返回配置的好感度设定`)
          } else if (prop === 'favorability_div_1' && favorabilityConfig.favorability_div_1 !== undefined) {
            returnValue = favorabilityConfig.favorability_div_1
            self.logger.info(`[CONFIG INTERCEPT] prop=favorability_div_1 -> ${returnValue}`)
          } else if (prop === 'prompt_1' && favorabilityConfig.prompt_1 !== undefined) {
            returnValue = favorabilityConfig.prompt_1
            self.logger.info(`[CONFIG INTERCEPT] prop=prompt_1 -> 返回配置的好感度设定`)
          } else if (prop === 'favorability_div_2' && favorabilityConfig.favorability_div_2 !== undefined) {
            returnValue = favorabilityConfig.favorability_div_2
            self.logger.info(`[CONFIG INTERCEPT] prop=favorability_div_2 -> ${returnValue}`)
          } else if (prop === 'prompt_2' && favorabilityConfig.prompt_2 !== undefined) {
            returnValue = favorabilityConfig.prompt_2
            self.logger.info(`[CONFIG INTERCEPT] prop=prompt_2 -> 返回配置的好感度设定`)
          } else if (prop === 'favorability_div_3' && favorabilityConfig.favorability_div_3 !== undefined) {
            returnValue = favorabilityConfig.favorability_div_3
            self.logger.info(`[CONFIG INTERCEPT] prop=favorability_div_3 -> ${returnValue}`)
          } else if (prop === 'prompt_3' && favorabilityConfig.prompt_3 !== undefined) {
            returnValue = favorabilityConfig.prompt_3
            self.logger.info(`[CONFIG INTERCEPT] prop=prompt_3 -> 返回配置的好感度设定`)
          } else if (prop === 'favorability_div_4' && favorabilityConfig.favorability_div_4 !== undefined) {
            returnValue = favorabilityConfig.favorability_div_4
            self.logger.info(`[CONFIG INTERCEPT] prop=favorability_div_4 -> ${returnValue}`)
          } else if (prop === 'prompt_4' && favorabilityConfig.prompt_4 !== undefined) {
            returnValue = favorabilityConfig.prompt_4
            self.logger.info(`[CONFIG INTERCEPT] prop=prompt_4 -> 返回配置的好感度设定`)
          }
        }

        // 拦截心情配置属性
        const moodConfig = self.botMoodConfigs.get(currentBotId)
        if (moodConfig) {
          if (prop === 'mood_prompt_0' && moodConfig.mood_prompt_0 !== undefined) {
            returnValue = moodConfig.mood_prompt_0
            self.logger.info(`[CONFIG INTERCEPT] prop=mood_prompt_0 -> 返回配置的心情设定`)
          } else if (prop === 'mood_div_1' && moodConfig.mood_div_1 !== undefined) {
            returnValue = moodConfig.mood_div_1
            self.logger.info(`[CONFIG INTERCEPT] prop=mood_div_1 -> ${returnValue}`)
          } else if (prop === 'mood_prompt_1' && moodConfig.mood_prompt_1 !== undefined) {
            returnValue = moodConfig.mood_prompt_1
            self.logger.info(`[CONFIG INTERCEPT] prop=mood_prompt_1 -> 返回配置的心情设定`)
          } else if (prop === 'mood_div_2' && moodConfig.mood_div_2 !== undefined) {
            returnValue = moodConfig.mood_div_2
            self.logger.info(`[CONFIG INTERCEPT] prop=mood_div_2 -> ${returnValue}`)
          } else if (prop === 'mood_prompt_2' && moodConfig.mood_prompt_2 !== undefined) {
            returnValue = moodConfig.mood_prompt_2
            self.logger.info(`[CONFIG INTERCEPT] prop=mood_prompt_2 -> 返回配置的心情设定`)
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
        self.logger.info(`[API CLIENT GET] currentBotId=${botId || '<EMPTY>'}`)

        // 如果没有 botId 上下文，返回原始 apiClient（兼容其他调用）
        if (!botId) {
          return self.originalAPIClient
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

                self.logger.info(`[API CLIENT CHAT] botId=${botId}, hasReasonerConfig=${!!reasonerConfig}, hasNotReasonerConfig=${!!notReasonerConfig}`)

                // 如果没有特殊配置，使用原始 apiClient
                if (!reasonerConfig && !notReasonerConfig) {
                  self.logger.info(`[API CLIENT CHAT] 使用原始 apiClient`)
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

                self.logger.info(`[API CLIENT CHAT] 动态配置 baseURL=${dynamicConfig.baseURL}, model=${dynamicConfig.appointModel}`)

                // 创建一个新的 APIClient 实例
                const APIClientClass = Object.getPrototypeOf(target).constructor
                const dynamicAPIClient = new APIClientClass(self.ctx, dynamicConfig)

                // 使用新创建的 APIClient 调用 chat
                return dynamicAPIClient.chat.apply(dynamicAPIClient, args)
              }
            }

            // 其他方法直接返回原始方法
            return target[method]
          }
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
