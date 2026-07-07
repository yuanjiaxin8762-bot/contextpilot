import { createOpenCodeBridge, isAbortError } from '../lib/opencode-bridge/index.js'

const OPENCODE_DEFAULT_BASE_URL = 'http://127.0.0.1:4096'
const OPENCODE_DEFAULT_PROVIDER_ID = 'opencode'
const OPENCODE_DEFAULT_MODEL_ID = 'deepseek-v4-flash-free'
const OPENCODE_DEFAULT_DIRECTORY = 'C:\\Users\\LYin\\Projects\\contextpilot'
const OPENAI_COMPATIBLE_DEFAULT_PATH = '/chat/completions'
const OPENCODE_CHAT_SYSTEM_PROMPT =
  '你是 ContextPilot 聊天区的普通对话助手。禁止调用工具、禁止读取或修改文件、禁止创建子任务。只用文本直接回答用户问题。'
const OPENCODE_CHAT_DISABLED_TOOLS = [
  'task',
  'todowrite',
  'edit',
  'bash',
  'read',
  'grep',
  'glob',
  'lsp',
  'webfetch',
  'websearch',
  'skill',
  'question',
  'plan_enter',
  'plan_exit',
  'external_directory',
]

const env = import.meta.env
const backend = (env.VITE_CHAT_BACKEND || 'opencode').toLowerCase()
const opencodeSessions = new Map()

export const chatModelLabel =
  backend === 'openai-compatible'
    ? `OpenAI Compatible · ${env.VITE_OPENAI_MODEL || 'model'}`
    : `opencode · ${opencodeModelID()}`

// 流式开关：仅 opencode 后端默认开启，可用 VITE_OPENCODE_STREAMING=false 回退到同步路径。
export const chatStreams =
  backend === 'opencode' && (env.VITE_OPENCODE_STREAMING ?? 'true') !== 'false'

export { isAbortError }

// 模块级单例 client，懒加载（首次发送时才读 env，与现有 lazy 风格一致）。
let bridgeClient
function getBridgeClient() {
  if (!bridgeClient) {
    bridgeClient = createOpenCodeBridge({
      baseUrl: trimTrailingSlash(env.VITE_OPENCODE_BASE_URL || OPENCODE_DEFAULT_BASE_URL),
      username: env.VITE_OPENCODE_USERNAME || 'opencode',
      password: env.VITE_OPENCODE_PASSWORD,
      directory: env.VITE_OPENCODE_DIRECTORY || OPENCODE_DEFAULT_DIRECTORY,
    })
  }
  return bridgeClient
}

// 流式版发送：复用同步路径的 session 缓存、首轮上下文注入、禁工具 guard、provider/model 配置。
// onDelta(delta, fullText) 由底层 runPrompt 在每个文本增量时回调；fullText 是已拼接的完整文本。
export async function sendChatMessageStream({ sessionId, title, messages, signal, onDelta, onReasoning }) {
  if (backend === 'openai-compatible') {
    // 该后端 v1 不支持流式：走同步接口，再整体回调一次。
    const text = await sendOpenAICompatibleMessage({ messages, signal })
    if (onDelta) onDelta(text, text)
    return { text, sessionID: null }
  }

  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user')
  if (!latestUserMessage?.text?.trim()) {
    throw new Error('没有可发送的用户消息。')
  }

  // 复用同步路径的 session 缓存（按 client session id 映射到 opencode session id）。
  const session = await ensureOpencodeSession(sessionId, title, signal)
  const promptText = session.isNew ? buildSeededPrompt(messages, latestUserMessage.text) : latestUserMessage.text
  const guard = opencodeChatPromptGuardPayload()
  const directory = env.VITE_OPENCODE_DIRECTORY || OPENCODE_DEFAULT_DIRECTORY

  const client = getBridgeClient()

  // 内部 abort：监听到模型重试耗尽时主动终止，避免干等满 120s 超时。
  // 外部 signal（用户停止）转发到 innerAbort，统一由 runPrompt 的 signal 处理。
  const innerAbort = new AbortController()
  const onExternalAbort = () => innerAbort.abort()
  if (signal) {
    if (signal.aborted) innerAbort.abort()
    else signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  // 收集模型重试信息（session.status: retry），失败时给出真实网关原因，而非笼统“超时”。
  let lastRetry = null
  const MAX_RETRY = 4
  const handleUpdate = (update) => {
    if (update?.type === 'status' && update.status?.type === 'retry') {
      lastRetry = update.status
      if (update.status.attempt >= MAX_RETRY) {
        // 重试次数过多，主动终止——比等满 120s 超时快得多（约 30s 出结果）。
        innerAbort.abort()
      }
    }
  }

  try {
    const result = await client.runPrompt({
      sessionID: session.id,
      directory,
      prompt: promptText,
      model: {
        providerID: opencodeProviderID(),
        modelID: opencodeModelID(),
      },
      ...(env.VITE_OPENCODE_AGENT ? { agent: env.VITE_OPENCODE_AGENT } : {}),
      ...(env.VITE_OPENCODE_MODEL_VARIANT ? { variant: env.VITE_OPENCODE_MODEL_VARIANT } : {}),
      ...(guard.system ? { system: guard.system } : {}),
      ...(guard.tools ? { tools: guard.tools } : {}),
      timeoutMs: 120000,
      signal: innerAbort.signal,
      onUpdate: handleUpdate,
      ...(onDelta ? { onDelta: (delta, fullText) => onDelta(delta, fullText) } : {}),
      ...(onReasoning ? { onReasoning: (reasoningText) => onReasoning(reasoningText) } : {}),
    })
    return { text: result.text, reasoning: result.reasoning, sessionID: result.sessionID }
  } catch (error) {
    console.error(error)
    const userAborted = Boolean(signal?.aborted)
    // 用户主动停止：原样抛，UI 静默处理（保留已流式文本）。
    if (userAborted && !/timed out/i.test(error.message)) {
      throw error
    }
    if (isAbortError(error) || error?.name === 'AbortError') {
      // 重试耗尽（innerAbort）或超时：若有 retry 信息，给出真实网关原因。
      if (lastRetry) {
        throw new Error(
          `模型调用失败：${lastRetry.message}（已重试 ${lastRetry.attempt} 次仍失败）。建议换个模型或稍后重试。`,
        )
      }
      throw new Error('模型生成超时（120 秒未完成），请稍后重试或换个模型。')
    }
    if (isNetworkError(error) || error?.name === 'OpenCodeSseError') {
      throw new Error(
        `无法连接 opencode 服务。请先启动 opencode headless server（默认地址 ${
          env.VITE_OPENCODE_BASE_URL || OPENCODE_DEFAULT_BASE_URL
        }），或设置 VITE_OPENCODE_BASE_URL 指向你的服务。`,
      )
    }
    throw error
  } finally {
    if (signal) signal.removeEventListener('abort', onExternalAbort)
  }
}

// 启动时从 opencode 加载真实历史会话（仅当前项目 directory）。
// 返回 UI session 数组；失败或为空返回 null，由调用方回退 mock。
export async function loadHistory() {
  if (backend !== 'opencode') return null
  const directory = env.VITE_OPENCODE_DIRECTORY || OPENCODE_DEFAULT_DIRECTORY
  const client = getBridgeClient()
  try {
    const list = await client.listSessions({ directory })
    if (!Array.isArray(list) || list.length === 0) return null

    const result = []
    for (const oc of list) {
      // 预填 session 缓存：历史会话续聊时 ensureOpencodeSession 直接命中，复用 opencode session。
      opencodeSessions.set(oc.id, { id: oc.id })

      let messages = []
      try {
        const withParts = await client.messages({ sessionID: oc.id, directory })
        if (Array.isArray(withParts)) messages = withParts.map(toUIMessage).filter(Boolean)
      } catch {
        // 单个会话消息加载失败则保留空消息列表，不中断整体加载。
      }

      const firstUser = messages.find((m) => m.role === 'user')
      result.push({
        id: oc.id,
        title: oc.title || '未命名对话',
        time: formatRelative(oc.time?.updated || oc.time?.created),
        summary: firstUser?.text || oc.title || '等待模型回复',
        status: '进行中',
        tone: 'progress',
        isDraft: false,
        messages,
        contextCards: [],
      })
    }
    return result
  } catch (error) {
    console.warn('[chatAdapter] loadHistory 失败，回退 mock：', error?.message || error)
    return null
  }
}

// 删除后端会话（opencode.db）。成功返回 true 并清本地 session 缓存；失败返回 false（不抛）。
export async function deleteRemoteSession(sessionId, signal) {
  if (backend !== 'opencode') return false
  const directory = env.VITE_OPENCODE_DIRECTORY || OPENCODE_DEFAULT_DIRECTORY
  const client = getBridgeClient()
  try {
    await client.removeSession({ sessionID: sessionId, directory }, signal)
    opencodeSessions.delete(sessionId)
    return true
  } catch (error) {
    console.warn('[chatAdapter] deleteRemoteSession 失败：', error?.message || error)
    return false
  }
}

// opencode WithParts → UI message：text/reasoning 分别从 parts 提取拼接。
function toUIMessage(withParts) {
  if (!withParts || typeof withParts !== 'object') return null
  const info = withParts.info || {}
  const parts = Array.isArray(withParts.parts) ? withParts.parts : []
  const text = parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
  const reasoning = parts
    .filter((p) => p && p.type === 'reasoning' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
  return {
    id: info.id,
    role: info.role === 'user' ? 'user' : 'assistant',
    time: formatClock(info.time?.created),
    text,
    ...(reasoning ? { reasoning } : {}),
  }
}

// 毫秒时间戳 → 相对时间（与 mock「2 分钟前」风格一致）。
function formatRelative(ts) {
  if (!ts || typeof ts !== 'number') return '未知'
  const diff = Date.now() - ts
  if (diff < 0) return '刚刚'
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day === 1) return '昨天'
  if (day < 7) return `${day} 天前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}-${d.getDate()}`
}

// 毫秒时间戳 → HH:mm。
function formatClock(ts) {
  if (!ts || typeof ts !== 'number') return ''
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

export async function sendChatMessage({ sessionId, title, messages, signal }) {
  if (backend === 'openai-compatible') {
    return sendOpenAICompatibleMessage({ messages, signal })
  }

  return sendOpencodeMessage({ sessionId, title, messages, signal })
}

async function sendOpencodeMessage({ sessionId, title, messages, signal }) {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user')
  if (!latestUserMessage?.text?.trim()) {
    throw new Error('没有可发送的用户消息。')
  }

  const session = await ensureOpencodeSession(sessionId, title, signal)
  const promptText = session.isNew ? buildSeededPrompt(messages, latestUserMessage.text) : latestUserMessage.text
  const response = await requestOpencode(withOpencodeDirectory(`/session/${encodeURIComponent(session.id)}/message`), {
    method: 'POST',
    body: buildOpencodePromptPayload(promptText),
    signal,
  })
  return extractOpencodeAssistantText(response)
}

async function ensureOpencodeSession(clientSessionId, title, signal) {
  const cacheKey = clientSessionId || 'default'
  const cached = opencodeSessions.get(cacheKey)
  if (cached) return { ...cached, isNew: false }

  const response = await requestOpencode(withOpencodeDirectory('/session'), {
    method: 'POST',
    body: buildOpencodeSessionPayload(title),
    signal,
  })
  const id = response?.id
  if (!id) throw new Error(`opencode 未返回会话 ID：${title || cacheKey}`)

  const session = { id }
  opencodeSessions.set(cacheKey, session)
  return { ...session, isNew: true }
}

function buildOpencodeSessionPayload(title) {
  return {
    ...(title ? { title } : {}),
    ...(env.VITE_OPENCODE_AGENT ? { agent: env.VITE_OPENCODE_AGENT } : {}),
    ...opencodeChatPermissionPayload(),
    model: {
      providerID: opencodeProviderID(),
      id: opencodeModelID(),
      ...(env.VITE_OPENCODE_MODEL_VARIANT ? { variant: env.VITE_OPENCODE_MODEL_VARIANT } : {}),
    },
  }
}

function buildOpencodePromptPayload(text) {
  return {
    ...(env.VITE_OPENCODE_AGENT ? { agent: env.VITE_OPENCODE_AGENT } : {}),
    ...(env.VITE_OPENCODE_MODEL_VARIANT ? { variant: env.VITE_OPENCODE_MODEL_VARIANT } : {}),
    ...opencodeChatPromptGuardPayload(),
    model: {
      providerID: opencodeProviderID(),
      modelID: opencodeModelID(),
    },
    parts: [{ type: 'text', text }],
  }
}

function buildSeededPrompt(messages, latestUserText) {
  const latestUserIndex = messages.findLastIndex((message) => message.role === 'user')
  const priorMessages = normalizeMessages(messages.slice(0, latestUserIndex)).slice(-8)
  if (priorMessages.length === 0) return latestUserText

  const transcript = priorMessages
    .map((message) => `${message.role === 'user' ? '用户' : 'AI'}：${message.content}`)
    .join('\n')

  return `以下是 ContextPilot 聊天区已有上下文，请在此基础上继续回答。\n\n${transcript}\n\n本轮用户问题：${latestUserText}`
}

async function requestOpencode(path, options = {}) {
  const baseURL = trimTrailingSlash(env.VITE_OPENCODE_BASE_URL || OPENCODE_DEFAULT_BASE_URL)
  const headers = {
    ...jsonHeaders(options.body),
    ...basicAuthHeader(env.VITE_OPENCODE_USERNAME || 'opencode', env.VITE_OPENCODE_PASSWORD),
  }

  try {
    return await requestJson(`${baseURL}${path}`, { ...options, headers })
  } catch (error) {
    if (isNetworkError(error)) {
      throw new Error(
        `无法连接 opencode 服务。请先启动 opencode headless server（默认地址 ${baseURL}），或设置 VITE_OPENCODE_BASE_URL 指向你的服务。`,
      )
    }
    throw error
  }
}

async function sendOpenAICompatibleMessage({ messages, signal }) {
  const baseURL = env.VITE_OPENAI_BASE_URL
  if (!baseURL) {
    throw new Error('缺少 VITE_OPENAI_BASE_URL，无法调用 OpenAI-compatible 模型接口。')
  }

  const url = `${trimTrailingSlash(baseURL)}${normalizePath(env.VITE_OPENAI_CHAT_PATH || OPENAI_COMPATIBLE_DEFAULT_PATH)}`
  const payload = {
    model: env.VITE_OPENAI_MODEL || 'default',
    messages: [
      {
        role: 'system',
        content: '你是 ContextPilot 的聊天助手。优先使用当前会话上下文，回答要直接、清晰、可执行。',
      },
      ...normalizeMessages(messages),
    ],
    temperature: Number(env.VITE_OPENAI_TEMPERATURE || 0.4),
    stream: false,
  }

  const response = await requestJson(url, {
    method: 'POST',
    body: payload,
    headers: {
      ...jsonHeaders(payload),
      ...(env.VITE_OPENAI_API_KEY ? { Authorization: `Bearer ${env.VITE_OPENAI_API_KEY}` } : {}),
    },
    signal,
  })

  return extractOpenAICompatibleAssistantText(response)
}

function normalizeMessages(messages) {
  return messages
    .filter(
      (message) =>
        ['user', 'assistant'].includes(message.role) && message.text && !message.pending && !message.error,
    )
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.text,
    }))
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: options.headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  })

  if (response.status === 204) return undefined

  const text = await response.text()
  const data = text ? parseJson(text) : undefined
  if (!response.ok) {
    throw new Error(formatRequestError(response, data, text))
  }

  return data
}

function extractOpencodeAssistantText(response, options = {}) {
  const assistant = Array.isArray(response)
    ? [...response].reverse().find((message) => message?.info?.role === 'assistant' || message?.type === 'assistant')
    : response
  if (!assistant) {
    if (options.allowIncomplete) return ''
    throw new Error('opencode 没有返回 assistant 消息。')
  }
  if (assistant.info?.error?.message) throw new Error(assistant.info.error.message)
  if (assistant.error?.message) throw new Error(assistant.error.message)

  const text = (assistant.parts || assistant.content || [])
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n\n')

  if (!text && options.allowIncomplete) return ''
  if (!text) throw new Error('opencode 返回了消息，但没有文本内容。')
  return text
}

function extractOpenAICompatibleAssistantText(response) {
  const content = response?.choices?.[0]?.message?.content
  if (typeof content === 'string' && content.trim()) return content.trim()
  if (Array.isArray(content)) {
    const text = content
      .map((part) => part.text || part.content || '')
      .filter(Boolean)
      .join('\n')
      .trim()
    if (text) return text
  }

  throw new Error('模型接口没有返回可显示的文本。')
}

function formatRequestError(response, data, text) {
  const message =
    data?.error?.message || data?.message || data?.data?.message || text || `${response.status} ${response.statusText}`
  return `模型请求失败：${message}`
}

function jsonHeaders(body) {
  return body === undefined
    ? { Accept: 'application/json' }
    : { Accept: 'application/json', 'Content-Type': 'application/json' }
}

function basicAuthHeader(username, password) {
  if (!password) return {}
  return { Authorization: `Basic ${btoa(`${username}:${password}`)}` }
}

function opencodeChatPromptGuardPayload() {
  if (env.VITE_OPENCODE_CHAT_ENABLE_TOOLS === 'true') return {}
  return {
    system: env.VITE_OPENCODE_SYSTEM_PROMPT || OPENCODE_CHAT_SYSTEM_PROMPT,
    tools: Object.fromEntries(OPENCODE_CHAT_DISABLED_TOOLS.map((tool) => [tool, false])),
  }
}

function opencodeChatPermissionPayload() {
  if (env.VITE_OPENCODE_CHAT_ENABLE_TOOLS === 'true') return {}
  return {
    permission: OPENCODE_CHAT_DISABLED_TOOLS.map((permission) => ({
      permission,
      pattern: '*',
      action: 'deny',
    })),
  }
}

function withOpencodeDirectory(path) {
  const directory = env.VITE_OPENCODE_DIRECTORY || OPENCODE_DEFAULT_DIRECTORY
  if (!directory) return path

  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}directory=${encodeURIComponent(directory)}`
}

function opencodeProviderID() {
  return env.VITE_OPENCODE_PROVIDER_ID || OPENCODE_DEFAULT_PROVIDER_ID
}

function opencodeModelID() {
  return env.VITE_OPENCODE_MODEL_ID || env.VITE_OPENCODE_MODEL || OPENCODE_DEFAULT_MODEL_ID
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}

function normalizePath(value) {
  return value.startsWith('/') ? value : `/${value}`
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isNetworkError(error) {
  return error instanceof TypeError && /fetch|network|failed/i.test(error.message)
}
