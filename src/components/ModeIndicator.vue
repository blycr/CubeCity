<script setup>
import { eventBus } from '@/js/utils/event-bus.js'
import gsap from 'gsap'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useGameState } from '../stores/useGameState'

const gameState = useGameState()
const aiStatus = ref({ running: false, reason: '', phase: '' })
function onAiStatus(payload) {
  aiStatus.value = { ...aiStatus.value, ...payload }
}
onMounted(() => {
  eventBus.on('agent:ai-status', onAiStatus)
})
onUnmounted(() => {
  eventBus.off('agent:ai-status', onAiStatus)
})
const modeLabel = computed(() => {
  const isZh = gameState.language === 'zh'
  switch (gameState.currentMode) {
    case 'build': return isZh ? '建造' : 'BUILD'
    case 'relocate': return isZh ? '搬迁' : 'RELOCATE'
    case 'demolish': return isZh ? '拆除' : 'DEMOLISH'
    case 'select': return isZh ? '选择' : 'SELECT'
    default: return gameState.currentMode?.toUpperCase() || 'UNKNOWN'
  }
})

// 颜色 class
const modeColorClass = computed(() => {
  switch (gameState.currentMode) {
    case 'build': return 'text-green-500'
    case 'relocate': return 'text-blue-500'
    case 'demolish': return 'text-red-500'
    case 'select': return 'text-yellow-500'
    default: return 'text-industrial-accent'
  }
})

// 绑定 span 的 ref
const modeSpan = ref(null)

// 监听 mode 变化，触发 gsap 动画
watch(() => gameState.currentMode, (newVal, oldVal) => {
  if (newVal !== oldVal && modeSpan.value) {
    gsap.fromTo(
      modeSpan.value,
      { fontSize: 12 },
      {
        fontSize: 16,
        duration: 0.18,
        yoyo: true,
        repeat: 1,
        ease: 'bounce.out',
        clearProps: 'fontSize',
      },
    )
  }
})
</script>

<template>
  <div class="absolute top-4 left-4 flex flex-col gap-2 pointer-events-none">
    <div class="resource-display rounded px-3 py-1 w-fit">
      <span class="text-xs text-gray-400 uppercase tracking-wide">{{ gameState.language === 'zh' ? '模式:' : 'MODE:' }}</span>
      <span
        ref="modeSpan"
        class="text-sm font-bold ml-2 transition-colors duration-200"
        :class="modeColorClass"
      >
        {{ modeLabel }}
      </span>
    </div>
    <div
      v-if="aiStatus.running && aiStatus.reason"
      class="resource-display rounded px-3 py-1 text-xs text-industrial-green font-medium max-w-md truncate"
    >
      🤖 {{ aiStatus.reason }}
    </div>
  </div>
</template>
