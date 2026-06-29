<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Filler,
} from 'chart.js'

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler)

const { t } = useI18n()
const canvasRef = ref(null)
const chartRef = ref(null)
const running = ref(false)
const useLargeDataset = ref(false)
const fps = ref(0)
const durationMs = ref(0)
const frameCount = ref(0)
const startTime = ref(0)
let rafId = 0

const labels = computed(() => t('chart.performanceTest'))
const dataPointCount = computed(() => (useLargeDataset.value ? 5000 : 500))
const datasetCount = computed(() => (useLargeDataset.value ? 4 : 2))
const estimatedRender = computed(() => `${Math.round(dataPointCount.value * datasetCount.value / 1000)}k 节点`)

function buildData() {
  const count = dataPointCount.value
  const datasets = Array.from({ length: datasetCount.value }, (_, index) => ({
    label: `Series ${index + 1}`,
    data: Array.from({ length: count }, (_, i) => Math.sin(i / 40 + index) * 40 + 50 + index * 5),
    borderColor: ['#6366f1', '#3b82f6', '#0f9d76', '#b06a10'][index % 4],
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    pointRadius: 0,
    tension: 0.25,
  }))

  return {
    labels: Array.from({ length: count }, (_, i) => i),
    datasets,
  }
}

function renderChart() {
  if (!canvasRef.value) return
  chartRef.value?.destroy()

  chartRef.value = new Chart(canvasRef.value, {
    type: 'line',
    data: buildData(),
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: { display: false },
      },
    },
  })
}

function tick() {
  if (!running.value) return
  frameCount.value += 1
  const elapsed = performance.now() - startTime.value
  durationMs.value = Math.round(elapsed)
  fps.value = elapsed > 0 ? Math.round((frameCount.value / elapsed) * 1000) : 0
  renderChart()
  rafId = requestAnimationFrame(tick)
}

function startTest() {
  stopTest()
  running.value = true
  frameCount.value = 0
  startTime.value = performance.now()
  durationMs.value = 0
  fps.value = 0
  rafId = requestAnimationFrame(tick)
}

function stopTest() {
  running.value = false
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
}

function toggleDataset() {
  useLargeDataset.value = !useLargeDataset.value
  if (running.value) startTest()
  else renderChart()
}

onMounted(renderChart)
onBeforeUnmount(() => {
  stopTest()
  chartRef.value?.destroy()
})
</script>

<template>
  <section class="chart-performance">
    <header class="chart-performance__head">
      <h3>{{ labels.title }}</h3>
      <div class="chart-performance__actions">
        <button type="button" @click="toggleDataset">
          {{ useLargeDataset ? labels.switchToSmall : labels.switchToLarge }}
        </button>
        <button type="button" class="primary" @click="startTest" :disabled="running">Start</button>
        <button type="button" @click="stopTest" :disabled="!running">{{ labels.stopTest }}</button>
      </div>
    </header>

    <div class="chart-performance__stats">
      <span>{{ labels.dataPoints }}: {{ dataPointCount }}</span>
      <span>{{ labels.datasets }}: {{ datasetCount }}</span>
      <span>{{ labels.estimatedRender }}: {{ estimatedRender }}</span>
      <span>{{ labels.fps }}: {{ fps }}</span>
      <span>{{ labels.duration }}: {{ durationMs }} ms</span>
    </div>

    <div class="chart-performance__canvas">
      <canvas ref="canvasRef" aria-label="chart performance canvas"></canvas>
    </div>
  </section>
</template>

<style scoped>
.chart-performance {
  margin-top: 12px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
}

.chart-performance__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.chart-performance__head h3 {
  margin: 0;
  font-size: 14px;
}

.chart-performance__actions {
  display: flex;
  gap: 8px;
}

.chart-performance__actions button {
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--text);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
}

.chart-performance__actions button.primary {
  border-color: transparent;
  background: var(--brand-grad);
  color: #fff;
}

.chart-performance__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 10px;
  color: var(--muted);
  font-size: 12px;
}

.chart-performance__canvas {
  height: 220px;
}
</style>
