# Sword

A warm, local-first Bible study tool. **Sword** (repo name *machaira* — Greek μάχαιρα,
"sword") is a member of the [SWORD Project](https://www.crosswire.org/sword/) family, the
same open ecosystem behind [BibleTime](https://bibletime.info/) and
[Xiphos](https://xiphos.org/). It pairs a paper-textured reading experience with real study
tooling: a downloadable module library, verse comparison, Strong's lexicon lookup, full-text
search, and personal journaling.

> Content is **real, never mocked**. Modules are downloaded from CrossWire's repositories on
> demand; features that don't yet have a backend show honest empty/disabled states rather than
> fabricated data.

## Screens

| Screen | What it does |
| --- | --- |
| **Read** | Renders a chapter from any installed translation; translation picker, book/chapter navigation, verse selection + persisted highlights. |
| **Study** | Side-by-side verse comparison across installed translations, plus Strong's glosses for modules that carry Greek/Hebrew tags. |
| **Search** | Real SWORD full-text search (word / phrase) across installed modules. |
| **Library** | Browse CrossWire repositories, install modules with live progress, and uninstall. This is the downloader that feeds every other screen. |
| **Journal** | Per-account notes with tags, synced through the server and exportable as Markdown + JSON. |
| **Settings** | Account administration plus Paper/Ink themes, accent colour, scripture text scale, and reading toggles. |

Features that are intentionally deferred (LLM study-partner chat, semantic "by meaning"
ranking, the connections graph) are present in the UI as clearly disabled states. See the
[roadmap](#roadmap).

## Architecture

Two npm workspaces run together in development:

```
machaira/
  client/   Vue 3 + Vite + TypeScript + Pinia   (UI, dev server on :5273)
  server/   Fastify + node-sword-interface       (SWORD engine wrapper, :5274)
```

- **`server/`** wraps [`node-sword-interface`](https://www.npmjs.com/package/node-sword-interface)
  (a native binding to CrossWire's `libsword`) and exposes a small JSON API: list/install/remove
  modules, read chapters, compare verses, look up Strong's entries, and search. The native engine
  is not reentrant, so all access is serialized through a mutex.
- The server also owns authentication: users and revocable sessions live in SQLite, passwords are
  hashed with Argon2id, and future provider credentials have an AES-256-GCM encrypted per-user
  store whose key remains outside the database.
- **`client/`** is a single-page app that talks to the server over `/api` (proxied in dev).
  Reading/study data plus per-user notes and highlights come from the server. IndexedDB retains
  reading-plan progress and any legacy notes/highlights until the user explicitly imports them.

CrossWire modules can't be fetched directly from a browser (no CORS, and they ship in a binary
`zText`/OSIS format), which is why the local server exists to decode them into JSON.

## Requirements

- **Node.js 20+** and npm.
- **A C/C++ toolchain**, because `node-sword-interface` compiles `libsword` on install. On
  Debian/Ubuntu:

  ```sh
  sudo apt-get install build-essential cmake pkg-config subversion \
    libcurl4-openssl-dev libicu-dev zlib1g-dev
  ```

  (`subversion` is required by the build; a missing `svn` shows up as a CMake
  `Subversion_WC_INFO` failure.)

## Getting started

```sh
npm install            # installs both workspaces; compiles libsword (first run is slow)
export MACHAIRA_SECRET_KEY="$(openssl rand -base64 32)"
npm run dev            # runs server (:5274) and client (:5273) together
```

Then open **http://localhost:5273**.

On a new database, the login screen asks you to create the first administrator. Public sign-up is
then closed; that administrator can provision or disable additional accounts from Settings. Keep
`MACHAIRA_SECRET_KEY` stable across restarts — losing it makes encrypted provider credentials
unrecoverable.

To run the halves separately:

```sh
npm run dev:server     # Fastify on :5274  (honours PORT if set)
npm run dev:client     # Vite on :5273, proxies /api -> :5274
```

**First run:** nothing is installed yet, so Read/Study/Search show an empty state. Open
**Library**, install a translation (e.g. *KJV*), and it becomes available everywhere. Install
*StrongsGreek* / *StrongsHebrew* to enable lexicon lookups, and a module with embedded tags
(e.g. *KJVA*) to see Strong's glosses in Study.

## Storage & data

- **SWORD modules** are downloaded to `server/data/sword/` (gitignored) — the "everything on your
  machine" install root.
- **Accounts, sessions, encrypted secrets, notes, and highlights** live in
  `server/data/machaira.sqlite` by default and are isolated by account. Stop the server before
  copying the SQLite file for a simple consistent backup.
- **Reading-plan progress and settings** remain browser-local. Settings offers a one-time,
  non-destructive import when legacy IndexedDB notes or highlights are found, and exports current
  server-backed personal data as Markdown + JSON.

### Server configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5274` | Fastify listen port. |
| `MACHAIRA_DB_PATH` | `server/data/machaira.sqlite` | SQLite database path. |
| `MACHAIRA_SECRET_KEY` | required | Base64-encoded 32-byte encryption key; generate with `openssl rand -base64 32`. |
| `MACHAIRA_ORIGIN` | same-origin only | Exact browser origin allowed for cross-origin API requests. |
| `NODE_ENV` | development | Set to `production` to mark the session cookie `Secure`. |

## Roadmap

Planned work is tracked as [GitHub issues](https://github.com/gobha-me/machaira/issues). The near
term is focused on making the app self-hostable and multi-user: container/Kubernetes deployment
now follows authentication and server-side per-user storage — followed by the
LLM study partner, semantic search, voice input, and the connections graph.

## License

[GPL-2.0-or-later](LICENSE). Sword builds on CrossWire's `libsword` (GPL-2.0+) and stands with
its sibling projects in the SWORD family. Bible texts and lexicons are distributed by
[CrossWire](https://www.crosswire.org/) and their respective copyright holders under their own
licenses; installing a module accepts that module's terms.
