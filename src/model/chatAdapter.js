import { createOpenCodeBridge, isAbortError } from '../lib/opencode-bridge/index.js'

const OPENCODE_DEFAULT_BASE_URL = 'http://127.0.0.1:4096'
const OPENCODE_DEFAULT_PROVIDER_ID = 'opencode'
const OPENCODE_DEFAULT_MODEL_ID = 'deepseek-v4-flash-free'
const OPENCODE_DEFAULT_DIRECTORY = 'C:\\Users\\LYin\\Projects\\contextpilot'
const OPENAI_COMPATIBLE_DEFAULT_PATH = '/chat/completions'
const OPENCODE_CHAT_SYSTEM_PROMPT =
  '你是 ContextPilot 聊天区的普通对话助手。请遵循当前会话的对话底盘配置，直接、清晰、可执行地回答用户问题。'
const SUPERVISOR_SYSTEM_PROMPT =
  '你是 ContextPilot 的上下文监督助手。你的职责是把主对话按主题总结成结构化上下文卡片，供用户在工作台勾选后注入后续对话。严格按用户指令的 JSON 数组格式输出，不要输出任何解释或多余文字。'
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

const CHAT_CONFIG_DEFAULTS = {
  goal: '',
  stage: '需求澄清',
  rules: ['优先给出可执行结论', '涉及不确定性时说明假设', '改动建议附带验证方式'],
  toolPermissions: {
    readFiles: 'allow',
    runTests: 'allow',
    writeFiles: 'confirm',
    network: 'deny',
  },
  acceptanceCriteria: '',
  projectMemory: '',
}

const CHAT_CONFIG_TOOL_LABELS = {
  readFiles: '读取文件',
  runTests: '运行测试',
  writeFiles: '写入文件',
  network: '联网',
}

const env = import.meta.env
const backend = (env.VITE_CHAT_BACKEND || 'opencode').toLowerCase()
const opencodeSessions = new Map()
// 主对话 sessionID → 监督 sessionID（监督对话独立存在于 opencode，专门做卡片总结）。
const supervisorSessions = new Map()

function normalizeMetadata(metadata) {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
}

export function createDefaultChatConfig() {
  return {
    ...CHAT_CONFIG_DEFAULTS,
    rules: [...CHAT_CONFIG_DEFAULTS.rules],
    toolPermissions: { ...CHAT_CONFIG_DEFAULTS.toolPermissions },
  }
}

export function normalizeChatConfig(config) {
  const input = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const toolPermissions = input.toolPermissions && typeof input.toolPermissions === 'object'
    ? input.toolPermissions
    : {}
  const normalizeText = (value, maxLength) => String(value || '').trim().slice(0, maxLength)
  const normalizePermission = (value, fallback) =>
    ['allow', 'confirm', 'deny'].includes(value) ? value : fallback

  return {
    goal: normalizeText(input.goal, 300),
    stage: normalizeText(input.stage, 80) || CHAT_CONFIG_DEFAULTS.stage,
    rules: [...new Set((Array.isArray(input.rules) ? input.rules : CHAT_CONFIG_DEFAULTS.rules)
      .map((rule) => normalizeText(rule, 80))
      .filter(Boolean))].slice(0, 12),
    toolPermissions: {
      readFiles: normalizePermission(toolPermissions.readFiles, CHAT_CONFIG_DEFAULTS.toolPermissions.readFiles),
      runTests: normalizePermission(toolPermissions.runTests, CHAT_CONFIG_DEFAULTS.toolPermissions.runTests),
      writeFiles: normalizePermission(toolPermissions.writeFiles, CHAT_CONFIG_DEFAULTS.toolPermissions.writeFiles),
      network: normalizePermission(toolPermissions.network, CHAT_CONFIG_DEFAULTS.toolPermissions.network),
    },
    acceptanceCriteria: normalizeText(input.acceptanceCriteria, 500),
    projectMemory: normalizeText(input.projectMemory, 500),
  }
}

function buildMainMetadata(baseMetadata, supervisorSessionId, cards) {
  const metadata = { ...normalizeMetadata(baseMetadata), type: 'main' }
  if (supervisorSessionId) metadata.supervisorSessionId = supervisorSessionId
  if (cards !== undefined) metadata.contextCards = cards || []
  if (metadata.chatConfig !== undefined) metadata.chatConfig = normalizeChatConfig(metadata.chatConfig)
  return metadata
}

function buildSupervisorMetadata(mainSessionId) {
  return { type: 'supervisor', mainSessionId }
}

function rememberOpencodeSession(cacheKey, session) {
  if (!session?.id) return
  opencodeSessions.set(cacheKey || session.id, session)
  opencodeSessions.set(session.id, session)
}

function rememberSupervisorSession(mainSessionId, supervisorId, alias) {
  if (!mainSessionId || !supervisorId) return
  supervisorSessions.set(mainSessionId, supervisorId)
  if (alias && alias !== mainSessionId) supervisorSessions.set(alias, supervisorId)
}

async function updateSessionMetadata(client, directory, sessionID, metadata, signal) {
  return client.updateSession({ sessionID, directory, metadata }, signal)
}

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
export async function sendChatMessageStream({ sessionId, title, messages, signal, onDelta, onReasoning, selectedCards, chatConfig }) {
  if (backend === 'openai-compatible') {
    // 该后端 v1 不支持流式：走同步接口，再整体回调一次。
    const text = await sendOpenAICompatibleMessage({ messages, signal, chatConfig })
    if (onDelta) onDelta(text, text)
    return { text, sessionID: null }
  }

  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user')
  if (!latestUserMessage?.text?.trim()) {
    throw new Error('没有可发送的用户消息。')
  }

  // 复用同步路径的 session 缓存（按 client session id 映射到 opencode session id）。
  const session = await ensureOpencodeSession(sessionId, title, signal, chatConfig)
  // 选中卡片作为上下文前置注入（补上工作台勾选 → 主对话的链路）。
  const basePrompt = session.isNew ? buildSeededPrompt(messages, latestUserMessage.text) : latestUserMessage.text
  const cardContext = selectedCards?.length ? buildContextFromCards(selectedCards) : ''
  const promptText = cardContext ? `${cardContext}\n\n${basePrompt}` : basePrompt
  const guard = opencodeChatPromptGuardPayload(chatConfig)
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

    const supervisorByMainId = new Map()
    for (const oc of list) {
      const metadata = normalizeMetadata(oc.metadata)
      if (metadata.type === 'supervisor' && metadata.mainSessionId) {
        supervisorByMainId.set(metadata.mainSessionId, oc.id)
      }
    }

    const result = []
    for (const oc of list) {
      const metadata = normalizeMetadata(oc.metadata)
      // 监督 session（副进程）不进侧栏，跳过。
      if (metadata.type === 'supervisor') continue

      const supervisorSessionId = metadata.supervisorSessionId || supervisorByMainId.get(oc.id)
      // 预填 session 缓存：历史会话续聊时 ensureOpencodeSession 直接命中，复用 opencode session。
      rememberOpencodeSession(oc.id, { id: oc.id })
      // 重建主→监督映射：刷新后 supervisorSessions 不丢，监督 session 长期复用。
      if (supervisorSessionId) {
        rememberSupervisorSession(oc.id, supervisorSessionId)
      }

      let messages = []
      try {
        const withParts = await client.messages({ sessionID: oc.id, directory })
        if (Array.isArray(withParts)) messages = withParts.map(toUIMessage).filter(Boolean)
      } catch {
        // 单个会话消息加载失败则保留空消息列表，不中断整体加载。
      }

      const firstUser = messages.find((m) => m.role === 'user')
      let contextCards = []
      if (supervisorSessionId) {
        contextCards = await getSupervisorCards(supervisorSessionId)
      }
      if (!contextCards.length && Array.isArray(metadata.contextCards)) {
        contextCards = metadata.contextCards
      }
      const uiMetadata = buildMainMetadata(metadata, supervisorSessionId)
      if (supervisorSessionId && (metadata.type !== 'main' || metadata.supervisorSessionId !== supervisorSessionId)) {
        try {
          await updateSessionMetadata(client, directory, oc.id, uiMetadata)
        } catch (error) {
          console.warn('[chatAdapter] 补写主 session metadata 失败：', error?.message || error)
        }
      }
      if (supervisorSessionId && supervisorByMainId.get(oc.id) !== supervisorSessionId) {
        try {
          await updateSessionMetadata(client, directory, supervisorSessionId, buildSupervisorMetadata(oc.id))
        } catch (error) {
          console.warn('[chatAdapter] 补写监督 session metadata 失败：', error?.message || error)
        }
      }
      result.push({
        id: oc.id,
        title: oc.title || '未命名对话',
        time: formatRelative(oc.time?.updated || oc.time?.created),
        summary: firstUser?.text || oc.title || '等待模型回复',
        status: '进行中',
        tone: 'progress',
        isDraft: false,
        messages,
        metadata: uiMetadata,
        contextCards,
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
    // sessionId 可能是前端 UI id，先映射到 opencode session id，避免 DELETE 404。
    const oc = await ensureOpencodeSession(sessionId, undefined, signal)
    await client.removeSession({ sessionID: oc.id, directory }, signal)
    opencodeSessions.delete(sessionId)
    return true
  } catch (error) {
    console.warn('[chatAdapter] deleteRemoteSession 失败：', error?.message || error)
    return false
  }
}

// 把卡片写回 opencode session 的 metadata（持久化在 opencode.db，跨设备同步）。
// baseMetadata 传入该 session 现有 metadata，避免覆盖其他字段；失败返回 false（不抛）。
export async function saveRemoteCards(sessionId, cards, baseMetadata, signal) {
  if (backend !== 'opencode') return false
  const client = getBridgeClient()
  const directory = env.VITE_OPENCODE_DIRECTORY || OPENCODE_DEFAULT_DIRECTORY
  try {
    // sessionId 可能是前端 UI id（新建会话），先映射到 opencode session id，避免 PATCH 404。
    const oc = await ensureOpencodeSession(sessionId, undefined, signal)
    const supervisorId = normalizeMetadata(baseMetadata).supervisorSessionId || supervisorSessions.get(oc.id) || supervisorSessions.get(sessionId)
    const metadata = buildMainMetadata(baseMetadata, supervisorId, cards)
    await updateSessionMetadata(client, directory, oc.id, metadata, signal)
    return true
  } catch (error) {
    console.warn('[chatAdapter] saveRemoteCards 失败：', error?.message || error)
    return false
  }
}

// 把会话级底盘配置与当前卡片一起写入主 session metadata。
// 新建草稿会话保存配置时会先创建远端 session，确保切换或刷新后仍可读回。
export async function saveSessionChatConfig(sessionId, title, chatConfig, baseMetadata, cards, signal) {
  if (backend !== 'opencode') return false
  const client = getBridgeClient()
  const directory = env.VITE_OPENCODE_DIRECTORY || OPENCODE_DEFAULT_DIRECTORY
  try {
    const normalizedConfig = normalizeChatConfig(chatConfig)
    const oc = await ensureOpencodeSession(sessionId, title, signal, normalizedConfig)
    const supervisorId =
      normalizeMetadata(baseMetadata).supervisorSessionId ||
      supervisorSessions.get(oc.id) ||
      supervisorSessions.get(sessionId)
    const metadata = buildMainMetadata(
      { ...normalizeMetadata(baseMetadata), chatConfig: normalizedConfig },
      supervisorId,
      cards,
    )
    await updateSessionMetadata(client, directory, oc.id, metadata, signal)
    return true
  } catch (error) {
    console.warn('[chatAdapter] saveSessionChatConfig 失败：', error?.message || error)
    return false
  }
}

// 监督总结：用独立的监督 opencode session 基于「过去卡片 + 本轮对话」增量总结成卡片。
// 返回 { cards, supervisorId }；失败时 cards 为 []（不抛）。
export async function runSupervisorSummary({ mainSessionId, turnMessages, messages, cards, mainMetadata, signal }) {
  if (backend !== 'opencode') return { cards: [], supervisorId: null }
  const client = getBridgeClient()
  const directory = env.VITE_OPENCODE_DIRECTORY || OPENCODE_DEFAULT_DIRECTORY

  let supervisorId
  try {
    supervisorId = await ensureSupervisorSession(mainSessionId, mainMetadata, signal)
  } catch (error) {
    console.warn('[chatAdapter] ensureSupervisorSession 失败：', error?.message || error)
    return { cards: [], supervisorId: null }
  }

  const prompt = buildSupervisorPrompt(turnMessages || messages, cards)
  // 60s 超时，避免同步 /message 卡死。
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), 60000)
  if (signal) {
    if (signal.aborted) timeout.abort()
    else signal.addEventListener('abort', () => timeout.abort(), { once: true })
  }
  try {
    const result = await client.prompt(
      {
        sessionID: supervisorId,
        directory,
        model: { providerID: opencodeProviderID(), modelID: opencodeModelID() },
        system: SUPERVISOR_SYSTEM_PROMPT,
        parts: [{ type: 'text', text: prompt }],
      },
      timeout.signal,
    )
    const text = extractOpencodeAssistantText(result, { allowIncomplete: true })
    return { cards: parseCardsFromText(text), supervisorId }
  } catch (error) {
    console.warn('[chatAdapter] runSupervisorSummary 失败：', error?.message || error)
    return { cards: [], supervisorId }
  } finally {
    clearTimeout(timer)
  }
}

// 为主对话创建/复用监督 session（缓存 mainId → supervisorId）。
// 创建时给监督 session 打标 type=supervisor（便于 loadHistory 过滤），并把绑定关系
// 持久化进主 session metadata（刷新后可重建映射，监督 session 长期复用）。
async function ensureSupervisorSession(mainSessionId, mainMetadata, signal) {
  const client = getBridgeClient()
  const directory = env.VITE_OPENCODE_DIRECTORY || OPENCODE_DEFAULT_DIRECTORY
  const main = await ensureOpencodeSession(mainSessionId, undefined, signal)
  const mainId = main.id
  const baseMainMetadata = normalizeMetadata(mainMetadata)
  const cached = baseMainMetadata.supervisorSessionId || supervisorSessions.get(mainId) || supervisorSessions.get(mainSessionId)
  if (cached) {
    rememberSupervisorSession(mainId, cached, mainSessionId)
    try {
      await updateSessionMetadata(client, directory, mainId, buildMainMetadata(baseMainMetadata, cached), signal)
    } catch (error) {
      console.warn('[chatAdapter] 写主 session supervisorSessionId 失败：', error?.message || error)
    }
    try {
      await updateSessionMetadata(client, directory, cached, buildSupervisorMetadata(mainId), signal)
    } catch (error) {
      console.warn('[chatAdapter] 写监督 session mainSessionId 失败：', error?.message || error)
    }
    return cached
  }

  const sup = await client.createSession(
    {
      directory,
      model: { id: opencodeModelID(), providerID: opencodeProviderID() },
      metadata: buildSupervisorMetadata(mainId),
    },
    signal,
  )
  rememberSupervisorSession(mainId, sup.id, mainSessionId)
  try {
    await updateSessionMetadata(client, directory, mainId, buildMainMetadata(baseMainMetadata, sup.id), signal)
  } catch (error) {
    console.warn('[chatAdapter] 写主 session supervisorSessionId 失败：', error?.message || error)
  }
  return sup.id
}

// 拉取监督 session 的最新总结，解析成卡片（选择对话时刷新工作台用）。
export async function getSupervisorCards(supervisorId, signal) {
  if (backend !== 'opencode' || !supervisorId) return []
  const client = getBridgeClient()
  const directory = env.VITE_OPENCODE_DIRECTORY || OPENCODE_DEFAULT_DIRECTORY
  try {
    const withParts = await client.messages({ sessionID: supervisorId, directory }, signal)
    if (!Array.isArray(withParts)) return []
    // 取最后一条 assistant 总结的 text（最新卡片集）。
    const last = [...withParts].reverse().find((m) => m?.info?.role === 'assistant')
    if (!last) return []
    const text = (last.parts || [])
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
    return parseCardsFromText(text)
  } catch (error) {
    console.warn('[chatAdapter] getSupervisorCards 失败：', error?.message || error)
    return []
  }
}

// 构造发给监督 session 的 prompt：本轮对话 + 现有卡片，要求输出更新后的完整卡片 JSON。
function buildSupervisorPrompt(turnMessages, cards) {
  const transcript = normalizeMessages(turnMessages || [])
    .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
    .join('\n')
  const cardsBlock =
    Array.isArray(cards) && cards.length
      ? cards
          .map(
            (c) =>
              `- id: ${c.id || ''}\n  topic: ${c.topic || c.title}\n  category: ${c.category || ''}\n  title: ${c.title || ''}\n  body: ${c.body || ''}`,
          )
          .join('\n')
      : '（暂无）'
  return [
    '下面是用户与 AI 的本轮对话上下文，以及这个主对话过去已经沉淀出的上下文卡片。请只基于本轮对话对卡片做增量更新。',
    '',
    '要求：',
    '1. 只输出更新后的完整 JSON 数组，每个元素形如 {"id":"","topic":"","category":"","title":"","body":""}。',
    '2. 先判断本轮对话是否符合某个已有卡片主题；符合时只更新那个已有卡片，必须保留它原来的 id 和 topic，不要新增重复卡片。',
    '3. 如果本轮对话不符合任何已有卡片主题，才追加一个新卡片；新卡片可以省略 id 或把 id 留空，topic 要稳定。',
    '4. 与本轮无关的旧卡片原样保留在数组里。',
    '5. category 从 [问题分析, 修复方案, 关键报错, 旧假设, 概念说明, 进展] 里选最接近的，必要时可自拟。',
    '6. title 一句话概括主题，body 写该主题的关键信息或要点。',
    '7. 不要输出 JSON 以外的任何文字（不要解释、不要 markdown 代码块标记）。',
    '',
    '过去卡片：',
    cardsBlock,
    '',
    '本轮对话上下文：',
    transcript,
  ].join('\n')
}

// 从模型输出中提取卡片 JSON 数组（容错：处理 ```json 包裹、前后多余文字）。
function parseCardsFromText(text) {
  if (!text || typeof text !== 'string') return []
  let jsonText = text
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) jsonText = fence[1]
  const start = jsonText.indexOf('[')
  const end = jsonText.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return []
  try {
    const arr = JSON.parse(jsonText.slice(start, end + 1))
    if (!Array.isArray(arr)) return []
    return arr
      .filter((c) => c && typeof c === 'object')
      .map((c) => ({
        id: String(c.id || '').trim(),
        topic: String(c.topic || c.title || '').trim(),
        category: String(c.category || '其他').trim(),
        title: String(c.title || '').trim(),
        body: String(c.body || '').trim(),
      }))
      .filter((c) => c.title || c.body)
  } catch {
    return []
  }
}

// 选中的卡片 → 注入主对话的上下文文本块。
function buildContextFromCards(selectedCards) {
  if (!Array.isArray(selectedCards) || selectedCards.length === 0) return ''
  const blocks = selectedCards.map((c) => `【${c.title}】\n${c.body}`)
  return `以下是用户在工作台选定的上下文模块，回答时请参考这些内容：\n\n${blocks.join('\n\n')}`
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

export async function sendChatMessage({ sessionId, title, messages, signal, chatConfig }) {
  if (backend === 'openai-compatible') {
    return sendOpenAICompatibleMessage({ messages, signal, chatConfig })
  }

  return sendOpencodeMessage({ sessionId, title, messages, signal, chatConfig })
}

async function sendOpencodeMessage({ sessionId, title, messages, signal, chatConfig }) {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user')
  if (!latestUserMessage?.text?.trim()) {
    throw new Error('没有可发送的用户消息。')
  }

  const session = await ensureOpencodeSession(sessionId, title, signal, chatConfig)
  const promptText = session.isNew ? buildSeededPrompt(messages, latestUserMessage.text) : latestUserMessage.text
  const response = await requestOpencode(withOpencodeDirectory(`/session/${encodeURIComponent(session.id)}/message`), {
    method: 'POST',
    body: buildOpencodePromptPayload(promptText, chatConfig),
    signal,
  })
  return extractOpencodeAssistantText(response)
}

async function ensureOpencodeSession(clientSessionId, title, signal, chatConfig) {
  const cacheKey = clientSessionId || 'default'
  const cached = opencodeSessions.get(cacheKey)
  if (cached) return { ...cached, isNew: false }

  const response = await requestOpencode(withOpencodeDirectory('/session'), {
    method: 'POST',
    body: buildOpencodeSessionPayload(title, chatConfig),
    signal,
  })
  const id = response?.id
  if (!id) throw new Error(`opencode 未返回会话 ID：${title || cacheKey}`)

  const session = { id }
  rememberOpencodeSession(cacheKey, session)
  return { ...session, isNew: true }
}

function buildOpencodeSessionPayload(title, chatConfig) {
  return {
    ...(title ? { title } : {}),
    metadata: { type: 'main', chatConfig: normalizeChatConfig(chatConfig) },
    ...(env.VITE_OPENCODE_AGENT ? { agent: env.VITE_OPENCODE_AGENT } : {}),
    ...opencodeChatPermissionPayload(),
    model: {
      providerID: opencodeProviderID(),
      id: opencodeModelID(),
      ...(env.VITE_OPENCODE_MODEL_VARIANT ? { variant: env.VITE_OPENCODE_MODEL_VARIANT } : {}),
    },
  }
}

function buildOpencodePromptPayload(text, chatConfig) {
  return {
    ...(env.VITE_OPENCODE_AGENT ? { agent: env.VITE_OPENCODE_AGENT } : {}),
    ...(env.VITE_OPENCODE_MODEL_VARIANT ? { variant: env.VITE_OPENCODE_MODEL_VARIANT } : {}),
    ...opencodeChatPromptGuardPayload(chatConfig),
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

async function sendOpenAICompatibleMessage({ messages, signal, chatConfig }) {
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
        content: buildChatSystemPrompt(chatConfig),
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

function opencodeChatPromptGuardPayload(chatConfig) {
  const system = buildChatSystemPrompt(chatConfig)
  if (env.VITE_OPENCODE_CHAT_ENABLE_TOOLS === 'true') return { system }
  return {
    system,
    tools: Object.fromEntries(OPENCODE_CHAT_DISABLED_TOOLS.map((tool) => [tool, false])),
  }
}

function buildChatSystemPrompt(chatConfig) {
  const basePrompt = env.VITE_OPENCODE_SYSTEM_PROMPT || OPENCODE_CHAT_SYSTEM_PROMPT
  const config = normalizeChatConfig(chatConfig)
  const permissionLabel = (key) => {
    const value = config.toolPermissions[key]
    return value === 'allow' ? '允许' : value === 'confirm' ? '需先征得用户确认' : '禁止'
  }
  const ruleBlock = config.rules.length ? config.rules.map((rule) => `- ${rule}`).join('\n') : '- 无额外规则'

  return [
    basePrompt,
    '',
    '【当前会话对话底盘配置】',
    `对话目标：${config.goal || '未设置，围绕用户当前问题推进。'}`,
    `当前阶段：${config.stage}`,
    '对话规则：',
    ruleBlock,
    '工具权限：',
    ...Object.entries(CHAT_CONFIG_TOOL_LABELS).map(([key, label]) => `- ${label}：${permissionLabel(key)}`),
    `验收标准：${config.acceptanceCriteria || '给出清晰、可执行的下一步。'}`,
    `项目记忆：${config.projectMemory || '暂无。'}`,
    '将以上配置视为本会话的持续约束；工具是否真正可用仍以运行环境实际授予的权限为准。',
  ].join('\n')
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
