<script setup>
import { computed, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { createDefaultChatConfig, normalizeChatConfig } from '../model/chatAdapter.js'

const props = defineProps({
  sessionTitle: { type: String, required: true },
  config: { type: Object, default: () => createDefaultChatConfig() },
  saving: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

const emit = defineEmits(['close', 'save'])

const stages = ['需求澄清', '方案设计', '实现与调试', '测试与验证', '交付与复盘']
const suggestedRules = ['优先给出可执行结论', '涉及不确定性时说明假设', '改动建议附带验证方式']
const tools = [
  { key: 'readFiles', label: '读取文件', description: '允许读取当前项目文件与配置', icon: 'layers' },
  { key: 'runTests', label: '运行测试', description: '允许执行测试与生成验证结果', icon: 'check' },
  { key: 'writeFiles', label: '写入文件', description: '写入前需要人工确认', icon: 'pencil' },
  { key: 'network', label: '联网', description: '允许访问外部网络与文档', icon: 'share' },
]

const draft = ref(createDefaultChatConfig())
const newRule = ref('')

watch(
  () => props.config,
  (config) => {
    draft.value = normalizeChatConfig(config)
    newRule.value = ''
  },
  { immediate: true, deep: true },
)

const activeRules = computed(() => draft.value.rules || [])

function toggleRule(rule) {
  const rules = [...activeRules.value]
  const index = rules.indexOf(rule)
  if (index >= 0) rules.splice(index, 1)
  else rules.push(rule)
  draft.value.rules = rules
}

function addRule() {
  const value = newRule.value.trim()
  if (!value || activeRules.value.includes(value)) return
  draft.value.rules = [...activeRules.value, value]
  newRule.value = ''
}

function removeRule(rule) {
  draft.value.rules = activeRules.value.filter((item) => item !== rule)
}

function toolState(key) {
  return draft.value.toolPermissions?.[key] || 'deny'
}

function toolStateLabel(key) {
  const state = toolState(key)
  return state === 'allow' ? '允许' : state === 'confirm' ? '需确认' : '关闭'
}

function toggleTool(key) {
  const state = toolState(key)
  const next = state === 'deny' ? (key === 'writeFiles' ? 'confirm' : 'allow') : 'deny'
  draft.value.toolPermissions = {
    ...draft.value.toolPermissions,
    [key]: next,
  }
}

function submit() {
  emit('save', normalizeChatConfig(draft.value))
}
</script>

<template>
  <Teleport to="body">
    <div class="session-config-overlay" role="presentation" @click.self="$emit('close')">
      <section
        class="session-config-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-config-title"
        @keydown.esc="$emit('close')"
      >
        <header class="session-config-header">
          <div>
            <div class="session-config-title-row">
              <h2 id="session-config-title">对话底盘配置</h2>
              <span>{{ sessionTitle }}</span>
            </div>
            <p>配置会随当前对话保存，并在后续每轮对话中作为系统指令生效。</p>
          </div>
          <button type="button" class="icon-btn session-config-close" aria-label="关闭对话底盘配置" @click="$emit('close')">
            <AppIcon name="x" :size="18" />
          </button>
        </header>

        <form class="session-config-form" @submit.prevent="submit">
          <div class="config-row">
            <div class="config-row-label">
              <span class="config-row-number">1</span>
              <div>
                <h3>对话目标</h3>
                <p>定义本次对话希望达成的目标与预期产出</p>
              </div>
            </div>
            <label class="config-field">
              <span class="sr-only">对话目标</span>
              <textarea v-model="draft.goal" maxlength="300" placeholder="例如：定位支付回调状态不一致的原因，并给出可验证的修复方案。"></textarea>
              <small>{{ draft.goal.length }} / 300</small>
            </label>
          </div>

          <div class="config-row">
            <div class="config-row-label">
              <span class="config-row-number">2</span>
              <div>
                <h3>当前阶段</h3>
                <p>帮助模型聚焦当前的协作重点</p>
              </div>
            </div>
            <label class="config-select">
              <span class="sr-only">当前阶段</span>
              <select v-model="draft.stage">
                <option v-for="stage in stages" :key="stage" :value="stage">{{ stage }}</option>
              </select>
              <AppIcon name="chevron" :size="17" />
            </label>
          </div>

          <div class="config-row">
            <div class="config-row-label">
              <span class="config-row-number">3</span>
              <div>
                <h3>对话规则</h3>
                <p>约束模型在本对话中的回答方式与边界</p>
              </div>
            </div>
            <div class="config-rules">
              <button
                v-for="rule in suggestedRules"
                :key="rule"
                type="button"
                class="config-rule"
                :class="{ selected: activeRules.includes(rule) }"
                :aria-pressed="activeRules.includes(rule)"
                @click="toggleRule(rule)"
              >
                <span class="config-rule-check"><AppIcon name="check" :size="13" /></span>
                {{ rule }}
              </button>
              <label class="config-add-rule">
                <span class="sr-only">添加对话规则</span>
                <input v-model="newRule" maxlength="80" placeholder="添加规则" @keydown.enter.prevent="addRule" />
                <button type="button" aria-label="添加规则" @click="addRule"><AppIcon name="plus" :size="15" /></button>
              </label>
              <button
                v-for="rule in activeRules.filter((rule) => !suggestedRules.includes(rule))"
                :key="rule"
                type="button"
                class="config-rule selected custom"
                :title="rule"
                @click="removeRule(rule)"
              >
                {{ rule }}
                <AppIcon name="x" :size="14" />
              </button>
            </div>
          </div>

          <div class="config-row">
            <div class="config-row-label">
              <span class="config-row-number">4</span>
              <div>
                <h3>工具权限</h3>
                <p>作为模型本轮及后续对话的工具使用边界</p>
              </div>
            </div>
            <div class="config-tool-grid">
              <article v-for="tool in tools" :key="tool.key" class="config-tool" :data-state="toolState(tool.key)">
                <div class="config-tool-topline">
                  <span class="config-tool-icon"><AppIcon :name="tool.icon" :size="17" /></span>
                  <span class="config-tool-state">{{ toolStateLabel(tool.key) }}</span>
                </div>
                <h4>{{ tool.label }}</h4>
                <p>{{ tool.description }}</p>
                <button
                  type="button"
                  class="config-switch"
                  :class="{ enabled: toolState(tool.key) !== 'deny' }"
                  :aria-label="`${tool.label}${toolState(tool.key) === 'deny' ? '已关闭，点击开启' : '已开启，点击关闭'}`"
                  :aria-pressed="toolState(tool.key) !== 'deny'"
                  @click="toggleTool(tool.key)"
                >
                  <span></span>
                </button>
              </article>
            </div>
          </div>

          <div class="config-row">
            <div class="config-row-label">
              <span class="config-row-number">5</span>
              <div>
                <h3>验收标准</h3>
                <p>定义完成当前目标时需要满足的验证条件</p>
              </div>
            </div>
            <label class="config-field">
              <span class="sr-only">验收标准</span>
              <textarea v-model="draft.acceptanceCriteria" maxlength="500" placeholder="例如：给出根因、修改建议、影响范围和可执行的验证步骤。"></textarea>
              <small>{{ draft.acceptanceCriteria.length }} / 500</small>
            </label>
          </div>

          <div class="config-row">
            <div class="config-row-label">
              <span class="config-row-number">6</span>
              <div>
                <h3>项目记忆</h3>
                <p>记录需要跨轮持续遵循的事实、决定与约束</p>
              </div>
            </div>
            <label class="config-field">
              <span class="sr-only">项目记忆</span>
              <textarea v-model="draft.projectMemory" maxlength="500" placeholder="例如：已确认的技术约束、历史结论、关键接口或待避免的方案。"></textarea>
              <small>{{ draft.projectMemory.length }} / 500</small>
            </label>
          </div>

          <footer class="session-config-footer">
            <p v-if="error" class="session-config-error" role="alert">{{ error }}</p>
            <div class="session-config-actions">
              <button type="submit" class="primary-action" :disabled="saving">
                <AppIcon name="check" :size="16" />
                <span>{{ saving ? '正在保存…' : '保存对话配置' }}</span>
              </button>
              <button type="button" class="secondary-action" :disabled="saving" @click="$emit('close')">取消</button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>
