// OpenCode HTTP 客户端：封装 session 创建、prompt_async、同步 message、消息列表、/global/event。
// 由 opencode-bridge/client.ts 翻译为纯 JS，行为与 TS 版逐行等价。

import { isAbortError, streamSseJson } from './sse.js'

export class OpenCodeHttpError extends Error {
  constructor(message, status, body) {
    super(message)
    this.name = 'OpenCodeHttpError'
    this.status = status
    this.body = body
  }
}

function trimRightSlash(value) {
  return value.replace(/\/+$/, '')
}

function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let output = ''

  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)

    output += alphabet[(triple >> 18) & 63]
    output += alphabet[(triple >> 12) & 63]
    output += b === undefined ? '=' : alphabet[(triple >> 6) & 63]
    output += c === undefined ? '=' : alphabet[triple & 63]
  }

  return output
}

function mergeSignals(signals) {
  const active = signals.filter((signal) => !!signal)
  if (active.length === 0) return
  if (active.length === 1) return active[0]

  const controller = new AbortController()
  const abort = () => controller.abort()

  for (const signal of active) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', abort, { once: true })
  }

  return controller.signal
}

function eventSessionID(event) {
  const properties = event.properties
  if (!properties || typeof properties !== 'object') return

  if ('sessionID' in properties && typeof properties.sessionID === 'string') {
    return properties.sessionID
  }

  if (
    event.type === 'message.part.updated' &&
    'part' in properties &&
    properties.part &&
    typeof properties.part === 'object' &&
    'sessionID' in properties.part &&
    typeof properties.part.sessionID === 'string'
  ) {
    return properties.part.sessionID
  }

  if (
    event.type === 'message.updated' &&
    'info' in properties &&
    properties.info &&
    typeof properties.info === 'object' &&
    'sessionID' in properties.info &&
    typeof properties.info.sessionID === 'string'
  ) {
    return properties.info.sessionID
  }
}

function isDirectoryMatch(event, directory) {
  if (!directory) return true
  if (!event.directory) return true
  return event.directory === directory
}

function promptParts(input) {
  if (input.parts?.length) return input.parts
  if (input.prompt !== undefined) return [{ type: 'text', text: input.prompt }]
  throw new Error('runPrompt requires either prompt or parts')
}

function errorToMessage(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export class OpenCodeBridgeClient {
  constructor(config) {
    this.config = config
    this.baseUrl = trimRightSlash(config.baseUrl)
    // 浏览器原生 fetch 是 window 的方法，赋值给属性后通过 this.fetchFn() 调用会丢失 window
    // 上下文（this 变成 client 实例），触发 "Illegal invocation"。绑定到 globalThis 修复。
    // 若调用方传了自定义 fetch（已 bind 或箭头函数），保持原样。
    this.fetchFn = config.fetch ?? fetch.bind(globalThis)
    this.defaultHeaders = new Headers(config.headers)

    if (config.password) {
      const username = config.username ?? 'opencode'
      this.defaultHeaders.set('Authorization', `Basic ${encodeBase64(`${username}:${config.password}`)}`)
    }
  }

  makeUrl(path, query) {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\/+/, '')}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue
      url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  workspaceQuery(input) {
    return {
      directory: input?.directory ?? this.config.directory,
      workspace: input?.workspace ?? this.config.workspace,
    }
  }

  async request(method, path, input) {
    const headers = new Headers(this.defaultHeaders)
    const extraHeaders = new Headers(input?.headers)
    extraHeaders.forEach((value, key) => headers.set(key, value))

    let body
    if (input?.body !== undefined) {
      headers.set('Content-Type', 'application/json')
      body = JSON.stringify(input.body)
    }

    const response = await this.fetchFn(this.makeUrl(path, input?.query), {
      method,
      headers,
      body,
      signal: input?.signal,
    })

    if (response.status === 204) return undefined

    const text = await response.text()
    if (!response.ok) {
      throw new OpenCodeHttpError(
        `OpenCode request failed: ${response.status} ${response.statusText}`,
        response.status,
        text,
      )
    }

    if (!text) return undefined

    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  health(signal) {
    return this.request('GET', '/global/health', { signal })
  }

  listSessions(input = {}, signal) {
    return this.request('GET', '/session', {
      query: {
        ...this.workspaceQuery(input),
        limit: input.limit,
        before: input.before,
      },
      signal,
    })
  }

  removeSession(input, signal) {
    return this.request('DELETE', `/session/${encodeURIComponent(input.sessionID)}`, {
      query: this.workspaceQuery(input),
      signal,
    })
  }

  createSession(input = {}, signal) {
    const { directory, workspace, ...body } = input
    return this.request('POST', '/session', {
      query: this.workspaceQuery({ directory, workspace }),
      body,
      signal,
    })
  }

  promptAsync(input, signal) {
    const { sessionID, directory, workspace, ...body } = input
    return this.request('POST', `/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      query: this.workspaceQuery({ directory, workspace }),
      body,
      signal,
    })
  }

  prompt(input, signal) {
    const { sessionID, directory, workspace, ...body } = input
    return this.request('POST', `/session/${encodeURIComponent(sessionID)}/message`, {
      query: this.workspaceQuery({ directory, workspace }),
      body,
      signal,
    })
  }

  messages(input, signal) {
    return this.request('GET', `/session/${encodeURIComponent(input.sessionID)}/message`, {
      query: {
        ...this.workspaceQuery(input),
        limit: input.limit,
        before: input.before,
      },
      signal,
    })
  }

  globalEvents(options = {}) {
    return streamSseJson({
      url: this.makeUrl('/global/event'),
      fetchFn: this.fetchFn,
      headers: this.defaultHeaders,
      signal: options.signal,
      reconnect: options.reconnect ?? true,
      retryDelayMs: options.retryDelayMs,
      maxRetryDelayMs: options.maxRetryDelayMs,
      onSseError: options.onSseError,
    })
  }

  async runPrompt(input) {
    const localAbort = new AbortController()
    const timeout = input.timeoutMs
      ? setTimeout(
          () => localAbort.abort(new DOMException('OpenCode prompt timed out', 'AbortError')),
          input.timeoutMs,
        )
      : undefined
    const signal = mergeSignals([input.signal, localAbort.signal])
    const directory = input.directory ?? this.config.directory
    const workspace = input.workspace ?? this.config.workspace

    let targetSessionID = input.sessionID
    let promptSubmitted = false
    let settled = false
    const partText = new Map()
    const partOrder = []
    const reasoningText = new Map()
    const reasoningOrder = []
    // partID → part.type：从 message.part.updated 收集。用于把 field='text' 的 delta
    // 正确分流到正文或思考（text 和 reasoning 的内容字段都叫 text，field 都是 'text'）。
    const partType = new Map()
    // messageID → role：用于跳过回放的用户消息 part（只取 assistant 输出）。
    const messageRole = new Map()
    const messageIDs = new Set()
    const events = []

    const text = () => partOrder.map((partID) => partText.get(partID) ?? '').join('')
    const reasoning = () => reasoningOrder.map((partID) => reasoningText.get(partID) ?? '').join('')
    const rememberPart = (partID) => {
      if (!partOrder.includes(partID)) partOrder.push(partID)
    }
    const rememberReasoning = (partID) => {
      if (!reasoningOrder.includes(partID)) reasoningOrder.push(partID)
    }
    const emit = (update) => {
      input.onUpdate?.(update)
      if (update.type === 'delta') input.onDelta?.(update.delta, update.text, update.event)
      if (update.type === 'reasoning' || update.type === 'reasoning.delta') {
        input.onReasoning?.(update.text, update.event)
      }
    }

    let resolveConnected
    let rejectConnected
    const connected = new Promise((resolve, reject) => {
      resolveConnected = resolve
      rejectConnected = reject
    })

    let resolveDone
    let rejectDone
    const done = new Promise((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })

    const listener = (async () => {
      try {
        for await (const event of this.globalEvents({ signal, reconnect: false })) {
          input.onEvent?.(event)

          if (event.payload.type === 'server.connected') {
            resolveConnected()
            emit({ type: 'connected', event })
            continue
          }

          if (!isDirectoryMatch(event, directory)) continue

          const payload = event.payload
          const sessionID = eventSessionID(payload)
          if (targetSessionID && sessionID && sessionID !== targetSessionID) continue
          if (targetSessionID && !sessionID) continue

          events.push(event)

          if (payload.type === 'message.updated') {
            const info = payload.properties.info
            messageIDs.add(info.id)
            if (info.role) messageRole.set(info.id, info.role)
            continue
          }

          if (payload.type === 'message.part.updated') {
            const part = payload.properties.part
            // 跳过回放的用户消息 part，只累积 assistant 输出。
            if (messageRole.get(part.messageID) === 'user') continue
            messageIDs.add(part.messageID)
            partType.set(part.id, part.type)
            if (part.type === 'text' && typeof part.text === 'string') {
              rememberPart(part.id)
              partText.set(part.id, part.text)
              emit({
                type: 'part',
                text: text(),
                sessionID: targetSessionID ?? part.sessionID ?? '',
                messageID: part.messageID,
                partID: part.id,
                event,
              })
            } else if (part.type === 'reasoning' && typeof part.text === 'string') {
              rememberReasoning(part.id)
              reasoningText.set(part.id, part.text)
              emit({
                type: 'reasoning',
                text: reasoning(),
                sessionID: targetSessionID ?? part.sessionID ?? '',
                messageID: part.messageID,
                partID: part.id,
                event,
              })
            }
            continue
          }

          if (payload.type === 'message.part.delta') {
            if (payload.properties.field !== 'text') continue
            // 跳过回放的用户消息 delta，只累积 assistant 输出。
            if (messageRole.get(payload.properties.messageID) === 'user') continue
            messageIDs.add(payload.properties.messageID)
            // 按 partID 关联的 partType 区分正文与思考增量（两者 field 都是 'text'）。
            if (partType.get(payload.properties.partID) === 'reasoning') {
              rememberReasoning(payload.properties.partID)
              reasoningText.set(
                payload.properties.partID,
                (reasoningText.get(payload.properties.partID) ?? '') + payload.properties.delta,
              )
              emit({
                type: 'reasoning.delta',
                delta: payload.properties.delta,
                text: reasoning(),
                sessionID: payload.properties.sessionID,
                messageID: payload.properties.messageID,
                partID: payload.properties.partID,
                event,
              })
            } else {
              rememberPart(payload.properties.partID)
              partText.set(
                payload.properties.partID,
                (partText.get(payload.properties.partID) ?? '') + payload.properties.delta,
              )
              emit({
                type: 'delta',
                delta: payload.properties.delta,
                text: text(),
                sessionID: payload.properties.sessionID,
                messageID: payload.properties.messageID,
                partID: payload.properties.partID,
                event,
              })
            }
            continue
          }

          if (payload.type === 'session.status') {
            emit({
              type: 'status',
              sessionID: payload.properties.sessionID,
              status: payload.properties.status,
              event,
            })
            if (promptSubmitted && payload.properties.status.type === 'idle') {
              settled = true
              resolveDone()
              return
            }
            continue
          }

          if (payload.type === 'session.error') {
            emit({
              type: 'error',
              sessionID: payload.properties.sessionID,
              error: payload.properties.error,
              event,
            })
            settled = true
            rejectDone(new Error(errorToMessage(payload.properties.error)))
            return
          }
        }
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) {
          if (!settled) rejectDone(error)
          return
        }
        rejectConnected(error)
        rejectDone(error)
      }
    })()

    try {
      await connected

      if (!targetSessionID) {
        const session = await this.createSession({ directory, workspace }, signal)
        targetSessionID = session.id
      }

      promptSubmitted = true
      await this.promptAsync(
        {
          sessionID: targetSessionID,
          directory,
          workspace,
          messageID: input.messageID,
          model: input.model,
          agent: input.agent,
          noReply: input.noReply,
          tools: input.tools,
          format: input.format,
          system: input.system,
          variant: input.variant,
          parts: promptParts(input),
        },
        signal,
      )

      await done

      return {
        sessionID: targetSessionID,
        text: text(),
        reasoning: reasoning(),
        partText: Object.fromEntries(partText.entries()),
        reasoningText: Object.fromEntries(reasoningText.entries()),
        messageIDs: [...messageIDs],
        events,
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      localAbort.abort()
      await listener.catch(() => undefined)
    }
  }
}

export function createOpenCodeBridge(config) {
  return new OpenCodeBridgeClient(config)
}
