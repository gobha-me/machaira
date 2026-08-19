# CLAUDE.md

Guidance for working in this repo. Keep it short and durable — conventions and
invariants only. Status and change history live in GitHub issues + git log, not here.

## What this is

**Sword** (repo `machaira`, Greek *máchaira* = "sword") is a local-first Bible study
app in the SWORD Project family. A Node backend wraps the SWORD engine and exposes JSON;
a Vue 3 frontend renders six screens (Read, Study, Search, Library, Journal, Settings).

## Commands

```bash
npm install          # also compiles the node-sword-interface native addon (see below)
npm run dev          # runs server + client together (concurrently)
npm run dev:server   # Fastify API on http://127.0.0.1:5274
npm run dev:client   # Vite dev server on http://localhost:5273 (proxies /api -> :5274)
npm run build        # server (tsc) then client (vue-tsc -b && vite build)
docker build .       # production image: native addon + server + compiled client
```

Per-workspace: `npm -w server run <script>`, `npm -w client run <script>`. There is no
`typecheck` script yet — use `npx vue-tsc --noEmit` (client) / `npx tsc --noEmit` (server).

## Layout

npm workspaces: `client/` (Vue 3 + Vite + TS) and `server/` (Fastify + TS, ESM).

- `server/src/sword.ts` — the only module that touches `node-sword-interface`. Singleton
  + all public API.
- `server/src/app.ts` — testable Fastify app factory; `auth.ts` + `database.ts` own users,
  sessions, and SQLite migrations. `secrets.ts` is the server-only encrypted secret store;
  `ai.ts` owns provider configuration, prompts, and streaming adapters.
- `server/src/routes/` — `auth.ts` (bootstrap/login/account administration), `personal-data.ts`
  (per-user notes/highlights and legacy import), `sources.ts`
  (repos, install/uninstall via SSE), `read.ts`
  (books, chapter), `study.ts` (compare, strongs, search), `ai.ts` (provider settings and chat),
  `semantic.ts` (embedding index/search), and `connections.ts` (derived passage graph).
- `server/src/text.ts` — SWORD markup handling (`stripMarkup`, `parseVerseMarkup`).
- `server/src/books.ts` — book code → display name / section.
- `server/data/sword/` — downloaded SWORD modules at runtime (gitignored).
- `client/src/stores/` — Pinia: `settings`, `ui`, `reader`, `library`, `notes`.
- `client/src/screens/` — one `.vue` per screen. `client/src/services/api.ts` (typed
  fetch client), `db.ts` (IndexedDB). `client/src/theme.ts` — design tokens.
- `Dockerfile` + `deploy/helm/machaira/` — non-root production image and single-replica
  Kubernetes deployment. `/app/server/data` is the sole persistent volume mount.

## Backend invariants (important)

- **`node-sword-interface` is a native addon that compiles on `npm install`.** It needs
  system build tools: `build-essential cmake pkg-config subversion libcurl4-openssl-dev
  libicu-dev zlib1g-dev`. If install fails, that toolchain is the first thing to check.
- **libsword is not reentrant.** A native call issued while another is in flight crashes
  the addon. Every access to the singleton is funneled through the `withSword()`
  promise-chain mutex in `sword.ts`. Never call the addon directly outside that.
- **Markup is a process-wide flag.** `enableMarkup()`/`disableMarkup()` toggle global
  state; reads must set the mode they need. Serialization by `withSword` is what makes
  per-call toggling safe. Rendered footnotes come back as
  `<div class="sword-markup sword-note">…</div>`, headings as `sword-section-title`,
  Strong's as `<w>` — parsed in `text.ts`, never leaked into plain search/compare text.
- **Auth is deny-by-default.** The global hook protects `/api/*`; only health and the minimal
  status/bootstrap/login endpoints are public. Sessions use opaque cookie tokens whose hashes
  live in SQLite. Never return password hashes, session tokens, encryption keys, or decrypted
  provider secrets to the client.
- **`MACHAIRA_SECRET_KEY` is required and external.** It is a base64 32-byte AES-GCM key. Keep it
  stable and out of the database/repository; user-secret ciphertext is bound to its user + name.
  AI provider APIs expose only redacted key status, never decrypted keys.
- **Personal data is server-owned and user-scoped.** Every notes/highlights query includes the
  authenticated user ID. Legacy IndexedDB data is only imported after explicit account-specific
  confirmation and never overwrites an existing server record.
- **Production is deliberately single-replica.** SQLite and the serialized libsword singleton
  share one `ReadWriteOnce` data volume. The Helm Deployment uses `Recreate`; do not scale it out
  without replacing both storage and native-engine coordination.

## Conventions

- **No mock data, ever.** Real SWORD/CrossWire content only. Features without an available
  implementation show honest empty/disabled states —
  never fabricated content. This is a hard product rule.
- **License: GPL-2.0-or-later** (matches libsword / the SWORD family). Keep new files
  compatible.
- User accounts, sessions, notes, and highlights live in server-side SQLite. Reading-plan progress
  and settings remain browser-local; legacy IndexedDB notes/highlights are retained as a
  non-destructive import source. Journal data remains exportable as Markdown + JSON.
- TypeScript throughout; server is ESM (note the `.js` import specifiers).

## Roadmap

Tracked as GitHub issues (labels `roadmap`, `phase-1-hosting`, etc.). Phase 1 provides the
self-hosting foundation; Phase 2 provides the multi-provider study partner and semantic search.
