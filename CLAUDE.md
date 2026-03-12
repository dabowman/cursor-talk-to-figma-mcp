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
Modular server implementing MCP via `@modelcontextprotocol/sdk`. Entry point is `server.ts` which imports domain-grouped tool modules from `tools/` (document, create, apply, modify, text, components, export, scan, libraries) and prompt definitions from `prompts/`. Exposes 50+ tools and 6 AI prompts. Types in `types.ts`, utilities in `utils.ts`, WebSocket connection management in `connection.ts`. Communicates with the AI agent over stdio and with the WebSocket relay via `ws`. Each request gets a UUID, is tracked in a `pendingRequests` Map with timeout/promise callbacks, and resolves when the plugin responds.

### WebSocket Relay (`src/socket.ts`)
Lightweight Bun WebSocket server on port 3055 (configurable via `PORT` env). Routes messages between MCP server and Figma plugin using channel-based isolation. Clients call `join` to enter a channel; messages broadcast only within the same channel. Exposes `GET /channels` HTTP endpoint for auto-discovery of active channels.

### Figma Plugin (`src/figma_plugin/`)
Runs inside Figma. Source lives in `src/figma_plugin/src/` as ES modules, bundled into a single `code.js` via `bun run build:plugin`. `code.js` is the plugin main thread handling 55+ commands via a dispatcher. `ui.html` is the plugin UI for WebSocket connection management. `manifest.json` declares permissions (dynamic-page access, localhost network).

**Source structure** (mirrors the MCP server's `tools/` layout):
- `src/main.js` — entry point: imports, concurrency control, command dispatcher, plugin UI handlers
- `src/helpers.js` — shared utilities: state, progress updates, toNumber, filterFigmaNode, etc.
- `src/setcharacters.js` — font-safe text replacement (handles mixed fonts)
- `src/commands/document.js` — getDocumentInfo, getSelection, getNodeInfo, readMyDesign, getNodeTree (FSGN traversal), exportNodeAsImage
- `src/commands/create.js` — create (single nodes and nested trees)
- `src/commands/apply.js` — unified property application: fill, stroke, corner radius, opacity, layout, variables, text styles
- `src/commands/modify.js` — moveNode, resizeNode, renameNode, deleteNode, cloneNode, cloneAndModify, reorderChildren
- `src/commands/text.js` — setTextContent, setMultipleTextContents
- `src/commands/components.js` — createComponent, combineAsVariants, instance overrides, component properties, exposed instances, etc.
- `src/commands/scan.js` — scanTextNodes, scanNodesByTypes, annotations
- `src/commands/styles.js` — getStyles, getLocalVariables, getLocalComponents, FIELD_MAP (shared with apply.js)
- `src/commands/connections.js` — setDefaultConnector, createConnections, setFocus, setSelections

**JS constraints**: The bundled `code.js` runs in Figma's sandboxed JS VM. The source files are modern ES modules (arrow functions, let/const, template literals are all fine — bun bundles them into an IIFE). However, do **not** use optional chaining (`?.`) or nullish coalescing (`??`) in source files — Biome enforces this via `useOptionalChain: off` override. After editing source files, run `bun run build:plugin` to regenerate `code.js`.

## Key Patterns

- **Colors**: Figma uses RGBA 0-1 range. The MCP tools accept 0-1 floats.
- **Logging**: All logs go to stderr. Stdout is reserved for MCP protocol messages.
- **Timeouts**: 30s default per command. Progress updates from the plugin reset the inactivity timer.
- **Chunking**: Large operations (scanning 100+ nodes) are chunked with progress updates to prevent Figma UI freezing.
- **Reconnection**: WebSocket auto-reconnects after 2 seconds on disconnect.
- **Zod validation**: All tool parameters are validated with Zod schemas.
- **Batch operations**: Prefer `set_multiple_text_contents`, `delete_multiple_nodes`, `set_multiple_annotations` over repeated single-node calls. Use `create` for all node creation — it handles both single nodes and nested trees. Use `apply` for all property changes — it handles fill, stroke, corner radius, opacity, layout, variables, and text styles on one or many nodes.
- **Tree inspection**: Prefer `get_node_tree` over `read_my_design` or repeated `get_node_info` calls. Use `detail="structure"` for orientation (~5 tokens/node), `detail="layout"` for building/cloning (~15 tokens/node), `detail="full"` for variable/style audits (~30 tokens/node). Start with `depth=3` for component internals. Instances are leaf nodes by default — call `get_node_tree` on an instance ID to expand its internals. If `tokenEstimate > 8000`, narrow with `depth` or `filter`.
- **Layout inspection**: `get_node_tree` and `get_node_info` return auto-layout properties (layoutMode, sizing modes, alignment, spacing, padding, layoutWrap) on frames with active auto-layout. Default values (MIN alignment, zero spacing/padding, NO_WRAP) are omitted to keep output concise.
- **FSGN format**: `get_node_tree` returns YAML in Figma Scene Graph Notation. The `meta` section has `nodeCount` and `tokenEstimate`. The `defs` section deduplicates variables (`v1`, `v2`…), styles (`s1`, `s2`…), and components (`c1`, `c2`…) referenced throughout `nodes`. Use the short IDs from `defs` when calling `apply` with `variables` or `textStyleId`.
- **Design tokens**: Use `get_local_variables` to discover variables, then `apply` with `variables` field to bind them to node properties. Supports all fields in FIELD_MAP (fill, stroke, opacity, cornerRadius, padding, spacing, width, height, visible, characters, etc.). Color variables bind via `setBoundVariableForPaint`; scalar variables bind via `setBoundVariable`.
- **Text styles**: Use `get_styles` to discover text styles, then `apply` with `textStyleId` to apply them. The `apply` tool deduplicates font loading across multiple nodes automatically.
- **Component properties**: Use `get_component_properties` to discover property definitions (names with #suffix, types, defaults). Then `add_component_property` to add BOOLEAN/TEXT/INSTANCE_SWAP/VARIANT properties, `edit_component_property` to rename or change defaults, `delete_component_property` to remove. BOOLEAN defaults are real booleans; all others are strings.
- **Exposed instances vs slots**: `set_exposed_instance` sets `isExposedInstance` on a nested INSTANCE, which surfaces that instance's component properties at the parent level (so users don't need to deep-select to find them). This is NOT the same as Figma's newer "Slot" feature. Slots are a distinct component property type (flexible content areas where users can add/remove/reorder any content) but have no plugin API support yet — they can only be created through the Figma UI.
- **Comments**: Use `get_comments`, `post_comment`, `delete_comment` to read/write Figma file comments via REST API. Requires `FIGMA_API_TOKEN` with `file_comments:read` and `file_comments:write` scopes. The `fileKey` param comes from the Figma URL: `https://www.figma.com/design/<fileKey>/...`

## Figma Design Patterns

These are hard-won patterns from real agent sessions. Violating them causes silent failures or wasted tool calls.

### Sizing sequencing
Cannot set `FILL` sizing at frame creation time — the frame isn't yet a child of an auto-layout parent when the property is set. **Pattern**: Create the frame first (with `parentId`), THEN call `apply` with `layoutSizingHorizontal`/`layoutSizingVertical` separately. The `create` tool handles this automatically with two-pass sizing.

### Use FRAME, not RECTANGLE, for stretchy shapes
RECTANGLE nodes cannot have `layoutSizingVertical: FILL`. Use a FRAME with a fill color instead. Example: a 1px-wide FRAME replaces a RECTANGLE for timeline connecting lines.

### `create` tool capabilities
The `create` tool is the single entry point for all node creation. It accepts a node spec that can be a single node or a nested tree. Supported properties: `cornerRadius`, `strokeColor` + `strokeWeight`, font properties (`fontWeight`, `fontSize`, `fontFamily`, `fontStyle`, `fontColor`) on TEXT nodes, `fillColor`, and all auto-layout properties on FRAMEs. FILL sizing is applied in a second pass after all nodes exist. The root node's FILL sizing works if the parent has auto-layout.

### `apply` tool capabilities
The `apply` tool is the single entry point for modifying properties on existing nodes. It accepts a flat list or nested tree of node operations. Each operation targets a `nodeId` and can set any combination of: `fillColor`, `strokeColor`, `strokeWeight`, `cornerRadius`, `opacity`, `width`, `height`, layout properties (`layoutMode`, `layoutWrap`, padding, alignment, sizing, spacing), `variables` (map of field→variableId for design token bindings), and `textStyleId`. Execution order per node: layout mode → direct values → variable bindings → text style. Variable bindings override direct values (set both for fallback + token).

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
The plugin classifies operations: `READ_OPS` run freely, `GLOBAL_OPS` (e.g., `create`, `apply`, `delete_multiple_nodes`) serialize via global mutex, and per-node writes lock by `nodeId`. Max 6 concurrent in-flight operations. This makes parallel agent execution safe when agents operate on disjoint node sets.

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
- Use `get_node_tree(detail="structure", depth=2)` on a target node to orient before making modifications. Prefer this over `read_my_design` (raw JSON dump) and repeated `get_node_info` depth escalation
- Use `get_styles` and `get_local_variables` to discover the design system before applying styles/tokens
- The plugin and relay must both be running before any tool calls succeed
- After 2 consecutive identical errors on the same tool, stop retrying and diagnose the root cause (wrong node ID, lost connection, or type mismatch)
- After 2 timeouts in a row, assume the WebSocket connection is lost — call `join_channel` to re-establish before retrying
