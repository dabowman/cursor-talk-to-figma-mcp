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
Modular server implementing MCP via `@modelcontextprotocol/sdk`. Entry point is `server.ts` which imports domain-grouped tool modules from `tools/` (document, create, apply, modify, text, components, export, scan, find, libraries, lint) and prompt definitions from `prompts/`. Exposes 50+ tools and 6 AI prompts. Types in `types.ts`, utilities in `utils.ts`, WebSocket connection management in `connection.ts`. Communicates with the AI agent over stdio and with the WebSocket relay via `ws`. Each request gets a UUID, is tracked in a `pendingRequests` Map with timeout/promise callbacks, and resolves when the plugin responds.

### WebSocket Relay (`src/socket.ts`)
Lightweight Bun WebSocket server on port 3055 (configurable via `PORT` env). Routes messages between MCP server and Figma plugin using channel-based isolation. Clients call `join` to enter a channel; messages broadcast only within the same channel. Exposes `GET /channels` HTTP endpoint for auto-discovery of active channels.

### Figma Plugin (`src/figma_plugin/`)
Runs inside Figma. Source lives in `src/figma_plugin/src/` as ES modules, bundled into a single `code.js` via `bun run build:plugin`. `code.js` is the plugin main thread handling 55+ commands via a dispatcher. `ui.html` is the plugin UI for WebSocket connection management. `manifest.json` declares permissions (dynamic-page access, localhost network).

**Source structure** (mirrors the MCP server's `tools/` layout):
- `src/main.js` — entry point: imports, concurrency control, command dispatcher, plugin UI handlers
- `src/helpers.js` — shared utilities: state, progress updates, toNumber, filterFigmaNode, sanitizeSymbols, etc.
- `src/setcharacters.js` — font-safe text replacement (handles mixed fonts)
- `src/commands/document.js` — getDocumentInfo, getSelection, getNodeInfo, readMyDesign, getNodeTree (FSGN traversal), exportNodeAsImage
- `src/commands/create.js` — create (single nodes and nested trees, including COMPONENT and INSTANCE types)
- `src/commands/apply.js` — unified property application: fill, stroke, corner radius, opacity, font properties, layout, variables, text styles, variant swapping, exposed instances
- `src/commands/modify.js` — moveNode, resizeNode, renameNode, deleteNode, cloneNode, cloneAndModify, reorderChildren
- `src/commands/text.js` — setTextContent, setMultipleTextContents
- `src/commands/components.js` — createComponent, combineAsVariants, instance overrides, component properties, exposed instances, etc.
- `src/commands/find.js` — unified search: componentId, variableId, styleId, text, name, type criteria with auto-grouping
- `src/commands/scan.js` — scanTextNodes, scanNodesByTypes, annotations (prefer `find` for new searches)
- `src/commands/styles.js` — getStyles, getLocalVariables, getLocalComponents, getDesignSystem, createVariables, updateVariables, createStyles, updateStyles, FIELD_MAP (shared with apply.js)
- `src/commands/lint.js` — lintDesign: subtree scan for unbound properties, variable matching (CIE76 deltaE for colors), auto-fix
- `src/commands/connections.js` — setDefaultConnector, createConnections, setFocus, setSelections

**JS constraints**: The bundled `code.js` runs in Figma's sandboxed JS VM. The source files are modern ES modules (arrow functions, let/const, template literals are all fine — bun bundles them into an IIFE). However, do **not** use optional chaining (`?.`) or nullish coalescing (`??`) in source files — Biome enforces this via `useOptionalChain: off` override. After editing source files, run `bun run build:plugin` to regenerate `code.js`.

## Key Patterns

- **Colors**: Figma uses RGBA 0-1 range. The MCP tools accept 0-1 floats.
- **Logging**: All logs go to stderr. Stdout is reserved for MCP protocol messages.
- **Session logging**: Every tool call is logged to `~/.figmagent/sessions/` (JSON files named by date + session ID). Logs capture tool name, params summary, duration, success/error, and response size. Use the `export_session` tool to get a summary or full log. Session files are auto-created on the first tool call.
- **Timeouts**: 30s default per command. Progress updates from the plugin reset the inactivity timer.
- **Chunking**: Large operations (scanning 100+ nodes) are chunked with progress updates to prevent Figma UI freezing.
- **Reconnection**: WebSocket auto-reconnects after 2 seconds on disconnect.
- **Zod validation**: All tool parameters are validated with Zod schemas.
- **Output budget**: All variable-size tools (`get`, `find`, `get_design_system`, `scan_nodes_by_types`, `lint_design`) enforce a 30K character default budget. When output exceeds the budget, the response includes the meta/summary section and instructions for narrowing the query. Pass `maxOutputChars` (on `get`, `find`, `get_design_system`) to raise the limit when full data is genuinely needed. `preferredValues` arrays are stripped from instance `componentProperties` and replaced with counts on `componentPropertyDefinitions` — use `component_properties` to access full preferred values. Symbol values (`figma.mixed`) are sanitized to the string `"mixed"` before leaving the plugin.
- **Batch operations**: Prefer `set_multiple_text_contents`, `delete_multiple_nodes`, `set_multiple_annotations` over repeated single-node calls. Use `create` for all node creation — it handles single nodes, nested trees, components, and instances. Use `apply` for all property changes — it handles fill, stroke, corner radius, opacity, font family/weight/size/color, layout, variables, text styles, variant swapping, and exposed instances on one or many nodes.
- **Searching nodes**: Use `find` to search a subtree for nodes matching criteria. Returns matches grouped by nearest component/frame ancestor with ancestry paths. Search criteria (combinable with AND): `componentId` (instances of these components/component_sets), `variableId` (nodes bound to these variables), `styleId` (nodes using these styles), `text` (regex on text content), `name` (regex on node name), `type` (node types), `annotation` (regex on annotation labels), `hasAnnotation` (boolean, find all annotated nodes). Use `excludeDefinitions: true` (default) with `componentId` to skip matches inside the component definitions themselves. Use `scope: "DOCUMENT"` to search all pages (default: current page only). Use `find` to locate targets, then `get` for details, then `apply`/annotate to act. Replaces `scan_nodes_by_types` and `scan_text_nodes` for most use cases.
- **Reading nodes**: Use `get` to read any node and its subtree. **Always start with `detail="structure"` and `depth=2`** for orientation, then increase detail/depth only after reviewing the structure. Accepts `nodeId` (single) or `nodeIds` (multiple, fetched in parallel). Detail levels: `"structure"` (~5 tokens/node), `"layout"` (~15 tokens/node), `"full"` (~30 tokens/node). Going straight to `detail="full"` with high depth risks hitting the 30K char output budget. Instances are leaf nodes by default — call `get` on an instance ID to expand its internals. If `tokenEstimate > 8000`, narrow with `depth` or `filter`. COMPONENT_SET nodes and non-variant COMPONENT nodes include `componentPropertyDefinitions` in the output (with `preferredValues` replaced by counts). Variant components (children of a COMPONENT_SET) do not — their property definitions live on the parent COMPONENT_SET. Instance nodes include `componentRef` (resolved in `defs.components` with id, name, key, description). Use `get` instead of separate `get_component_properties` or `get_main_component` calls.
- **Layout inspection**: `get` returns auto-layout properties (layoutMode, sizing modes, alignment, spacing, padding, layoutWrap) on frames with active auto-layout. Default values (MIN alignment, zero spacing/padding, NO_WRAP) are omitted to keep output concise.
- **FSGN format**: `get` returns YAML in Figma Scene Graph Notation. The `meta` section has `nodeCount` and `tokenEstimate`. The `defs` section deduplicates variables (`v1`, `v2`…), styles (`s1`, `s2`…), and components (`c1`, `c2`…) referenced throughout `nodes`. Use the short IDs from `defs` when calling `apply` with `variables` or `textStyleId`. When multiple nodeIds are passed, returns one FSGN block per node separated by `---`.
- **Design system discovery**: Use `get_design_system` to discover both styles and variables in one call. Returns `{ styles: { colors (with full paints), texts (with fontFamily/fontStyle/fontSize/lineHeight/letterSpacing), effects (with effect objects), grids (with grid configs) }, variables: [collections with modes and values] }`. Replaces separate `get_styles` + `get_local_variables` calls.
- **Design tokens**: Use `get_design_system` to discover variables, then `apply` with `variables` field to bind them to node properties. Supports all fields in FIELD_MAP (fill, stroke, opacity, cornerRadius, padding, spacing, width, height, visible, characters, fontSize, fontFamily, fontStyle, lineHeight, letterSpacing, paragraphSpacing, paragraphIndent). Color variables bind via `setBoundVariableForPaint`; scalar variables bind via `setBoundVariable`.
- **Variable CRUD**: Use `create_variables` to create collections, modes, and variables with initial values in one call. Use `update_variables` to modify values, rename, or delete existing variables. Both accept batch operations. Variable types: COLOR (rgba 0-1), FLOAT (number), STRING (text), BOOLEAN. Values are set per mode name (not mode ID). Alias references use `{ alias: "VariableID:xxx" }`. Scopes are validated before creation — invalid scopes fail without creating the variable. Duplicate variable names in the same collection are skipped. Valid scopes by type: COLOR → ALL_FILLS, FRAME_FILL, SHAPE_FILL, TEXT_FILL, STROKE_COLOR, EFFECT_COLOR; FLOAT → CORNER_RADIUS, WIDTH_HEIGHT, GAP, OPACITY, STROKE_FLOAT, EFFECT_FLOAT, FONT_SIZE, FONT_WEIGHT, LINE_HEIGHT, LETTER_SPACING, PARAGRAPH_SPACING, PARAGRAPH_INDENT; STRING → TEXT_CONTENT, FONT_FAMILY, FONT_STYLE; ALL_SCOPES works for any type.
- **Style CRUD**: Use `create_styles` to create paint, text, effect, and grid styles in batch. Use `update_styles` to modify properties, rename, or delete existing styles. PAINT styles accept a `color` shorthand (solid color) or `paints` array (gradients/images/stacks). TEXT styles require valid `fontFamily`+`fontStyle` — fonts are loaded automatically. `lineHeight` accepts `"AUTO"`, `{ value, unit }`, or a number — unitless values < 10 are auto-converted to PERCENT (e.g. 1.5 → 150%), values >= 10 are treated as PIXELS. `letterSpacing` accepts `{ value, unit }` or a number — values where |value| < 1 are auto-converted to PERCENT (e.g. -0.025 → -2.5%), otherwise PIXELS. EFFECT styles require `effects` array. GRID styles require `grids` array. Duplicate style names within the same type are skipped. Colors use RGBA 0-1 range. Both `create_styles` and `update_styles` accept a `variables` field to bind design token variables to style properties. TEXT styles support: fontSize, fontFamily, fontStyle, lineHeight, letterSpacing, paragraphSpacing, paragraphIndent. PAINT styles support: color (binds to first paint). `get_design_system` reports existing `boundVariables` on styles.
- **Text styles**: Use `get_design_system` to discover text styles, then `apply` with `textStyleId` to apply them. The `apply` tool deduplicates font loading across multiple nodes automatically.
- **Effect styles**: Use `get_design_system` to discover effect styles (shadows, blurs), then `apply` with `effectStyleId` to apply them. Works on any node that supports effects (frames, rectangles, text, etc.).
- **Component properties**: Use `get(nodeId)` on a COMPONENT or COMPONENT_SET to discover `componentPropertyDefinitions` (names with #suffix, types, defaults). Child nodes wired to properties show `componentPropertyReferences` in FSGN output (e.g. `{ characters: "Label#12:0", visible: "Show Icon#0:1" }`). Use `component_properties` to batch add/edit/delete/bind property definitions in a single call. Operations: `add` (name, type, defaultValue — optional `targetNodeId` to auto-bind the property to a child node), `edit` (propertyName, newName/defaultValue), `delete` (propertyName), `bind` (propertyName + targetNodeId — wire an existing property to a child node). Auto-detection maps property type to binding field: BOOLEAN→`visible`, TEXT→`characters`, INSTANCE_SWAP→`mainComponent`. Override with explicit `targetField`. BOOLEAN defaults are real booleans; all others are strings.
- **Exposed instances vs slots**: Use `apply` with `isExposedInstance: true` on a nested INSTANCE inside a COMPONENT to surface that instance's component properties at the parent level. This is NOT the same as Figma's newer "Slot" feature. Slots are a distinct component property type (flexible content areas where users can add/remove/reorder any content) but have no plugin API support yet — they can only be created through the Figma UI.
- **Variant swapping**: Use `apply` with `swapVariantId` on an INSTANCE to swap it to a different variant within the same component set. The instance keeps its position and compatible overrides.
- **Design linting**: Use `lint_design` to scan a subtree for properties not bound to design token variables. Accepts PAGE node IDs (e.g. `0:1`) to lint all top-level components on the page in one call. Checks fills, strokes, cornerRadius, opacity, spacing, padding, fontSize, and fontFamily. Scope-aware: matches variables based on their declared scopes and node context (e.g., TEXT_FILL variables only match text node fills, FRAME_FILL only match frame fills, STROKE_COLOR only match strokes). Compares unbound values using perceptual color distance (CIE76 deltaE) for colors and numeric proximity for scalars. Severities: `exact_match` (auto-fixable), `near_match` (review suggested), `no_match` (no variable found), `ambiguous` (multiple scope-compatible variables tie — reports alternatives, never auto-fixed). Use `autoFix: true` to bind exact matches automatically. Filter with `properties` array, tune color sensitivity with `threshold` (default 5.0), and cap output with `maxIssues` (default 200). Instance children are linted but not auto-fixed (bindings belong on the main component).
- **Comments**: Use `get_comments`, `post_comment`, `delete_comment` to read/write Figma file comments via REST API. Requires `FIGMA_API_TOKEN` with `file_comments:read` and `file_comments:write` scopes. The `fileKey` param comes from the Figma URL: `https://www.figma.com/design/<fileKey>/...`
- **Annotations**: Use `find` with `hasAnnotation: true` or `annotation: "regex"` to search for annotated nodes (replaces brute-force `get_annotations` loops). Use `get_annotations` with `nodeIds` array for batch reading annotations on known nodes. Categories are only included in the response when annotations are found, keeping empty responses compact.

## Figma Design Patterns

These are hard-won patterns from real agent sessions. Violating them causes silent failures or wasted tool calls.

### Sizing sequencing
Cannot set `FILL` sizing at frame creation time — the frame isn't yet a child of an auto-layout parent when the property is set. **Pattern**: Create the frame first (with `parentId`), THEN call `apply` with `layoutSizingHorizontal`/`layoutSizingVertical` separately. The `create` tool handles this automatically with two-pass sizing.

### Use FRAME, not RECTANGLE, for stretchy shapes
RECTANGLE nodes cannot have `layoutSizingVertical: FILL`. Use a FRAME with a fill color instead. Example: a 1px-wide FRAME replaces a RECTANGLE for timeline connecting lines.

### `create` tool capabilities
The `create` tool is the single entry point for all node creation. Node types: FRAME (default), TEXT, RECTANGLE, COMPONENT, INSTANCE, SVG. It accepts `node` (single node spec or nested tree) or `nodes` (array of node specs created in parallel). Use `nodes` when building multiple sibling components (e.g. variants before `combine_as_variants`) — creates all roots in parallel and returns `{ totalRoots, totalNodesCreated, roots: [...] }`. Supported properties: `cornerRadius`, `strokeColor` + `strokeWeight`, font properties (`fontWeight`, `fontSize`, `fontFamily`, `fontStyle`, `fontColor`) on TEXT nodes, `fillColor`, and all auto-layout properties on FRAMEs and COMPONENTs. Font loading on TEXT nodes resolves `fontWeight` to a style name (e.g. 600→"Semi Bold"), loads the font, and assigns `node.fontName` before setting characters. Fallback chain: requested font+weight → requested font+style → Inter Regular. COMPONENT nodes work exactly like FRAMEs but create a component. INSTANCE nodes require `componentId` (local) or `componentKey` (library). SVG nodes require an `svg` property with a valid SVG string — Figma parses it into vector nodes (use for icons, arrows, dividers, illustrations). FILL sizing is applied in a second pass after all nodes exist. The root node's FILL sizing works if the parent has auto-layout. **Auto-positioning**: Top-level nodes created without explicit x/y are automatically placed 100px to the right of the rightmost existing page content, preventing pile-ups at the origin.

### `apply` tool capabilities
The `apply` tool is the single entry point for modifying properties on existing nodes. It accepts a flat list or nested tree of node operations. Each operation targets a `nodeId` and can set any combination of: `swapVariantId` (swap instance to different variant), `isExposedInstance` (expose/unexpose nested instance), `fillColor`, `strokeColor`, `strokeWeight`, `cornerRadius`, `opacity`, `clipsContent` (frames only), `width`, `height`, font properties (`fontFamily`, `fontWeight`, `fontSize`, `fontColor`) on TEXT nodes, layout properties (`layoutMode`, `layoutWrap`, padding, alignment, sizing, spacing), `variables` (map of field→variableId for design token bindings), `textStyleId`, and `effectStyleId`. Execution order per node: component ops → layout mode → direct values → font properties → variable bindings → text style → effect style. Variable bindings override direct values (set both for fallback + token). Never delete and recreate text nodes just to change their font — use `apply` with font properties instead.

### Instance text override ID format
For text overrides on instances, use the path format `I<instanceId>;<componentTextNodeId>`. For nested instances: `I<outerInstance>;<innerInstance>;<textNodeId>`. Use `scan_text_nodes` on the component to discover text node IDs first.

### Bind variables on COMPONENT nodes, not instances
Variable bindings and text style assignments propagate from a COMPONENT to all its instances automatically. Always bind at the component level. Use `get(instanceId)` to read the instance — its `componentRef` in `defs.components` resolves to the main component's id, name, key, and description.

### Reparenting nodes
No `reparent_node` tool exists — `move_node` only changes x/y, not hierarchy. To move a node to a new parent: `clone_and_modify(nodeId, parentId=newParent)` + delete the original. Clones preserve all instance overrides.

### Connection drops and channel recovery
If a command times out, the MCP server automatically invalidates the current channel so the next command triggers auto-join and re-discovers available channels. The plugin reuses the same channel name on reconnect (only increments to `-2` if another plugin genuinely occupies it). `join_channel` validates channel names against the relay before joining — if the requested channel doesn't exist, it returns the list of available channels. Manual `join_channel` is rarely needed; auto-recovery handles most cases.

### MCP tool discovery after code changes
When new tools are added to the MCP server source, they won't appear until the MCP connection is restarted (via `/mcp` in Claude Code). After restart, tools need re-discovery via `ToolSearch`. The channel is re-joined automatically on the first tool call.

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
4. Run plugin in Figma, click Connect — the plugin joins a channel named after the file (e.g. `my-design-file`). The MCP server auto-joins when you first issue a command.

### Windows/WSL

Uncomment the `hostname: "0.0.0.0"` line in `src/socket.ts` to allow connections from Windows host.

## Agent Notes

- No need to call `join_channel` manually — the MCP server auto-joins when you issue the first Figma command. If multiple Figma files are open, the first command returns a list of file names; call `join_channel({ channel: "file-name" })` to pick one.
- Call `get_document_info` first to understand the design structure
- Use `find` to search for nodes by criteria (component usage, variable bindings, style usage, text content, name, type) — returns grouped matches with ancestry paths
- Use `get(nodeId, detail="structure", depth=2)` on a target node to orient before making modifications
- Use `get_design_system` to discover styles and variables before applying styles/tokens
- The plugin and relay must both be running before any tool calls succeed
- After 2 consecutive identical errors on the same tool, stop retrying and diagnose the root cause (wrong node ID, lost connection, or type mismatch)
- After 2 timeouts in a row on any tool, assume the WebSocket connection is lost. The MCP server auto-invalidates the channel on timeout and re-discovers on the next command, but if auto-recovery fails, call `join_channel` explicitly
