import { createRouter, createWebHashHistory, type RouteLocationNormalized, type RouterHistory } from 'vue-router'
import { validModuleName } from '@machaira/scripture'
import ReadScreen from './screens/ReadScreen.vue'
import PlanScreen from './screens/PlanScreen.vue'
import StudyScreen from './screens/StudyScreen.vue'
import SearchScreen from './screens/SearchScreen.vue'
import LibraryScreen from './screens/LibraryScreen.vue'
import JournalScreen from './screens/JournalScreen.vue'
import SettingsScreen from './screens/SettingsScreen.vue'

export interface PassageLocation {
  moduleName: string
  book: string
  chapter: number
  verseStart: number | null
  verseEnd: number | null
}

function positiveInteger(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

export function readPassage(route: RouteLocationNormalized): PassageLocation | null {
  if (route.name !== 'read') return null
  const { module, book, chapter, verse } = route.params
  if (!validModuleName(module)) return null
  if (typeof book !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(book)) return null
  if (typeof chapter !== 'string') return null
  const chapterNumber = positiveInteger(chapter)
  if (chapterNumber === null) return null
  if (!verse) return { moduleName: module, book, chapter: chapterNumber, verseStart: null, verseEnd: null }
  if (typeof verse !== 'string' || !/^[1-9]\d*(?:-[1-9]\d*)?$/.test(verse)) return null
  const [start, end = start] = verse.split('-')
  const verseStart = positiveInteger(start)
  const verseEnd = positiveInteger(end)
  if (verseStart === null || verseEnd === null || verseEnd < verseStart) return null
  return { moduleName: module, book, chapter: chapterNumber, verseStart, verseEnd }
}

export function passageRoute(passage: PassageLocation) {
  const verse = passage.verseStart === null ? '' : passage.verseEnd !== null && passage.verseEnd !== passage.verseStart
    ? `${passage.verseStart}-${passage.verseEnd}` : String(passage.verseStart)
  return {
    name: 'read',
    params: { module: passage.moduleName, book: passage.book, chapter: String(passage.chapter), verse }
  }
}

export function createAppRouter(history: RouterHistory = createWebHashHistory()) {
  const router = createRouter({
    history,
    routes: [
      { path: '/read/:module?/:book?/:chapter?/:verse?', name: 'read', component: ReadScreen },
      { path: '/plan', name: 'plan', component: PlanScreen },
      { path: '/study', name: 'study', component: StudyScreen },
      { path: '/search', name: 'search', component: SearchScreen },
      { path: '/library', name: 'library', component: LibraryScreen },
      { path: '/journal', name: 'journal', component: JournalScreen },
      { path: '/settings', name: 'settings', component: SettingsScreen },
      { path: '/:pathMatch(.*)*', redirect: { name: 'read' } }
    ]
  })
  router.beforeEach((to) => {
    if (to.name === 'read' && Object.values(to.params).some(Boolean) && !readPassage(to)) {
      return { name: 'read', replace: true }
    }
  })
  return router
}
