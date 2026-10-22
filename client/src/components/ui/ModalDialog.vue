<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

defineProps<{ labelledby: string; placement?: 'end' }>()
const emit = defineEmits<{ (event: 'close'): void }>()
const root = ref<HTMLElement | null>(null)
const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
const background: Array<{ element: Element; inert: string | null; hidden: string | null }> = []

function controls(): HTMLElement[] {
  return Array.from(root.value?.querySelectorAll<HTMLElement>(
    'button, a[href], input:not([type="hidden"]), select, textarea, [tabindex]'
  ) ?? []).filter((element) => {
    if (element.tabIndex < 0 || element.matches(':disabled') || element.closest('[hidden], [inert]')) return false
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor)
      if (style.display === 'none' || style.visibility === 'hidden') return false
    }
    return true
  })
}

function focusFirst(): void {
  (controls()[0] ?? root.value)?.focus()
}

function containFocus(event: FocusEvent): void {
  if (event.target instanceof Node && !root.value?.contains(event.target)) focusFirst()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
  } else if (event.key === 'Tab') {
    const targets = controls()
    const index = targets.indexOf(document.activeElement as HTMLElement)
    event.preventDefault()
    if (!targets.length) {
      root.value?.focus()
      return
    }
    const next = index < 0 ? (event.shiftKey ? targets.length - 1 : 0)
      : (index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length
    const target = targets[next] ?? root.value
    target?.focus()
  }
}

onMounted(() => {
  // Teleport leaves the dialog outside the app so the background can be made inert.
  // Preserve existing attributes, including an already-hidden background.
  for (const element of document.body.children) {
    if (element === root.value || element.contains(root.value)) continue
    background.push({ element, inert: element.getAttribute('inert'), hidden: element.getAttribute('aria-hidden') })
    element.setAttribute('inert', '')
    element.setAttribute('aria-hidden', 'true')
  }
  document.addEventListener('focusin', containFocus)
  // A removed focused control can leave focus on body; keep Tab contained there too.
  document.addEventListener('keydown', onKeydown)
  focusFirst()
})

onBeforeUnmount(() => {
  document.removeEventListener('focusin', containFocus)
  document.removeEventListener('keydown', onKeydown)
  for (const { element, inert, hidden } of background) {
    if (inert === null) element.removeAttribute('inert')
    else element.setAttribute('inert', inert)
    if (hidden === null) element.removeAttribute('aria-hidden')
    else element.setAttribute('aria-hidden', hidden)
  }
  if (opener?.isConnected) opener.focus()
})
</script>

<template>
  <Teleport to="body">
    <!-- eslint-disable-next-line vuejs-accessibility/click-events-have-key-events, vuejs-accessibility/no-static-element-interactions -- Backdrop dismissal supplements the dialog Escape handler and explicit close controls. -->
    <div
      ref="root"
      class="dialog-backdrop"
      :class="{ 'at-end': placement === 'end' }"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="labelledby"
      tabindex="-1"
      @click.self="emit('close')"
    >
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
.dialog-backdrop { position: fixed; z-index: 80; inset: 0; display: grid; place-items: center; padding: 20px; background: #0007; }
.dialog-backdrop.at-end { display: flex; justify-content: flex-end; padding: 0; }
</style>
