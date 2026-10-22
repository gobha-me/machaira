/** Local-first, account-scoped cache with debounced last-write-wins server sync. */
export class AccountCache<T extends { updated_at: number }> {
  current: T | null = null
  private userId: string | null = null
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private options: {
    key: (userId: string) => string
    parse: (value: unknown) => T | null
    get: () => Promise<T | null>
    put: (value: T) => Promise<T>
    apply: (value: T) => void
  }) {}

  activate(userId: string | null): void {
    this.generation += 1
    clearTimeout(this.timer)
    this.userId = userId
    this.current = null
    if (!userId) return
    try {
      this.current = this.options.parse(JSON.parse(localStorage.getItem(this.options.key(userId)) ?? 'null'))
    } catch {
      // Missing, corrupt or blocked browser storage must not prevent reading.
    }
    if (this.current) this.options.apply(this.current)
  }

  async restore(): Promise<void> {
    if (!this.userId) return
    const generation = this.generation
    try {
      const remote = await this.options.get()
      if (generation !== this.generation) return
      if (remote && (!this.current || remote.updated_at >= this.current.updated_at)) {
        this.accept(remote)
      } else if (this.current) this.schedule()
    } catch {
      // Keep the local cache usable while offline. A later change/login/reconnect retries sync.
    }
  }

  update(value: Omit<T, 'updated_at'>): void {
    if (!this.userId) return
    if (this.current) {
      const { updated_at: _timestamp, ...previous } = this.current
      if (JSON.stringify(previous) === JSON.stringify(value)) return
    }
    this.current = { ...value, updated_at: Math.max(Date.now(), (this.current?.updated_at ?? 0) + 1) } as T
    this.cache()
    this.schedule()
  }

  private cache(): void {
    if (!this.userId || !this.current) return
    try { localStorage.setItem(this.options.key(this.userId), JSON.stringify(this.current)) }
    catch { /* Browser storage is best effort; server sync can still succeed. */ }
  }

  private accept(value: T): void {
    clearTimeout(this.timer)
    this.current = value
    this.cache()
    this.options.apply(value)
  }

  private schedule(): void {
    clearTimeout(this.timer)
    const generation = this.generation
    this.timer = setTimeout(() => { void this.save(generation) }, 1000)
  }

  private async save(generation: number): Promise<void> {
    if (generation !== this.generation || !this.current || !this.userId) return
    try {
      const remote = await this.options.put(this.current)
      if (generation !== this.generation) return
      // A pending response must not roll back edits made while its request was in flight.
      if (this.current && remote.updated_at >= this.current.updated_at) this.accept(remote)
    } catch {
      // The immediate local write survives network/server failure and is retried on restore.
    }
  }
}
