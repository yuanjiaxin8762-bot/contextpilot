<script setup>
import { ref, computed, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import ContextCard from './ContextCard.vue'

const props = defineProps({
  cards: { type: Array, required: true },
  collapsed: { type: Boolean, default: false },
  isSummarizing: { type: Boolean, default: false },
})

defineEmits(['collapse', 'expand', 'update-priority', 'toggle', 'configure'])

// 类型筛选：按 category 动态生成，计数对应实际卡片；点击可过滤列表
const activeFilter = ref('全部')
const filterBarRef = ref(null)
const isFilterDragging = ref(false)
const filterDragMoved = ref(false)
let filterDragStartX = 0
let filterDragStartScrollLeft = 0
let filterPointerLabel = ''

const filters = computed(() => {
  const categories = [...new Set(props.cards.map((c) => c.category))]
  return [
    { label: '全部', count: props.cards.length, active: activeFilter.value === '全部' },
    ...categories.map((cat) => ({
      label: cat,
      count: props.cards.filter((c) => c.category === cat).length,
      active: activeFilter.value === cat,
    })),
  ]
})
const filteredCards = computed(() =>
  activeFilter.value === '全部'
    ? props.cards
    : props.cards.filter((c) => c.category === activeFilter.value),
)

// 当前筛选分类被清空时回退到「全部」。
watch(
  () => props.cards.map((card) => card.category).join('|'),
  () => {
    if (
      activeFilter.value !== '全部' &&
      !props.cards.some((c) => c.category === activeFilter.value)
    ) {
      activeFilter.value = '全部'
    }
  },
)

function selectFilter(label) {
  if (filterDragMoved.value) return
  activeFilter.value = label
}

function filterLabelFromEvent(event) {
  return event.target?.closest?.('[data-filter-label]')?.dataset.filterLabel || ''
}

function handleFilterWheel(event) {
  const el = filterBarRef.value
  if (!el || el.scrollWidth <= el.clientWidth) return

  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  if (!delta) return

  event.preventDefault()
  el.scrollLeft += delta
}

function startFilterDrag(event) {
  if (event.button !== undefined && event.button !== 0) return

  const el = filterBarRef.value
  if (!el || el.scrollWidth <= el.clientWidth) return

  isFilterDragging.value = true
  filterDragMoved.value = false
  filterPointerLabel = filterLabelFromEvent(event)
  filterDragStartX = event.clientX
  filterDragStartScrollLeft = el.scrollLeft
}

function moveFilterDrag(event) {
  const el = filterBarRef.value
  if (!isFilterDragging.value || !el) return

  const offset = event.clientX - filterDragStartX
  if (Math.abs(offset) > 4) filterDragMoved.value = true
  el.scrollLeft = filterDragStartScrollLeft - offset
}

function endFilterDrag() {
  if (!isFilterDragging.value) return

  isFilterDragging.value = false
  window.setTimeout(() => {
    filterDragMoved.value = false
    filterPointerLabel = ''
  }, 0)
}

function handleFilterPointerUp() {
  const label = filterPointerLabel
  const wasDragging = filterDragMoved.value
  endFilterDrag()
  if (!wasDragging && label) {
    activeFilter.value = label
  }
}

// 顶部指标随选择状态联动：总片段数 = 已选中 + 隐藏（基于全部片段）
const metrics = computed(() => {
  const total = props.cards.length
  const selected = props.cards.filter((c) => c.selected).length
  return [
    { label: '总片段数', value: String(total), icon: 'layers', tone: 'violet' },
    { label: '已选中', value: String(selected), icon: 'check', tone: 'green' },
    { label: '隐藏', value: String(total - selected), icon: 'zap', tone: 'blue' },
  ]
})
</script>

<template>
  <section class="context-panel" :class="{ collapsed }" aria-label="上下文工作台">
    <!-- 收起态：窄轨，仅留图标 + 展开按钮 -->
    <button
      v-if="collapsed"
      type="button"
      class="rail-toggle"
      aria-label="展开上下文栏"
      @click="$emit('expand')"
    >
      <span class="rail-content-icon"><AppIcon name="layers" :size="18" /></span>
      <AppIcon name="chevrons-right" :size="18" />
    </button>

    <template v-else>
      <header class="panel-header">
        <div>
          <h2>可控上下文工作台</h2>
        </div>
        <button
          type="button"
          class="icon-btn"
          aria-label="收起上下文栏"
          @click="$emit('collapse')"
        >
          <AppIcon name="chevrons-left" :size="16" />
        </button>
      </header>

    <div class="metric-grid" aria-label="上下文统计">
      <div
        v-for="m in metrics"
        :key="m.label"
        class="metric"
        :data-tone="m.tone"
      >
        <span class="metric-ico"><AppIcon :name="m.icon" :size="18" /></span>
        <div class="metric-body">
          <span class="metric-value">{{ m.value }}<small v-if="m.unit">{{ m.unit }}</small></span>
          <span class="metric-label">{{ m.label }}</span>
        </div>
      </div>
    </div>

    <button type="button" class="primary-action config-action" @click="$emit('configure')">
      <AppIcon name="sliders" :size="16" />
      <span>对话底盘配置</span>
    </button>

    <div
      ref="filterBarRef"
      class="filter-bar"
      :class="{ dragging: isFilterDragging }"
      aria-label="上下文类型筛选，可左右滑动"
      tabindex="0"
      @wheel="handleFilterWheel"
      @pointerdown="startFilterDrag"
      @pointermove="moveFilterDrag"
      @pointerup="handleFilterPointerUp"
      @pointercancel="endFilterDrag"
      @pointerleave="endFilterDrag"
    >
      <button
        v-for="filter in filters"
        :key="filter.label"
        type="button"
        :class="{ active: filter.active }"
        :data-filter-label="filter.label"
        @click="selectFilter(filter.label)"
      >
        {{ filter.label }}
        <span class="count">{{ filter.count }}</span>
      </button>
    </div>

    <div class="search-row">
      <label class="search-box">
        <span class="search-ico"><AppIcon name="search" :size="16" /></span>
        <span class="sr-only">搜索上下文片段</span>
        <input type="search" placeholder="搜索上下文片段..." />
      </label>

      <div class="context-toolbar">
        <button type="button" class="with-icon"><AppIcon name="filter" :size="14" />筛选</button>
      </div>
    </div>

    <div v-if="isSummarizing" class="context-status" aria-live="polite">
      <span class="status-dot pulse"></span>
      监督助手正在总结本轮对话…
    </div>

    <div v-if="filteredCards.length" class="context-list">
      <ContextCard
        v-for="card in filteredCards"
        :key="card.id"
        :card="card"
        :selected="card.selected"
        @toggle="$emit('toggle', card.id)"
        @update-priority="$emit('update-priority', $event)"
      />
    </div>
    <div v-else-if="!isSummarizing" class="context-empty" aria-live="polite">
      <span class="empty-icon"><AppIcon name="layers" :size="22" /></span>
      <h3>暂无上下文数据</h3>
      <p>发送第一条消息后，监督助手会自动总结成本卡片。</p>
    </div>
    </template>
  </section>
</template>
