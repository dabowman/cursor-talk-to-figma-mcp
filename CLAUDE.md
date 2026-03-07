# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP (Model Context Protocol) server that bridges AI agents (Cursor, Claude Code) with Figma. Three components communicate in a pipeline:

```
Claude Code / Cursor <-(stdio)-> MCP Server <-(WebSocket)-> WebSocket Relay <-(WebSocket)-> Figma Plugin
```

## Build & Development Commands

```bash
bun install              # Install dependencies
bun run build            # Build MCP server (tsup -> dist/)
bun run dev              # Build in watch mode
bun socket               # Start WebSocket relay server (port 3055)
bun run start            # Run built MCP server
bun setup                # Full setup (install + write .cursor/mcp.json + .mcp.json)
bun run test             # Run tests (bun:test)
bun run lint             # Lint with Biome
bun run lint:fix         # Auto-fix lint + format issues
bun run format           # Auto-format with Biome
bun run check            # Lint + format check combined
```

## Architecture

### MCP Server (`src/talk_to_figma_mcp/`)
Modular server implementing MCP via `@modelcontextprotocol/sdk`. Entry point is `server.ts` which imports domain-grouped tool modules from `tools/` (document, create, modify, text, layout, components, export, scan, libraries) and prompt definitions from `prompts/`. Exposes 55+ tools and 6 AI prompts. Types in `types.ts`, utilities in `utils.ts`, WebSocket connection management in `connection.ts`. Communicates with the AI agent over stdio and with the WebSocket relay via `ws`. Each request gets a UUID, is tracked in a `pendingRequests` Map with timeout/promise callbacks, and resolves when the plugin responds.

### WebSocket Relay (`src/socket.ts`)
Lightweight Bun WebSocket server on port 3055 (configurable via `PORT` env). Routes messages between MCP server and Figma plugin using channel-based isolation. Clients call `join` to enter a channel; messages broadcast only within the same channel. Exposes `GET /channels` HTTP endpoint for auto-discovery of active channels.

### Figma Plugin (`src/cursor_mcp_plugin/`)
Runs inside Figma. `code.js` is the plugin main thread handling 55+ commands via a dispatcher. `ui.html` is the plugin UI for WebSocket connection management. `manifest.json` declares permissions (dynamic-page access, localhost network). The plugin is **not built/bundled** — `code.js` is written directly as the runtime artifact.

**JS constraints**: `code.js` runs in Figma's sandboxed JS VM, not a modern browser engine. Do **not** use optional chaining (`?.`), nullish coalescing (`??`), catch binding omission (`catch {}`), or other post-ES2017 syntax. These cause syntax errors at plugin load time. `let`/`const` are fine, but `var` inside nested functions triggers Biome's `noInnerDeclarations`.

### Build (`tsup.config.ts`)
Bundles only the MCP server (`src/talk_to_figma_mcp/server.ts`) into `dist/` as both CJS and ESM. DTS (type declaration) generation is disabled. The WebSocket relay and Figma plugin are not part of the build output.

## Key Patterns

- **Colors**: Figma uses RGBA 0-1 range. The MCP tools accept 0-1 floats.
- **Logging**: All logs go to stderr. Stdout is reserved for MCP protocol messages.
- **Timeouts**: 30s default per command. Progress updates from the plugin reset the inactivity timer.
- **Chunking**: Large operations (scanning 100+ nodes) are chunked with progress updates to prevent Figma UI freezing.
- **Reconnection**: WebSocket auto-reconnects after 2 seconds on disconnect.
- **Zod validation**: All tool parameters are validated with Zod schemas.
- **Batch operations**: Prefer `set_multiple_text_contents`, `delete_multiple_nodes`, `set_multiple_annotations`, `set_multiple_properties`, `create_frame_tree` over repeated single-node calls.
- **Large nodes**: Use `get_node_info` with `depth=1` or `depth=2` for large component sets to avoid token overflow. Use `depth=2` or `depth=3` when first inspecting component sets or complex frames. Omit `depth` for full tree on small nodes.
- **Layout inspection**: `get_node_info` and `read_my_design` return auto-layout properties (layoutMode, sizing modes, alignment, spacing, padding, layoutWrap) on frames with active auto-layout. Default values (MIN alignment, zero spacing/padding, NO_WRAP) are omitted to keep output concise.
- **Design tokens**: Use `get_local_variables` to discover variables, then `batch_bind_variables` to bind them to node properties in bulk. For single bindings, `bind_variable` also works. Color variables bind via `setBoundVariableForPaint`; scalar variables bind via `setBoundVariable`.
- **Text styles**: Use `get_styles` to discover text styles, then `batch_set_text_styles` to apply them to multiple text nodes at once (deduplicates font loading). For single nodes, `set_text_style` also works.
- **Comments**: Use `get_comments`, `post_comment`, `delete_comment` to read/write Figma file comments via REST API. Requires `FIGMA_API_TOKEN` with `file_comments:read` and `file_comments:write` scopes. The `fileKey` param comes from the Figma URL: `https://www.figma.com/design/<fileKey>/...`

## Local Development

For local development, point the MCP config to the local server.ts instead of the published package:

```json
{
  "mcpServers": {
    "TalkToFigma": {
      "command": "bun",
      "args": ["/path-to-repo/src/talk_to_figma_mcp/server.ts"]
    }
  }
}
```

## Setup

1. Run `bun setup` — installs dependencies and writes MCP config for both Cursor (`.cursor/mcp.json`) and Claude Code (`.mcp.json`)
2. `bun socket` in one terminal (WebSocket relay)
3. In Figma: Plugins > Development > Link existing plugin > select `src/cursor_mcp_plugin/manifest.json`
4. Run plugin in Figma, click Connect, then call `join_channel` (no arguments needed — auto-discovers the active channel)

### Windows/WSL

Uncomment the `hostname: "0.0.0.0"` line in `src/socket.ts` to allow connections from Windows host.

## Agent Notes

- Always call `join_channel` before issuing any Figma commands (no arguments needed — auto-discovers the active plugin channel via the relay's `GET /channels` endpoint)
- Call `get_document_info` first to understand the design structure
- Use `read_my_design` or `get_selection` before making modifications
- Use `get_styles` and `get_local_variables` to discover the design system before applying styles/tokens
- The plugin and relay must both be running before any tool calls succeed
- After 2 consecutive identical errors on the same tool, stop retrying and diagnose the root cause (wrong node ID, lost connection, or type mismatch)
- After 2 timeouts in a row, assume the WebSocket connection is lost — call `join_channel` to re-establish before retrying
