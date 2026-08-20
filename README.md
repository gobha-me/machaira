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
| **Read** | Renders a chapter from any installed translation in a responsive phone, tablet, or desktop layout; translation picker, book/chapter navigation, touch-friendly passage tools and range selection, persisted highlights, and browser read-aloud follow-along. |
| **Study** | Side-by-side verse comparison, Strong's glosses, and streamed passage-aware chat—with pluggable hold-to-talk input—through user-configured providers. |
| **Search** | Real SWORD full-text and embedding-backed “by meaning” search, with typed or hold-to-talk input. |
| **Library** | Browse CrossWire repositories, install modules with live progress, and uninstall. This is the downloader that feeds every other screen. |
| **Journal** | Per-account notes with tags, plus an interactive graph of linked, cross-referenced, and thematically related passages. |
| **Settings** | Account administration, encrypted chat/embedding provider configuration, vector-index controls, themes, scripture text scale, and reading toggles. |

Voice controls use explicit browser, local, and cloud provider orders and degrade to honest
disabled states when no configured path is available. See
[Voice input and read-aloud](#voice-input-and-read-aloud) for compatibility and privacy details.

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
  sudo apt-get install build-essential cmake ffmpeg pkg-config subversion \
    libcurl4-openssl-dev libicu-dev zlib1g-dev
  ```

  (`subversion` is required by the build; a missing `svn` shows up as a CMake
  `Subversion_WC_INFO` failure. `ffmpeg`/`ffprobe` validate and normalize microphone recordings
  before transcription.)

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

Select **Listen** on the Read screen to hear the current chapter through an explicit ordered list
of browser, local, and cloud providers. Playback begins at the selected verse when there is one,
highlights each verse when **Settings → Listening → Follow along** is enabled, and marks an enabled
reading-plan chapter complete only after natural playback completion. The Listen bar names the
active backend and reports visible fallback when a provider fails.

Configure the order under **Settings → Listening**. Browser speech remains an opportunistic option,
not the definition of read-aloud support. Local and cloud requests go through the Sword server so
API keys never reach the browser. Cloud TTS is disabled until it is explicitly placed in the saved
order; only then may verse text be sent to that provider.

Two non-browser paths are supported:

- **Local OpenAI-compatible:** use a service exposing `POST /v1/audio/speech`. The tested CPU-first
  runtime is Kokoro-FastAPI v0.8.0 with base URL `http://127.0.0.1:8880/v1`, model `kokoro`, and
  voice `af_heart`. A local key is optional.
- **Venice or another OpenAI-compatible cloud:** the Venice preset uses
  `https://api.venice.ai/api/v1`, model `tts-kokoro`, and voice `af_sky`. A cloud key is required,
  encrypted at rest, and used only by the server.

Remote audio is generated a verse at a time with one-verse prefetch for prompt start and accurate
follow-along. Stop, pause/resume, replay, navigation cancellation, provider failure, and fallback
apply to browser and generated audio. Browser-local WASM/WebGPU voices are not supported yet.

Search and the Study partner use a separate ordered voice-input graph configured under
**Settings → Voice input**. Hold the microphone button with a pointer, or hold Space/Enter while it
is focused, then release to transcribe. The control names the active browser, local, or cloud tier,
reports fallback, and lets Escape or another press cancel. The transcript is appended to the draft
but is never submitted automatically.

- **Browser recognition** remains an opportunistic fast path. Depending on the browser, its vendor
  may process microphone audio remotely.
- **Local OpenAI-compatible STT** sends a recording through Machaira to a private endpoint exposing
  `POST /v1/audio/transcriptions`. The tested CPU-first runtime is Speaches 0.8.3 with
  `Systran/faster-whisper-small`, base URL `http://127.0.0.1:8000/v1`, and no required key.
- **Cloud STT** supports Venice and other OpenAI-compatible transcription APIs. The Venice preset
  uses `https://api.venice.ai/api/v1` and `nvidia/parakeet-tdt-0.6b-v3`. Cloud audio is sent only
  after the user confirms and saves a provider order containing Cloud STT; keys remain encrypted
  and server-side.

The remote path requires `getUserMedia`, `MediaRecorder`, and a secure browser context. Current
Chrome/Chromium, Firefox, and Safari can record a provider-supported WebM, Ogg, MP4, or WAV format;
the server verifies the real duration and converts it to mono 16-kHz WAV. Recordings are limited to
60 seconds and 8 MiB, live only in browser memory and a private temporary server directory with
mode-0600 files, and are deleted immediately after the provider request. They are never stored in SQLite or logged.
This path supplies reliable Linux/KDE voice input even when `SpeechRecognition` is absent.

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

The embedding provider setting defaults to 32 verses per rebuild request and accepts values from
1 to 64. OpenAI-compatible cloud services commonly accept the default; LiteLLM/vLLM deployments,
Ollama, and small local or sidecar runtimes may need a lower value depending on their configured
limits and available memory. If a provider explicitly rejects a batch as too large, Sword retries
that batch at the reported limit (or progressively halves it) and uses the smaller size for the
rest of the rebuild. Other 400/413/422 responses are reported without retrying so configuration or
model errors cannot loop indefinitely. Semantic-search queries remain single-input requests.

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

The chart can also add private, CPU-first Kokoro TTS and Speaches STT sidecars to the same Pod:

```sh
helm upgrade --install machaira deploy/helm/machaira \
  --namespace machaira \
  --set tts.sidecar.enabled=true \
  --set stt.sidecar.enabled=true
```

No TTS port is added to the Service or Ingress. After installation, save a **Local TTS** provider
with `http://127.0.0.1:8880/v1`, `kokoro`, and `af_heart`; then place Local in the read-aloud order.
The image is pinned to `ghcr.io/remsky/kokoro-fastapi-cpu:v0.8.0` and supports amd64 and arm64.
The defaults request 500m CPU/1 GiB RAM and limit the sidecar to 2 CPU/4 GiB RAM; adjust
`tts.sidecar.resources` for the node and expected latency. The model is baked into the image, so
routine Pod replacement does not redownload it.

The STT sidecar is pinned to `ghcr.io/speaches-ai/speaches:0.8.3-cpu`, which publishes amd64 and
arm64 images. It pre-downloads the multilingual `Systran/faster-whisper-small` model, runs CPU
`int8`, and keeps the model loaded. The model is about 486 MiB; the chart persists its cache on the
application PVC so Pod replacement does not redownload it. Defaults request 1 CPU/2 GiB RAM and
limit the sidecar to 2 CPU/4 GiB RAM. Startup time depends on the first model download and storage
speed. No STT port is added to the Service or Ingress. After installation, test and save **Local
STT** with `http://127.0.0.1:8000/v1` and `Systran/faster-whisper-small`, then place Local in the
voice-input order. Override `stt.sidecar.model`, image, or resources for another tested profile.

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
- **Reader position, reading-plan progress, and settings** remain browser-local. Reader position
  is isolated by account in each browser and does not sync across browsers or devices. Settings
  offers a one-time, non-destructive import when legacy IndexedDB notes or highlights are found,
  and exports current server-backed personal data as Markdown + JSON.

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
