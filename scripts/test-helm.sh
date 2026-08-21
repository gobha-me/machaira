#!/usr/bin/env bash
set -euo pipefail

helm_bin="${HELM_BIN:-helm}"
chart_dir="${1:-deploy/helm/machaira}"
chart_test_dir=$(mktemp -d)
trap 'rm -rf "${chart_test_dir}"' EXIT

render() {
  local name=$1
  shift
  "${helm_bin}" template machaira "${chart_dir}" "$@" > "${chart_test_dir}/${name}.yaml"
}

"${helm_bin}" lint "${chart_dir}"

render default
if grep -q 'name: MACHAIRA_DEPLOYMENT_PROVIDERS_JSON' "${chart_test_dir}/default.yaml"; then
  echo 'Default render must not register deployment providers' >&2
  exit 1
fi
if grep -Eq '^        - name: (embeddings|stt|tts)$' "${chart_test_dir}/default.yaml"; then
  echo 'Default render must not deploy inference containers' >&2
  exit 1
fi

render embeddings --set inference.embeddings.mode=bundled
grep -q '^        - name: embeddings$' "${chart_test_dir}/embeddings.yaml"
grep -q 'subPath: embedding-model-cache' "${chart_test_dir}/embeddings.yaml"
grep -q 'all-minilm:22m' "${chart_test_dir}/embeddings.yaml"

render stt --set inference.stt.mode=bundled
grep -q '^        - name: stt$' "${chart_test_dir}/stt.yaml"
grep -q 'subPath: stt-model-cache' "${chart_test_dir}/stt.yaml"

render tts --set inference.tts.mode=bundled
grep -q '^        - name: tts$' "${chart_test_dir}/tts.yaml"
grep -q 'ghcr.io/remsky/kokoro-fastapi-cpu:v0.8.0' "${chart_test_dir}/tts.yaml"

render all \
  --set inference.embeddings.mode=bundled \
  --set inference.stt.mode=bundled \
  --set inference.tts.mode=bundled
test "$(grep -Ec '^        - name: (embeddings|stt|tts)$' "${chart_test_dir}/all.yaml")" -eq 3
if grep -Eq 'targetPort: (embeddings|stt|tts)' "${chart_test_dir}/all.yaml"; then
  echo 'Inference ports must not be exposed through the application Service' >&2
  exit 1
fi

render external \
  --set inference.stt.mode=external \
  --set inference.stt.external.baseUrl=http://speech.internal/v1
grep -q 'MACHAIRA_DEPLOYMENT_PROVIDERS_JSON' "${chart_test_dir}/external.yaml"
grep -q 'speech.internal' "${chart_test_dir}/external.yaml"
if grep -q '^        - name: stt$' "${chart_test_dir}/external.yaml"; then
  echo 'External mode must not deploy a sidecar' >&2
  exit 1
fi

render ephemeral \
  --set persistence.enabled=false \
  --set inference.embeddings.mode=bundled \
  --set inference.embeddings.persistence.enabled=false
grep -q 'name: embedding-cache' "${chart_test_dir}/ephemeral.yaml"
if grep -q 'subPath: embedding-model-cache' "${chart_test_dir}/ephemeral.yaml"; then
  echo 'Ephemeral inference cache must not use a PVC subPath' >&2
  exit 1
fi

render gpu \
  --set inference.embeddings.mode=bundled \
  --set inference.embeddings.gpu.enabled=true \
  --set inference.stt.mode=bundled \
  --set inference.stt.gpu.enabled=true \
  --set inference.tts.mode=bundled \
  --set inference.tts.gpu.enabled=true
test "$(grep -c 'nvidia.com/gpu: 1' "${chart_test_dir}/gpu.yaml")" -eq 3
grep -q 'ghcr.io/speaches-ai/speaches:0.8.3-cuda' "${chart_test_dir}/gpu.yaml"
grep -q 'ghcr.io/remsky/kokoro-fastapi-gpu:v0.8.0' "${chart_test_dir}/gpu.yaml"

render legacy --set stt.sidecar.enabled=true --set tts.sidecar.enabled=true
grep -q '^        - name: stt$' "${chart_test_dir}/legacy.yaml"
grep -q '^        - name: tts$' "${chart_test_dir}/legacy.yaml"
grep -q 'MACHAIRA_DEPLOYMENT_PROVIDERS_JSON' "${chart_test_dir}/legacy.yaml"

if "${helm_bin}" template machaira "${chart_dir}" \
  --set inference.tts.mode=external > "${chart_test_dir}/invalid-external.yaml" 2>&1; then
  echo 'External mode without a base URL must fail validation' >&2
  exit 1
fi

if "${helm_bin}" template machaira "${chart_dir}" \
  --set tts.sidecar.enabled=true \
  --set inference.tts.mode=external \
  --set inference.tts.external.baseUrl=http://speech.internal/v1 \
  > "${chart_test_dir}/invalid-conflict.yaml" 2>&1; then
  echo 'Conflicting legacy and canonical modes must fail validation' >&2
  exit 1
fi

echo 'Helm inference render matrix passed'
