#!/usr/bin/env bash
set -euo pipefail

docker_bin="${DOCKER_BIN:-docker}"
compose=("${docker_bin}" compose)
repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
test_dir=$(mktemp -d)
smoke_project=""

cleanup() {
  if [[ -n "${smoke_project}" ]]; then
    COMPOSE_PROFILES=easy \
      MACHAIRA_ENV_FILE="${test_dir}/app.env" \
      MACHAIRA_PORT="${smoke_port}" \
      MACHAIRA_SMOKE_IMAGE="${MACHAIRA_SMOKE_IMAGE:-machaira:compose-smoke}" \
      "${compose[@]}" --project-directory "${repo_dir}" \
        -p "${smoke_project}" \
        -f "${repo_dir}/compose.yaml" \
        -f "${repo_dir}/deploy/compose/smoke.yaml" \
        down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "${test_dir}"
}
trap cleanup EXIT

secret=$(openssl rand -base64 32)
printf 'MACHAIRA_SECRET_KEY=%s\n' "${secret}" > "${test_dir}/app.env"

dc() {
  local profile=$1
  shift
  COMPOSE_PROFILES="${profile}" \
    MACHAIRA_ENV_FILE="${test_dir}/app.env" \
    "${compose[@]}" --project-directory "${repo_dir}" -f "${repo_dir}/compose.yaml" "$@"
}

render() {
  local name=$1
  local profile=$2
  shift 2
  dc "${profile}" "$@" config > "${test_dir}/${name}.yaml"
}

render app ""
render embeddings embeddings
render stt stt
render tts tts
render voice voice
render easy easy
render gpu easy -f "${repo_dir}/deploy/compose/gpu.yaml"

test "$(dc "" config --services)" = "machaira"
test "$(dc embeddings config --services | sort | tr '\n' ' ')" = "embeddings embeddings-model machaira "
test "$(dc voice config --services | sort | tr '\n' ' ')" = "machaira stt stt-model tts "
test "$(dc easy config --services | sort | tr '\n' ' ')" = "embeddings embeddings-model machaira stt stt-model tts "

grep -q 'host_ip: 127.0.0.1' "${test_dir}/app.yaml"
grep -q 'published: "5274"' "${test_dir}/app.yaml"
if grep -Eq 'published: "(11434|8000|8880)"' "${test_dir}/easy.yaml"; then
  echo 'Inference ports must not be published' >&2
  exit 1
fi

grep -q 'ollama/ollama:0.32.15' "${test_dir}/embeddings.yaml"
grep -q 'all-minilm:22m' "${test_dir}/embeddings.yaml"
grep -q 'ghcr.io/speaches-ai/speaches:0.8.3-cpu' "${test_dir}/stt.yaml"
grep -q 'Systran/faster-whisper-small' "${test_dir}/stt.yaml"
grep -q 'ghcr.io/remsky/kokoro-fastapi-cpu:v0.8.0' "${test_dir}/tts.yaml"
grep -q '/tmp:rw,exec,nosuid,nodev,size=256m,mode=1777' "${test_dir}/tts.yaml"
grep -q 'http://embeddings:11434/v1' "${test_dir}/easy.yaml"
grep -q 'http://stt:8000/v1' "${test_dir}/easy.yaml"
grep -q 'http://tts:8880/v1' "${test_dir}/easy.yaml"
test "$(grep -c 'driver: nvidia' "${test_dir}/gpu.yaml")" -eq 3
grep -q 'ghcr.io/speaches-ai/speaches:0.8.3-cuda' "${test_dir}/gpu.yaml"
grep -q 'ghcr.io/remsky/kokoro-fastapi-gpu:v0.8.0' "${test_dir}/gpu.yaml"

printf '%s\n' \
  "MACHAIRA_SECRET_KEY=${secret}" \
  'MACHAIRA_DEPLOYMENT_PROVIDERS_JSON={"embeddings":{"source":"external","engine":"openai-compatible","baseUrl":"http://host.docker.internal:11434/v1","model":"external-model","batchSize":16}}' \
  > "${test_dir}/external.env"
COMPOSE_PROFILES="" \
  MACHAIRA_ENV_FILE="${test_dir}/external.env" \
  "${compose[@]}" --project-directory "${repo_dir}" -f "${repo_dir}/compose.yaml" \
  config > "${test_dir}/external.yaml"
grep -q 'host.docker.internal:11434/v1' "${test_dir}/external.yaml"
if grep -q 'source.*bundled' "${test_dir}/external.yaml"; then
  echo 'App-only external configuration must not register bundled providers' >&2
  exit 1
fi

echo 'Compose render matrix passed'

if [[ "${MACHAIRA_COMPOSE_SMOKE:-0}" != "1" ]]; then
  exit 0
fi

smoke_project="machaira-compose-smoke-$$"
smoke_port=$((15274 + ($$ % 1000)))

smoke_dc() {
  COMPOSE_PROFILES=easy \
    MACHAIRA_ENV_FILE="${test_dir}/app.env" \
    MACHAIRA_PORT="${smoke_port}" \
    MACHAIRA_SMOKE_IMAGE="${MACHAIRA_SMOKE_IMAGE:-machaira:compose-smoke}" \
    "${compose[@]}" --project-directory "${repo_dir}" \
      -p "${smoke_project}" \
      -f "${repo_dir}/compose.yaml" \
      -f "${repo_dir}/deploy/compose/smoke.yaml" "$@"
}

wait_for_health() {
  local attempt
  for attempt in $(seq 1 90); do
    if curl --fail --silent "http://127.0.0.1:${smoke_port}/api/health" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  smoke_dc ps >&2
  smoke_dc logs --no-color >&2
  return 1
}

smoke_dc up --detach
wait_for_health

cookie_jar="${test_dir}/cookies.txt"
curl --fail --silent \
  --cookie-jar "${cookie_jar}" \
  --header 'content-type: application/json' \
  --data '{"username":"ComposeOwner","password":"correct horse battery staple"}' \
  "http://127.0.0.1:${smoke_port}/api/auth/bootstrap" >/dev/null

curl --fail --silent --cookie "${cookie_jar}" \
  "http://127.0.0.1:${smoke_port}/api/providers/deployment" |
  node -e '
    let raw = ""
    process.stdin.on("data", chunk => { raw += chunk })
    process.stdin.on("end", () => {
      const providers = JSON.parse(raw).providers
      for (const capability of ["embeddings", "stt", "tts"]) {
        if (providers[capability]?.readiness?.state !== "ready") process.exit(1)
      }
    })
  '

# Recreate the stack without deleting volumes, then prove the owner account survived.
smoke_dc down --remove-orphans
smoke_dc up --detach
wait_for_health
curl --fail --silent \
  --header 'content-type: application/json' \
  --data '{"username":"ComposeOwner","password":"correct horse battery staple"}' \
  "http://127.0.0.1:${smoke_port}/api/auth/login" >/dev/null

echo 'Compose startup, provider wiring, and persistence smoke test passed'
