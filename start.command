#!/bin/bash
# Double-click (macOS) or run: ./start.command  → opens http://127.0.0.1:3000
cd "$(dirname "$0")"
[ -f .env ] || cp .env.example .env
(sleep 1.5; open "http://127.0.0.1:${PORT:-3000}") &
exec node server.js
