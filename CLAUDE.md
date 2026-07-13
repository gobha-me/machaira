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
```

Per-workspace: `npm -w server run <script>`, `npm -w client run <script>`. There is no
`typecheck` script yet — use `npx vue-tsc --noEmit` (client) / `npx tsc --noEmit` (server).

## Layout

npm workspaces: `client/` (Vue 3 + Vite + TS) and `server/` (Fastify + TS, ESM).

- `server/src/sword.ts` — the only module that touches `node-sword-interface`. Singleton
  + all public API.
- `server/src/routes/` — `sources.ts` (repos, install/uninstall via SSE), `read.ts`
  (books, chapter), `study.ts` (compare, strongs, search).
- `server/src/text.ts` — SWORD markup handling (`stripMarkup`, `parseVerseMarkup`).
- `server/src/books.ts` — book code → display name / section.
- `server/data/sword/` — downloaded SWORD modules at runtime (gitignored).
- `client/src/stores/` — Pinia: `settings`, `ui`, `reader`, `library`, `notes`.
- `client/src/screens/` — one `.vue` per screen. `client/src/services/api.ts` (typed
  fetch client), `db.ts` (IndexedDB). `client/src/theme.ts` — design tokens.

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

## Conventions

- **No mock data, ever.** Real SWORD/CrossWire content only. Features without a backend
  yet (LLM chat, semantic ranking, connections graph) show honest empty/disabled states —
  never fabricated content. This is a hard product rule.
- **License: GPL-2.0-or-later** (matches libsword / the SWORD family). Keep new files
  compatible.
- User notes/highlights/journal live in **IndexedDB** on the client, exportable as
  Markdown + JSON. (Server-side per-user persistence is a roadmap item — see issues.)
- TypeScript throughout; server is ESM (note the `.js` import specifiers).

## Roadmap

Tracked as GitHub issues (labels `roadmap`, `phase-1-hosting`, etc.). Phase 1 is
self-hosting: auth, server-side persistence, containerization/k8s.
