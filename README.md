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
| **Settings** | Account administration, encrypted provider configuration with in-app model discovery, vector-index controls, themes, scripture text scale, and reading toggles. |

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
  voice `af_heart`. A local key is optional. **Test & load models** lists models when the runtime
  implements the OpenAI-compatible discovery endpoint; model and voice IDs remain manually editable.
- **Venice or another OpenAI-compatible cloud:** the Venice preset uses
  `https://api.venice.ai/api/v1`, model `tts-kokoro`, and voice `af_sky`. A cloud key is required,
  encrypted at rest, and used only by the server. Venice discovery filters to TTS models and loads
  the voice catalog for the selected model.

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
  `Systran/faster-whisper-small`, base URL `http://127.0.0.1:8000/v1`, and no required key. Use
  **Test & load models** to verify reachability and select a listed model without leaving Settings.
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

Enter the provider's base URL (ending at `/v1`, not the final operation path), then select
**Test & load** to search the models visible to the supplied account. A discovered ID can be
selected without leaving Settings, and the field continues to accept an exact manual ID.
Local URLs are resolved by the Sword server: `127.0.0.1` means the Sword
container or pod itself, so containerized deployments generally need a reachable service DNS name
or host gateway instead. Chat responses stream through Sword; provider keys never return to the
browser, and conversations are kept only in the current browser tab.

### Provider model discovery

Discovery is always explicit: changing a URL never sends a request. **Test & load** uses a staged
URL/key without saving an incomplete configuration, while a matching saved provider can reuse its
encrypted key. **Refresh** bypasses the five-minute in-memory success cache. Keys are sent only by
the Sword server and are never included in a discovery response.

- OpenAI-compatible endpoints use `GET /models`. The standard response reports identifiers and
  owners but not task capabilities, so those entries are labeled **Compatibility not reported**
  rather than guessed from model names.
- Anthropic uses its paginated Models API and reports display names and token limits.
- A Local chat or embedding endpoint first checks Ollama's richer `/api/tags` installed-model list,
  then falls back to OpenAI-compatible discovery for vLLM and other servers.
- Venice cloud STT/TTS requests are filtered to `asr` or `tts`; selecting a Venice TTS model loads
  its compatible voices. Other OpenAI-compatible audio services keep manual voice entry available.

An unavailable, unauthorized, unsupported, timed-out, oversized, or malformed discovery response
is reported inline and never prevents manual configuration. Existing/manual IDs remain in the
field when a refresh omits them and receive an unavailable warning. Discovery follows no redirects,
reads at most 2 MiB and 500 models across at most ten pages, and times out after ten seconds.

### Semantic search

Open **Settings → Semantic search** and configure either an OpenAI-compatible embeddings API or
a local endpoint such as Ollama. The embedding provider is separate from the study-partner chat
provider, so Anthropic chat can be paired with any embeddings service. Enter the provider base URL
ending at `/v1`, use **Test & load** or enter an embedding model ID manually, save it, then select
**Build index**.

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

## Docker Compose

Compose 2.24 or newer is the supported single-host deployment. Copy the safe template, generate a
stable encryption key, and start the lightweight application-only profile:

```sh
cp .env.example .env
sed -i "s|^MACHAIRA_SECRET_KEY=.*|MACHAIRA_SECRET_KEY=$(openssl rand -base64 32)|" .env
docker compose up -d
```

Open **http://localhost:5274**. The application binds to loopback by default; set
`MACHAIRA_BIND_ADDRESS=0.0.0.0` only when a firewall and TLS-terminating reverse proxy protect the
host. Only the application port is published. Inference containers stay on the private Compose
network.

Optional profiles use the same pinned CPU-first providers and defaults as Helm:

| Stack | Command |
| --- | --- |
| Embeddings only | `COMPOSE_PROFILES=embeddings docker compose up -d` |
| Speech-to-text only | `COMPOSE_PROFILES=stt docker compose up -d` |
| Text-to-speech only | `COMPOSE_PROFILES=tts docker compose up -d` |
| Both voice directions | `COMPOSE_PROFILES=voice docker compose up -d` |
| Complete easy mode | `COMPOSE_PROFILES=easy docker compose up -d` |

Use `COMPOSE_PROFILES` rather than the `--profile` flag: the value selects both the services and
the matching non-secret provider descriptors loaded by Machaira. Set it in `.env` to make a
profile persistent. Bundled providers then appear in Settings with readiness and prefilled private
URLs; users still explicitly save and enable them.

Compose and Helm share this tested provider matrix:

| Capability | CPU runtime | Tested default | Persistent cache | Default request / limit |
| --- | --- | --- | --- | --- |
| Embeddings | Ollama 0.32.15 | `all-minilm:22m`, batch 16 | `embedding-model-cache` | 500m/512 MiB · 2 CPU/2 GiB |
| STT | Speaches 0.8.3 CPU | `Systran/faster-whisper-small`, CPU int8 | `stt-model-cache` | 1 CPU/2 GiB · 2 CPU/4 GiB |
| TTS | Kokoro-FastAPI v0.8.0 CPU | `kokoro`, voice `af_heart` | model is image-baked | 500m/1 GiB · 2 CPU/4 GiB |

The final column is Helm's request/limit pair; Compose applies the upper bound as its service
limit. Model-loader helpers are separately capped and exit after readiness is established.

The complete CPU stack needs roughly four cores and 8 GiB of memory for practical startup
headroom. The CPU images support linux/amd64 and linux/arm64. Initial Ollama and Speaches model
downloads can take several minutes; named volumes preserve those caches and application data
across `docker compose down` and recreation. Never use `docker compose down --volumes` unless all
application data and cached models may be deleted.

For an NVIDIA-equipped linux/amd64 host with the NVIDIA Container Toolkit installed, select the
CUDA images and reserve one GPU per inference service with the override:

```sh
COMPOSE_PROFILES=easy docker compose -f compose.yaml -f deploy/compose/gpu.yaml up -d
```

Every bundled service can instead be omitted and configured as a Local or cloud provider in each
user's Settings. To advertise a private externally managed endpoint to every user, leave profiles
disabled and set the non-secret `MACHAIRA_DEPLOYMENT_PROVIDERS_JSON` descriptor in `.env`; the
template includes an embeddings example. `host.docker.internal` resolves to the Compose host on
Linux and Docker Desktop. Provider credentials remain encrypted per-user Settings data and must
not be placed in `.env` descriptors.

## Container image

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

The chart can also add a private CPU-first inference stack to the same Pod. Each capability is
disabled by default and uses the same `disabled`, `bundled`, or `external` mode vocabulary:

```sh
helm upgrade --install machaira deploy/helm/machaira \
  --namespace machaira \
  --set inference.embeddings.mode=bundled \
  --set inference.stt.mode=bundled \
  --set inference.tts.mode=bundled
```

Bundled providers appear in Settings with live readiness and prefilled internal URLs. Selecting a
provider only fills the editable configuration: users must still save it, explicitly put Local TTS
or STT in an ordered voice graph, and explicitly start a semantic-index build. The deployment never
silently enables cloud processing. Inference ports are not added to the Service or Ingress.

The shared provider matrix is documented in the Compose section above. The complete Helm CPU
profile requests roughly 2.1 CPU and 3.75 GiB of memory including Machaira; a 4-core, 8-GiB node
leaves practical startup and filesystem headroom. Initial Ollama and Speaches downloads persist in
PVC cache subpaths. Set a capability's `persistence.enabled=false` for an intentionally ephemeral
cache.

For a private, keyless OpenAI-compatible service managed outside the chart, use `external` mode;
the chart registers the supplied endpoint but deploys no sidecar:

```sh
helm upgrade --install machaira deploy/helm/machaira \
  --namespace machaira \
  --set inference.embeddings.mode=external \
  --set inference.embeddings.external.baseUrl=http://embeddings.inference.svc.cluster.local/v1 \
  --set inference.embeddings.model=my-embedding-model
```

Provider credentials and cloud providers remain per-user Settings data encrypted by Machaira; do
not put them in chart values. NVIDIA GPU overrides set `inference.<capability>.gpu.enabled=true`,
add the configured `nvidia.com/gpu` limit, and select the pinned CUDA image (the documented GPU
profile is linux/amd64). Adjust resource limits for the installed GPU and model. The legacy
`tts.sidecar.*` and `stt.sidecar.*` values remain accepted as deprecated aliases.

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
| `MACHAIRA_DEPLOYMENT_PROVIDERS_JSON` | unset | Non-secret deployment-provider descriptors generated by Helm/Compose or supplied for private external endpoints; invalid values fail server startup. |
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
