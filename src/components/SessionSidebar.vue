<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from './AppIcon.vue'

defineProps({
  sessions: { type: Array, required: true },
  activeId: { type: String, default: '' },
  collapsed: { type: Boolean, default: false },
})

const emit = defineEmits(['select', 'create', 'share', 'rename', 'delete', 'collapse', 'expand'])
const openMenuId = ref('')

function toggleMenu(id) {
  openMenuId.value = openMenuId.value === id ? '' : id
}

function closeMenu() {
  openMenuId.value = ''
}

function selectSession(id) {
  closeMenu()
  emit('select', id)
}

function runAction(type, id) {
  closeMenu()
  emit(type, id)
}

function handleDocumentClick() {
  closeMenu()
}

onMounted(() => {
  document.addEventListener('click', handleDocumentClick)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
})
</script>

<template>
  <aside class="sidebar" :class="{ collapsed }" aria-label="会话导航">
    <!-- 收起态：窄轨，仅留品牌标 + 展开按钮 -->
    <button
      v-if="collapsed"
      type="button"
      class="rail-toggle"
      aria-label="展开会话栏"
      @click="$emit('expand')"
    >
      <span class="rail-content-icon"><AppIcon name="user" :size="18" /></span>
      <AppIcon name="chevrons-right" :size="18" />
    </button>

    <template v-else>
      <div class="sidebar-header">
        <h1 class="brand-word">contexpilot</h1>
        <button
          type="button"
          class="icon-btn"
          aria-label="收起会话栏"
          @click="$emit('collapse')"
        >
          <AppIcon name="chevrons-left" :size="16" />
        </button>
      </div>

      <nav class="quick-actions" aria-label="快捷操作">
        <button type="button" class="primary-action" @click="$emit('create')">
          <AppIcon name="plus" :size="16" />
          <span>新建对话</span>
        </button>
      </nav>

      <section class="session-list" aria-label="会话列表">
        <div class="section-heading">
          <span>会话</span>
          <strong>{{ sessions.length }}</strong>
        </div>
        <div
          v-for="session in sessions"
          :key="session.id"
          class="session-item"
          :class="{ active: session.id === activeId }"
          @click.stop
        >
          <button type="button" class="session-main" @click="selectSession(session.id)">
            <strong>{{ session.title }}</strong>
            <em>{{ session.time }}</em>
          </button>

          <div class="session-actions">
            <button
              type="button"
              class="session-menu-trigger"
              :aria-label="`${session.title} 操作`"
              :aria-expanded="openMenuId === session.id"
              @click.stop="toggleMenu(session.id)"
            >
              <AppIcon name="more-horizontal" :size="18" />
            </button>

            <div v-if="openMenuId === session.id" class="session-menu" role="menu">
              <button type="button" role="menuitem" @click.stop="runAction('share', session.id)">
                <AppIcon name="share" :size="17" />
                <span>分享</span>
              </button>
              <button type="button" role="menuitem" @click.stop="runAction('rename', session.id)">
                <AppIcon name="pencil" :size="17" />
                <span>重命名</span>
              </button>
              <button
                type="button"
                class="danger"
                role="menuitem"
                @click.stop="runAction('delete', session.id)"
              >
                <AppIcon name="trash" :size="17" />
                <span>删除</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      <button type="button" class="all-sessions">
        <span>查看全部会话 ({{ sessions.length }})</span>
        <AppIcon name="arrow-right" :size="16" />
      </button>
    </template>
  </aside>
</template>
