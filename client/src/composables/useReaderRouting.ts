import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { passageRoute, readPassage, type PassageLocation } from '../router'
import { useReader } from '../stores/reader'

export function useReaderRouting(ready: Ref<boolean>) {
  const router = useRouter()
  const reader = useReader()
  const routeError = ref<string | null>(null)
  let generation = 0
  let initializationGeneration = 0
  let openingRoute = false
  onScopeDispose(() => {
    generation += 1
    initializationGeneration += 1
  })

  const passage = computed<PassageLocation | null>(() => {
    const { moduleName, book, chapter, data } = reader
    if (!moduleName || !book || reader.loadingChapter || reader.error ||
      data?.module !== moduleName || data.book !== book || data.chapter !== chapter) return null
    return {
      moduleName, book, chapter,
      verseStart: reader.selectionBounds?.lo ?? null,
      verseEnd: reader.selectionBounds?.hi ?? null
    }
  })
  function matches(target: PassageLocation): boolean {
    return JSON.stringify(target) === JSON.stringify(passage.value)
  }
  function landingRoute() {
    return passage.value ? passageRoute(passage.value) : { name: 'read' }
  }

  async function initialize(): Promise<void> {
    const initialization = ++initializationGeneration
    const userId = reader.activeUserId
    await router.isReady()
    const route = router.currentRoute.value
    const target = readPassage(route)
    await reader.init(target ?? undefined)
    if (initialization !== initializationGeneration || userId !== reader.activeUserId) return
    if (route === router.currentRoute.value && target && !matches(target)) {
      routeError.value = 'This passage link is not available in your library.'
      await router.replace(landingRoute())
    }
  }

  watch(() => reader.activeUserId, () => {
    generation += 1
    openingRoute = false
    routeError.value = null
  }, { flush: 'sync' })

  watch([() => router.currentRoute.value, ready], async ([route, isReady]) => {
    const request = ++generation
    openingRoute = false
    if (!isReady || route.name !== 'read') return
    const target = readPassage(route)
    if (target && !matches(target)) {
      openingRoute = true
      routeError.value = null
      const result = await reader.openRoute(target, () => request === generation)
      if (request !== generation) return
      openingRoute = false
      if (!result.ok) {
        routeError.value = result.error
        await router.replace(landingRoute())
      }
    } else if (!target && passage.value) {
      await router.replace(landingRoute())
    }
  }, { flush: 'sync' })

  watch(passage, (next, previous) => {
    if (!next || !ready.value || openingRoute || router.currentRoute.value.name !== 'read') return
    const target = readPassage(router.currentRoute.value)
    if (target && matches(target)) return
    // Chapter navigation belongs in Back/Forward history. Verse selection updates the
    // shareable URL in place, so selecting a range does not fill history with clicks.
    const sameChapter = previous && next.moduleName === previous.moduleName &&
      next.book === previous.book && next.chapter === previous.chapter
    const replace = !target || sameChapter
    void router[replace ? 'replace' : 'push'](passageRoute(next))
  })

  return { initialize, routeError }
}
