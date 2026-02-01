// src/index.ts
import { Context } from 'koishi'
import { createConfig, updateBotIdOptions } from './config'
import type { Config } from './types'
import { BotManager } from './bot-manager'
import { SessionVirtualizer } from './virtualizer'

export const name = 'multi-bot-controller-satori-ai-charon'

// 声明服务依赖
export const inject = {
  required: ['database', 'satori', 'multi-bot-controller'],
}

// 导出配置 Schema
export { ConfigSchema as Config } from './config'
export * from './types'

// 导出动态 Schema 创建函数
export { createConfig }

export const usage = `

## 工作原理

本插件为每个 Bot 配置独立的用户数据空间、人格设定和 API 配置，实现多 Bot 数据隔离。

### 注意事项

暂时未支持对Sat指令的多bot隔离，请使用昵称触发对话。

### 隔离范围

| 数据类型 | 隔离方式 |
|---------|---------|
| 用户好感度、用户记忆、用户等级、使用次数 | userId 虚拟化 |
| 人设提示词 | 动态注入 |
| 模型配置 | 配置拦截 |
| 群常识、并发计数（可选） | channelId 虚拟化（可选） |


`

export function apply(ctx: Context, config: Config): void {
  // 创建 logger
  const logger = ctx.logger('satori-ai-charon')

  logger.info('Satori-AI 多 Bot 数据隔离插件正在启动...')

  // 用于存储需要手动清理的 dispose 函数
  const manualDisposes: Array<() => void> = []

  // ========================================
  // 扩展数据库表结构
  // ========================================
  let dbExtended = false

  function setupDatabaseExtension() {
    if (dbExtended) return

    try {
      ctx.model.extend('p_system', {
        botId: 'string',
        realUserId: 'string',
      })

      dbExtended = true
      logger.info('数据库表 p_system 已扩展，添加 botId 和 realUserId 字段')
    } catch (error) {
      logger.warn('扩展数据库表时出错（可能已扩展）:', error)
    }
  }

  // ========================================
  // 初始化 BotManager
  // ========================================
  const botManager = new BotManager(
    ctx,
    config.bots,
    {
      virtualizeChannelId: config.virtualizeChannelId,
      debug: config.debug,
      verboseLogging: config.verboseLogging,
    }
  )

  // ========================================
  // 动态 Schema 更新服务
  // 从 multi-bot-controller 获取已配置的 bot 列表
  // ========================================
  function setupBotSchemaService() {
    const knownBots: Set<string> = new Set()
    let debounceTimer: NodeJS.Timeout | null = null

    const scheduleScan = () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => scanFromMBC(), 200)
    }

    const scanFromMBC = () => {
      try {
        const mbcService = ctx['multi-bot-controller']
        if (!mbcService) {
          logger.warn('multi-bot-controller 服务不可用')
          return
        }

        const bots = mbcService.getBots()
        const enabledBots = bots.filter((b: any) => b.enabled)
        const botIds = enabledBots.map((b: any) => `${b.platform}:${b.selfId}`).sort()

        const currentSet = new Set(botIds)
        if (setsEqual(knownBots, currentSet)) {
          return
        }

        knownBots.clear()
        botIds.forEach((id: string) => knownBots.add(id))
        updateBotIdOptions(ctx, botIds)
        logger.info(`Bot 列表已更新，共 ${botIds.length} 个可用`)
      } catch (error) {
        logger.warn('从 multi-bot-controller 获取 Bot 列表失败:', error)
      }
    }

    const setsEqual = (a: Set<string>, b: Set<string>): boolean => {
      if (a.size !== b.size) return false
      for (const item of a) {
        if (!b.has(item)) return false
      }
      return true
    }

    // 立即扫描一次
    const scanTimer = setTimeout(() => scanFromMBC(), 500)
    manualDisposes.push(() => clearTimeout(scanTimer))

    // 监听事件
    ctx.on('multi-bot-controller/bots-updated', () => scheduleScan())
    ctx.on('bot-added', () => scheduleScan())
    ctx.on('bot-removed', () => scheduleScan())
    ctx.on('ready', () => scheduleScan())
  }

  setupBotSchemaService()

  // ========================================
  // Session 虚拟化器
  // ========================================
  const virtualizer = new SessionVirtualizer(ctx, botManager)

  // 包装数据库 get 方法
  virtualizer.wrapDatabaseGet()

  // 从配置中设置每个 bot 的提示词、模型和 API 配置
  function applyBotConfigs() {
    for (const botConfig of config.bots) {
      if (!botConfig.botId) continue

      if (botConfig.prompt) {
        virtualizer.setBotPrompt(botConfig.botId, botConfig.prompt)
        logger.info(`Bot ${botConfig.botId} 已配置提示词`)
      }

      // 深度思考模型配置
      if (botConfig.reasonerModel?.model) {
        const reasonerConfig = {
          model: botConfig.reasonerModel.model,
          baseURL: botConfig.reasonerModel.baseURL,
          apiKey: botConfig.reasonerModel.apiKey,
        }
        virtualizer.setBotReasonerModel(botConfig.botId, reasonerConfig)
        logger.info(`Bot ${botConfig.botId} 已配置深度思考模型: ${reasonerConfig.model}`)
        if (reasonerConfig.baseURL) {
          logger.info(`Bot ${botConfig.botId} 深度思考模型 API 地址: ${reasonerConfig.baseURL}`)
        }
      }

      // 非思考模型配置（enableNotReasoner = true 时显示配置）
      if (botConfig.enableNotReasoner === true && botConfig.notReasonerModel?.model) {
        const notReasonerConfig = {
          model: botConfig.notReasonerModel.model,
          baseURL: botConfig.notReasonerModel.baseURL,
          apiKey: botConfig.notReasonerModel.apiKey,
        }
        virtualizer.setBotNotReasonerModel(botConfig.botId, notReasonerConfig)
        logger.info(`Bot ${botConfig.botId} 已配置非思考模型: ${notReasonerConfig.model}`)
        if (notReasonerConfig.baseURL) {
          logger.info(`Bot ${botConfig.botId} 非思考模型 API 地址: ${notReasonerConfig.baseURL}`)
        }
      }

      // 好感度配置（enableFavorability = true 时显示配置）
      if (botConfig.enableFavorability === true && botConfig.favorabilityConfig) {
        virtualizer.setBotFavorabilityConfig(botConfig.botId, botConfig.favorabilityConfig)
        logger.info(`Bot ${botConfig.botId} 已配置好感度设定`)
      }

      // 心情配置（enableMood = true 时显示配置）
      if (botConfig.enableMood === true && botConfig.moodConfig) {
        virtualizer.setBotMoodConfig(botConfig.botId, botConfig.moodConfig)
        logger.info(`Bot ${botConfig.botId} 已配置心情设定`)
      }
    }
  }

  // 立即应用配置
  applyBotConfigs()

  // ========================================
  // 等待 satori-ai 就绪并包装其实例
  // ========================================
  function setupSATService() {
    // 尝试立即获取
    tryWrapSAT()

    // 监听 satori-ai 就绪事件
    ctx.on('satori-ai/ready', () => {
      logger.info('satori-ai 已就绪，正在设置 Session 虚拟化...')
      tryWrapSAT()
    })

    // 兜底：延迟轮询检测
    let checkCount = 0
    const maxChecks = 20
    const checkTimer = setInterval(() => {
      checkCount++
      if (tryWrapSAT() || checkCount >= maxChecks) {
        clearInterval(checkTimer)
      }
    }, 500)

    manualDisposes.push(() => clearInterval(checkTimer))
  }

  let satWrapped = false

  function tryWrapSAT(): boolean {
    if (satWrapped) return true

    try {
      // satori-ai 使用 'sat' 作为服务名
      const sat = ctx.get('sat')
      if (!sat) {
        return false
      }

      logger.info('satori-ai 服务已找到，正在设置...')

      // 先扩展数据库（此时 satori-ai 已经创建了表）
      setupDatabaseExtension()

      // 包装 SAT 实例（使用 monkey-patch 直接修改原始实例）
      virtualizer.wrapSATInstance(sat)

      satWrapped = true
      logger.info('SAT 实例包装完成')
      return true
    } catch (error) {
      logger.debug('获取 satori-ai 服务失败（可能尚未加载）:', error)
      return false
    }
  }

  setupSATService()

  // ========================================
  // 中间件：在 satori-ai 处理消息前虚拟化 session 并设置 async 上下文
  // ========================================
  ctx.middleware(async (session, next) => {
    // 获取当前 bot 的配置
    const botId = botManager.getBotId(session.platform || '', session.selfId || '')

    const botConfig = botManager.getBotConfig(botId)

    // 如果没有此 bot 的配置，直接放行
    if (!botConfig) {
      return next()
    }

    // 使用 AsyncLocalStorage 设置 botId 上下文
    // 这样所有后续的异步操作（包括 satori-ai 的命令处理）都能访问到 botId
    return virtualizer.asyncContext.run(botId, async () => {
      // debug 模式下输出详细日志
      if (config.debug) {
        logger.debug(`[MIDDLEWARE] Bot ${botId} 处理消息: userId=${session.userId}`)
      }

      // 调用 next() 继续处理消息
      const result = await next()

      return result
    })
  })

  // ========================================
  // 注册调试指令
  // ========================================
  registerDebugCommands(ctx, botManager, logger, virtualizer)

  // ========================================
  // 插件停用时清理
  // ========================================
  ctx.on('dispose', async () => {
    logger.info('Satori-AI Charon 插件正在停止...')

    // 恢复数据库 get 方法
    virtualizer.unwrapDatabaseGet()

    // 清理手动管理的资源
    for (const dispose of manualDisposes) {
      try {
        dispose()
      } catch (error) {
        logger.warn('清理手动资源时出错:', error)
      }
    }
    manualDisposes.length = 0

    logger.info('Satori-AI Charon 插件已完全停止')
  })
}

/**
 * 注册调试指令
 */
function registerDebugCommands(
  ctx: Context,
  botManager: BotManager,
  _logger: any,
  virtualizer: SessionVirtualizer
): void {
  // 查看所有 bot 状态
  ctx.command('satori-charon.status', '查看所有 bot 的数据隔离状态', { authority: 4 })
    .action(() => {
      const bots = botManager.getAllBotStatus()

      if (bots.length === 0) {
        return '当前没有配置任何 bot'
      }

      let output = `Bot 数据隔离状态（共 ${bots.length} 个）：\n\n`

      for (const bot of bots) {
        output += `## ${bot.botId}\n`
        output += `- 状态: ${bot.initialized ? '已初始化' : '未初始化'}\n`
        output += `- 平台: ${bot.platform}\n`
        if (bot.error) {
          output += `- 错误: ${bot.error}\n`
        }
        output += '\n'
      }

      return output.trim()
    })

  // 测试虚拟化功能
  ctx.command('satori-charon.test <userId:string>', '测试 userId 虚拟化', { authority: 4 })
    .action(({ session }, userId) => {
      const botId = botManager.getBotId(session.platform || '', session.selfId || '')
      const virtualSession = virtualizer.createVirtualSession(session, botId)

      return `原始 userId: ${session.userId}\n虚拟 userId: ${virtualSession.userId}\n输入 userId: ${userId}\n解析后: ${virtualizer.resolveRealUserId(userId)}`
    })

  // 手动重新扫描 bot 列表
  ctx.command('satori-charon.reload', '重新加载 Bot 列表', { authority: 4 })
    .action(() => {
      // 这里应该触发重新扫描，暂时返回提示
      return 'Bot 列表重载功能需要配合 multi-bot-controller 的事件系统'
    })
}
