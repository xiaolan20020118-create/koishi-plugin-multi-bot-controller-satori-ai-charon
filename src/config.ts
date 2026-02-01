// src/config.ts
import { Context, Schema } from 'koishi'
import type { BotPersonaConfig, Config } from './types'

/**
 * 更新 botId 选择选项
 * 此函数由 index.ts 在运行时调用
 */
export function updateBotIdOptions(ctx: Context, botIds: string[]) {
  // 占位符始终放在最前面，作为默认选项
  const placeholder = Schema.const('').description('无')

  if (botIds.length === 0) {
    ctx.schema.set('satori-ai-charon.botId', Schema.union([
      placeholder,
    ]))
    return
  }

  const options = [
    placeholder,
    ...botIds.map(botId => Schema.const(botId).description(botId))
  ]

  ctx.schema.set('satori-ai-charon.botId', Schema.union(options))
}

/**
 * 创建单个 Bot 配置 Schema
 * 导出以供 ConfigSchema 复用
 */
export const createBotConfigSchema = (): Schema<BotPersonaConfig> => {
  return Schema.intersect([
    // Bot 选择
    Schema.object({
      botId: Schema.dynamic('satori-ai-charon.botId')
        .description('**Bot ID**<br>从 multi-bot-controller 已配置的 Bot 中选择')
        .required(),
    }),

    // 人设提示词
    Schema.object({
      prompt: Schema.string()
        .role('textarea')
        .description('**人设提示词**<br>覆盖 satori-ai 的默认提示词，让此 bot 使用不同的人格设定')
        .default(''),
    }),

    // 深度思考模型配置
    Schema.object({
      reasonerModel: Schema.intersect([
        Schema.object({
          baseURL: Schema.string()
            .description('API 地址<br>如 "https://api.deepseek.com"')
            .default(''),
        }),
        Schema.object({
          model: Schema.string()
            .description('深度思考模型<br>如 "deepseek-reasoner"')
            .default(''),
        }),
        Schema.object({
          apiKey: Schema.union([
            Schema.array(String).role('secret'),
            Schema.transform(String, value => [value]),
          ]).description('API Key<br>支持多 key 轮换')
            .role('secret')
            .default([]),
        }),
      ]),
    }),

    // 非思考模型配置（使用 mbc 模式：Schema.intersect + Schema.union）
    Schema.intersect([
      Schema.object({
        enableNotReasoner: Schema.boolean()
          .description('是否配置非深度思考模型')
          .default(false),
      }),
      Schema.union([
        Schema.object({
          enableNotReasoner: Schema.const(true).required(),
          notReasonerModel: Schema.intersect([
            Schema.object({
              baseURL: Schema.string()
                .description('API 地址<br>如 "https://api.deepseek.com"')
                .default(''),
            }),
            Schema.object({
              model: Schema.string()
                .description('非思考模型<br>如 "deepseek-chat"')
                .default(''),
            }),
            Schema.object({
              apiKey: Schema.union([
                Schema.array(String).role('secret'),
                Schema.transform(String, value => [value]),
              ]).description('API Key<br>支持多 key 轮换')
                .role('secret')
                .default([]),
            }),
          ]),
        }),
        Schema.object({}),
      ]),
    ]),

    // 好感度配置（使用 mbc 模式：Schema.intersect + Schema.union）
    Schema.intersect([
      Schema.object({
        enableFavorability: Schema.boolean()
          .description('是否配置好感度设定')
          .default(false),
      }),
      Schema.union([
        Schema.object({
          enableFavorability: Schema.const(true).required(),
          favorabilityConfig: Schema.intersect([
            Schema.object({
              prompt_0: Schema.string()
                .role('textarea')
                .description('厌恶好感补充设定')
                .default(''),
            }),
            Schema.object({
              favorability_div_1: Schema.number()
                .description('厌恶-陌生分界线')
                .default(15),
            }),
            Schema.object({
              prompt_1: Schema.string()
                .role('textarea')
                .description('陌生好感补充设定')
                .default(''),
            }),
            Schema.object({
              favorability_div_2: Schema.number()
                .description('陌生-朋友分界线')
                .default(150),
            }),
            Schema.object({
              prompt_2: Schema.string()
                .role('textarea')
                .description('朋友好感补充设定')
                .default(''),
            }),
            Schema.object({
              favorability_div_3: Schema.number()
                .description('朋友-恋人分界线')
                .default(300),
            }),
            Schema.object({
              prompt_3: Schema.string()
                .role('textarea')
                .description('恋人好感补充设定')
                .default(''),
            }),
            Schema.object({
              favorability_div_4: Schema.number()
                .description('恋人-亲人分界线')
                .default(500),
            }),
            Schema.object({
              prompt_4: Schema.string()
                .role('textarea')
                .description('亲人好感补充设定')
                .default(''),
            }),
          ]),
        }),
        Schema.object({}),
      ]),
    ]),

    // 心情配置（使用 mbc 模式：Schema.intersect + Schema.union）
    Schema.intersect([
      Schema.object({
        enableMood: Schema.boolean()
          .description('是否配置心情设定')
          .default(false),
      }),
      Schema.union([
        Schema.object({
          enableMood: Schema.const(true).required(),
          moodConfig: Schema.intersect([
            Schema.object({
              mood_prompt_0: Schema.string()
                .role('textarea')
                .description('烦躁心情补充设定')
                .default('你现在的心情是：有点烦躁'),
            }),
            Schema.object({
              mood_div_1: Schema.number()
                .description('心情正常-烦躁分界线')
                .default(-1),
            }),
            Schema.object({
              mood_prompt_1: Schema.string()
                .role('textarea')
                .description('生气心情补充设定')
                .default('你现在的心情是：非常生气'),
            }),
            Schema.object({
              mood_div_2: Schema.number()
                .description('烦躁-生气分界线')
                .default(-15),
            }),
            Schema.object({
              mood_prompt_2: Schema.string()
                .role('textarea')
                .description('心情达到最高补充设定')
                .default('你现在的心情十分愉悦'),
            }),
          ]),
        }),
        Schema.object({}),
      ]),
    ]),
  ]) as Schema<BotPersonaConfig>
}

/**
 * 创建插件配置 Schema
 */
export const createConfig = (ctx: Context): Schema<Config> => {
  // 初始化默认 Schema
  updateBotIdOptions(ctx, [])

  return Schema.intersect([
    Schema.object({
      bots: Schema.array(createBotConfigSchema())
        .role('list')
        .default([])
        .description('**Bot 数据隔离配置列表**\n\n添加 Bot 后，每个 Bot 将拥有独立的用户数据、好感度、记忆文件等'),
    }),

    Schema.object({
      virtualizeChannelId: Schema.boolean()
        .description('**是否虚拟化 channelId**<br>启用后，每个 Bot 将拥有独立的群常识和并发计数。如果不启用，群常识将在多个 Bot 之间共享。')
        .default(false),
    }).description('隔离设置'),

    Schema.object({
      debug: Schema.boolean()
        .description('是否输出调试日志')
        .default(false),
      verboseLogging: Schema.boolean()
        .description('显示详细日志（关闭后只输出关键信息）')
        .default(false),
    }).description('高级设置'),
  ]) as Schema<Config>
}

// 静态导出（用于配置界面）
// 复用 createBotConfigSchema() 消除重复代码
export const ConfigSchema: Schema<Config> = Schema.intersect([
  Schema.object({
    bots: Schema.array(createBotConfigSchema())
      .role('list')
      .default([])
      .description('**Bot 数据隔离配置列表**\n\n添加 Bot 后，每个 Bot 将拥有独立的用户数据、好感度、记忆文件等'),
  }),
  Schema.object({
    virtualizeChannelId: Schema.boolean()
      .description('**是否虚拟化 channelId**<br>启用后，每个 Bot 将拥有独立的群常识和并发计数。如果不启用，群常识将在多个 Bot 之间共享。')
      .default(false),
  }).description('隔离设置'),
  Schema.object({
    debug: Schema.boolean()
      .description('是否输出调试日志')
      .default(false),
    verboseLogging: Schema.boolean()
      .description('显示详细日志（关闭后只输出关键信息）')
      .default(false),
  }).description('高级设置'),
])

export const name = 'multi-bot-controller-satori-ai-charon'
