#!/bin/sh
# Builds every test script and the demo with the native command line tool; fails on the first error.
#   core/test/run-native.sh [path/to/temencore]
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
BIN=${1:-$ROOT/build/native/temencore}
cd "$ROOT"
node -e "import('./src/default-script.js').then((m) => require('fs').writeFileSync('core/test/.demo.js', m.DEFAULT_SCRIPT))"
status=0
for f in test/*.js test/images test/svg core/test/.demo.js; do
  if out=$("$BIN" "$f" 2>&1); then
    echo "ok   $(basename "$f")  $(echo "$out" | tail -1)"
  else
    echo "FAIL $(basename "$f")"; echo "$out" | tail -5; status=1
  fi
done
rm -f core/test/.demo.js

# .temen archives, as the web app saves them (zips written by fflate): project.temen has a subfolder and
# the app's own .assistant/ data and Finder junk to skip; lone.temen is a single script that becomes the entry
for f in core/test/project.temen core/test/lone.temen; do
  if out=$("$BIN" "$f" 2>&1); then
    echo "ok   $(basename "$f")  $(echo "$out" | tail -1)"
  else
    echo "FAIL $(basename "$f")"; echo "$out" | tail -5; status=1
  fi
done
exit $status
