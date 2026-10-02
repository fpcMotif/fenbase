#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCS_ROOT="${1:-$SCRIPT_DIR/docs}"

if [ ! -d "$DOCS_ROOT" ]; then
  echo "Docs root not found: $DOCS_ROOT" >&2
  exit 1
fi

echo "Deprecated document reference check:"
cd "$SCRIPT_DIR"
node scripts/check-deprecated-doc-refs.mjs "$DOCS_ROOT"
