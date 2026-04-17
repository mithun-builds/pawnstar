#!/bin/bash
cd "$(dirname "$0")"
echo "Starting local server for PawnStar..."
python3 -m http.server 8080 &
SERVER_PID=$!
sleep 1
open http://localhost:8080
echo "Press [CTRL+C] in this window to stop the server when you're done."
wait $SERVER_PID
