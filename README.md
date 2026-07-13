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
| **Journal** | Personal notes with tags, stored locally in the browser and exportable as Markdown + JSON. |
| **Settings** | Paper/Ink themes, accent colour, scripture text scale, reading toggles — all persisted. |

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
- **`client/`** is a single-page app that talks to the server over `/api` (proxied in dev).
  Reading/study data comes from the server; personal notes and highlights live in the browser via
  IndexedDB.

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
npm run dev            # runs server (:5274) and client (:5273) together
```

Then open **http://localhost:5273**.

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
- **Notes, highlights, and settings** are personal and stay in the browser (IndexedDB). Export
  them as Markdown + JSON from Settings.

## Roadmap

Planned work is tracked as [GitHub issues](https://github.com/gobha-me/machaira/issues). The near
term is focused on making the app self-hostable and multi-user: authentication and accounts,
server-side per-user storage for notes, and container/Kubernetes deployment — followed by the
LLM study partner, semantic search, voice input, and the connections graph.

## License

[GPL-2.0-or-later](LICENSE). Sword builds on CrossWire's `libsword` (GPL-2.0+) and stands with
its sibling projects in the SWORD family. Bible texts and lexicons are distributed by
[CrossWire](https://www.crosswire.org/) and their respective copyright holders under their own
licenses; installing a module accepts that module's terms.
