#!/bin/sh
# Copies what the iOS assistant shares with the web app into the app's resources:
#   public/api.txt            the API reference (generated from api.html by `npm run build`)
#   public/api-catalog.json   the editor's completion entries (from src/api-catalog.js, same build)
#   src/assistant-rules.txt   the modelling rules both assistants follow
# Run after changing either (and commit the copies, so the iOS build needs no Node).
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DEST="$ROOT/ios/TemenCAD/Resources"
(cd "$ROOT" && node scripts/api-text.mjs >/dev/null)
cp "$ROOT/public/api.txt" "$DEST/api.txt"
cp "$ROOT/public/api-catalog.json" "$DEST/api-catalog.json"
cp "$ROOT/src/assistant-rules.txt" "$DEST/assistant-rules.txt"
echo "synced api.txt ($(wc -l < "$DEST/api.txt") lines), api-catalog.json and assistant-rules.txt"
