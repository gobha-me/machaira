<script setup lang="ts">
const props = defineProps<{ modelValue: boolean; disabled?: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

function toggle() {
  if (!props.disabled) emit('update:modelValue', !props.modelValue)
}
</script>

<template>
  <span
    class="toggle"
    :class="{ on: modelValue, disabled }"
    role="switch"
    :aria-checked="modelValue"
    @click="toggle"
  >
    <span class="knob"></span>
  </span>
</template>

<style scoped>
.toggle {
  width: 36px;
  height: 21px;
  border-radius: 11px;
  background: var(--line);
  position: relative;
  display: inline-block;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s;
}
.toggle.on {
  background: var(--accent);
}
.toggle.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.knob {
  position: absolute;
  top: 2.5px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--card);
  box-shadow: 0 1px 3px rgba(30, 22, 10, 0.2);
  transition: left 0.15s;
}
.toggle.on .knob {
  left: 17px;
  background: var(--on-accent);
}
</style>
