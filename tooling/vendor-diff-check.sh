#!/bin/sh
# CI vendor-diff gate: files under vendor/interchange must match the pinned
# stock Interchange commit, except for entries in
# tooling/vendor-diff-allowlist.txt. Exits 0 when clean, 1 with the
# offending diff lines otherwise.
#
# Scope notes:
# - The vendored tree is a pruned checkout (upstream-only paths such as
#   bin/, docs/, or packages never vendored are reported as information,
#   not failures). The gate fails on *vendor drift*: vendored files whose
#   bytes differ from stock, and files added locally under vendor/.
# - Local build artifacts (node_modules, tsbuildinfo, .DS_Store, tmp/,
#   .env*) and our provenance record (VENDORED.md) are excluded.
#
# Env overrides:
#   INTERCHANGE_STOCK_REPO  upstream repo (default https://github.com/faremeter/interchange)
#   INTERCHANGE_STOCK_REF   pinned stock commit (default 9febf699e1c8a01fd329927e5a14be7f94e9919e)
set -eu

STOCK_REPO="${INTERCHANGE_STOCK_REPO:-https://github.com/faremeter/interchange}"
STOCK_REF="${INTERCHANGE_STOCK_REF:-9febf699e1c8a01fd329927e5a14be7f94e9919e}"
ALLOWLIST="tooling/vendor-diff-allowlist.txt"
VENDOR_DIR="vendor/interchange"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

git init -q "$WORK/stock"
git -C "$WORK/stock" remote add origin "$STOCK_REPO"
git -C "$WORK/stock" fetch -q --depth 1 origin "$STOCK_REF"
git -C "$WORK/stock" checkout -q FETCH_HEAD

diff -qr "$WORK/stock" "$VENDOR_DIR" > "$WORK/diff.txt" || true

# Upstream-only paths (pruned from the vendored checkout): informational.
grep "^Only in $WORK/stock" "$WORK/diff.txt" > "$WORK/upstream-only.txt" || true
grep -v "^Only in $WORK/stock" "$WORK/diff.txt" > "$WORK/vendor-side.txt" || true

# `diff -q` renders an added file as `Only in <dir>: <name>`. Normalize that
# vendor-side form to a full path so allowlist entries can remain exact and a
# bare filename (which could mask drift elsewhere) is never necessary.
sed 's|^Only in \(vendor/interchange/.*\): \([^/]*\)$|Only in \1/\2|' \
  "$WORK/vendor-side.txt" > "$WORK/vendor-side-normalized.txt"

# Drop local build artifacts and the provenance record from the verdict.
grep -vE "node_modules|\.tsbuildinfo|\.DS_Store|/\.claude|tmp(/|$)|: tmp$|\.env($|[.-])|VENDORED\.md" \
  "$WORK/vendor-side-normalized.txt" > "$WORK/candidates.txt" || true

grep -v '^#' "$ALLOWLIST" | grep -v '^$' > "$WORK/patterns.txt" || true
if [ -s "$WORK/patterns.txt" ]; then
  grep -vF -f "$WORK/patterns.txt" "$WORK/candidates.txt" > "$WORK/unexpected.txt" || true
else
  cp "$WORK/candidates.txt" "$WORK/unexpected.txt"
fi

if [ -s "$WORK/unexpected.txt" ]; then
  echo "vendor-diff gate FAILED: vendor/interchange drifts from stock $STOCK_REF outside the allowlist:"
  cat "$WORK/unexpected.txt"
  echo "Either revert the files above toward stock, or record them in $ALLOWLIST with an upstream-issue justification."
  exit 1
fi
echo "vendor-diff gate passed: no vendor drift from stock $STOCK_REF (allowlist: $ALLOWLIST)."
if [ -s "$WORK/upstream-only.txt" ]; then
  echo "informational: upstream paths absent from the pruned checkout:"
  cat "$WORK/upstream-only.txt"
fi
