<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import ChatMessage from './ChatMessage.vue'

const props = defineProps({
  title: { type: String, default: 'AI 对话窗口' },
  messages: { type: Array, required: true },
  isSending: { type: Boolean, default: false },
  error: { type: String, default: '' },
  modelLabel: { type: String, default: 'opencode' },
  contextCategories: { type: Array, default: () => [] },
})

const emit = defineEmits(['send', 'add-context'])
const draft = ref('')
const messagesEl = ref(null)
const canSend = computed(() => draft.value.trim().length > 0 && !props.isSending)
const isEmpty = computed(() => props.messages.length === 0)
const inputPlaceholder = computed(() =>
  isEmpty.value ? '输入消息，开始新的对话' : '输入消息，继续当前对话',
)

function submitMessage() {
  if (!canSend.value) return
  emit('send', draft.value)
  draft.value = ''
}

watch(
  () => props.messages.length,
  async () => {
    await nextTick()
    if (messagesEl.value) {
      messagesEl.value.scrollTop = messagesEl.value.scrollHeight
    }
  },
)
</script>

<template>
  <section class="chat-panel" aria-label="AI 对话窗口">
    <header class="chat-header">
      <div>
        <h2>{{ title }}</h2>
      </div>
      <span class="model-chip"><span class="dot pulse"></span>{{ modelLabel }}</span>
    </header>

<<<<<<< HEAD
    <div ref="messagesEl" class="messages" :class="{ empty: isEmpty }">
      <div v-if="isEmpty" class="chat-empty" aria-live="polite">
        <span class="empty-icon"><AppIcon name="sparkles" :size="22" /></span>
        <h3>新对话已准备</h3>
        <p>发送第一条消息后，系统会为本轮对话加载新的上下文数据。</p>
      </div>
      <template v-else>
        <ChatMessage
          v-for="message in messages"
          :key="message.id"
          :message="message"
          :categories="contextCategories"
          @add-context="$emit('add-context', $event)"
        />
        <ChartPerformance v-if="title.includes('数据可视化')" />
      </template>
=======
    <div ref="messagesEl" class="messages">
      <ChatMessage v-for="message in messages" :key="message.id" :message="message" />
>>>>>>> 68fdd7ea4f321e698077ff870762d9ef59aadb35
    </div>

    <div class="composer-shell">
      <p v-if="error" class="composer-error">{{ error }}</p>
      <form class="composer" aria-label="发送消息" @submit.prevent="submitMessage">
        <input
          v-model="draft"
          type="text"
          :disabled="isSending"
          :placeholder="inputPlaceholder"
        />
        <button type="submit" :disabled="!canSend">
          <AppIcon name="send" :size="16" />
          <span>{{ isSending ? '发送中' : '发送' }}</span>
        </button>
      </form>
    </div>
  </section>
</template>
