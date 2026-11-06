#!/bin/bash
# Nested test of the fork with the gnome-extensions skill's runner (headless):
#   tests/run.sh [test name] [--profile] [--visible] [--keep]     default: smoke
# Results (shell.log, result, out.json) in $DIR (default /tmp/claude-1000/awsm-tests/<name>).
# EXT=<dir> runs another copy of the extension (e.g. the old code, for comparing out.json).
# Also fails when shell.log holds a JS ERROR from the extension.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
EXT=${EXT:-$(dirname "$HERE")}
NAME=${1:-smoke}; [ $# -gt 0 ] && shift
DIR=${DIR:-/tmp/claude-1000/awsm-tests/$NAME}
~/.claude/skills/gnome-extensions/nested-test/nested-test.sh \
    --dir "$DIR" --script "$HERE/$NAME.js" --ext "$EXT" \
    ${TEST_TIMEOUT:+--timeout $TEST_TIMEOUT} "$@"
rc=$?
if grep -q "NESTED-TEST: ERROR\|JS ERROR.*another-window\|another-window-session-manager.*Error" "$DIR/shell.log" 2>/dev/null; then
    echo "FAIL: JS ERROR from the extension in $DIR/shell.log"
    grep "JS ERROR\|NESTED-TEST: ERROR\|another-window-session-manager.*Error" "$DIR/shell.log" | head -5
    rc=1
fi
exit $rc
