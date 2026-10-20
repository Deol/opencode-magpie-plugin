# 工具调用 ID 兼容性验证

## 实现边界

OpenAI Responses 的 `call_id` 最多 64 字符。插件通过仅限 `openai` provider 的 `context`、`compaction`、`generate`、`title` hooks，在协议编码、HTTP 压缩和 WebSocket 增量选择之前，处理待发送消息中的 `tool-call.id` 和 `tool-result.id`。

超过上限的 ID 映射为 `call_` + 原 ID 的 SHA-256 base64url（共 48 字符）。相同 ID 在独立请求中也得到相同映射；64 字符及以下的 ID 不变。工具名称、参数、输出和持久化历史不变。

## 真实服务验证

环境：OpenCode 2.0.32，独立临时项目加载本仓库修改后的源码；使用现有登录连接，没有修改全局配置。OpenAI provider 实际连接是 `https://chatgpt.com/backend-api/codex`，模型为 `gpt-6-astra`。

先用 Cursor Composer 2.5、Claude Opus 5.5、GPT-5.5 实际调用回显和加法工具。这几次自然返回的 ID 均为 40 字符，未自然复现用户的 82 字符 ID 来源。

随后通过会话导出/导入 API，复制 GPT-5.5 测试历史，仅将其中一次工具调用 ID 改为 82 字符，作为故障夹具。没有修改用户原会话。

| 场景 | 结果 |
| --- | --- |
| 关闭兼容处理，82 字符历史切到 OpenAI WebSocket | 服务端返回相同的 `Invalid response.create payload` / 长度 82 超过 64 错误 |
| 首版原始请求补丁，HTTP + zstd | 失败：未覆盖 Codex 地址和压缩请求；已用编码前的消息 hook 替代 |
| 最终实现，82 字符历史，OpenAI HTTP + zstd | 工具调用及续轮成功 |
| 最终实现，OpenAI WebSocket，新连接和连续续轮 | 成功；捕获 8 个帧，1 个全量、7 个含 `previous_response_id` 的增量请求 |
| OpenAI → Cursor Composer → OpenAI | 工具调用与历史回忆成功，包括 Cursor 单次返回三个并行原生工具调用后的回放 |
| 切回 Cursor GPT-5.5 | 返回 429 `provider.quota`，该次未通过，不能据此判断兼容性 |

使用同一只读文件和工作目录，分别在 OpenAI HTTP、OpenAI WebSocket、Cursor Composer 执行 `read`、`grep`、`shell`（`pwd`）。三个工具各有三次已完成调用，脚本比较原始 `state.content`，每种工具的三份输出完全相同。回显和加法工具也实际执行，覆盖顺序和 Code Mode 并发调用。

最终实现捕获的 14 次 OpenAI 主请求中，发送前最长 ID 为 82，处理后最长 48；重新读取会话历史，原 82 字符 ID 保持不变。

主要证据会话：`ses_cd3f524af2b14d7498e97245db`。本机原始证据位于 OpenCode 临时目录下的 `call-id-live/`（`trace.jsonl`、会话 JSON、测试脚本），未提交凭据或用户历史。

## 尚未覆盖

- `api.openai.com` API key 直连：本次使用的是现有 ChatGPT/Codex 登录连接。
- 用户原始会话中 82 字符 ID 的具体生成来源。
- compaction、generate、title 的真实模型请求：已验证 hook 注册和同一转换逻辑，未单独做线上调用。
- Cursor 其他模型和所有工具的穷举测试。

本地检查：`pnpm check`，98 项测试通过，类型检查、lint、构建通过。
