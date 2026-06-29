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
})

const emit = defineEmits(['send'])
const draft = ref('')
const messagesEl = ref(null)
const canSend = computed(() => draft.value.trim().length > 0 && !props.isSending)

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

    <div ref="messagesEl" class="messages">
      <ChatMessage v-for="message in messages" :key="message.id" :message="message" />
    </div>

    <div class="composer-shell">
      <p v-if="error" class="composer-error">{{ error }}</p>
      <form class="composer" aria-label="发送消息" @submit.prevent="submitMessage">
        <input
          v-model="draft"
          type="text"
          :disabled="isSending"
          placeholder="输入消息，继续当前对话"
        />
        <button type="submit" :disabled="!canSend">
          <AppIcon name="send" :size="16" />
          <span>{{ isSending ? '发送中' : '发送' }}</span>
        </button>
      </form>
    </div>
  </section>
</template>
