# OpenCode Bridge

这个目录是一个独立的 TypeScript 拼接模块，用来把 OpenCode 前端的消息发送和接收逻辑接到你的项目里。它没有改动现有业务文件，也没有依赖 `@opencode-ai/sdk`。

## 文件说明

- `types.ts`：OpenCode session、prompt、event 的最小类型定义。
- `sse.ts`：SSE 解析器，逻辑对应 OpenCode SDK 里的 server-sent events 处理。
- `client.ts`：OpenCode HTTP 客户端，封装 session 创建、`prompt_async`、同步 `prompt`、消息列表和 `/global/event`。
- `index.ts`：统一导出。
- `example.ts`：最小调用示例，需要把 `baseUrl` 换成你的 OpenCode server 地址。

## 核心流程

OpenCode 前端不是从 `POST /session/:id/prompt_async` 的响应体拿模型输出。这个接口正常返回 `204 NoContent`。

真正的输出链路是：

1. 连接 `GET /global/event`，保持 SSE 长连接。
2. 创建 session：`POST /session`。
3. 发送消息：`POST /session/:sessionID/prompt_async`。
4. 从 SSE 里接收 `message.part.delta`。
5. 按 `partID` 拼接 `properties.delta`。
6. 收到 `session.status` 且 `status.type === "idle"` 后认为本轮完成。

## 最小使用

```ts
import { createOpenCodeBridge } from "./opencode-bridge"

const client = createOpenCodeBridge({
  baseUrl: "https://your-opencode-server.example.com",
  // 如果 serve 开了密码：
  // password: "your-server-password",
  // username: "opencode",

  // 如果你的云端 OpenCode 需要指定工作目录，填云端机器上的项目目录。
  // 本地 Windows 路径只有在 server 也运行在这台 Windows 上时才有意义。
  // directory: "/workspace/contextpilot",
})

const result = await client.runPrompt({
  prompt: "帮我分析一下当前项目结构",
  timeoutMs: 120_000,
  onDelta(delta, fullText) {
    console.log(delta)
    // fullText 是当前已经拼接出来的完整文本
  },
})

console.log(result.sessionID)
console.log(result.text)
```

## 复用已有 session

```ts
await client.runPrompt({
  sessionID: "ses_xxx",
  prompt: "继续刚才的问题",
  onDelta(delta) {
    console.log(delta)
  },
})
```

## 指定模型

`prompt_async` 的模型参数沿用 OpenCode 源码里的形状：

```ts
await client.runPrompt({
  prompt: "hello",
  model: {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-20250514",
  },
})
```

实际 `providerID` 和 `modelID` 要以你的 OpenCode server 配置为准。不传时由 server 使用默认模型。

## 只监听事件

如果你想自己处理所有事件，可以直接用：

```ts
for await (const event of client.globalEvents()) {
  if (event.payload.type === "message.part.delta") {
    console.log(event.payload.properties.delta)
  }
}
```

`/global/event` 返回的是：

```ts
{
  directory?: string
  payload: {
    type: string
    properties?: unknown
  }
}
```

如果你传了 `directory`，`runPrompt` 会只处理这个目录下的事件。

## 同步接口

如果你不需要前端那样的流式输出，也可以用同步接口：

```ts
const session = await client.createSession()
const message = await client.prompt({
  sessionID: session.id,
  parts: [{ type: "text", text: "直接返回最终 message" }],
})
```

这个对应 `POST /session/:sessionID/message`。它会等模型完成后返回最终 message，但不适合做实时流式 UI。

## 和 OpenCode 源码的对应关系

- 前端提交 prompt：`packages/app/src/components/prompt-input/submit.ts`
- 前端连接 `/global/event`：`packages/app/src/context/server-sdk.tsx`
- 前端拼接 `message.part.delta`：`packages/app/src/context/global-sync/event-reducer.ts`
- 后端 `prompt_async`：`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
- 后端 `/global/event`：`packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts`

## 注意事项

- 如果 OpenCode server 在云端，`directory` 必须是云端 server 能识别的路径；本地 `C:\Users\...` 路径对云端 server 没意义。
- 如果 server 配了密码，这里使用 Basic Auth，默认用户名是 `opencode`。
- `runPrompt` 会先连上 SSE，再发送 prompt，避免漏掉早期 token。
- SSE 是长连接，不会自己结束；本模块用目标 session 的 `session.status: idle` 作为本轮结束信号。
