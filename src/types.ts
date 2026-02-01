// src/types.ts

// ========================================
// Koishi 类型扩展
// ========================================

declare module 'koishi' {
  interface Context {
    // satori-ai 服务（必选依赖）
    satori: any

    // multi-bot-controller 服务（必选依赖）
    'multi-bot-controller': import('koishi-plugin-multi-bot-controller').MultiBotControllerService
  }

  interface Tables {
    // 扩展 satori-ai 的 p_system 表，添加多 bot 隔离字段
    p_system: {
      id?: number
      userid: string
      usersname: string
      p: number
      favorability: number
      userlevel: number
      usage: number
      location: string
      lastChatTime?: number
      items?: Record<string, any>
      // 多 bot 隔离字段
      botId?: string
      realUserId?: string
    }
  }

  interface Events {
    /** satori-ai 插件就绪事件 */
    'satori-ai/ready'(): void
    /** bot 配置更新事件（来自 multi-bot-controller） */
    'multi-bot-controller/bots-updated'(): void
  }
}

// ========================================
// 插件类型定义
// ========================================

/** Bot 信息（来自 multi-bot-controller） */
export interface MbcBotInfo {
  platform: string
  selfId: string
  enabled: boolean
}

/** 单个 Bot 的人设配置 */
export interface BotPersonaConfig {
  /** Bot 标识符 (格式: platform:selfId) */
  botId: string
  /** 人设提示词（可选，覆盖 satori-ai 的默认提示词） */
  prompt?: string
  /** 深度思考模型配置 */
  reasonerModel?: {
    /** 模型名称 */
    model: string
    /** API 地址 */
    baseURL?: string
    /** API Key */
    apiKey?: string[]
  }
  /** 是否启用非思考模型配置 */
  enableNotReasoner?: boolean
  /** 非思考模型配置 */
  notReasonerModel?: {
    /** 模型名称 */
    model: string
    /** API 地址 */
    baseURL?: string
    /** API Key */
    apiKey?: string[]
  }
  /** 是否启用好感度配置 */
  enableFavorability?: boolean
  /** 好感度配置 */
  favorabilityConfig?: {
    /** 厌恶好感补充设定 */
    prompt_0?: string
    /** 厌恶-陌生分界线 */
    favorability_div_1?: number
    /** 陌生好感补充设定 */
    prompt_1?: string
    /** 陌生-朋友分界线 */
    favorability_div_2?: number
    /** 朋友好感补充设定 */
    prompt_2?: string
    /** 朋友-恋人分界线 */
    favorability_div_3?: number
    /** 恋人好感补充设定 */
    prompt_3?: string
    /** 恋人-亲人分界线 */
    favorability_div_4?: number
    /** 亲人好感补充设定 */
    prompt_4?: string
  }
  /** 是否启用心情配置 */
  enableMood?: boolean
  /** 心情配置 */
  moodConfig?: {
    /** 烦躁心情补充设定 */
    mood_prompt_0?: string
    /** 心情正常-烦躁分界线 */
    mood_div_1?: number
    /** 生气心情补充设定 */
    mood_prompt_1?: string
    /** 烦躁-生气分界线 */
    mood_div_2?: number
    /** 心情达到最高补充设定 */
    mood_prompt_2?: string
  }
}

/** 插件配置 */
export interface Config {
  /** Bot 人设配置列表 */
  bots: BotPersonaConfig[]

  /** 是否虚拟化 channelId（隔离群常识和并发计数） */
  virtualizeChannelId: boolean

  /** 是否输出调试日志 */
  debug: boolean

  /** 是否输出详细日志 */
  verboseLogging: boolean
}

/** 虚拟化选项 */
export interface VirtualizeOptions {
  /** 是否虚拟化 userId */
  virtualizeUserId: boolean
  /** 是否虚拟化 channelId */
  virtualizeChannelId: boolean
  /** Bot ID 前缀 */
  botId: string
}

/** Bot 的运行时状态 */
export interface BotStatus {
  /** Bot 标识符 */
  botId: string
  /** 平台 */
  platform: string
  /** 是否已初始化 */
  initialized: boolean
  /** 错误信息（如果有） */
  error?: string
}
