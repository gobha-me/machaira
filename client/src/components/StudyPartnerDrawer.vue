<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useSettings } from '../stores/settings'
import { usePassageContext } from '../composables/usePassageContext'
import ModalDialog from './ui/ModalDialog.vue'
import StudyPartner from './StudyPartner.vue'

const props = defineProps<{ returnFocus: HTMLElement | null }>()
const settings = useSettings()
const passage = usePassageContext()
const media = window.matchMedia('(max-width: 768px)')
const mobile = ref(media.matches)
let opener: HTMLElement | null = null

function resize() { mobile.value = media.matches }
function close() { if (settings.studyPartnerOpen) settings.toggle('studyPartnerOpen') }
function onKey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.repeat || event.isComposing) return
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'y') {
    event.preventDefault()
    settings.toggle('studyPartnerOpen')
  } else if (event.key === 'Escape' && settings.studyPartnerOpen && !mobile.value
    && document.activeElement?.closest('#study-partner')) {
    event.preventDefault()
    close()
  }
}

watch([() => settings.studyPartnerOpen, mobile], async ([open], [wasOpen]) => {
  if (open && !wasOpen) opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  await nextTick()
  if (open && !mobile.value) document.querySelector<HTMLButtonElement>('#study-partner .close-partner')?.focus()
  if (!open) (opener?.isConnected ? opener : props.returnFocus)?.focus()
})

onMounted(() => {
  media.addEventListener('change', resize)
  window.addEventListener('keydown', onKey)
})
onUnmounted(() => {
  media.removeEventListener('change', resize)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <ModalDialog
    v-if="settings.studyPartnerOpen && mobile"
    labelledby="study-partner-title"
    placement="end"
    @close="close"
  >
    <div
      id="study-partner"
      class="partner-drawer mobile-sheet"
    >
      <StudyPartner
        :passage="passage"
        closable
        @close="close"
      />
    </div>
  </ModalDialog>
  <div
    v-else-if="settings.studyPartnerOpen"
    id="study-partner"
    class="partner-drawer"
  >
    <StudyPartner
      :passage="passage"
      closable
      @close="close"
    />
  </div>
</template>

<style scoped>
/* A flex sibling reserves space for the drawer; desktop reading text is never overlaid. */
.partner-drawer {
  width: clamp(320px, 35vw, 430px);
  flex-shrink: 0;
  min-height: 0;
  display: flex;
  border-left: 1px solid var(--line);
}
.partner-drawer :deep(.partner) { width: 100%; }
.mobile-sheet {
  width: 100%;
  height: 100dvh;
  border: 0;
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
  box-sizing: border-box;
}
</style>
