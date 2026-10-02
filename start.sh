#!/usr/bin/env sh
# Start the OpenCode Go session proxy. Extra arguments are passed through,
# for example:  ./start.sh --port 9000
exec node "$(dirname "$0")/proxy.mjs" --port 8787 "$@"
