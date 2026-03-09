#!/bin/bash

# Get the directory where this script lives, then resolve to repo root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_PATH="$REPO_DIR/src/talk_to_figma_mcp/server.ts"

MCP_CONFIG="{
  \"mcpServers\": {
    \"TalkToFigma\": {
      \"command\": \"bun\",
      \"args\": [
        \"$SERVER_PATH\"
      ]
    }
  }
}"

bun install

# Cursor: write .cursor/mcp.json
mkdir -p .cursor
echo "$MCP_CONFIG" > .cursor/mcp.json
echo "✓ Cursor MCP config written to .cursor/mcp.json"

# Claude Code: write .mcp.json in project root
echo "$MCP_CONFIG" > .mcp.json
echo "✓ Claude Code MCP config written to .mcp.json"
