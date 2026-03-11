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
bun socket               # Start WebSocket relay server (port 3055)
bun setup                # Full setup (install + write .cursor/mcp.json + .mcp.json)
bun run build:plugin     # Bundle Figma plugin (src/figma_plugin/src/ → code.js)
bun run test             # Run tests (bun:test)
bun run lint             # Lint with Biome
bun run lint:fix         # Auto-fix lint + format issues
bun run format           # Auto-format with Biome
bun run check            # Lint + format check combined
```

## Architecture

### MCP Server (`src/figmagent_mcp/`)
Modular server implementing MCP via `@modelcontextprotocol/sdk`. Entry point is `server.ts` which imports domain-grouped tool modules from `tools/` (document, create, modify, text, layout, components, export, scan, libraries) and prompt definitions from `prompts/`. Exposes 60+ tools and 6 AI prompts. Types in `types.ts`, utilities in `utils.ts`, WebSocket connection management in `connection.ts`. Communicates with the AI agent over stdio and with the WebSocket relay via `ws`. Each request gets a UUID, is tracked in a `pendingRequests` Map with timeout/promise callbacks, and resolves when the plugin responds.

### WebSocket Relay (`src/socket.ts`)
Lightweight Bun WebSocket server on port 3055 (configurable via `PORT` env). Routes messages between MCP server and Figma plugin using channel-based isolation. Clients call `join` to enter a channel; messages broadcast only within the same channel. Exposes `GET /channels` HTTP endpoint for auto-discovery of active channels.

### Figma Plugin (`src/figma_plugin/`)
Runs inside Figma. Source lives in `src/figma_plugin/src/` as ES modules, bundled into a single `code.js` via `bun run build:plugin`. `code.js` is the plugin main thread handling 55+ commands via a dispatcher. `ui.html` is the plugin UI for WebSocket connection management. `manifest.json` declares permissions (dynamic-page access, localhost network).

**Source structure** (mirrors the MCP server's `tools/` layout):
- `src/main.js` — entry point: imports, concurrency control, command dispatcher, plugin UI handlers
- `src/helpers.js` — shared utilities: state, progress updates, toNumber, filterFigmaNode, etc.
- `src/setcharacters.js` — font-safe text replacement (handles mixed fonts)
- `src/commands/document.js` — getDocumentInfo, getSelection, getNodeInfo, readMyDesign, etc.
- `src/commands/create.js` — createRectangle, createFrame, createText, createFrameTree
- `src/commands/modify.js` — setFillColor, moveNode, deleteNode, cloneAndModify, etc.
- `src/commands/text.js` — setTextContent, setMultipleTextContents
- `src/commands/layout.js` — setLayoutMode, setPadding, setAxisAlign, setLayoutSizing, setItemSpacing
- `src/commands/components.js` — createComponent, combineAsVariants, instance overrides, component properties, exposed instances, etc.
- `src/commands/scan.js` — scanTextNodes, scanNodesByTypes, annotations
- `src/commands/styles.js` — getStyles, getLocalVariables, bindVariable, batchSetTextStyles, etc.
- `src/commands/connections.js` — setDefaultConnector, createConnections, setFocus, setSelections

**JS constraints**: The bundled `code.js` runs in Figma's sandboxed JS VM. The source files are modern ES modules (arrow functions, let/const, template literals are all fine — bun bundles them into an IIFE). However, do **not** use optional chaining (`?.`) or nullish coalescing (`??`) in source files — Biome enforces this via `useOptionalChain: off` override. After editing source files, run `bun run build:plugin` to regenerate `code.js`.

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
- **Component properties**: Use `get_component_properties` to discover property definitions (names with #suffix, types, defaults). Then `add_component_property` to add BOOLEAN/TEXT/INSTANCE_SWAP/VARIANT properties, `edit_component_property` to rename or change defaults, `delete_component_property` to remove. BOOLEAN defaults are real booleans; all others are strings. Use `set_exposed_instance` on a nested INSTANCE to create a slot.
- **Comments**: Use `get_comments`, `post_comment`, `delete_comment` to read/write Figma file comments via REST API. Requires `FIGMA_API_TOKEN` with `file_comments:read` and `file_comments:write` scopes. The `fileKey` param comes from the Figma URL: `https://www.figma.com/design/<fileKey>/...`

## Figma Design Patterns

These are hard-won patterns from real agent sessions. Violating them causes silent failures or wasted tool calls.

### Sizing sequencing
Cannot set `FILL` sizing at frame creation time — the frame isn't yet a child of an auto-layout parent when the property is set. **Pattern**: Create the frame first (with `parentId`), THEN call `set_layout_sizing` separately. `create_frame_tree` handles this automatically with two-pass sizing.

### Use FRAME, not RECTANGLE, for stretchy shapes
RECTANGLE nodes cannot have `layoutSizingVertical: FILL`. Use a FRAME with a fill color instead. Example: a 1px-wide FRAME replaces a RECTANGLE for timeline connecting lines.

### `create_frame_tree` inline capabilities
Beyond basic structure, the tree spec supports: `cornerRadius`, `strokeColor` + `strokeWeight`, font properties (`fontWeight`, `fontSize`, `fontColor`) on TEXT nodes, and `fillColor`. FILL sizing is applied in a second pass after all nodes exist. The root node's FILL sizing works if the parent has auto-layout.

### Instance text override ID format
For text overrides on instances, use the path format `I<instanceId>;<componentTextNodeId>`. For nested instances: `I<outerInstance>;<innerInstance>;<textNodeId>`. Use `scan_text_nodes` on the component to discover text node IDs first.

### Bind variables on COMPONENT nodes, not instances
Variable bindings and text style assignments propagate from a COMPONENT to all its instances automatically. Always bind at the component level. Use `get_main_component(instanceId)` to resolve an instance to its source component.

### Reparenting nodes
No `reparent_node` tool exists — `move_node` only changes x/y, not hierarchy. To move a node to a new parent: `clone_and_modify(nodeId, parentId=newParent)` + delete the original. Clones preserve all instance overrides.

### Silent connection drops
If commands time out consistently, the plugin connection has likely dropped. Closing/reopening the plugin in Figma creates a NEW channel. Recovery: call `join_channel` again (auto-discovers the new channel). The relay stays running; it's the plugin↔relay WebSocket that breaks.

### MCP tool discovery after code changes
When new tools are added to the MCP server source, they won't appear until the MCP connection is restarted (via `/mcp` in Claude Code). After restart, tools need re-discovery via `ToolSearch` and the channel needs re-joining.

## Concurrency & Sub-Agents

### Plugin concurrency control
The plugin classifies operations: `READ_OPS` run freely, `GLOBAL_OPS` (e.g., `create_frame_tree`, `batch_bind_variables`, `delete_multiple_nodes`) serialize via global mutex, and per-node writes lock by `nodeId`. Max 6 concurrent in-flight operations. This makes parallel agent execution safe when agents operate on disjoint node sets.

### Sub-agent architecture
For large Figma tasks (8+ variants, 100+ tool calls), use the `/figma-sub-agents` skill to delegate work:
- **Discovery** (`.claude/agents/figma-discovery.md`) — read-only exploration, returns structured JSON summary
- **Builder** — creates/clones node structures, can run in parallel (max 3)
- **Styler** — applies variable bindings and text styles, can run in parallel (max 3)

Phases must be sequential: Discovery → Build → Style. Within Build or Style, agents can run in parallel on disjoint node subtrees. All agents share one WebSocket channel — request UUID correlation routes responses.

## Setup

1. Run `bun setup` — installs dependencies and writes MCP config for both Cursor (`.cursor/mcp.json`) and Claude Code (`.mcp.json`)
2. `bun socket` in one terminal (WebSocket relay)
3. In Figma: Plugins > Development > Link existing plugin > select `src/figma_plugin/manifest.json`
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
