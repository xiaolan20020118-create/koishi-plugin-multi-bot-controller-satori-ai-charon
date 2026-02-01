// src/bot-manager.ts
import { Context } from 'koishi'
import { BotPersonaConfig, BotStatus } from './types'

/**
 * Bot 管理器
 * 负责从 multi-bot-controller 同步配置，管理 bot 的状态
 */
export class BotManager {
  private readonly logger: ReturnType<Context['logger']>
  private readonly botStatusMap: Map<string, BotStatus> = new Map()

  constructor(
    ctx: Context,
    private config: BotPersonaConfig[],
    private options: {
      virtualizeChannelId: boolean
      debug: boolean
      verboseLogging: boolean
    }
  ) {
    this.logger = ctx.logger('satori-ai-charon')
  }

  /**
   * 解析 botId 为 platform 和 selfId
   */
  parseBotId(botId: string): { platform: string; selfId: string } {
    const [platform, selfId] = botId.split(':', 2)
    return { platform, selfId }
  }

  /**
   * 获取 bot 的人设配置
   */
  getBotConfig(botId: string): BotPersonaConfig | undefined {
    return this.config.find(bot => bot.botId === botId)
  }

  /**
   * 通过 platform 和 selfId 获取 bot 配置
   */
  getBotConfigByPlatform(platform: string, selfId: string): BotPersonaConfig | undefined {
    const botId = this.getBotId(platform, selfId)
    return this.getBotConfig(botId)
  }

  /**
   * 生成 bot 的唯一标识符
   */
  getBotId(platform: string, selfId: string): string {
    return `${platform}:${selfId}`
  }

  /**
   * 获取所有 bot 配置
   */
  getConfig(): BotPersonaConfig[] {
    return this.config
  }

  /**
   * 获取 bot 的运行时状态
   */
  getBotStatus(botId: string): BotStatus | undefined {
    return this.botStatusMap.get(botId)
  }

  /**
   * 设置 bot 的运行时状态
   */
  setBotStatus(botId: string, status: Partial<BotStatus>): void {
    const current = this.botStatusMap.get(botId) || {
      botId,
      platform: this.parseBotId(botId).platform,
      initialized: false,
    }
    this.botStatusMap.set(botId, Object.assign({}, current, status))
    this.debug(`Bot ${botId} 状态已更新:`, status)
  }

  /**
   * 获取所有已配置的 bot
   */
  getConfiguredBots(): BotPersonaConfig[] {
    return this.config.filter(bot => bot.botId)
  }

  /**
   * 获取所有 bot 的运行时状态
   */
  getAllBotStatus(): BotStatus[] {
    return Array.from(this.botStatusMap.values())
  }

  /**
   * 检查是否应该虚拟化 channelId
   */
  shouldVirtualizeChannelId(): boolean {
    return this.options.virtualizeChannelId
  }

  /**
   * 输出调试日志
   */
  private debug(...args: unknown[]): void {
    if (this.options.debug) {
      this.logger.debug(args)
    }
  }

  /**
   * 输出详细日志
   */
  verbose(...args: unknown[]): void {
    if (this.options.verboseLogging) {
      this.logger.info(args)
    }
  }
}
