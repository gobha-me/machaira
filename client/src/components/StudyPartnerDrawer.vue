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
  if (open && !mobile.value) document.querySelector<HTMLButtonElement>('#study-partner .close-partner')?.focus({ preventScroll: true })
  if (!open) (opener?.isConnected ? opener : props.returnFocus)?.focus({ preventScroll: true })
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
  <div class="partner-slot">
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
  </div>
</template>

<style scoped>
/* Keep the desktop column even while closed so toggling never rewraps or scrolls
   the reading passage. Below 1100px it takes no layout space at all. */
.partner-slot {
  width: clamp(320px, 35vw, 430px);
  flex-shrink: 0;
  position: relative;
  min-height: 0;
  display: flex;
}
.partner-drawer {
  width: 100%;
  min-height: 0;
  display: flex;
  border-left: 1px solid var(--line);
  box-sizing: border-box;
}
.partner-drawer :deep(.partner) { width: 100%; }
@media (width < 1100px) {
  .partner-slot { width: 0; }
  .partner-drawer:not(.mobile-sheet) {
    position: absolute;
    inset: 0 0 0 auto;
    z-index: 40;
    width: clamp(320px, 40vw, 430px);
    box-shadow: -12px 0 30px #0002;
  }
}
.mobile-sheet {
  width: 100%;
  height: 100dvh;
  border: 0;
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
  box-sizing: border-box;
}
</style>
