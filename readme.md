# koishi-plugin-multi-bot-controller-satori-ai-charon

[![npm](https://img.shields.io/npm/v/koishi-plugin-multi-bot-controller-satori-ai-charon?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-multi-bot-controller-satori-ai-charon)

为 [satori-ai](https://github.com/koishijs/plugins) 插件实现多 Bot 数据隔离和人格配置，每个 Bot 拥有独立的用户数据、好感度、记忆文件、提示词和模型配置。

## 功能特性

### 数据隔离
- **userId 虚拟化**：每个 Bot 拥有独立的用户数据空间
  - 用户记忆文件隔离
  - 用户好感度隔离
  - 用户等级、使用次数隔离

- **channelId 虚拟化（可选）**：可隔离群常识和并发计数
  - 群常识文件隔离
  - 并发控制隔离

### 人格和模型配置
- **提示词隔离**：每个 Bot 可以配置不同的人格设定
  - 覆盖 satori-ai 的默认提示词
  - 支持长文本配置
  - 动态注入到系统提示中

- **深度思考模型隔离**：每个 Bot 可以使用不同的深度思考模型和 API
  - 配置模型名称（覆盖 appointModel）
  - 配置 API 地址（覆盖 baseURL）
  - 配置 API Key（覆盖 key，支持多 key 轮换）

- **非思考模型隔离**：每个 Bot 可以配置不同的低成本模型和 API（可选）
  - 配置模型名称（覆盖 not_reasoner_LLM）
  - 配置触发字数阈值（覆盖 use_not_reasoner_LLM_length）
  - 配置 API 地址（覆盖 not_reasoner_LLM_URL）
  - 配置 API Key（覆盖 not_reasoner_LLM_key）
  - 通过开关控制是否启用

### 技术实现
- **Session 虚拟化**：通过 Proxy 包装 Session 对象，只在 satori-ai 内部生效
- **数据库扩展**：为 p_system 表添加 botId 和 realUserId 字段
- **方法拦截**：拦截 satori-ai 的所有方法调用，自动虚拟化 session 参数
- **提示词注入**：在系统提示构建完成后，动态添加 Bot 特定的提示词
- **配置拦截**：拦截 satori-ai 的 config 访问，动态返回 Bot 特定的模型和 API 配置
- **配置联动**：使用 Schema.intersect + Schema.union 实现非思考模型配置的条件显示

## 安装

```bash
# 在 koishi-app 目录下执行
npm install koishi-plugin-multi-bot-controller-satori-ai-charon
```

## 配置

在 Koishi 配置文件中添加插件：

```yaml
plugins:
  multi-bot-controller-satori-ai-charon:
    # Bot 数据隔离配置列表
    bots:
      - botId: onebot:123456  # 从 multi-bot-controller 已配置的 Bot 中选择
        # 人设提示词（可选）
        prompt: |
          你是一个活泼可爱的女仆，名叫小樱。
          你性格开朗，说话经常使用颜文字 (≧∇≦)。
          你对用户非常忠诚，会称呼用户为"主人"。
        # 深度思考模型配置
        reasonerModel:
          model: deepseek-reasoner
          baseURL: https://api.deepseek.com
          apiKey:
            - your-api-key-here
        # 启用非思考模型
        enableNotReasoner: true
        # 非思考模型配置
        notReasonerModel:
          model: deepseek-chat
          length: 8
          baseURL: https://api.deepseek.com
          apiKey:
            - your-api-key-here
    # 是否虚拟化 channelId（隔离群常识和并发计数）
    virtualizeChannelId: false
    # 调试选项
    debug: false
    verboseLogging: false
```

## 隔离范围说明

| 数据类型 | 隔离方式 | 说明 |
|---------|---------|------|
| 用户记忆文件 | userId 虚拟化 | 每个 Bot 拥有独立的用户长期记忆 |
| 用户好感度 | userId 虚拟化 | 每个 Bot 拥有独立的用户好感度系统 |
| 用户等级、使用次数 | userId 虚拟化 | 每个 Bot 拥有独立的用户等级和使用次数 |
| 人设提示词 | 动态注入 | 每个 Bot 可以有不同的人格设定 |
| 深度思考模型 | 配置拦截 | 每个 Bot 可以使用不同的深度思考模型和 API |
| 非思考模型 | 配置拦截 | 每个 Bot 可以使用不同的低成本模型和 API（可选） |
| 群常识 | channelId 虚拟化（可选） | 可选是否隔离群常识 |
| 并发计数 | channelId 虚拟化（可选） | 可选是否隔离并发控制 |

## 配合 multi-bot-controller 使用

当与 [multi-bot-controller](https://github.com/koishijs/plugins/tree/main/plugins/multi-bot-controller) 配合使用时：

1. 在 multi-bot-controller 中配置多个 bot
2. 在本插件中为每个 bot 配置独立的人格和模型配置
3. 每个 bot 将：
   - 拥有独立的用户数据空间
   - 使用不同的人格设定（如果有配置 prompt）
   - 使用不同的深度思考模型和 API（如果有配置 reasonerModel）
   - 使用不同的非思考模型和 API（如果启用 enableNotReasoner）
   - 根据 multi-bot-controller 的规则响应消息

## 调试指令

- `satori-charon.status` - 查看所有 bot 的数据隔离状态
- `satori-charon.test <userId>` - 测试 userId 虚拟化功能
- `satori-charon.reload` - 重新加载 Bot 列表

## 兼容性

- **Koishi**: ^4.18.7
- **multi-bot-controller**: ^1.0.3（可选）
- **satori-ai**: 最新版本

## 许可证

MIT
