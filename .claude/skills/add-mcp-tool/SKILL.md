# Skill: Adding a New MCP Tool to Figmagent

Use this skill when adding new tools or commands that let AI agents control Figma through the MCP server.

## Architecture Overview

Three components form a pipeline. The relay and plugin UI are generic routers — adding a new tool only touches the two endpoints:

```
MCP Server (server.ts) ←WebSocket→ Relay (socket.ts) ←WebSocket→ Plugin UI (ui.html) ←postMessage→ Plugin Code (code.js)
```

**Files you MUST edit:**
1. `src/figmagent_mcp/tools/<domain>.ts` — tool registration (e.g., `modify.ts`, `components.ts`, `create.ts`)
2. `src/figmagent_mcp/types.ts` — add command name to `FigmaCommand` union type
3. `src/figma_plugin/code.js` — command case in `handleCommand` switch + handler function

**Files you do NOT edit** (generic message routers):
- `src/socket.ts` — relay, just broadcasts messages within channels
- `src/figma_plugin/ui.html` — forwards commands/results between WebSocket and code.js

## Request/Response Lifecycle

When an AI agent calls a tool:

1. **tools/<domain>.ts** handler calls `sendCommandToFigma(commandName, params)`
2. A UUID is generated, stored in `pendingRequests` Map with resolve/reject callbacks and a 30s timeout (extended to 60s when progress updates are received)
3. Message sent over WebSocket: `{ id, type: "message", channel, message: { id, command, params } }`
4. **Relay** broadcasts to all other clients in the same channel
5. **Plugin UI** receives, forwards to code.js via `parent.postMessage({ pluginMessage: { type: "execute-command", id, command, params } })`
6. **code.js** `figma.ui.onmessage` handler dispatches to `handleCommand(command, params)`
7. `handleCommand` switch matches the command string and calls the handler function
8. Handler executes against `figma.*` APIs, returns a result object
9. Result flows back: `figma.ui.postMessage({ type: "command-result", id, result })` → UI → WebSocket → relay → server.ts
10. **connection.ts** matches the response UUID to `pendingRequests`, resolves the promise

**Critical**: The command name string must match EXACTLY between `sendCommandToFigma("my_command")` in the tool file and `case "my_command":` in code.js, and must be in the `FigmaCommand` union in `types.ts`. Parameter shapes must also agree — there is no shared schema, just convention.

## Step-by-Step: Adding a Simple Tool

### Step 1: Define the tool in the appropriate tools/ module

Add the tool in the relevant domain file under `src/figmagent_mcp/tools/`:
- `document.ts` — get_document_info, get_selection, get_node_info, read_my_design
- `create.ts` — create (single nodes and nested trees)
- `modify.ts` — rename_node, set_fill_color, set_stroke_color, move_node, resize_node, delete_node, set_corner_radius
- `text.ts` — set_text_content, set_multiple_text_contents
- `layout.ts` — set_layout_mode, set_padding, set_axis_align, set_layout_sizing, set_item_spacing
- `components.ts` — get_styles, get_local_variables, get_local_components, create_component, combine_as_variants, create_component_instance, get/set_instance_overrides, swap_component_variant, get_component_properties, add/edit/delete_component_property, set_exposed_instance, bind_variable, set_text_style, get_main_component
- `scan.ts` — scan_text_nodes, scan_nodes_by_types, get_annotations, set_annotation
- `export.ts` — export_node_as_image
- `libraries.ts` — remote library tools (REST API based)
- `comments.ts` — get_comments, post_comment, delete_comment (REST API based, requires FIGMA_API_TOKEN)

Also add the command name to the `FigmaCommand` union type in `src/figmagent_mcp/types.ts`.

```typescript
server.tool(
  "my_new_tool",                              // Command name — must match code.js
  "Description of what this tool does",        // Shown to the AI agent
  {
    // Zod schema for parameters
    nodeId: z.string().describe("The ID of the node to modify"),
    someValue: z.number().describe("A numeric value"),
    optionalParam: z.string().optional().describe("Optional parameter"),
  },
  async ({ nodeId, someValue, optionalParam }: any) => {
    try {
      const result = await sendCommandToFigma("my_new_tool", {
        nodeId,
        someValue,
        optionalParam,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);
```

### Step 2: Add the command case in code.js handleCommand

Find the `handleCommand` function's switch statement and add a case:

```javascript
case "my_new_tool":
  return await myNewTool(params);
```

### Step 3: Write the handler function in code.js

Add the function anywhere in code.js (convention: near related functions):

```javascript
async function myNewTool(params) {
  const { nodeId, someValue, optionalParam } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error("Node not found with ID: " + nodeId);
  }

  // Do something with the node...

  return {
    id: node.id,
    name: node.name,
    // ... result data
  };
}
```

## Figma Plugin API Constraints

These are real constraints of the Figma plugin environment that you must follow:

### Async-first API
- Always use `await figma.getNodeByIdAsync(nodeId)` — never `figma.getNodeById()` (sync version)
- Call `await figma.currentPage.loadAsync()` before accessing `figma.currentPage.children`
- All handler functions must be `async`

### Font loading before text mutation
Before setting `node.characters` on a TEXT node, you MUST load the font first:
```javascript
await figma.loadFontAsync(node.fontName);
node.characters = "new text";
```
For mixed fonts (multiple fonts in one text node), `node.fontName` returns `figma.mixed`. Use the existing `setCharacters()` helper which handles this.

### Deep-clone Figma property arrays
Figma node properties like `.fills`, `.strokes`, `.effects` are special objects. To save/restore them:
```javascript
const savedFills = JSON.parse(JSON.stringify(node.fills));
// ... modify node ...
node.fills = savedFills;  // restore
```
Direct assignment of modified arrays works: `node.fills = [{ type: "SOLID", color: { r, g, b }, opacity: a }]`

### Colors are 0–1 floats
Figma uses `{ r, g, b }` in 0–1 range (not 0–255), with opacity separate. The MCP tools accept 0–1 floats directly.

### Node type checking
Always verify a node's type before accessing type-specific properties:
```javascript
if (!("fills" in node)) {
  throw new Error("Node does not support fills: " + nodeId);
}
// or
if (node.type !== "TEXT") {
  throw new Error("Node is not a text node");
}
```

### code.js is not bundled
`code.js` is the direct runtime artifact — it is not compiled or bundled. Write plain JavaScript (ES2020+ is fine — `let`, `const`, template literals, spread syntax, `async/await`, `Promise.all`, `Object.entries()` all work). There is no TypeScript, no imports, no module system.

## Adding a Batch/Chunked Tool

For operations on many nodes (10+), use chunking to prevent Figma UI freezing and to keep the MCP timeout alive via progress updates.

### server.ts side
Same as simple tool — just call `sendCommandToFigma`. The server handles progress updates automatically (resets the inactivity timeout when it receives them).

### code.js side — chunked pattern

```javascript
async function myBatchTool(params) {
  const { items } = params || {};
  const commandId = params.commandId || generateCommandId();

  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new Error("Missing or invalid items parameter");
  }

  // Signal start
  sendProgressUpdate(
    commandId, "my_batch_tool", "started",
    0, items.length, 0,
    `Starting batch operation for ${items.length} items`
  );

  const results = [];
  let successCount = 0;
  let failureCount = 0;
  const CHUNK_SIZE = 5;
  const chunks = [];

  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    chunks.push(items.slice(i, i + CHUNK_SIZE));
  }

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];

    // Progress update per chunk — this resets the server-side timeout
    sendProgressUpdate(
      commandId, "my_batch_tool", "in_progress",
      Math.round(5 + (chunkIndex / chunks.length) * 90),
      items.length, successCount + failureCount,
      `Processing chunk ${chunkIndex + 1}/${chunks.length}`
    );

    // Process items within chunk in parallel
    const chunkResults = await Promise.all(chunk.map(async (item) => {
      try {
        const node = await figma.getNodeByIdAsync(item.nodeId);
        if (!node) return { success: false, nodeId: item.nodeId, error: "Not found" };

        // ... do work ...

        return { success: true, nodeId: item.nodeId };
      } catch (error) {
        return { success: false, nodeId: item.nodeId, error: error.message };
      }
    }));

    chunkResults.forEach((result) => {
      if (result.success) successCount++;
      else failureCount++;
      results.push(result);
    });
  }

  // Final progress
  sendProgressUpdate(
    commandId, "my_batch_tool", "completed",
    100, items.length, successCount + failureCount,
    `Completed: ${successCount} succeeded, ${failureCount} failed`
  );

  return {
    success: failureCount === 0,
    totalCount: items.length,
    successCount,
    failureCount,
    results,
  };
}
```

Key points:
- `CHUNK_SIZE = 5` is the convention
- Chunks processed sequentially, items within a chunk processed in parallel
- `sendProgressUpdate()` calls are essential — they flow from code.js → UI → WebSocket (as `type: "progress_update"`) → relay → server, where they reset the inactivity timeout from 30s to 60s. Without these, long batch operations will time out.
- `params.commandId` is injected by `sendCommandToFigma` — use it for progress tracking
- The relay (`socket.ts`) only forwards `type: "message"` and `type: "progress_update"`. If you introduce a new message type, you must add handling for it in the relay or it will be silently dropped.

## Existing Helpers Available in code.js

| Helper | Purpose |
|--------|---------|
| `sendProgressUpdate(commandId, type, status, progress, total, processed, message, payload)` | Send progress through the chain — required for batch ops |
| `setCharacters(node, text, options)` | Set text content with smart font handling (handles mixed fonts) |
| `rgbaToHex(color)` | Convert Figma 0–1 RGBA to hex string |
| `filterFigmaNode(node, depth)` | Serialize a Figma node to a clean JSON-safe object (depth limits child traversal). Includes auto-layout properties (layoutMode, sizing modes, alignment, spacing, padding, layoutWrap) when layout is active. |
| `findNodeByIdInTree(nodeId)` | Walk `figma.currentPage` depth-first to find a node — fallback for `getNodeByIdAsync` failures on nested instance IDs |
| `toNumber(value)` | Safe string-to-number coercion |
| `delay(ms)` | Promise-based delay |
| `generateCommandId()` | Create a unique command ID |
| `uniqBy(arr, predicate)` | De-duplicate an array by key |

### filterFigmaNode exists in BOTH files

`filterFigmaNode` has separate implementations in `code.js` and `utils.ts`. When adding a tool, decide where to filter:
- **In code.js (plugin side)**: Smaller WebSocket payload, less data over the wire. Most existing tools do this.
- **In utils.ts (server side)**: Simpler plugin handler, but sends raw Figma data over WebSocket. Supports `depth` param for limiting child traversal.

### Dead file: setcharacters.js

`src/figma_plugin/setcharacters.js` contains duplicated `setCharacters` and `uniqBy` functions from code.js. The manifest only loads `code.js` — this file is unused. Do not edit it; always edit `code.js` directly.

## Checklist

Before considering the tool complete:

- [ ] Command name string matches exactly in tools/<domain>.ts and code.js
- [ ] Command name added to `FigmaCommand` union in `types.ts`
- [ ] Parameter names/shapes match between Zod schema (tool file) and destructuring (code.js)
- [ ] Handler function in code.js is `async`
- [ ] Every `case` in `handleCommand` ends with `return` or `throw` — never fall through. (A missing `return` on `set_instance_overrides` once caused it to silently execute `set_layout_mode`.)
- [ ] Uses `figma.getNodeByIdAsync()` (not sync version)
- [ ] Font loaded before text mutation (if applicable)
- [ ] Node type/capability checked before accessing type-specific properties
- [ ] Batch operations use chunking with `sendProgressUpdate()`
- [ ] Error cases throw Error objects (code.js) or return error content (server.ts)
- [ ] Return value from code.js handler is JSON-serializable (no Figma internal objects)
- [ ] If using custom message types beyond command/result, verify the relay (`socket.ts`) forwards that type
