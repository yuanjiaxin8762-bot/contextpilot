<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from './AppIcon.vue'

defineProps({
  message: {
    type: Object,
    required: true,
  },
  categories: {
    type: Array,
    default: () => [],
  },
})

const emit = defineEmits(['add-context'])
const menuOpen = ref(false)
const messageToolsEl = ref(null)

function handleDocumentClick(event) {
  if (!messageToolsEl.value?.contains(event.target)) {
    menuOpen.value = false
  }
}

function addToContext(category, message) {
  menuOpen.value = false
  emit('add-context', { category, message })
}

onMounted(() => {
  document.addEventListener('click', handleDocumentClick)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
})
</script>

<template>
  <article class="message" :class="message.role">
    <div class="bubble" :class="{ pending: message.pending, error: message.error }">
      <h3 v-if="message.heading">{{ message.heading }}</h3>
      <p>{{ message.text }}</p>

      <div v-if="message.codeBlock" class="fix-block">
        <div class="fix-head">
          <span class="fix-dots"><i></i><i></i><i></i></span>
          <code class="fix-file">{{ message.codeBlock.file }}</code>
          <span class="fix-lang">{{ message.codeBlock.language }}</span>
        </div>
        <pre><code>{{ message.codeBlock.code }}</code></pre>
      </div>
    </div>
    <div ref="messageToolsEl" class="message-tools">
      <button
        type="button"
        class="message-menu-trigger"
        :aria-label="`${message.role === 'user' ? '用户' : 'AI'}消息操作`"
        :aria-expanded="menuOpen"
        @click.stop="menuOpen = !menuOpen"
      >
        <AppIcon name="more-horizontal" :size="18" />
      </button>
      <div v-if="menuOpen" class="message-menu" role="menu" @click.stop>
        <button
          v-for="category in categories"
          :key="category"
          type="button"
          role="menuitem"
          @click="addToContext(category, message)"
        >
          {{ category }}
        </button>
      </div>
    </div>
  </article>
</template>
