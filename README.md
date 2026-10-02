# ocgo-session-proxy

[![test](https://github.com/Phi-2X/ocgo-session-proxy/actions/workflows/test.yml/badge.svg)](https://github.com/Phi-2X/ocgo-session-proxy/actions/workflows/test.yml)

一个零依赖的本地反向代理：自动给发往 **OpenCode Go** 的每个请求补上
`x-opencode-session` 请求头，并且这个值**按会话自动推导**——同一会话跨轮保持稳定，
不同会话互不相同。

任何 OpenAI / Anthropic 兼容的客户端只要把请求地址填成
`http://127.0.0.1:8787/v1`（Anthropic 类型填 `http://127.0.0.1:8787`），
并填入自己的 OpenCode Go API Key，就能正常调用。代理**不保存任何密钥**。

---

## 为什么需要它

OpenCode Go 要求客户端发出稳定的会话标识（[官方文档](https://opencode.ai/docs/go/)）：

> Send a stable session ID in `x-opencode-session` for each conversation so we can
> optimize routing and prompt caching.

大多数 agent 框架（Cherry Studio、AstrBot、各类 OpenAI 兼容框架）没有这个概念，于是直接报错：

```json
{"type":"error","error":{"type":"MissingSessionID","message":"...Request is missing x-opencode-session..."}}
```

而如果只是在客户端里**静态配一个头值**，所有会话都会共用同一个身份，网关的路由与
prompt cache 优化都会退化——这正是它想避免的情况。所以本代理改为从**请求体内容**推导
会话身份。

---

## 快速开始

要求 Node.js ≥ 20（本机已验证 v24.19.0），**无需 npm install**。

```powershell
# Windows
cd ocgo-session-proxy
.\start.cmd
```

```bash
# macOS / Linux
cd ocgo-session-proxy
./start.sh
```

或直接：

```bash
node proxy.mjs                 # 默认监听 127.0.0.1:8787
node proxy.mjs --port 9000     # 换端口
```

启动后会打印：

```
ocgo-session-proxy listening on http://127.0.0.1:8787
  upstream         https://opencode.ai/zen/go
  OpenAI base URL  http://127.0.0.1:8787/v1   |   Anthropic base URL  http://127.0.0.1:8787
  session headers  x-opencode-session, x-session-id (derived per request)
  diagnostics      http://127.0.0.1:8787/_proxy/health, /_proxy/stats, /_proxy/sessions
```

每处理一个请求会打一行日志，可以直接看到会话是否被正确复用：

```
2026-09-10T16:02:21.374Z POST /v1/chat/completions model=kimi-k2.6 session=ocgo-ac91e1251a2146259848898f(new) -> 200 1105ms ttfb=1104ms 74B
2026-09-10T16:02:25.100Z POST /v1/chat/completions model=kimi-k2.6 session=ocgo-ac91e1251a2146259848898f(matched) -> 200 980ms ttfb=701ms 512B
```

`session=...(new)` 是新建会话，`(matched)` 表示这一轮被归入了同一个会话。

---

## 各客户端怎么填

| 客户端 | API 地址 / Base URL | 说明 |
| --- | --- | --- |
| **Cherry Studio**（OpenAI 类型） | `http://127.0.0.1:8787/v1` | 模型列表可直接点“获取”，也可手填 `kimi-k2.6`、`glm-5.3` 等 |
| **Cherry Studio**（Anthropic 类型） | `http://127.0.0.1:8787` | 用于走 `/v1/messages` 的模型：`minimax-m3`、`qwen3.8-max` 等 |
| **AstrBot**（OpenAI 兼容服务提供商） | `http://127.0.0.1:8787/v1` | API Key 填 Go 的 key |
| **LobeChat / NextChat / One API / New API** | `http://127.0.0.1:8787/v1` | 同上 |
| **Claude Code** | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` | 走 `/v1/messages` |
| **Codex / Responses 类客户端** | `http://127.0.0.1:8787/v1` | 走 `/v1/responses` |
| **任意 SDK**（openai-python/node、anthropic） | `base_url="http://127.0.0.1:8787/v1"` | 无需改代码 |
| **DeepSeek Harness** | 同上 | 也可以用本代理；DSH 本身另有原生插件方案 |

> 模型清单见 `http://127.0.0.1:8787/v1/models`（与网关的 `https://opencode.ai/zen/go/v1/models` 一致）。

---

## 会话 id 是怎么推导出来的

对每个请求的 JSON body：

1. **抽取**有序的“消息单元”。优先按已知结构识别，识别不了就退化为“按 key 排序把 body 里
   所有字符串按顺序摊平”，所以未知框架也能得到稳定 id，而不是共用一个常量。

   | Body 形状 | 识别方式 | system 来源 |
   | --- | --- | --- |
   | OpenAI `/v1/chat/completions` | `messages[]` | `role: system / developer` |
   | Anthropic `/v1/messages` | `messages[]` | 顶层 `system` |
   | OpenAI `/v1/responses` | `input`（字符串或数组） | `instructions` |
   | Gemini `contents` | `contents[]` | `systemInstruction` |
   | 旧版 completions | `prompt` | — |
   | 其它任意结构 | 递归摊平所有字符串 | — |

2. **逐条摘要**：`sha256(稳定序列化)` 取前 16 位。序列化时**忽略噪声键**
   （`id / index / created / timestamp / user / model / stream / temperature / metadata /
   cache_control` 等），因此客户端给消息换 id、挪 cache_control 标记都不会改变身份。

3. **匹配**已有会话：允许请求侧跳过最多 2 个前导单元、存量侧跳过任意数量（客户端截断历史
   窗口时，存量历史会比请求更“老”）。命中规则：
   - 从头部对齐时共享 ≥ 2 个单元；或
   - 带偏移对齐时共享 ≥ 3 个单元；或
   - 只有 1 个共享单元，但两边互为前缀扩展（这就是常见的“第 1 轮 → 第 2 轮”）。

4. **特殊处理**
   - `system / developer` 文本**不参与匹配**。不少客户端每轮都会改写 system
     （塞入当前日期、时间戳、“会话开始”之类），参与匹配就会每轮都换 id。
   - 命中后把会话的消息序列更新为更长的那一版，所以历史会越记越长。
   - 无法归因的请求（body 不是 JSON、没有对话内容、超过解析上限）使用**一次性随机 id**，
     绝不让无关会话共用一个值。
   - 无 body 的请求（如 `GET /v1/models`）使用本进程的静态 id。
   - 客户端自带的 `x-opencode-session` / `x-session-id` 默认会被**覆盖**（静态配置值不能
     代表真实会话）；确实需要透传时加 `--trust-client-session`。

会话表只存摘要、不存任何对话内容，默认留在内存中，闲置 24 小时或超过 2000 个会话后淘汰。

---

## 通用性设计

- **路径归一化**：`/chat/completions` → `/v1/chat/completions`；客户端把 `/v1` 拼重了
  （`/v1/v1/chat/completions`）也会自动折叠。URL 其余部分与查询串原样透传。
- **完全透明**：请求体、状态码、响应头、错误体原样转发；响应**逐块流式**转发（SSE 不会被
  缓冲），压缩编码原样保留（不使用会自动解压的 fetch，而是 `node:https` 直连）。
- **请求头**：剥掉 hop-by-hop（`connection / keep-alive / transfer-encoding / upgrade /
  expect / te / trailer / proxy-*`，以及 `Connection` 里点名的字段），`Host` 改写为上游主机，
  `Content-Length` 重算；客户端 key（`Authorization: Bearer ...` 或 `x-api-key`）原样透传。
- **User-Agent**：如果客户端只报了个库名（`axios / undici / python-httpx / curl / okhttp /
  openai-python / Go-http-client ...`），替换为 `ocgo-local-proxy/1.0`（Go 要求客户端自报身份
  而不是库名）；真实客户端 UA（如 `CherryStudio/1.2`、`AstrBot/4.0`）原样保留。
- **CORS 默认开启**，`OPTIONS` 预检在本地直接应答（不转发），方便浏览器类前端。
- **不持有密钥**：客户端自己填 key，代理只是管道。

---

## 参数

| 参数 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--port` | `OCGO_PORT` | `8787` | 监听端口 |
| `--host` | `OCGO_HOST` | `127.0.0.1` | 监听地址（默认只允许本机） |
| `--upstream` | `OCGO_UPSTREAM` | `https://opencode.ai/zen/go` | 网关地址（可改成 Zen 或自建） |
| `--trust-client-session` | `OCGO_TRUST_CLIENT_SESSION` | 关 | 透传客户端自带的会话头，不做推导 |
| `--no-extra-session-header` | — | 关 | 不再附带 `x-session-id` |
| `--session-ttl-hours` | — | `24` | 会话闲置多久后遗忘 |
| `--max-sessions` | — | `2000` | 最多记住多少个会话 |
| `--state` | `OCGO_STATE` | 关 | 把会话表（只有摘要）持久化到文件，重启后可续用 |
| `--max-body-mb` | — | `64` | 超过此大小的 body 不解析（改用一次性 id） |
| `--hard-max-body-mb` | — | `512` | 超过此大小的请求直接 413 |
| `--connect-timeout-ms` | — | `20000` | 连接上游超时；响应阶段不设空闲超时，长流不受影响 |
| `--log` | `OCGO_LOG` | 关 | 额外把请求日志追加到文件 |
| `--cors` / `--no-cors` | `OCGO_CORS` | 开 | CORS 处理 |
| `--agent` | `OCGO_AGENT` | `ocgo-local-proxy/1.0` | 需要替客户端上报的 UA |
| `--quiet` | — | 关 | 不打印逐请求日志 |
| `--help` | — | — | 帮助 |

---

## 诊断端点（不会转发到上游）

| 端点 | 内容 |
| --- | --- |
| `GET /_proxy/health` | 存活、上游地址、会话数 |
| `GET /_proxy/stats` | 请求数、按来源统计（new/matched/static/ephemeral）、状态码分布、最近 20 条日志 |
| `GET /_proxy/sessions` | 最近的会话（只有 id、消息数、命中次数、最后活跃时间，**不含内容**） |
| `GET /_proxy/help` | 帮助文本 |

---

## 测试与验证

```bash
npm test          # 29 个用例：会话推导 + 代理端到端（本地 mock 上游，不外呼）
```

覆盖：同会话跨轮同 id / 不同会话不同 id / system 每轮变化 / 历史窗口截断 / 分叉会话分离 /
四种 API 形状 / 未知结构兜底 / TTL 与容量淘汰 / 状态持久化 / 头覆盖 / 路径归一化 /
hop-by-hop 剥离 / UA 替换 / 上游错误透传 / **SSE 首块不被缓冲** / 413 / CORS 预检 / 诊断端点。

真机验证（需要你自己的 Go key，会产生极少量 token）：

```bash
node verify-live.mjs --key <你的_GO_KEY> --model kimi-k2.6
```

它会先直连网关（不带会话头）复现 `MissingSessionID`，再经代理发“同一会话的两轮 + 另一个会话”，
并打印每一轮用到的 session id 与 usage（含 `cached` 字段，便于确认 prompt cache 生效）。

> 注意：用**无效 key** 做探测时，网关会先返回 `AuthError: Invalid API key.`，看不到
> `MissingSessionID`，因此“头部是否被接受”只能用一个有效 key 来最终确认。

---

## 已知限制

- **客户端每轮只发最新一条消息**（不带历史）时无法跨轮配对，日志会显示 `(new)`。
  这是信息论上的限制——请把客户端设置为携带历史（Cherry Studio、AstrBot 默认如此）。
- **两个会话以完全相同的开头**会被视为同一会话（对 prompt cache 无影响，因为缓存本身按内容匹配）。
  需要严格隔离时用 `--trust-client-session`，让客户端自己发会话头。
- 会话表默认在内存里：重启后第一个请求会新建会话（可用 `--state` 持久化）。
- 端口默认只绑定 `127.0.0.1`，不要随意改成 `0.0.0.0`。
- OpenCode Go 的定位是编码 agent，且会监测滥用流量。本代理只做文档要求的事：补会话头、
  如实自报 `ocgo-local-proxy/1.0`，不伪造 OpenCode 特征；使用风险由使用者自行判断。若网关
  对 UA 另有要求，可用 `--agent` 调整。

---

## English quick reference

Zero-dependency local reverse proxy for OpenCode Go. It derives a per-conversation
session id from each request body and stamps `x-opencode-session`, so any
OpenAI/Anthropic-compatible client works by pointing at `http://127.0.0.1:8787/v1`
(Anthropic clients: `http://127.0.0.1:8787`) and using its own API key. The proxy
stores no credentials, forwards everything transparently (including SSE), and only
overrides the session headers. Run `node proxy.mjs`, test with `npm test`, verify
with `node verify-live.mjs --key <KEY>`. See the tables above for flags, client
setups and diagnostics.

## 文件

| 文件 | 作用 |
| --- | --- |
| `proxy.mjs` | 反向代理：监听、头改写、流式转发、日志、诊断端点 |
| `session.mjs` | 会话身份：body 抽取、摘要、匹配、淘汰、持久化 |
| `test/session.test.mjs`、`test/proxy.test.mjs` | 单元与端到端测试（`node:test`，零依赖） |
| `verify-live.mjs` | 用真实 key 验证网关不再报 `MissingSessionID` |
| `start.cmd` / `start.sh` | 启动脚本 |

---

## 许可

[MIT](LICENSE) © 2026 Phi-2X

