#!/bin/sh
# Builds every test script and the demo with the native command line tool; fails on the first error.
#   core/test/run-native.sh [path/to/temencore]
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
BIN=${1:-$ROOT/build/native/temencore}
node -e "import('$ROOT/src/default-script.js').then((m) => require('fs').writeFileSync('$HERE/.demo.js', m.DEFAULT_SCRIPT))"
status=0
for f in "$ROOT"/test/*.js "$ROOT"/test/images "$HERE/.demo.js"; do
  if out=$("$BIN" "$f" 2>&1); then
    echo "ok   $(basename "$f")  $(echo "$out" | tail -1)"
  else
    echo "FAIL $(basename "$f")"; echo "$out" | tail -5; status=1
  fi
done
rm -f "$HERE/.demo.js"
exit $status
