#!/usr/bin/env bash
set -euo pipefail

IMAGE_PREFIX="${IMAGE_PREFIX:-kilo}"
TAG="${TAG:-latest}"
PLATFORMS="${PLATFORMS:-linux/amd64}"
OUTPUT_MODE="${OUTPUT_MODE:-load}"

if [[ "${OUTPUT_MODE}" != "load" && "${OUTPUT_MODE}" != "push" ]]; then
	echo "OUTPUT_MODE must be load or push" >&2
	exit 1
fi

if [[ "${OUTPUT_MODE}" == "load" && "${PLATFORMS}" == *,* ]]; then
	echo "OUTPUT_MODE=load only supports a single platform. Use OUTPUT_MODE=push for multi-platform builds." >&2
	exit 1
fi

MODE_FLAG="--load"
if [[ "${OUTPUT_MODE}" == "push" ]]; then
	MODE_FLAG="--push"
fi

docker buildx build \
	--platform "${PLATFORMS}" \
	-f apps/ai-code-insights-api/Dockerfile \
	apps/ai-code-insights-api \
	-t "${IMAGE_PREFIX}/ai-code-insights-api:${TAG}" \
	${MODE_FLAG}

docker buildx build \
	--platform "${PLATFORMS}" \
	-f apps/ai-code-insights-web/Dockerfile \
	apps/ai-code-insights-web \
	-t "${IMAGE_PREFIX}/ai-code-insights-web:${TAG}" \
	${MODE_FLAG}
