#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

node scripts/check-runtime.mjs
pnpm install --frozen-lockfile
exec pnpm build
