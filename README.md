# Sword

A warm, local-first Bible study tool. **Sword** (repo name *machaira* — Greek μάχαιρα,
"sword") is a member of the [SWORD Project](https://www.crosswire.org/sword/) family, the
same open ecosystem behind [BibleTime](https://bibletime.info/) and
[Xiphos](https://xiphos.org/). It pairs a paper-textured reading experience with real study
tooling: a downloadable module library, verse comparison, Strong's lexicon lookup, exact and
semantic search, personal journaling, and a bring-your-own-model study partner.

> Content is **real, never mocked**. Modules are downloaded from CrossWire's repositories on
> demand; features that don't yet have a backend show honest empty/disabled states rather than
> fabricated data.

## Screens

| Screen | What it does |
| --- | --- |
| **Read** | Renders a chapter from any installed translation; translation picker, book/chapter navigation, verse selection, persisted highlights, and browser read-aloud follow-along. |
| **Study** | Side-by-side verse comparison, Strong's glosses, and streamed passage-aware chat—with optional hold-to-talk input—through a user-configured model provider. |
| **Search** | Real SWORD full-text and embedding-backed “by meaning” search, with typed or hold-to-talk input. |
| **Library** | Browse CrossWire repositories, install modules with live progress, and uninstall. This is the downloader that feeds every other screen. |
| **Journal** | Per-account notes with tags, plus an interactive graph of linked, cross-referenced, and thematically related passages. |
| **Settings** | Account administration, encrypted chat/embedding provider configuration, vector-index controls, themes, scripture text scale, and reading toggles. |

Browser-native voice controls degrade to clearly disabled states when the Web Speech APIs are not
available. See [Voice input and read-aloud](#voice-input-and-read-aloud) for compatibility and
privacy details.

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
  hashed with Argon2id, and provider credentials have an AES-256-GCM encrypted per-user store
  whose key remains outside the database. API keys are decrypted only for server-side provider
  calls.
- Per-user semantic indexes store verse metadata and provider-generated vectors in SQLite. A
  staged rebuild preserves the previous usable index if an embedding request fails.
- Journal connection graphs are derived on demand from module-authored cross-references and the
  existing stored verse vectors. Opening a graph never makes a new embedding-provider request.
- **`client/`** is a single-page app that talks to the server over `/api` (proxied in dev).
  Reading/study data plus per-user notes and highlights come from the server. IndexedDB retains
  reading-plan progress and any legacy notes/highlights until the user explicitly imports them.
- In production, Fastify serves the compiled client and API from one image and one origin. The
  image runs as a non-root user and keeps all durable server state under `/app/server/data`.

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

### Voice input and read-aloud

Select **Listen** on the Read screen to hear the current chapter through the browser's built-in
speech-synthesis voice. Playback begins at the selected verse when there is one, highlights each
verse when **Settings → Listening → Follow along** is enabled, and marks an enabled reading-plan
chapter complete only after natural playback completion.

Search and the Study partner offer a hold-to-talk button where the browser implements speech
recognition. Hold the microphone button with a pointer, or hold Space/Enter while it is focused,
then release to stop. The transcript is added to the draft but is never submitted automatically.
Microphone permission and recognition availability are controlled by the browser. Depending on
the browser, recognition audio may be processed by the browser vendor's service; Sword does not
send microphone audio to its own server or store it.

### Study partner providers

Open **Settings → Study partner** after signing in and choose one of:

- **OpenAI-compatible** for OpenAI or another service exposing `/v1/chat/completions`.
- **Anthropic** for the Claude Messages API.
- **Local** for a keyless or authenticated OpenAI-compatible Llama-class server such as Ollama.

Enter the exact model identifier and the provider's base URL (ending at `/v1`, not the final
operation path). Local URLs are resolved by the Sword server: `127.0.0.1` means the Sword
container or pod itself, so containerized deployments generally need a reachable service DNS name
or host gateway instead. Chat responses stream through Sword; provider keys never return to the
browser, and conversations are kept only in the current browser tab.

### Semantic search

Open **Settings → Semantic search** and configure either an OpenAI-compatible embeddings API or
a local endpoint such as Ollama. The embedding provider is separate from the study-partner chat
provider, so Anthropic chat can be paired with any embeddings service. Enter the provider base URL
ending at `/v1` and an embedding model identifier, save it, then select **Build index**.

Building sends each verse from every installed, unlocked Bible module to the provider in bounded
batches; external services may charge for that usage. The UI reports real indexed verse and module
counts. Installing or removing a Bible, or changing the endpoint/model, marks the index stale until
the next successful rebuild. Exact note and journal search remains local and does not send personal
writing to the embeddings provider.

To run the halves separately:

```sh
npm run dev:server     # Fastify on :5274  (honours PORT if set)
npm run dev:client     # Vite on :5273, proxies /api -> :5274
```

**First run:** nothing is installed yet, so Read/Study/Search show an empty state. Open
**Library**, install a translation (e.g. *KJV*), and it becomes available everywhere. Install
*StrongsGreek* / *StrongsHebrew* to enable lexicon lookups, and a module with embedded tags
(e.g. *KJVA*) to see Strong's glosses in Study.

## Container

The root Dockerfile builds the native SWORD binding, server, and client in a multi-stage Node 22
image. The runtime image contains the native runtime libraries but not the compiler toolchain.

```sh
docker build -t machaira:local .
docker volume create machaira-data
export MACHAIRA_SECRET_KEY="$(openssl rand -base64 32)"
docker run --name machaira --rm \
  -p 5274:5274 \
  -e MACHAIRA_SECRET_KEY \
  -v machaira-data:/app/server/data \
  machaira:local
```

Open **http://localhost:5274**. Reuse the same secret and volume on every restart. Released images
are published as `ghcr.io/gobha-me/machaira:<version>` for `linux/amd64` and `linux/arm64`.

## Kubernetes with Helm

The chart deploys exactly one application replica because SQLite and the native SWORD engine are
single-writer resources. It creates a `ReadWriteOnce` claim for both the database and installed
modules, and expects the encryption key in an existing Secret.

```sh
kubectl create namespace machaira
kubectl create secret generic machaira \
  --namespace machaira \
  --from-literal=MACHAIRA_SECRET_KEY="$(openssl rand -base64 32)"

helm upgrade --install machaira ./deploy/helm/machaira \
  --namespace machaira \
  --set ingress.host=bible.example.com
```

The defaults expect an `nginx` IngressClass and cert-manager `letsencrypt-prod` ClusterIssuer.
Override `ingress.className`, `ingress.annotations`, `ingress.tls`, and `persistence.storageClass`
in a values file for the target cluster. Set `image.pullSecrets` if the registry requires
credentials, or set `image.repository` and `image.tag` to use a locally published image.

For a consistent manual backup, scale the Deployment to zero and snapshot or copy the PVC. Keep
the Kubernetes Secret with the backup: losing `MACHAIRA_SECRET_KEY` makes encrypted provider
credentials unrecoverable. Restore the Secret and PVC together before scaling back to one. The
chart marks its PVC to survive `helm uninstall`; delete that claim explicitly only when its data
is no longer needed.

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
| `HOST` | `127.0.0.1` | Fastify listen address; the container sets `0.0.0.0`. |
| `PORT` | `5274` | Fastify listen port. |
| `MACHAIRA_DB_PATH` | `server/data/machaira.sqlite` | SQLite database path. |
| `MACHAIRA_SECRET_KEY` | required | Base64-encoded 32-byte encryption key; generate with `openssl rand -base64 32`. |
| `MACHAIRA_ORIGIN` | same-origin only | Exact browser origin allowed for cross-origin API requests. |
| `NODE_ENV` | development | Set to `production` to mark the session cookie `Secure`. |

## Roadmap

Planned work is tracked as [GitHub issues](https://github.com/gobha-me/machaira/issues).
Authentication, server-side per-user storage, container/Kubernetes deployment, the multi-provider
LLM study partner, semantic scripture search, browser-native voice input, read-aloud follow-along,
and the Scripture connections graph form the current foundation. Future work will continue to be
tracked in GitHub issues.

## License

[GPL-2.0-or-later](LICENSE). Sword builds on CrossWire's `libsword` (GPL-2.0+) and stands with
its sibling projects in the SWORD family. Bible texts and lexicons are distributed by
[CrossWire](https://www.crosswire.org/) and their respective copyright holders under their own
licenses; installing a module accepts that module's terms.
