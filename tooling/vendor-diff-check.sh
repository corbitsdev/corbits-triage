#!/bin/sh
# CI vendor-diff gate: files under vendor/interchange must match the pinned
# stock Interchange commit, except for entries in
# tooling/vendor-diff-allowlist.txt. Exits 0 when clean, 1 with the
# offending paths otherwise.
#
# Scope notes:
# - Compares committed content only: the vendor/interchange tree at HEAD
#   against the stock commit's tree, by exact path, mode and blob id. Local
#   untracked or uncommitted files are not seen.
# - The vendored tree is a pruned checkout (upstream-only paths such as
#   bin/, docs/, or packages never vendored are reported as information,
#   not failures). The gate fails on any other difference: a changed blob,
#   mode or type, or a path added locally, unless the path is exactly an
#   allowlist entry. Our provenance record (VENDORED.md) is excluded.
#
# Env overrides:
#   INTERCHANGE_STOCK_REPO  upstream repo (default https://github.com/faremeter/interchange)
#   INTERCHANGE_STOCK_REF   pinned stock commit (default b1ca01f0d9bc2eb203e95b1780a6f685c5da8215)
set -eu

STOCK_REPO="${INTERCHANGE_STOCK_REPO:-https://github.com/faremeter/interchange}"
STOCK_REF="${INTERCHANGE_STOCK_REF:-b1ca01f0d9bc2eb203e95b1780a6f685c5da8215}"
ALLOWLIST="tooling/vendor-diff-allowlist.txt"
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

# Deleted entries are the pruned upstream-only paths. Every other entry fails
# unless its path is exactly allowlisted; a line that is not a diff-tree raw
# entry fails as it is.
awk -v allowlist="$WORK/allowlist.txt" \
  -v unexpected="$WORK/unexpected.txt" \
  -v upstream_only="$WORK/upstream-only.txt" '
  BEGIN {
    while ((getline entry < allowlist) > 0) allowed[entry] = 1
    allowed["VENDORED.md"] = 1
    printf "" > unexpected
    printf "" > upstream_only
  }
  !/^:[0-7]+ [0-7]+ [0-9a-f]+ [0-9a-f]+ [A-Z][0-9]*\t/ {
    print "unparseable: " $0 > unexpected
    next
  }
  {
    path = substr($0, index($0, "\t") + 1)
    status = substr($5, 1, 1)
    if (status == "D") print path > upstream_only
    else if (!(path in allowed)) print status " " path > unexpected
  }
' "$WORK/diff.txt"

if [ -s "$WORK/unexpected.txt" ]; then
  echo "vendor-diff gate FAILED: vendor/interchange drifts from stock $STOCK_REF outside the allowlist:"
  cat "$WORK/unexpected.txt"
  echo "Either revert the files above toward stock, or record them in $ALLOWLIST with an upstream-issue justification."
  exit 1
fi
echo "vendor-diff gate passed: no vendor drift from stock $STOCK_REF (allowlist: $ALLOWLIST)."
echo "informational: $(wc -l < "$WORK/upstream-only.txt" | tr -d ' ') upstream paths are absent from the pruned checkout."
