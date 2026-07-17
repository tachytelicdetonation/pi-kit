#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_COMMIT="216e672e7c9fc65682553394b74e483c0c9e47f7"
SOURCE_DIR="${PI_WORKFLOW_HOST_SOURCE_DIR:-$ROOT_DIR/.artifacts/pi-workflow-host-src}"
OUTPUT_DIR="${PI_WORKFLOW_HOST_OUTPUT_DIR:-$ROOT_DIR/.artifacts/pi-workflow-host}"
PATCH_FILE="$ROOT_DIR/patches/pi-coding-agent-0.80.10-active-tool-definitions.patch"

if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  rm -rf "$SOURCE_DIR"
  git clone https://github.com/earendil-works/pi.git "$SOURCE_DIR"
fi

git -C "$SOURCE_DIR" fetch --depth 1 origin "$PI_COMMIT"
git -C "$SOURCE_DIR" checkout --detach "$PI_COMMIT"
git -C "$SOURCE_DIR" reset --hard "$PI_COMMIT"
git -C "$SOURCE_DIR" clean -fdx

git -C "$SOURCE_DIR" apply --check --unidiff-zero "$PATCH_FILE"
git -C "$SOURCE_DIR" apply --unidiff-zero "$PATCH_FILE"

(
  cd "$SOURCE_DIR"
  npm ci --ignore-scripts
  npm run build
)
(
  cd "$SOURCE_DIR/packages/coding-agent"
  npx vitest --run \
    test/agent-session-dynamic-tools.test.ts \
    test/extensions-runner.test.ts
)

(
  cd "$ROOT_DIR"
  PI_CODING_AGENT_ROOT="$SOURCE_DIR/packages/coding-agent" npm run check:host-capabilities
)

mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_DIR"/*.tgz
(
  cd "$SOURCE_DIR/packages/coding-agent"
  npm pack --pack-destination "$OUTPUT_DIR"
)

printf '\nWorkflow-capable Pi host package written to:\n'
find "$OUTPUT_DIR" -maxdepth 1 -name '*.tgz' -print
