#!/bin/bash
set -e

# Ensure Codex CLI exists and bootstrap auth from env when available.
if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not found in container. Rebuild image with Codex installed." >&2
  exit 1
fi

if ! codex login status >/dev/null 2>&1; then
  if [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "OPENAI_API_KEY is required because this build uses Codex only." >&2
    exit 1
  fi
  printf "%s" "$OPENAI_API_KEY" | codex login --with-api-key >/dev/null 2>&1
fi

cd /app
npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
