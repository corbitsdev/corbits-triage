#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-only
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

sh tooling/vendor-diff-check.sh

# Stock workspace manifests expose source through this condition. Keep it in
# the invocation rather than rewriting vendored package exports.
bun test --conditions=intx-src \
  tooling/vendor-health.test.ts \
  vendor/interchange/packages/types/src/catalog.test.ts \
  vendor/interchange/packages/tool-packaging/src/loader.test.ts \
  vendor/interchange/packages/workflow-deploy/src/capability-walk.test.ts \
  vendor/interchange/packages/workflow-deploy/src/inert-ontrigger-bodies.test.ts \
  vendor/interchange/packages/workflow-host/src/workflow-definition-loader.test.ts
