<script setup>
import {onMounted, reactive, ref, computed, watch} from 'vue'
import SessionSidebar from './components/SessionSidebar.vue'
import ContextWorkbench from './components/ContextWorkbench.vue'
import ChatPanel from './components/ChatPanel.vue'
import SessionConfigModal from './components/SessionConfigModal.vue'
import WorkflowModal from './components/WorkflowModal.vue'
import { sessions, totalSessions, contextCards } from './data/workspace.js'
import { chatModelLabel, sendChatMessage, sendChatMessageStream, chatStreams, isAbortError, loadHistory, deleteRemoteSession, runSupervisorSummary, saveRemoteCards, getSupervisorCards, createDefaultChatConfig, normalizeChatConfig, saveSessionChatConfig } from './model/chatAdapter.js'

const baseContextCards = ref(contextCards.map((card) => ({ ...card })))
const defaultContextCategories = [...new Set(contextCards.map((card) => card.category))]

// 当前活动会话（驱动聊天区标题与消息）
const chatSessions = ref(
  sessions.map((session) => ({
    ...session,
    messages: session.messages.map((message) => ({ ...message })),
  })),
)
const activeSessionId = ref(sessions[0]?.id)

// 启动时从 opencode 加载真实历史会话；失败/为空则保留 mock（sessions）。
const isLoadingHistory = ref(true)
onMounted(async () => {
  try {
    const real = await loadHistory()
    if (real && real.length) {
      // 历史消息和监督卡片都在 loadHistory 内从对应 session 读回。
      chatSessions.value = real
      activeSessionId.value = real[0]?.id ?? activeSessionId.value
    }
  } finally {
    isLoadingHistory.value = false
  }
})

const activeSession = computed(
  () => chatSessions.value.find((s) => s.id === activeSessionId.value) ?? chatSessions.value[0],
)
const activeContextCards = computed(() => activeSession.value?.contextCards ?? baseContextCards.value)
const contextCategories = computed(() => {
  const categories = [...new Set(activeContextCards.value.map((card) => card.category))]
  return categories.length ? categories : defaultContextCategories
})

const isChartSession = computed(() => activeSession.value?.id === 'chart')

watch(
  () => activeSession.value?.id,
  (newId) => {
    if (newId === 'chart') {
      console.log('Entering chart performance test mode')
    }
  }
)
const isSending = ref(false)
const chatError = ref('')

// 当前生成请求的 AbortController，供后续“停止生成”按钮调用 abort()。
let activeAbortController = null

// 两侧栏收起状态
const sidebarCollapsed = ref(false)
const contextCollapsed = ref(false)
const isChatConfigOpen = ref(false)
const isWorkflowOpen = ref(false)
const isSavingChatConfig = ref(false)
const chatConfigError = ref('')

function openChatConfig() {
  const session = activeSession.value
  if (!session) return
  if (!session.metadata?.chatConfig) {
    session.metadata = {
      ...(session.metadata || {}),
      type: 'main',
      chatConfig: createDefaultChatConfig(),
    }
  }
  chatConfigError.value = ''
  isWorkflowOpen.value = false
  isChatConfigOpen.value = true
}

function openWorkflow() {
  if (!activeSession.value) return
  isChatConfigOpen.value = false
  isWorkflowOpen.value = true
}

function closeChatConfig() {
  if (isSavingChatConfig.value) return
  isChatConfigOpen.value = false
  chatConfigError.value = ''
}

async function saveChatConfig(config) {
  const session = activeSession.value
  if (!session || isSavingChatConfig.value) return

  const chatConfig = normalizeChatConfig(config)
  session.metadata = {
    ...(session.metadata || {}),
    type: 'main',
    chatConfig,
  }
  isSavingChatConfig.value = true
  chatConfigError.value = ''
  try {
    const saved = await saveSessionChatConfig(
      session.id,
      session.title,
      chatConfig,
      session.metadata,
      session.contextCards || [],
    )
    if (!saved) {
      throw new Error('配置未能同步到数据库，请稍后重试。')
    }
    isChatConfigOpen.value = false
  } catch (error) {
    chatConfigError.value = error instanceof Error ? error.message : '配置保存失败，请稍后重试。'
  } finally {
    isSavingChatConfig.value = false
  }
}

function selectSession(id) {
  activeSessionId.value = id
  chatError.value = ''
  refreshSupervisorCards(id)
}

// 选择对话时：拿副进程 id 缓存到 localStorage，并拉副进程最新总结刷新工作台卡片。
async function refreshSupervisorCards(sessionId) {
  const session = chatSessions.value.find((s) => s.id === sessionId)
  if (!session) return
  const supervisorId = session.metadata?.supervisorSessionId
  if (!supervisorId) return
  session.metadata = { ...(session.metadata || {}), type: 'main', supervisorSessionId: supervisorId }
  try {
    localStorage.setItem(`contextpilot:supervisor:${sessionId}`, supervisorId)
  } catch { /* localStorage 不可用时静默 */ }
  const incoming = await getSupervisorCards(supervisorId)
  if (incoming.length) {
    session.contextCards = mergeCards(session.contextCards || [], incoming)
    saveRemoteCards(session.id, session.contextCards, session.metadata)
  }
}

function buildNewSession() {
  const id = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    title: '新建对话',
    status: '待开始',
    tone: 'progress',
    time: '刚刚',
    summary: '等待第一条消息',
    messages: [],
    metadata: { type: 'main', chatConfig: createDefaultChatConfig() },
    contextCards: [],
    isDraft: true,
  }
}

function createNewSession() {
  const session = buildNewSession()

  chatSessions.value.unshift(session)
  activeSessionId.value = session.id
  chatError.value = ''
}

async function shareSession(id) {
  const session = chatSessions.value.find((item) => item.id === id)
  if (!session) return

  const text = `contexpilot 对话：${session.title}`
  try {
    await navigator.clipboard.writeText(text)
    window.alert('已复制分享信息')
  } catch {
    window.alert(text)
  }
}

function renameSession(id) {
  const session = chatSessions.value.find((item) => item.id === id)
  if (!session) return

  const nextTitle = window.prompt('重命名对话', session.title)?.trim()
  if (!nextTitle) return
  session.title = nextTitle
  if (session.summary === '等待第一条消息') {
    session.summary = nextTitle
  }
}

async function deleteSession(id) {
  const index = chatSessions.value.findIndex((item) => item.id === id)
  if (index < 0) return

  const session = chatSessions.value[index]
  if (!window.confirm(`删除对话“${session.title}”？`)) return

  // 后端删除（opencode.db）；失败不阻断前端删除，只提示。
  const ok = await deleteRemoteSession(id)

  chatSessions.value.splice(index, 1)
  if (chatSessions.value.length === 0) {
    const replacement = buildNewSession()
    chatSessions.value.push(replacement)
    activeSessionId.value = replacement.id
  } else if (activeSessionId.value === id) {
    const next = chatSessions.value[Math.min(index, chatSessions.value.length - 1)]
    activeSessionId.value = next.id
  }
  chatError.value = ok ? '' : '后端会话删除失败，刷新后该会话可能仍在。'
}

function addContextFromMessage({ category, message }) {
  if (!category || !message) return

  const target = activeSession.value?.contextCards ?? baseContextCards.value
  target.unshift({
    id: `from-message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    category,
    title: createContextTitle(category, message),
    body: createContextBody(message),
    partIDs: normalizePartIDs(message.partIDs),
    time: `今天 ${currentTime()}`,
    source: message.role === 'user' ? '对话' : 'AI',
    priority: '中',
    selected: true,
  })
}

function updateContextPriority({ id, priority }) {
  const card = activeContextCards.value.find((item) => item.id === id)
  if (!card || !['高', '中', '低'].includes(priority)) return
  card.priority = priority
  const session = activeSession.value
  if (session) saveRemoteCards(session.id, session.contextCards || [], session.metadata)
}

// —— 监督总结（工作台卡片自动生成）——
const summarizingIds = ref(new Set())
const isSummarizing = computed(() => summarizingIds.value.has(activeSessionId.value))

// 主对话 idle 后后台触发：让监督 session 总结对话 → 更新工作台卡片（不阻塞 UI）。
async function runSupervisor(session, turnMessages) {
  if (!session || summarizingIds.value.has(session.id)) return
  summarizingIds.value = new Set(summarizingIds.value).add(session.id)
  try {
    const { cards: incoming, supervisorId } = await runSupervisorSummary({
      mainSessionId: session.id,
      turnMessages,
      cards: session.contextCards || [],
      mainMetadata: session.metadata,
    })
    // 同步前端 metadata 的 supervisorSessionId，避免后续 saveRemoteCards 用旧 metadata 覆盖掉绑定。
    if (supervisorId) {
      session.metadata = { ...(session.metadata || {}), type: 'main', supervisorSessionId: supervisorId }
    }
    if (incoming?.length) {
      session.contextCards = mergeCards(session.contextCards || [], incoming)
      saveRemoteCards(session.id, session.contextCards, session.metadata)
    }
  } finally {
    const next = new Set(summarizingIds.value)
    next.delete(session.id)
    summarizingIds.value = next
  }
}

// 按 topic 增量合并：已有的更新 title/body/category，保留 selected/priority；新的追加。
function mergeCards(existing, incoming) {
  const result = [...(existing || [])]
  const byId = new Map()
  const byTopic = new Map()
  const remember = (card, index) => {
    if (card.id) byId.set(card.id, index)
    const topicKey = normalizeCardKey(card.topic || card.title)
    if (topicKey) byTopic.set(topicKey, index)
  }
  result.forEach(remember)

  for (const card of incoming) {
    const topicKey = normalizeCardKey(card.topic || card.title)
    const titleKey = normalizeCardKey(card.title)
    const idIdx = card.id ? byId.get(card.id) : undefined
    const idx = idIdx ?? byTopic.get(topicKey) ?? byTopic.get(titleKey)
    if (idx !== undefined) {
      const nextTopic = card.topic || result[idx].topic || card.title
      const changed =
        result[idx].topic !== nextTopic ||
        result[idx].category !== card.category ||
        result[idx].title !== card.title ||
        result[idx].body !== card.body
      result[idx] = {
        ...result[idx],
        topic: nextTopic,
        category: card.category,
        title: card.title,
        body: card.body,
        partIDs: normalizePartIDs([...(result[idx].partIDs || []), ...(card.partIDs || [])]),
        time: changed ? `今天 ${currentTime()}` : result[idx].time,
      }
      remember(result[idx], idx)
    } else {
      result.push({
        id: card.id || `card-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        topic: card.topic || card.title,
        category: card.category,
        title: card.title,
        body: card.body,
        partIDs: normalizePartIDs(card.partIDs),
        time: `今天 ${currentTime()}`,
        source: 'AI 总结',
        priority: '中',
        selected: false,
      })
      remember(result[result.length - 1], result.length - 1)
    }
  }
  return result
}

function normalizeCardKey(value) {
  return String(value || '').trim().toLowerCase()
}

function normalizePartIDs(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))]
}

// 工作台勾选回写：选中后注入主对话下一轮 prompt。
function toggleCardSelection(id) {
  const card = activeContextCards.value.find((item) => item.id === id)
  if (!card) return
  card.selected = !card.selected
  const session = activeSession.value
  if (session) saveRemoteCards(session.id, session.contextCards || [], session.metadata)
}

async function handleSendMessage(text) {
  const content = text.trim()
  const session = activeSession.value
  if (!content || !session || isSending.value) return

  chatError.value = ''
  const userMessage = createMessage('user', content)
  // 用 reactive 包裹：后续流式 onDelta 频繁改 text 必须经过 proxy 才能触发 UI 更新。
  // 否则 push 进响应式数组后，局部变量仍是原始对象，改它不会重渲染（气泡会卡在占位文本）。
  const assistantMessage = reactive(
    createMessage('assistant', '正在连接模型并生成回复...', { pending: true, reasoning: '' }),
  )

  session.messages.push(userMessage, assistantMessage)
  if (session.isDraft) {
    session.title = createSessionTitle(content)
    session.summary = content
    session.status = '进行中'
    session.isDraft = false
  }
  isSending.value = true

  // rAF 节流：onDelta/onReasoning 高频触发，用局部变量收敛，每帧至多写一次响应式字段。
  let pendingText = ''
  let pendingReasoning = ''
  let rafScheduled = false
  let rafId = 0
  const flush = () => {
    rafScheduled = false
    rafId = 0
    assistantMessage.text = pendingText
    assistantMessage.reasoning = pendingReasoning
  }

  activeAbortController = new AbortController()

  try {
    const selectedCards = (session.contextCards || []).filter((c) => c.selected)
    if (chatStreams) {
      const { text: reply, reasoning, partIDs } = await sendChatMessageStream({
        sessionId: session.id,
        title: session.title,
        messages: session.messages,
        signal: activeAbortController.signal,
        selectedCards,
        chatConfig: session.metadata?.chatConfig,
        onDelta: (delta, fullText) => {
          pendingText = fullText
          if (!rafScheduled) {
            rafScheduled = true
            rafId = requestAnimationFrame(flush)
          }
        },
        onReasoning: (reasoningText) => {
          pendingReasoning = reasoningText
          if (!rafScheduled) {
            rafScheduled = true
            rafId = requestAnimationFrame(flush)
          }
        },
      })
      assistantMessage.text = reply
      if (reasoning) assistantMessage.reasoning = reasoning
      assistantMessage.partIDs = normalizePartIDs(partIDs)
      // 后台触发监督总结，更新工作台卡片（不阻塞 UI）。
      runSupervisor(session, buildSupervisorTurn(userMessage, assistantMessage))
    } else {
      const reply = await sendChatMessage({
        sessionId: session.id,
        title: session.title,
        messages: session.messages,
        selectedCards,
        chatConfig: session.metadata?.chatConfig,
      })
      assistantMessage.text = reply
      runSupervisor(session, buildSupervisorTurn(userMessage, assistantMessage))
    }
  } catch (error) {
    if (isAbortError(error) && !/超时|timed out/i.test(error.message)) {
      // 用户主动停止：保留已流式文本；若几乎没内容则标记为已停止。
      if (!assistantMessage.text || assistantMessage.text.startsWith('正在连接')) {
        assistantMessage.text = '(已停止)'
      }
      refreshSessionContext(session, userMessage, assistantMessage)
    } else {
      const message = error instanceof Error ? error.message : '模型调用失败。'
      assistantMessage.text = message
      assistantMessage.error = true
      chatError.value = message
      refreshSessionContext(session, userMessage, assistantMessage)
    }
  } finally {
    if (rafId) cancelAnimationFrame(rafId)
    assistantMessage.pending = false
    isSending.value = false
    activeAbortController = null
  }
}

function createMessage(role, text, extra = {}) {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    time: currentTime(),
    text,
    ...extra,
  }
}

function buildSupervisorTurn(userMessage, assistantMessage) {
  return [
    { ...userMessage, pending: false, error: false },
    { ...assistantMessage, pending: false, error: false },
  ]
}

function currentTime() {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date())
}

function createSessionTitle(text) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 18 ? `${normalized.slice(0, 18)}...` : normalized
}

function createContextTitle(category, message) {
  if (message.heading) return message.heading

  const text = message.text.replace(/\s+/g, ' ').trim()
  const summary = text.length > 18 ? `${text.slice(0, 18)}...` : text
  const titleMap = {
    问题分析: '对话问题摘要',
    修复方案: '对话修复摘要',
    关键报错: '对话报错摘要',
    旧假设: '对话假设摘要',
  }

  return summary || titleMap[category] || `${category}摘要`
}

function createContextBody(message) {
  const text = message.text.replace(/\s+/g, ' ').trim()
  return text.length > 84 ? `${text.slice(0, 84)}...` : text
}

// 监督总结接管工作台卡片生成，这里不再硬编码覆盖 contextCards。
// 保留签名兼容历史调用点（chatError banner 已负责展示错误，无需卡片）。
function refreshSessionContext() {}
</script>

<template>
  <main
    class="app-shell"
    :class="{ 'hide-sidebar': sidebarCollapsed, 'hide-context': contextCollapsed }"
    aria-label="ContextPilot workspace"
  >
    <SessionSidebar
      :sessions="chatSessions"
      :total-sessions="totalSessions"
      :active-id="activeSessionId"
      :collapsed="sidebarCollapsed"
      @select="selectSession"
      @create="createNewSession"
      @share="shareSession"
      @rename="renameSession"
      @delete="deleteSession"
      @collapse="sidebarCollapsed = true"
      @expand="sidebarCollapsed = false"
    />

    <ContextWorkbench
      :cards="activeContextCards"
      :is-summarizing="isSummarizing"
      :collapsed="contextCollapsed"
      @collapse="contextCollapsed = true"
      @expand="contextCollapsed = false"
      @toggle="toggleCardSelection"
      @update-priority="updateContextPriority"
      @configure="openChatConfig"
      @workflow="openWorkflow"
    />

    <ChatPanel
      :title="activeSession.title"
      :messages="activeSession.messages"
      :is-sending="isSending"
      :error="chatError"
      :model-label="chatModelLabel"
      :context-categories="contextCategories"
      v-if="!isChartSession"
      @send="handleSendMessage"
      @add-context="addContextFromMessage"
    />

    <ChatPanel
      v-if="isChartSession"
      :title="activeSession.title"
      :messages="activeSession.messages"
      :is-sending="isSending"
      :error="chatError"
      :model-label="chatModelLabel"
      :context-categories="contextCategories"
      @send="handleSendMessage"
      @add-context="addContextFromMessage"
    />

    <SessionConfigModal
      v-if="isChatConfigOpen && activeSession"
      :session-title="activeSession.title"
      :config="activeSession.metadata?.chatConfig"
      :saving="isSavingChatConfig"
      :error="chatConfigError"
      @close="closeChatConfig"
      @save="saveChatConfig"
    />

    <WorkflowModal
      v-if="isWorkflowOpen && activeSession"
      :session-title="activeSession.title"
      :messages="activeSession.messages"
      :cards="activeContextCards"
      :is-summarizing="isSummarizing"
      @close="isWorkflowOpen = false"
    />
  </main>
</template>
