#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID=${GOOGLE_CLOUD_PROJECT:?"Set GOOGLE_CLOUD_PROJECT"}
REGION=${REGION:-us-central1}
SERVICE_NAME=${SERVICE_NAME:-gv-ai-copilot}
ENV_FILE=${ENV_FILE:-backend/.env}
TIMESTAMP=$(date +%Y%m%d%H%M%S)
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}:${TIMESTAMP}"

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BACKEND_DIR="${SCRIPT_DIR}/../backend"

if [[ ! -d "${BACKEND_DIR}" ]]; then
  echo "Backend directory not found" >&2
  exit 1
fi

if [[ -f "${ENV_FILE}" ]]; then
  mapfile -t env_lines < <(grep -Ev '^(#|$)' "${ENV_FILE}")
  env_kv=()
  for line in "${env_lines[@]}"; do
    if [[ "$line" != *=* ]]; then
      continue
    fi
    key=${line%%=*}
    value=${line#*=}
    if [[ -z "${value}" ]]; then
      continue
    fi
    env_kv+=("${key}=${value}")
  done
  if (( ${#env_kv[@]} )); then
    env_string=$(IFS=','; echo "${env_kv[*]}")
    ENV_ARGS=("--set-env-vars" "${env_string}")
  else
    ENV_ARGS=()
  fi
else
  echo "Warning: ${ENV_FILE} not found; deploying without environment variables." >&2
  ENV_ARGS=()
fi

pushd "${BACKEND_DIR}" >/dev/null

echo "Building container ${IMAGE}…"
gcloud builds submit --tag "${IMAGE}" .

echo "Deploying to Cloud Run service ${SERVICE_NAME} in ${REGION}…"
gcloud run deploy "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --platform managed \
  --image "${IMAGE}" \
  --allow-unauthenticated \
  "${ENV_ARGS[@]}"

popd >/dev/null
