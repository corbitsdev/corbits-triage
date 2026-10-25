#!/bin/sh
# CI vendor-diff gate: files under vendor/interchange must match the pinned
# stock Interchange commit, except for entries in
# tooling/vendor-diff-allowlist.txt and missing stock paths that match an entry
# in tooling/vendor-diff-pruned.txt exactly or as a directory prefix. Exits 0
# when clean, 1 with the offending paths otherwise.
#
# Scope notes:
# - Compares committed content only: the vendor/interchange tree at HEAD
#   against the stock commit's tree, by exact path, mode and blob id. Local
#   untracked or uncommitted files are not seen.
# - The vendored tree is a pruned checkout: a stock path missing from it is
#   reported as information when tooling/vendor-diff-pruned.txt lists it or
#   a directory above it, and fails otherwise. A pruned entry fails when it
#   covers a vendored path or no missing stock path. The gate fails on any other
#   difference: a changed blob, mode or type, or a path added locally, unless
#   the path is exactly an allowlist entry. Our provenance record
#   (VENDORED.md) is excluded.
#
# Env overrides:
#   INTERCHANGE_STOCK_REPO  upstream repo (default https://github.com/faremeter/interchange)
#   INTERCHANGE_STOCK_REF   pinned stock commit (default b1ca01f0d9bc2eb203e95b1780a6f685c5da8215)
set -eu

STOCK_REPO="${INTERCHANGE_STOCK_REPO:-https://github.com/faremeter/interchange}"
STOCK_REF="${INTERCHANGE_STOCK_REF:-b1ca01f0d9bc2eb203e95b1780a6f685c5da8215}"
ALLOWLIST="tooling/vendor-diff-allowlist.txt"
PRUNED="tooling/vendor-diff-pruned.txt"
VENDOR_DIR="vendor/interchange"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

VENDOR_TREE="$(git rev-parse --verify "HEAD:$VENDOR_DIR")"

git init -q "$WORK/stock"
git -C "$WORK/stock" fetch -q --depth 1 "$STOCK_REPO" "$STOCK_REF"
STOCK_TREE="$(git -C "$WORK/stock" rev-parse --verify "FETCH_HEAD^{tree}")"
# The scratch repo then borrows this repository's objects, so one diff-tree
# sees both trees without fetching stock into this repository. Borrowing only
# after the fetch keeps a shallow checkout's refs out of its negotiation.
echo "$(git rev-parse --path-format=absolute --git-common-dir)/objects" \
  > "$WORK/stock/.git/objects/info/alternates"

# Quoted paths keep each entry on one line: a path with a control character
# is quoted, so it never equals an allowlist entry and fails.
git -C "$WORK/stock" -c core.quotePath=true diff-tree -r --no-renames --no-abbrev \
  "$STOCK_TREE" "$VENDOR_TREE" > "$WORK/diff.txt"

grep -v '^#' "$ALLOWLIST" | grep -v '^$' > "$WORK/allowlist.txt" || true
grep -v '^#' "$PRUNED" | grep -v '^$' > "$WORK/pruned.txt" || true
git -c core.quotePath=true ls-tree -r --name-only "$VENDOR_TREE" > "$WORK/vendored.txt"

# A deleted entry passes as pruned when its path or a directory above it is
# listed. A pruned entry fails when it covers a vendored path, so it can't hide
# one, or covers no deleted path, such as a directory without its trailing `/`.
# Every other entry fails unless its path is exactly allowlisted; a line that
# is not a diff-tree raw entry fails as it is.
awk -v allowlist="$WORK/allowlist.txt" \
  -v pruned="$WORK/pruned.txt" \
  -v vendored="$WORK/vendored.txt" \
  -v unexpected="$WORK/unexpected.txt" \
  -v pruned_problems="$WORK/pruned-problems.txt" \
  -v upstream_only="$WORK/upstream-only.txt" '
  BEGIN {
    while ((getline entry < allowlist) > 0) allowed[entry] = 1
    allowed["VENDORED.md"] = 1
    while ((getline entry < pruned) > 0) pruned_paths[entry] = 1
    printf "" > unexpected
    printf "" > upstream_only
    printf "" > pruned_problems
    while ((getline path < vendored) > 0) {
      entry = pruned_entry(path)
      if (entry != "") print "covers vendored " path ": " entry > pruned_problems
    }
  }
  function pruned_entry(path,  i) {
    if (path in pruned_paths) return path
    for (i = length(path) - 1; i > 0; i--)
      if (substr(path, i, 1) == "/" && (substr(path, 1, i) in pruned_paths)) return substr(path, 1, i)
    return ""
  }
  !/^:[0-7]+ [0-7]+ [0-9a-f]+ [0-9a-f]+ [A-Z][0-9]*\t/ {
    print "unparseable: " $0 > unexpected
    next
  }
  {
    path = substr($0, index($0, "\t") + 1)
    status = substr($5, 1, 1)
    entry = status == "D" ? pruned_entry(path) : ""
    if (entry != "") {
      covered[entry] = 1
      print path > upstream_only
    } else if (!(path in allowed)) print status " " path > unexpected
  }
  END {
    for (entry in pruned_paths)
      if (!(entry in covered)) print "covers no missing stock path: " entry > pruned_problems
  }
' "$WORK/diff.txt"

if [ -s "$WORK/unexpected.txt" ]; then
  echo "vendor-diff gate FAILED: vendor/interchange drifts from stock $STOCK_REF outside the allowlist:"
  cat "$WORK/unexpected.txt"
  echo "Either revert the files above toward stock, or record them in $ALLOWLIST with an upstream-issue justification."
fi
if [ -s "$WORK/pruned-problems.txt" ]; then
  echo "vendor-diff gate FAILED: $PRUNED has entries that don't match what is pruned:"
  sort "$WORK/pruned-problems.txt"
  echo "Remove or narrow the entries above in $PRUNED."
fi
if [ -s "$WORK/unexpected.txt" ] || [ -s "$WORK/pruned-problems.txt" ]; then
  exit 1
fi
echo "vendor-diff gate passed: no vendor drift from stock $STOCK_REF (allowlist: $ALLOWLIST, pruned: $PRUNED)."
echo "informational: $(wc -l < "$WORK/upstream-only.txt" | tr -d ' ') upstream paths are absent from the pruned checkout."
