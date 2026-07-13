declare module 'node-sword-interface' {
  interface LocalModule {
    name: string
    description?: string
    language?: string
    distributionLicense?: string
    repository?: string
    version?: string
    size?: number
    hasStrongs?: boolean
    hasGreekStrongsKeys?: boolean
    hasHebrewStrongsKeys?: boolean
    hasFootnotes?: boolean
    hasHeadings?: boolean
    hasRedLetterWords?: boolean
    hasCrossReferences?: boolean
    locked?: boolean
    [key: string]: unknown
  }

  interface Verse {
    moduleCode: string
    bibleBookShortTitle: string
    chapter: number
    verseNr: number
    absoluteVerseNr: number
    content: string
  }

  interface StrongsEntry {
    rawEntry: string
    key: string
    transcription: string
    phoneticTranscription: string
    definition: string
    references: unknown[]
  }

  interface InstallProgress {
    totalPercent: number
    filePercent: number
    message: string
  }

  export default class NodeSwordInterface {
    constructor(customHomeDir?: string, localesBasePath?: string, timeoutMillis?: number)
    repositoryConfigExisting(): boolean
    updateRepositoryConfig(progressCB?: (p: unknown) => void): Promise<unknown>
    getRepoNames(): string[]
    getAllRepoModules(repositoryName: string, moduleType?: string): LocalModule[]
    getRepoModule(moduleCode: string): LocalModule
    isModuleAvailableInRepo(moduleCode: string, repositoryName?: string): boolean
    getAllLocalModules(moduleType?: string): LocalModule[]
    getLocalModule(moduleCode: string): LocalModule | undefined
    refreshLocalModules(): void
    installModule(
      repositoryName: string,
      moduleCode: string,
      progressCB?: (p: InstallProgress) => void
    ): Promise<void>
    uninstallModule(moduleCode: string): Promise<void>
    cancelInstallation(): void
    getBookList(moduleCode: string): string[]
    getBookChapterCount(moduleCode: string, bookCode: string): number
    getChapterVerseCount(moduleCode: string, bookCode: string, chapter: number): number
    getChapterText(moduleCode: string, bookCode: string, chapter: number): Verse[]
    getBookText(moduleCode: string, bookCode: string): Verse[]
    getStrongsEntry(strongsKey: string): StrongsEntry | undefined
    greekStrongsAvailable(): boolean
    hebrewStrongsAvailable(): boolean
    getModuleSearchResults(
      moduleCode: string,
      searchTerm: string,
      progressCB?: (p: unknown) => void,
      searchType?: string,
      searchScope?: string,
      isCaseSensitive?: boolean,
      useExtendedVerseBoundaries?: boolean,
      filterOnWordBoundaries?: boolean
    ): Promise<Verse[]>
    enableMarkup(): void
    disableMarkup(): void
    getSwordVersion(): string
    getSwordPath(): string
  }
}
