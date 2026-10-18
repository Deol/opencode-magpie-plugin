# opencode-magpie-plugin

[![npm](https://img.shields.io/npm/v/opencode-magpie-plugin)](https://www.npmjs.com/package/opencode-magpie-plugin)
[![CI](https://github.com/yee94/opencode-magpie-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/yee94/opencode-magpie-plugin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**在 OpenCode V2 中动态使用 Magpie 的 Cursor、WorkBuddy 等服务，无需手写模型配置。**

An OpenCode V2 plugin for the local [Magpie](https://usemagpie.ai/) gateway. It discovers providers and models, supplies built-in token pricing, and starts an installed gateway when needed. Zero runtime npm dependencies; no private registry or company-scoped packages required.

## 它解决什么问题

Magpie 管理多个服务的账号、模型、协议转换和路由；这个插件负责把这些能力接入 OpenCode。

```text
OpenCode V2
  ├─ /models：Cursor、WorkBuddy、Magpie（路由分组）
  ├─ 模型能力、上下文限制、reasoning 档位和价格
  └─ 原生 Chat / Responses / Anthropic 请求
          ↓
    本机 Magpie 网关
          ↓
    Cursor / WorkBuddy / 其他已配置服务
```

- `opencode.jsonc` 只加载插件，不维护 `providers.models`。
- 启动时发现目录，每 30 秒刷新；服务新增、模型下线都能反映到 OpenCode。
- Provider 显示 Magpie 中的分组名称，而不是统一挤在一个 “Magpie” 下；路由分组统一归入 Magpie。
- 内置独立价格表和模型名归一化逻辑，支持输入、输出、缓存读取与写入价格。
- Magpie 已安装但未运行时自动启动；macOS 上找到 app 内的可执行文件时优先启动 app，保留路由页；未安装时给出安装链接。
- 登录和服务凭据由 Magpie 管理，插件不需要复制上游 token。

这不是一个绕过 Magpie 的社区插件宿主：**推理请求仍经过本机 Magpie 网关**。

## 前置条件

1. 使用支持 `setup()`、`provider.transform` 和原生 provider runtime 的 **OpenCode V2**。不支持 V1。
2. 从 [Magpie 官网](https://usemagpie.ai/zh/) 安装 Magpie，并在其中登录需要的服务、启用模型。
3. 网关对本机可访问，默认地址 `http://127.0.0.1:3425`。

包的 Node.js 要求为 **22 或更高**。macOS 上已验证插件加载与 Cursor / WorkBuddy 目录注册；Windows 和 Linux 的实际网关联调尚未验证。

## 安装

在全局 `~/.config/opencode/opencode.jsonc` 中加入插件；如果已有 `plugins` 数组，追加即可：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-magpie-plugin"]
}
```

也可以固定版本：

```jsonc
{
  "plugins": ["opencode-magpie-plugin@0.1.5"]
}
```

OpenCode 会从公网 npm 安装插件，不需要先全局安装 npm 包。不要同时加载本插件的 npm 版和本地 file 版。

重启 OpenCode 服务，使全局配置生效：

```sh
opencode service restart
```

打开 `/plugins`，应看到 `magpie.providers`；打开 `/models`，选择 Cursor、WorkBuddy 等分组下的模型。

### Provider 名称与模型 ID

显示名与 Magpie 保持一致，内部 ID 则使用命名空间，避免覆盖另一个 Cursor / WorkBuddy 插件：

| OpenCode 中的显示名 | 内部 provider ID | 示例模型引用 | 发给 Magpie 的 model |
| --- | --- | --- | --- |
| Cursor | `magpie-cursor` | `magpie-cursor/gpt-5.5` | `cursor/gpt-5.5` |
| WorkBuddy | `magpie-workbuddy` | `magpie-workbuddy/claude-opus-4-6` | `workbuddy/claude-opus-4-6` |
| Magpie | `magpie-magpie` | `magpie-magpie/auto` | `group/auto` |

示例模型仅说明格式，实际列表取决于 Magpie 当前账号与配置。Magpie 自定义 provider ID 会原样映射为带 `magpie-` 前缀的 ID。

Routing group（例如 `group/auto`）会跨多个服务路由，因此不按 `owned_by` 或首个候选服务拆成 provider，而是统一归到 **Magpie** 分组下。发送时仍保留 `group/auto`，价格只用 Magpie 给出的价格，不按成员猜测。

## 自动发现与请求行为

插件先检查网关根路径的 `name: "magpie"`，再请求 `/v1/models`。请求携带 `X-Magpie-Prices: 1` 读取可用的网关价格扩展。

目录映射保留模型的上下文窗口、最大输出、输入输出模态和 reasoning 档位。仅发现聊天目录；重复的无 provider 前缀别名、图片生成或其他非聊天专用模型不会注册为聊天模型。

思考强度读取新版 `reasoning_levels`，并兼容已安装版本常见的 `supported_reasoning_levels`（`{ effort }` 对象或字符串列表）。只有网关实际声明的档位才会出现，可在 OpenCode 的模型变体控件中选择，或使用 `provider/model#high` 这样的引用。`default` 保留服务默认行为，不额外生成档位；网关未提供档位时不会凭模型名称猜测。

根据 `native_endpoints` 选择 OpenCode 内置 runtime：

| Magpie 元数据 | OpenCode runtime |
| --- | --- |
| 包含 `/v1/messages` | `anthropic-compatible` |
| 否则包含 `/v1/responses` | `openai-compatible/responses` |
| 其他情况 | `openai-compatible`（Chat Completions） |

消息、工具调用和工具结果由 OpenCode 原生 runtime 编码，再由 Magpie 转接。插件传递 `X-Magpie-Session` 保持会话标识，并指定 HTTP 传输。模型上游支持的完整能力仍取决于 Magpie 和相应服务。

思考档位按所选协议编码：Chat 使用 `reasoning_effort`，Responses 使用 `reasoning.effort`，Anthropic 使用 `thinking.type=adaptive` 配合 `output_config.effort`；Anthropic 的 `none` 关闭 thinking。

刷新成功时替换完整目录；刷新失败保留最近一次成功的目录。首次发现失败会报告初始化错误，不生成虚假的可用模型。

## 网关地址与启动

地址优先级：

1. OpenCode 服务进程中的 `MAGPIE_ADDR`。
2. `$XDG_CONFIG_HOME/magpie/settings.json` 的 `port`。
3. 未指定 XDG 路径时，使用 `~/.config/magpie/settings.json` 的 `port`。
4. 默认端口 `3425`。

`MAGPIE_ADDR` 使用 Magpie 自身的监听地址格式，例如：

```sh
MAGPIE_ADDR=127.0.0.1:3426 opencode --standalone
```

`0.0.0.0`、`::` 监听地址会转换为本机访问地址。本版本面向本机网关，不支持远程服务器地址。共享服务模式下，在终端临时设置变量不一定会改变已经启动的 OpenCode 服务环境。

网关不在线时，插件在 PATH、`~/.local/bin`、常见 Homebrew 路径以及 macOS 的 `Magpie.app` 中寻找可执行文件并把它拉起来。找到的是 `Magpie.app` 里的可执行文件时（安装器的软链会解析到真实路径），macOS 上优先启动 `magpie tray`——它同样提供网关，而且带窗口，路由页可以查看。app 非零退出或被信号终止后，才退回无窗口的 `magpie serve`。其他情况直接用 `serve`。Windows 通过 PATH / `~/.local/bin` 寻找 `magpie.exe`。如果无法找到，请安装 Magpie 或把它加入 OpenCode 服务的 PATH。

启动后会等待网关就绪；app 明确异常退出时才降级到 `serve`。app 仍在启动或正常退出（可能已交给现有 app）时，超时会提示检查 app，不会另起 `serve` 抢占端口。请求前和目录刷新时也会检查网关。插件卸载不会关闭已启动的共享网关。若端口被其他服务占用，会报错而不是向其发送模型请求。

便携版使用自定义端口时，请显式设置 `MAGPIE_ADDR`；插件不自动推断便携版的 data 目录。

## 价格与费用统计

### 价格从哪里来

价格表完整内置于 [`src/model-pricing.ts`](src/model-pricing.ts)，包含模型别名、渠道后缀处理、版本回退与 provider 专属覆盖。它从原有共享价格模块迁移而来，之后随本项目版本独立维护；运行时不请求私有包、私有 registry 或其他仓库。

普通模型使用以下顺序：

1. 内置价格表，优先应用已识别 provider 的专属覆盖。
2. 内置表未覆盖时，使用 Magpie 返回的 `magpie_price`。
3. 普通模型仍缺价时，查询 models.dev 本地缓存：优先同 provider 的精确 ID，再查已识别厂商（OpenAI、Anthropic、DeepSeek、Google、xAI）的精确 ID 或 `canonical_model_id`。不跨版本猜价、不采用其他转售商报价、不使用订阅 plan 目录的零价。
4. 所有来源均没有价格时，不启用该模型，避免把未知价格显示为免费。**路由组例外**：Magpie 只在组内全部成员同价时才给组报价，而路由组每一轮的成员由路由决定，成本本来就是一个区间而不是单一数字。这类组保持可选用、保留自己的名字，只是费用读数不精确。路由分组仍只用 Magpie 报价，不根据 `auto-*` 名称推断成员价格。

models.dev 缓存写入 `$XDG_CACHE_HOME/opencode-magpie-plugin/models.json`（默认 `~/.cache/opencode-magpie-plugin/models.json`）。首次可只读复用 Magpie、OpenCode 的 `models.json`；下载只写插件自己的目录。每次模型刷新检查缓存，超过 24 小时后台更新，缺价时可提前到 6 小时；同进程下载去重且失败后至少间隔 6 小时重试。首次下载和更新不阻塞模型发现，成功后下一次 30 秒刷新采用新目录；离线保留旧缓存。下载源为 `https://models.dev/api.json`，仍然零运行时依赖，目前只采用基础价，未接入阶梯价。

### 0.1.5

新增 models.dev 缓存作为缺价兜底，不改动内置费率和 provider 覆盖。补充的价格来自 models.dev，对应目录更新后可能变化；以实际服务账单为准。

Cursor 使用 `cursor` 覆盖，WorkBuddy 使用 `codebuddy` 覆盖；其他已识别服务按表中对应 provider 处理。Routing group 只用 Magpie 提供的价格，不按成员猜测。明确记录的零价格仍视为有效价格。

所有价格单位都是 **美元 / 百万 token**。OpenCode 用这些单价计算请求费用。普通计费的概念公式为：

```text
费用 = (非缓存输入 × input + 输出 × output
      + 缓存读取 × cache.read + 缓存写入 × cache.write) / 1,000,000
```

缓存部分不能再次算入非缓存输入。不同协议的 token 字段由宿主 runtime 归一化；插件不重写 token 来凑费用。继承的价格记录缺少缓存单价时，当前映射将该项设为 0。

### 准确性边界

- 表中同时存在官方参考价、服务专属估算价和版本回退，**不是所有模型的实时账单价**。
- Magpie 用户自定义价格不会覆盖已命中的内置价格表。
- Routing group 可能动态切换成员，目录价格不保证等于实际被选成员的价格。
- Cursor 等服务的 `usage.magpie_deferred` 是迟到用量，Magpie 会补记到账本；OpenCode 原生 runtime 不会因此修改历史费用。
- 当前价格映射不支持 Magpie 的上下文阶梯价和独立的一小时缓存写入价。

因此，OpenCode 费用适合观察 token 成本，**不能承诺与 Magpie 或订阅服务最终账单完全一致**。

### 查看或复用价格表

包提供公开的 `pricing` 子路径：

```js
import { getModelPricing, resolveModelPricingKey } from 'opencode-magpie-plugin/pricing';

console.log(resolveModelPricingKey('claude-opus-4-6'));
console.log(getModelPricing('claude-opus-4-6', 'cursor'));
```

`getModelPricing()` 对未知模型返回 `undefined`，不会自动填零；调用方获得的是副本，不会修改全局价格表。

## 本地开发 / file 模式

```sh
git clone https://github.com/yee94/opencode-magpie-plugin.git
cd opencode-magpie-plugin
corepack enable
pnpm install
pnpm check
```

把配置中的 npm 包替换为构建目录的 URL：

```jsonc
{
  "plugins": ["file:///absolute/path/opencode-magpie-plugin/dist"]
}
```

**必须指向 `dist` 目录，不是 `dist/index.mjs` 文件，也不是仓库根目录。** V2 本地目录加载器寻找目录内的 `server` / `index` 入口；直接填写文件路径会被忽略并记录 `configured plugin path must be a directory`。

修改源码后重新执行 `pnpm build`，再重新加载 OpenCode 服务。

## 排查

| 现象 | 检查项 |
| --- | --- |
| `/plugins` 没有 `magpie.providers` | 全局配置是否被当前服务读取；file 模式是否填写 `dist` 目录并已构建；查看 OpenCode 日志 |
| 提示未安装 Magpie | 安装 [Magpie](https://usemagpie.ai/zh/)，确认服务进程 PATH 可以找到它 |
| 启动超时 | 手动执行 `magpie serve` 查看错误，检查监听端口 |
| 插件已加载但没有模型 | 在 Magpie 登录并启用服务，检查 `/v1/models` 是否有模型及有效价格 |
| 添加模型后没出现 | 等待下一个 30 秒刷新周期；初次初始化失败则重载 OpenCode |
| 原有 Cursor 与新 Cursor 同时出现 | 两个插件可同时存在；Magpie 的内部 ID 是 `magpie-cursor` |
| 费用和实际账单不同 | 查看上面的价格优先级、迟到用量和阶梯价格边界 |

本机目录检查（不会调用模型）：

```sh
curl http://127.0.0.1:3425/
curl -H 'Authorization: Bearer magpie' -H 'X-Magpie-Prices: 1' \
  http://127.0.0.1:3425/v1/models
```

这里的 `magpie` 是本机网关占位 key，不是上游账号 token。

## 测试与发布

```sh
pnpm check
pnpm pack
```

维护者发布采用 tag 驱动：推送与 `package.json.version` 一致的 `v<version>` tag 后，GitHub Actions 自动检查、发布公网 npm 并创建 GitHub Release。正式版使用 `latest`，预发布版使用 `next`。完整步骤、认证要求与失败恢复见 [发布指南](docs/releasing.md)。

测试覆盖目录分组与替换、wire model ID、协议元数据、价格归一化与覆盖、未知价格、会话头、网关身份检查、自动启动与并发去重、未安装提示、刷新失败和清理。测试不消耗真实服务额度。

只发布 `dist`、README 和许可证，**没有 runtime dependencies**。价格表变更时应更新相应测试，并在 release 说明价格来源与变化。

## 相关项目与许可证

- [Magpie](https://usemagpie.ai/)：账号、网关、路由和上游转接。
- [OpenCode V2 plugins](https://opencode.ai/v2/docs/build/plugins)：插件生命周期与动态 provider API。

这是独立集成项目，不是 Magpie 或 OpenCode 官方插件。插件代码采用 [MIT](LICENSE)；Magpie 与各上游服务遵循各自的许可证和服务条款。
