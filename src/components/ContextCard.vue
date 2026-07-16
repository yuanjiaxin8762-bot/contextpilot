<script setup>
import AppIcon from './AppIcon.vue'

defineProps({
  card: { type: Object, required: true },
  selected: { type: Boolean, default: false },
})

defineEmits(['toggle', 'update-priority'])
</script>

<template>
  <article class="context-card" :class="{ selected }">
    <div class="card-topline">
      <span class="category-pill" :data-category="card.category">{{ card.category }}</span>
      <div class="card-actions">
<!--        <label class="priority-select" :data-priority="card.priority">-->
<!--          <span class="sr-only">设置优先级</span>-->
<!--          <select-->
<!--            :value="card.priority"-->
<!--            :aria-label="`${card.title} 优先级`"-->
<!--            @change="$emit('update-priority', { id: card.id, priority: $event.target.value })"-->
<!--          >-->
<!--            <option value="高">高优先级</option>-->
<!--            <option value="中">中优先级</option>-->
<!--            <option value="低">低优先级</option>-->
<!--          </select>-->
<!--        </label>-->
        <label
          class="card-check"
          :class="{ checked: selected }"
          :title="selected ? '取消选择该片段' : '选择该片段'"
        >
          <input type="checkbox" :checked="selected" @change="$emit('toggle')" />
          <AppIcon name="check" :size="13" />
        </label>
      </div>
    </div>
    <h3>{{ card.title }}</h3>
    <p>{{ card.body }}</p>
  </article>
</template>
