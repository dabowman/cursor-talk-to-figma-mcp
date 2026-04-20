# Figma `use_figma` MCP tool: comprehensive technical reference

**The `use_figma` tool executes arbitrary Plugin API JavaScript on Figma's remote server, returning structured JSON results.** It is the sole write-capable tool in Figma's official MCP server, operating on a stateless call model where the Figma file itself serves as persistent state between invocations. For the Figmagent refactor, `use_figma` can serve as an alternative transport that accepts the same Plugin API code your WebSocket relay already generates — but the call envelope, output constraints, and error-recovery model differ materially from a local plugin execution. This document covers every verified technical detail needed to architect a transport-agnostic tool layer.

**Source material**: All claims verified against the official [figma/mcp-server-guide](https://github.com/figma/mcp-server-guide) repo (cloned and read in full), the MCP `tools/list` schema, and Figma developer documentation.

---

## 1. Tool specification and call format

### What it does

`use_figma` is the general-purpose write tool for the remote Figma MCP server at `https://mcp.figma.com/mcp`. It creates, edits, deletes, or inspects any object in a Figma file: pages, frames, components, component sets, variants, variables, variable collections, styles, text, shapes, auto layout, and more. It is described in official docs as: *"The general-purpose tool for writing to Figma. When relevant, the agent will first check your design system for existing components to reuse before creating anything from scratch."*

### Input parameters

The full `inputSchema` is available via the standard MCP `tools/list` discovery call. Four parameters:

| Parameter | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `code` | string | **yes** | maxLength: 50000 | JavaScript code to execute. Has access to the `figma` global (Figma Plugin API). |
| `description` | string | **yes** | maxLength: 2000 | A concise description of what the code aims to do. |
| `fileKey` | string | **yes** | — | The key of the Figma file. Extracted from a URL like `https://figma.com/design/:fileKey/:fileName`. |
| `skillNames` | string | no | — | Comma-separated skill names for logging/telemetry. Does not affect execution. |

Note: `fileKey` is a bare string parameter, not a full URL. The agent or MCP client is responsible for extracting it from Figma URLs. For branch URLs (`figma.com/design/:fileKey/branch/:branchKey/...`), use the `branchKey` as the fileKey.

A standard MCP tool call follows JSON-RPC 2.0 format: `method: "tools/call"`, `params: { name: "use_figma", arguments: {...} }`.

### Response format and output

The code's `return` value is automatically JSON-serialized and returned to the agent via the MCP protocol as a JSON-RPC result. Objects, arrays, strings, and numbers all work. There is a community-reported **~20KB output limit** per call (not officially documented by Figma, but consistently observed). If the response exceeds some clients' token limits, Claude Code users can set the `MAX_MCP_OUTPUT_TOKENS` environment variable to increase the cap on the client side.

Errors thrown during execution are automatically captured and returned — no explicit error handling is required, though `throw` can be used for intentional error signaling.

### Script execution model

**Critical: `use_figma` auto-wraps your code in an async context with error handling.** You write plain JavaScript with top-level `await` and `return`. Do NOT use `figma.closePlugin()`, do NOT wrap in an async IIFE — these are handled for you.

```js
// CORRECT — plain top-level code with return
const frame = figma.createFrame()
frame.name = "Container"
frame.layoutMode = "VERTICAL"
return { nodeId: frame.id }
```

```js
// WRONG — do NOT wrap in async IIFE or use closePlugin
(async () => {
  try {
    const frame = figma.createFrame()
    figma.closePlugin(JSON.stringify({ nodeId: frame.id }))
  } catch(e) {
    figma.closePluginWithFailure(e.toString())
  }
})()
```

Key execution rules:
- `return` is the **only** output channel. The agent sees only the return value.
- `console.log()` output is **never** returned — use `return` instead.
- `figma.notify()` **throws "not implemented"** — never use it.
- `figma.closePlugin()` / `figma.closePluginWithFailure()` are **not needed** and should not be used.
- `getPluginData()` / `setPluginData()` are **not supported**. Use `getSharedPluginData()` / `setSharedPluginData()` instead (these work), or track node IDs via return values.
- Every `await`-able call **must** be `await`-ed. Unawaited promises fire-and-forget, causing silent failures.
- **Page context resets to the first page** at the start of each call. Use `await figma.setCurrentPageAsync(page)` to switch — the sync setter `figma.currentPage = page` throws.

### Timeout behavior

No explicit timeout value is documented for `use_figma` script execution. The MCP protocol-level error code `-32001` ("Request timed out") is reported by users experiencing connection issues, and `{jsonrpc: "2.0", error: {code: -32001, message: "Invalid sessionId"}}` appears when accessing the server without a valid session. Community reports indicate Claude Code and the Figma MCP server can timeout after prolonged open sessions, requiring restarts of both.

---

## 2. Authentication and connection model

### OAuth flow

The remote server authenticates via **OAuth through Figma**. When a client first connects to `https://mcp.figma.com/mcp`, it opens a browser window for the user to sign in to Figma and authorize the connection. The transport protocol is **Streamable HTTP** (HTTP POST/GET as primary transport, with SSE available for streaming server-to-client responses).

Configuration is minimal:
```json
{
  "mcpServers": {
    "figma": {
      "url": "https://mcp.figma.com/mcp"
    }
  }
}
```

For Claude Code: `claude mcp add --transport http figma https://mcp.figma.com/mcp`

### How file targeting works

The remote server is **link-based**. There is no session-level file binding. Each interaction requires the file URL or node link to be present somewhere in the conversation context — typically in the user's initial prompt (e.g., *"Using this Figma file: \<URL\>, create a settings screen"*). The MCP client extracts the `fileKey` and `node-id` from the URL and passes `fileKey` to the tool.

Within a conversation, subsequent prompts can omit the URL — the client infers continued work in the same file. But this inference is client-side behavior, not server-side session state. To target a specific page or node, include the node-id in the URL (`?node-id=X-Y`) or programmatically navigate within the Plugin API script using `figma.getNodeByIdAsync(id)` or `await figma.setCurrentPageAsync(page)`.

### Desktop server comparison

The desktop MCP server at `http://127.0.0.1:3845/mcp` authenticates through the local Figma desktop app session (no OAuth). It supports **selection-based prompting** — the server reads the currently selected layer directly. However, **`use_figma` is only available on the remote server**, not the desktop server. The desktop server provides only read tools.

---

## 3. The `figma-use` skill: verified contents

### Structure and purpose

The `figma-use` skill lives at `skills/figma-use/` in the [figma/mcp-server-guide](https://github.com/figma/mcp-server-guide) repo:

```
figma-use/
├── SKILL.md                    # 17 critical rules, page rules, pre-flight checklist, incremental workflow, error recovery
└── references/
    ├── gotchas.md              # Every known pitfall with WRONG/CORRECT code examples
    ├── common-patterns.md      # Script scaffolds: shapes, text, auto-layout, variables, components, multi-step workflows
    ├── plugin-api-patterns.md  # Quick reference: fills, strokes, auto layout, effects, components, styles, finding nodes
    ├── api-reference.md        # What works and what doesn't: node creation, variables API, core properties, unsupported APIs
    ├── validation-and-recovery.md  # get_metadata vs get_screenshot workflow, error recovery steps
    ├── component-patterns.md   # combineAsVariants, component properties, INSTANCE_SWAP, variant layout, metadata traversal
    ├── variable-patterns.md    # Collections, modes, scopes, aliasing, binding patterns, library variable importing
    ├── text-style-patterns.md  # Type ramps, font probing, listing/applying text styles
    ├── effect-style-patterns.md # Drop shadows, listing/applying effect styles
    ├── plugin-api-standalone.index.md  # Full API index (11,292 lines of .d.ts)
    ├── plugin-api-standalone.d.ts      # Complete Plugin API typings
    └── working-with-design-systems/
        ├── wwds.md                    # Overview of design system paradigms
        ├── wwds-variables.md          # Variables model (collections, modes, aliasing, scopes, grouping)
        ├── wwds-variables--creating.md
        ├── wwds-variables--using.md
        ├── wwds-components.md         # Components model (4 property types, descriptions)
        ├── wwds-components--creating.md
        ├── wwds-components--using.md
        ├── wwds-text-styles.md        # Text style model, gotchas, headless setBoundVariable limitation
        └── wwds-effect-styles.md      # Effect style model, variable bindings on effects
```

It is the **foundational skill for all write-to-canvas operations**. Every other write skill (`figma-generate-library`, `figma-generate-design`) builds on top of it. The official description is emphatic: *"MANDATORY prerequisite — you MUST invoke this skill BEFORE every `use_figma` tool call. NEVER call `use_figma` directly without loading this skill first. Skipping it causes common, hard-to-debug failures."*

### The 17 critical rules (from SKILL.md)

1. Use `return` to send data back. Do NOT call `figma.closePlugin()`.
2. Write plain JavaScript with top-level `await` and `return`. Do NOT wrap in async IIFE.
3. `figma.notify()` throws "not implemented" — never use it.
3a. `getPluginData()` / `setPluginData()` not supported — use `getSharedPluginData()` / `setSharedPluginData()` instead.
4. `console.log()` is NOT returned — use `return` for output.
5. Work incrementally in small steps. Validate after each step.
6. Colors are 0-1 range (not 0-255).
7. Fills/strokes are read-only arrays — clone, modify, reassign.
8. Font MUST be loaded before any text operation.
9. Pages load incrementally — use `await figma.setCurrentPageAsync(page)`.
10. `setBoundVariableForPaint` returns a NEW paint — must capture and reassign.
11. `createVariable` accepts collection object or ID string (object preferred).
12. `layoutSizingHorizontal/Vertical = 'FILL'` MUST be set AFTER `parent.appendChild(child)`.
13. Position new top-level nodes away from (0,0).
14. On error, STOP. Failed scripts are atomic — no changes made. Read the error, fix, retry.
15. MUST `return` ALL created/mutated node IDs.
16. Always set `variable.scopes` explicitly (default `ALL_SCOPES` pollutes every picker).
17. `await` every Promise — unawaited async calls cause silent failures.

### Other skills in the repo

| Skill | Purpose | Complexity |
|---|---|---|
| `figma-generate-library` | Design system builder — 20-100+ `use_figma` calls. 5 phases, 16 rules, state management, naming conventions. Has 7 reference docs + 9 helper JS scripts. | High |
| `figma-generate-design` | Screen building from design system. 6-step workflow: understand, discover DS, create wrapper, build sections, validate, update. | Medium |
| `figma-implement-design` | Design-to-code translation. 7-step workflow with URL parsing, screenshots, asset download, project convention adaptation. | Medium |
| `figma-code-connect-components` | Code Connect mapping. 4-step workflow with suggestions, codebase scanning, user review, bulk save. | Low |
| `figma-create-new-file` | Create blank files with plan resolution. | Trivial |
| `figma-create-design-system-rules` | Generate CLAUDE.md/AGENTS.md rules for DS conventions. | Low |

### Architectural implication for Figmagent

The `figma-use` skill's 17 rules and 16 reference files represent the knowledge that an LLM needs to write correct Plugin API JavaScript. **Figmagent's 50+ structured tools already encode this knowledge in validated, declarative interfaces** — the agent doesn't need to know about `setBoundVariableForPaint` returning a new paint, or FILL sizing ordering, because the tools handle it. Moving to `use_figma` as transport would either require the agent to internalize all this knowledge (or load the skill each time), or require Figmagent to generate the Plugin API scripts server-side while exposing the same high-level tool interface.

---

## 4. Plugin API execution context and capabilities

### Sandbox environment

`use_figma` executes JavaScript in a **Plugin API sandbox** — a minimal JavaScript environment on Figma's servers. The code is auto-wrapped in an async context with error handling. Available: full ES6+, JSON, Promise APIs, `Uint8Array`, and the `figma` global object for reading/writing file contents. **Not available**: DOM, `XMLHttpRequest`, browser `fetch`, `showUI`, or any browser APIs.

### Full API or subset?

**`use_figma` currently provides a subset of the full Plugin API.** Figma's blog explicitly states they are *"working toward parity with the Plugin API, starting with image support and custom fonts."*

**Confirmed available capabilities** (same as local plugins):
- Create/modify frames, rectangles, ellipses, text, vectors, lines, polygons, stars, sections, text paths, boolean operations
- Create components, component sets, variant management via `combineAsVariants`
- Full Variables API: `createVariableCollection()`, `createVariable()`, `getLocalVariablesAsync()`, `getLocalVariableCollectionsAsync()`, `getVariableByIdAsync()`, `importVariableByKeyAsync()`, `setBoundVariableForPaint()`, `setBoundVariableForEffect()`, `setBoundVariableForLayoutGrid()`
- Styles: `createPaintStyle()`, `createTextStyle()`, `getLocalPaintStylesAsync()`, `getLocalTextStylesAsync()`, `importStyleByKeyAsync()`
- Auto layout configuration on frames
- Node property manipulation (fills, strokes, effects, layout properties)
- Page creation and navigation: `await figma.setCurrentPageAsync()`
- Node binding: `node.setBoundVariable(field, variable)` for layout, sizing, padding, spacing, corner radius, opacity, stroke weight
- Node lookup: `await figma.getNodeByIdAsync(id)`
- SVG import: `figma.createNodeFromSvg(svgString)`
- Grouping: `figma.group()`, `figma.flatten()`, boolean operations
- Library imports: `importComponentByKeyAsync()`, `importComponentSetByKeyAsync()`
- Descriptions and documentation links on components

### Verified unsupported APIs

From the `api-reference.md` in the skill repo:

| API | Status |
|---|---|
| `figma.notify()` | **Throws "not implemented"** — most common mistake |
| `figma.showUI()` | No-op (silently ignored) |
| `figma.openExternal()` | No-op (silently ignored) |
| `figma.listAvailableFontsAsync()` | Not implemented |
| `figma.loadAllPagesAsync()` | Not implemented |
| `figma.variables.extendLibraryCollectionByKeyAsync()` | Not implemented |
| `figma.teamLibrary.*` | Not implemented (requires LiveGraph) |
| `getPluginData()` / `setPluginData()` | Not supported (use `getSharedPluginData()` instead) |
| `TextStyle.setBoundVariable()` | Throws "not a function" in headless mode |
| Custom fonts | Not yet supported — only default fonts work |
| Image/asset creation | Not yet supported (working toward parity) |

### Async operations

**Async Plugin API operations are supported.** The execution context awaits the auto-wrapped async function. Confirmed async methods:
- `figma.importComponentByKeyAsync()` — imports components from team libraries
- `figma.importComponentSetByKeyAsync()` — imports component sets
- `figma.importStyleByKeyAsync()` — imports styles from team libraries
- `figma.loadFontAsync()` — required before modifying text content
- `figma.getNodeByIdAsync()` — required for cross-page node access
- `figma.getLocalPaintStylesAsync()`, `figma.getLocalTextStylesAsync()`
- `figma.setCurrentPageAsync()` — page switching (sync setter throws)
- `figma.variables.importVariableByKeyAsync()` — imports library variables
- `figma.variables.getLocalVariablesAsync()`, `figma.variables.getLocalVariableCollectionsAsync()`, `figma.variables.getVariableByIdAsync()`, `figma.variables.getVariableCollectionByIdAsync()`

Community experience notes that `importComponentByKeyAsync` can cause lagging/freezing and requires proper async handling (awaiting each promise before proceeding).

### Confirmed restrictions vs. local plugin

| Capability | `use_figma` | Local Plugin |
|---|---|---|
| Image/asset creation | Not yet supported | `figma.createImage()` |
| Custom fonts | Not yet supported | Any available font |
| `figma.showUI()` (interactive iframe) | No-op (silently ignored) | Full UI support |
| `figma.notify()` | Throws "not implemented" | Works |
| `figma.listAvailableFontsAsync()` | Not implemented | Works |
| `figma.loadAllPagesAsync()` | Not implemented | Works |
| `getPluginData()` / `setPluginData()` | Not supported | Works |
| `TextStyle.setBoundVariable()` | Throws "not a function" | Works |
| Network requests | Not documented/likely restricted | Via `figma.fetch()` |
| Output size | ~20KB limit (observed) | No limit |
| File access method | `fileKey` param per call | Current open file |
| Page setter | Async only (`setCurrentPageAsync`) | Both sync and async |
| Script wrapping | Auto-wrapped (use `return`) | Manual (`closePlugin`) |

---

## 5. State and session model

### No JavaScript state between calls

**Each `use_figma` call starts a completely fresh plugin execution context.** JavaScript variables, closures, and in-memory objects from one call do not carry over to the next. There is no session concept on the server side. Additionally, `figma.currentPage` resets to the **first page** at the start of each call.

### The Figma file IS the persistent state

**Nodes created in one call persist in the Figma file and can be referenced in subsequent calls by their node IDs.** This is the critical insight for Figmagent's multi-step operations. The pattern for cross-call state management:

1. **Call 1** creates nodes and returns their IDs via `return { createdNodeIds: [...], mutatedNodeIds: [...] }`
2. The **agent** (LLM) stores these IDs in its conversation context
3. **Call 2** receives those IDs as hardcoded string literals in the script and accesses nodes via `await figma.getNodeByIdAsync(id)`

This means your tool layer must:
- Always return created/mutated node IDs from every operation
- Pass node IDs into subsequent scripts as literal values
- Use `get_metadata` to re-discover file state if IDs are lost or for validation

### Inter-call validation pattern

The recommended multi-step workflow uses read tools between writes. The skill docs are clear about when to use which validation tool:

**`get_metadata`** — Use for intermediate/structural validation (preferred, fast, cheap):
- After creating/modifying nodes — verify structure, counts, names, hierarchy
- After layout operations — verify positions and dimensions
- After combining variants — confirm all components are in the ComponentSet
- Between multi-step workflows — confirm step N before starting step N+1

**`get_screenshot`** — Use after major milestones (expensive, slow):
- After creating a component set — verify variants look correct, grid readable
- After composing a layout — verify spacing and structure
- After binding variables/modes — verify colors resolved correctly
- Before reporting results — final visual proof

What to look for in screenshots (commonly missed issues):
- **Cropped/clipped text** — line heights or frame sizing cutting off descenders/ascenders
- **Overlapping content** — elements stacking due to incorrect sizing or missing auto-layout
- **Placeholder text** still showing instead of actual content

The recommended sequence:
```
1. use_figma       -> Create/modify nodes
2. get_metadata    -> Verify structure, counts, names, positions (fast, cheap)
3. use_figma       -> Fix any structural issues found
4. get_metadata    -> Re-verify fixes
5. ... repeat ...
6. get_screenshot  -> Visual check after each major milestone
```

---

## 6. Rate limits and usage tiers

### Write tools are currently exempt

**`use_figma`, `search_design_system`, `create_new_file`, `add_code_connect_map`, `generate_figma_design`, and `whoami` are all exempt from the standard rate limits.** The docs state: *"Rate limits apply to Figma MCP server tools that read data from Figma. Some tools, such as those that write to Figma files, are exempt from the rate limits."*

This exemption applies during the current beta period. Figma has stated that write-to-canvas *"will eventually be a usage-based paid feature."* Rate limits may change — Figma reserves this right explicitly.

### Read tool rate limits

| Seat Type | Starter | Professional | Organization | Enterprise |
|---|---|---|---|---|
| View, Collab | 6/month | 6/month | 6/month | 6/month |
| Dev, Full | — | 200/day, 10/min | 200/day, 15/min | 600/day, 20/min |

Per-minute limits follow the same constraints as **Tier 1 Figma REST API** rate limits.

### Access requirements

- **Full seat** required for write operations (`use_figma`)
- **Dev seat** sufficient for read-only tools (`get_design_context`, `get_variable_defs`, etc.)
- **Edit permission** on the target file required for modifications
- Remote server available on **all seats and plans** (with rate limits)
- Desktop server available on **Dev or Full seat** for paid plans only

---

## 7. Error handling and atomic execution

### Atomic execution model

**`use_figma` is atomic — failed scripts do not execute at all.** If a script errors, no changes are made to the file. The file remains in exactly the same state as before the call. There are no partial nodes, no orphaned elements, and retrying after a fix is safe. This is a critical difference from Figmagent's WebSocket relay, where the plugin executes commands incrementally and partial failures can leave orphaned nodes.

### Error recovery protocol (from `figma-use` skill)

1. **STOP** — do NOT immediately fix the code and retry.
2. **Read the error message carefully.** Understand exactly what went wrong — wrong API usage, missing font, invalid property value, etc.
3. **If the error is unclear**, call `get_metadata` or `get_screenshot` to understand the current file state and confirm nothing changed.
4. **Fix the script** based on the error message.
5. **Retry** the corrected script.

### Common error patterns

| Error message | Likely cause | Fix |
|---|---|---|
| `"not implemented"` | Used `figma.notify()` | Remove it — use `return` |
| `"node must be an auto-layout frame..."` | Set FILL/HUG before appending to auto-layout parent | Move `appendChild` before `layoutSizingX = 'FILL'` |
| `"Setting figma.currentPage is not supported"` | Used sync page setter | Use `await figma.setCurrentPageAsync(page)` |
| Property value out of range | Color channel > 1 (used 0-255) | Divide by 255 |
| `"Cannot read properties of null"` | Node doesn't exist (wrong ID, wrong page) | Check page context, verify ID |
| Script hangs / no response | Infinite loop or unresolved promise | Check for missing `await` |
| `"The node with id X does not exist"` | Parent instance implicitly detached by `detachInstance()` | Re-discover nodes by traversal from stable parent |

### When a script succeeds but results look wrong

1. Call `get_metadata` for structural correctness (hierarchy, counts, positions).
2. Call `get_screenshot` for visual correctness. Watch for cropped/clipped text and overlapping elements.
3. Write a targeted fix script modifying only the broken parts — don't recreate everything.

---

## 8. Plugin API patterns and gotchas

### Basic script structure

```js
const createdNodeIds = []
const mutatedNodeIds = []

// Your code here — track every node you create or mutate
const frame = figma.createFrame()
frame.name = "Example"
createdNodeIds.push(frame.id)

return {
  success: true,
  createdNodeIds,
  mutatedNodeIds,
  count: createdNodeIds.length
}
```

### Frames with auto layout

```js
// Find clear space for top-level placement
const page = figma.currentPage
let maxX = 0
for (const child of page.children) {
  maxX = Math.max(maxX, child.x + child.width)
}

const frame = figma.createFrame()
frame.name = "Card"
frame.layoutMode = "VERTICAL"
frame.primaryAxisAlignItems = "MIN"
frame.counterAxisAlignItems = "MIN"
frame.paddingLeft = 16
frame.paddingRight = 16
frame.paddingTop = 12
frame.paddingBottom = 12
frame.itemSpacing = 8
frame.layoutSizingHorizontal = "HUG"
frame.layoutSizingVertical = "HUG"
frame.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]
frame.cornerRadius = 8
frame.x = maxX + 100
frame.y = 0
figma.currentPage.appendChild(frame)
return { nodeId: frame.id }
```

### Text with font loading

```js
await figma.loadFontAsync({ family: "Inter", style: "Regular" })
const text = figma.createText()
text.characters = "Hello World"
text.fontSize = 16
text.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }]
text.textAutoResize = "WIDTH_AND_HEIGHT"
return { nodeId: text.id }
```

### Variable collection with modes

```js
const collection = figma.variables.createVariableCollection("Theme/Colors")
// Rename the default mode (starts with one named "Mode 1")
collection.renameMode(collection.modes[0].modeId, "Light")
const darkModeId = collection.addMode("Dark")
const lightModeId = collection.modes[0].modeId

const bgVar = figma.variables.createVariable("bg", collection, "COLOR")
bgVar.setValueForMode(lightModeId, { r: 1, g: 1, b: 1, a: 1 })
bgVar.setValueForMode(darkModeId, { r: 0.1, g: 0.1, b: 0.1, a: 1 })
bgVar.scopes = ["FRAME_FILL", "SHAPE_FILL"]  // don't use ALL_SCOPES

return {
  collectionId: collection.id,
  lightModeId,
  darkModeId,
  bgVarId: bgVar.id
}
```

### Binding a color variable to a fill

```js
const variable = await figma.variables.getVariableByIdAsync("VariableID:1:2")
const rect = figma.createRectangle()
const basePaint = { type: "SOLID", color: { r: 0, g: 0, b: 0 } }
// setBoundVariableForPaint returns a NEW paint — must capture it!
const boundPaint = figma.variables.setBoundVariableForPaint(basePaint, "color", variable)
rect.fills = [boundPaint]
return { nodeId: rect.id }
```

### Importing library components

```js
const comp = await figma.importComponentByKeyAsync("COMPONENT_KEY")
const instance = comp.createInstance()
figma.currentPage.appendChild(instance)
return { instanceId: instance.id, componentId: comp.id }
```

### Key gotchas (from verified `gotchas.md`)

- **Colors are 0-1 range** — `{r: 255, g: 0, b: 0}` will throw; use `{r: 1, g: 0, b: 0}`.
- **Fills/strokes are immutable arrays** — `node.fills[0].color = ...` does nothing. Clone with `JSON.parse(JSON.stringify(node.fills))`, modify, reassign.
- **`addComponentProperty` returns a string key** — not an object. The key is unpredictable (e.g. `"label#4:0"`). Always capture and use the return value directly.
- **`combineAsVariants` requires ComponentNodes** — passing frames will error.
- **`combineAsVariants` does NOT auto-layout in headless mode** — all variants stack at (0,0). Manually position children in a grid after combining, then resize from actual child bounds.
- **`resize()` resets sizing modes to FIXED** — call `resize()` BEFORE setting HUG/FILL, not after. Never pass throwaway values like `resize(300, 1)` if you intend height to be HUG.
- **HUG parents collapse FILL children** — a HUG parent gives FILL children zero extra space. Parent must be FIXED or FILL.
- **`lineHeight` and `letterSpacing` must be objects** — `{ value: 24, unit: "PIXELS" }` or `{ unit: "AUTO" }`, not bare numbers.
- **Font style names are file-dependent** — "SemiBold" vs "Semi Bold" varies. Probe with try/catch before assuming.
- **`TextStyle.setBoundVariable()` not available in headless mode** — set raw values, bind variables interactively later.
- **COLOR variable values use `{r, g, b, a}`** (with alpha), while paint colors use `{r, g, b}` (alpha is a separate paint property).
- **`detachInstance()` invalidates ancestor node IDs** — re-discover by traversal from a stable non-instance frame.
- **`counterAxisAlignItems` does NOT support `'STRETCH'`** — use `'MIN'` on parent, then set children to FILL on the cross axis.
- **Variable scopes default to `ALL_SCOPES`** — always set explicitly to avoid polluting every picker.
- **Variable collection mode limits are plan-dependent** — Free: 1 mode, Professional: up to 4, Organization/Enterprise: 40+.

### Pre-flight checklist (from SKILL.md)

Before submitting ANY `use_figma` call, verify:

- [ ] Code uses `return` to send data back (NOT `figma.closePlugin()`)
- [ ] Code is NOT wrapped in an async IIFE
- [ ] `return` value includes structured data with actionable info (IDs, counts)
- [ ] NO usage of `figma.notify()` anywhere
- [ ] NO usage of `console.log()` as output
- [ ] All colors use 0-1 range (not 0-255)
- [ ] Fills/strokes are reassigned as new arrays (not mutated in place)
- [ ] Page switches use `await figma.setCurrentPageAsync(page)`
- [ ] `layoutSizingVertical/Horizontal = 'FILL'` is set AFTER `parent.appendChild(child)`
- [ ] `loadFontAsync()` called BEFORE any text property changes
- [ ] `lineHeight`/`letterSpacing` use `{unit, value}` format (not bare numbers)
- [ ] `resize()` is called BEFORE setting sizing modes
- [ ] New top-level nodes are positioned away from (0,0)
- [ ] ALL created/mutated node IDs are collected and included in `return`
- [ ] Every async call is `await`-ed

---

## 9. The `skillNames` parameter

The `skillNames` parameter is a **logging/telemetry-only** parameter passed to `use_figma`. It does not affect execution behavior. Each skill passes its own name:

```
skillNames: "figma-use"
skillNames: "figma-generate-library"
skillNames: "figma-generate-design"
```

For Figmagent, you can pass a custom value like `skillNames: "figmagent"` for tracking purposes. Available official skill names: `figma-use`, `figma-generate-library`, `figma-generate-design`, `figma-implement-design`, `figma-code-connect-components`, `figma-create-design-system-rules`, `figma-create-new-file`, plus any custom skills.

---

## 10. Integration with other Figma MCP tools

All Figma MCP tools are available in the same session and complement `use_figma`:

| Tool | Role in write workflow | Transport notes |
|---|---|---|
| `search_design_system` | Find existing components/variables/styles before creating | Remote only, write-exempt |
| `get_design_context` | Read structured representation of existing designs | Both servers, rate-limited |
| `get_metadata` | Lightweight XML outline for validation between writes | Both servers, rate-limited |
| `get_variable_defs` | Inspect variables/styles in a selection | Both servers, rate-limited |
| `get_screenshot` | Visual validation checkpoint after writes | Both servers, rate-limited |
| `create_new_file` | Create blank files before writing | Remote only, write-exempt |
| `whoami` | Verify authenticated user identity/permissions | Remote only, exempt |

The **recommended agent workflow** sequences these tools:
1. `get_design_context` or `get_metadata` -> understand current file state
2. `search_design_system` -> find reusable components and variables
3. `use_figma` -> write content using found assets
4. `get_screenshot` + `get_metadata` -> validate results
5. `use_figma` -> iterate and fix issues

For Figmagent's transport-agnostic layer, the read tools work identically regardless of your write transport. They complement both the WebSocket plugin relay and `use_figma` equally.

---

## Architectural guidance for Figmagent's transport layer

### What makes `use_figma` different from your WebSocket relay

| Dimension | WebSocket Plugin Relay | `use_figma` via MCP |
|---|---|---|
| Execution location | Local Figma desktop app | Figma's remote servers |
| Authentication | Desktop app session | OAuth (browser flow) |
| File targeting | Currently open file + selection | `fileKey` param per call |
| State between calls | Plugin can maintain JS state | Fully stateless — file is state |
| Script wrapping | Manual (`closePlugin` / message protocol) | Auto-wrapped (use `return`) |
| Error atomicity | **Non-atomic** — partial execution persists | **Atomic** — failed scripts don't execute |
| Output limits | None | ~20KB per call (observed) |
| Image/font support | Full Plugin API | No images, no custom fonts (yet) |
| `figma.showUI()` | Available | No-op |
| `figma.notify()` | Available | Throws "not implemented" |
| `getPluginData()` | Available | Not supported |
| `TextStyle.setBoundVariable()` | Available | Throws "not a function" |
| Rate limits | None (local) | Currently exempt (beta) |
| Network requests | Via iframe or Fetch API | Not documented/likely restricted |
| Page setter | Both sync and async | Async only (sync throws) |

### Transport abstraction strategy

Your tool layer should abstract over these differences:

1. **Script generation differs.** `use_figma` uses plain JS with `return`; the WebSocket plugin uses `figma.closePlugin()` inside an IIFE with message dispatching. A transport-agnostic layer would need to generate the appropriate script format per transport, or standardize on one format with a thin adapter.

2. **Error atomicity differs materially.** `use_figma` is atomic (failed = no changes). The WebSocket plugin executes incrementally and can leave partial state on failure. This means cleanup logic needed for WebSocket errors is unnecessary for `use_figma` errors — but the reverse is also true: `use_figma` can't do "best effort" partial work.

3. **The call envelope differs.** For WebSocket: send the command over your existing protocol with channel routing. For `use_figma`: MCP `tools/call` with `name: "use_figma"`, `code`, `description`, `fileKey`, and optionally `skillNames`.

4. **File targeting differs.** WebSocket relay operates on the currently open file. `use_figma` needs a `fileKey` extracted from the conversation context. Your tool layer needs a file-key resolver that can work in both modes.

5. **Output parsing is similar but not identical.** Both return JSON, but `use_figma` auto-serializes the `return` value while the WebSocket plugin sends an explicit `JSON.stringify`'d message. Parse accordingly.

6. **State management differs in mechanism, not concept.** Both require returning node IDs from creation calls and passing them into subsequent calls. The WebSocket plugin _could_ maintain state across calls (and currently does via the dispatcher's command routing), while `use_figma` cannot.

7. **Respect the ~20KB output limit** when generating scripts for `use_figma`. Break large operations into smaller chunks. Your WebSocket relay doesn't have this constraint, but designing for it makes your tool layer portable.

8. **API surface differs.** Several APIs available in local plugins don't work in `use_figma` (see section 4). A transport-agnostic layer must avoid these APIs entirely, or feature-detect per transport.

### What Figmagent's structured tools provide that raw `use_figma` does not

The `figma-use` skill compensates for `use_figma`'s low-level nature with 17 rules and 16 reference documents that the agent must load and internalize before every call. Figmagent's tool layer encodes this knowledge directly:

| Concern | `use_figma` approach | Figmagent approach |
|---|---|---|
| FILL sizing ordering | Agent must remember rule #12 | `create` tool handles two-pass sizing automatically |
| Color format | Agent must use 0-1 (rule #6) | Tools accept 0-1 natively, Zod validates |
| Font loading | Agent must call `loadFontAsync` first (rule #8) | `apply`/`create` tools handle font loading and fallback chains |
| Variable binding | Agent must capture `setBoundVariableForPaint` return (rule #10) | `apply` tool handles the capture-and-reassign pattern |
| Output budgeting | Agent must stay under ~20KB | Tools enforce 30K char budget with truncation hints |
| Node ID tracking | Agent must return all IDs (rule #15) | Tools always return structured results with IDs |
| Batch operations | Agent writes loops in JS | `apply`/`create` accept arrays of operations |
| Error recovery | Agent must stop, inspect, clean up (rule #14) | Tools validate inputs with Zod, chunk large ops, send progress updates |
| Top-level positioning | Agent must scan page children (rule #13) | `create` tool auto-positions away from existing content |

## Conclusion

`use_figma` provides a viable alternative transport for Figmagent's write operations — but within a different envelope and with distinct constraints. The key architectural differences are: **atomic error model** (no partial execution), **auto-wrapped script execution** (use `return` not `closePlugin`), **stateless per-call context**, the **~20KB output limit**, and **missing API surface** (no images, custom fonts, `getPluginData`, `TextStyle.setBoundVariable`). The file-as-state model means node IDs must be explicitly captured and threaded between calls, which aligns well with a typed-tool approach where each operation returns structured metadata. The current beta exemption from rate limits removes throughput concerns for write operations, though this will change when usage-based pricing arrives. The strongest transport-agnostic pattern is to treat each operation as an atomic script that takes explicit inputs (parent node IDs, variable keys, component keys) and returns explicit outputs (created node IDs, success/failure status) — adapting the script format and error handling per transport.
