<script setup lang="ts">
import { computed } from 'vue'
import { useUi, SCREENS } from '../stores/ui'
import { useReadingPlan } from '../stores/readingPlan'

const ui = useUi()
const plan = useReadingPlan()

// The Plan tab is opt-in — it only appears once the reading plan is turned on.
const visibleScreens = computed(() => SCREENS.filter((s) => s.id !== 'plan' || plan.enabled))
</script>

<template>
  <nav class="rail">
    <div class="brand">
      <div class="brand-mark"></div>
      <div class="brand-name serif">Sword</div>
    </div>
    <div class="rail-items">
      <button
        v-for="s in visibleScreens"
        :key="s.id"
        class="rail-btn hover-soft"
        @click="ui.go(s.id)"
      >
        <span class="rail-dot" :style="{ background: ui.screen === s.id ? 'var(--accent)' : 'transparent' }"></span>
        <span
          class="rail-label"
          :style="{
            color: ui.screen === s.id ? 'var(--accent)' : 'var(--muted)',
            fontWeight: ui.screen === s.id ? 700 : 500
          }"
        >{{ s.label }}</span>
      </button>
    </div>
    <div class="rail-foot">⌘K<br />search</div>
  </nav>
</template>

<style scoped>
.rail {
  width: 96px;
  flex-shrink: 0;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 22px 0 18px;
}
.brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-bottom: 34px;
}
.brand-mark {
  width: 8px;
  height: 8px;
  background: var(--accent);
  transform: rotate(45deg);
}
.brand-name {
  font-style: italic;
  font-weight: 600;
  font-size: 16px;
  letter-spacing: 0.06em;
}
.rail-items {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}
.rail-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  cursor: pointer;
  padding: 11px 0;
  width: 100%;
}
.rail-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}
.rail-label {
  font-size: 10.5px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}
.rail-foot {
  margin-top: auto;
  font-size: 10px;
  color: var(--muted);
  letter-spacing: 0.08em;
  text-align: center;
  line-height: 1.7;
}
</style>
