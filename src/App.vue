<script setup>
import {ref, computed, watch} from 'vue'
import SessionSidebar from './components/SessionSidebar.vue'
import ContextWorkbench from './components/ContextWorkbench.vue'
import ChatPanel from './components/ChatPanel.vue'
import { sessions, totalSessions, contextCards } from './data/workspace.js'
import { chatModelLabel, sendChatMessage } from './model/chatAdapter.js'

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

// 两侧栏收起状态
const sidebarCollapsed = ref(false)
const contextCollapsed = ref(false)

function selectSession(id) {
  activeSessionId.value = id
  chatError.value = ''
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

function deleteSession(id) {
  const index = chatSessions.value.findIndex((item) => item.id === id)
  if (index < 0) return

  const session = chatSessions.value[index]
  if (!window.confirm(`删除对话“${session.title}”？`)) return

  chatSessions.value.splice(index, 1)
  if (chatSessions.value.length === 0) {
    const replacement = buildNewSession()
    chatSessions.value.push(replacement)
    activeSessionId.value = replacement.id
  } else if (activeSessionId.value === id) {
    const next = chatSessions.value[Math.min(index, chatSessions.value.length - 1)]
    activeSessionId.value = next.id
  }
  chatError.value = ''
}

function addContextFromMessage({ category, message }) {
  if (!category || !message) return

  const target = activeSession.value?.contextCards ?? baseContextCards.value
  target.unshift({
    id: `from-message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    category,
    title: createContextTitle(category, message),
    body: createContextBody(message),
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
}

async function handleSendMessage(text) {
  const content = text.trim()
  const session = activeSession.value
  if (!content || !session || isSending.value) return

  chatError.value = ''
  const userMessage = createMessage('user', content)
  const assistantMessage = createMessage('assistant', '正在连接模型并生成回复...', {
    pending: true,
  })

  session.messages.push(userMessage, assistantMessage)
  if (session.isDraft) {
    session.title = createSessionTitle(content)
    session.summary = content
    session.status = '进行中'
    session.isDraft = false
  }
  isSending.value = true

  try {
    const reply = await sendChatMessage({
      sessionId: session.id,
      title: session.title,
      messages: session.messages,
    })
    assistantMessage.text = reply
    refreshSessionContext(session, userMessage, assistantMessage)
  } catch (error) {
    const message = error instanceof Error ? error.message : '模型调用失败。'
    assistantMessage.text = message
    assistantMessage.error = true
    chatError.value = message
    refreshSessionContext(session, userMessage, assistantMessage)
  } finally {
    assistantMessage.pending = false
    isSending.value = false
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

function refreshSessionContext(session, userMessage, assistantMessage) {
  const now = `今天 ${currentTime()}`
  const assistantText = assistantMessage.text || '等待模型回复'
  const hasError = Boolean(assistantMessage.error)

  session.contextCards = [
    {
      id: `${session.id}-intent`,
      category: '问题分析',
      title: '本轮用户需求',
      body: userMessage.text,
      time: now,
      source: '对话',
      priority: '中',
      selected: true,
    },
    {
      id: `${session.id}-reply`,
      category: hasError ? '关键报错' : '修复方案',
      title: hasError ? '模型连接异常' : 'AI 初步响应',
      body: assistantText,
      time: now,
      source: hasError ? '系统' : '对话',
      priority: hasError ? '高' : '中',
      selected: true,
    },
  ]
}
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
      :collapsed="contextCollapsed"
      @collapse="contextCollapsed = true"
      @expand="contextCollapsed = false"
      @update-priority="updateContextPriority"
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
  </main>
</template>
