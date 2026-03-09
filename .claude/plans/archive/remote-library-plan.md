# Remote Library Tools — MCP Server Spec

## Context

This spec is for extending a fork of [cursor-talk-to-figma-mcp](https://github.com/grab/cursor-talk-to-figma-mcp) with tools for working with published Figma design system libraries.

### The Problem

The current MCP server (and Figma Console MCP) cannot work with remote/published library components. The Figma Plugin API's `teamLibrary` object exposes methods for browsing remote **variables** (`getAvailableLibraryVariableCollectionsAsync`, `getVariablesInLibraryCollectionAsync`) but has **no equivalent methods for browsing remote components**. The method `getAvailableLibraryComponentsAsync` does not exist in the plugin sandbox.

This means an agent asked to "rebuild this screen using WPDS components" currently cannot:

1. Discover what components exist in the library
2. Get the published `key` needed to import a component
3. Import and instantiate a component from the library into the working file

The Figma REST API has the data. The Plugin API has the mutation capability. These tools bridge the two.

### Architecture

The cursor-talk-to-figma MCP server already has:

- A **Figma plugin** running in the working file (communicates via WebSocket)
- An **MCP server** (TypeScript, runs as a local process)
- A **WebSocket server** bridging the two

The new tools add a **REST API client** to the MCP server layer. The MCP server makes HTTP calls to `api.figma.com` using a personal access token, then passes the relevant data (component keys) to the plugin via the existing WebSocket bridge for import/instantiation.

```
┌──────────────────────────────────────────────────────────────────┐
│  MCP CLIENT (Cursor, Claude Code, etc.)                          │
│    ↕ MCP protocol                                                │
│  MCP SERVER (TypeScript process)                                 │
│    ├── Existing tools → WebSocket → Figma Plugin (read/write)    │
│    └── NEW: REST API client → api.figma.com (read catalog)       │
│              ↓ component keys                                    │
│         WebSocket → Figma Plugin (import + instantiate)          │
└──────────────────────────────────────────────────────────────────┘
```

---

## Configuration

### Environment Variable

```
FIGMA_API_TOKEN=[yourtokenhere]
```

The MCP server must accept a Figma personal access token via environment variable. This token is used for REST API calls. It requires the following scopes:

- `file_content:read` (Tier 1 — for GET /v1/files/:key)
- `library_content:read` (Tier 3 — for GET /v1/files/:key/components)
- `library_assets:read` (Tier 3 — for GET /v1/components/:key)

### MCP Config

```json
{
  "mcpServers": {
    "TalkToFigma": {
      "command": "bun",
      "args": ["/path/to/src/talk_to_figma_mcp/server.ts"],
      "env": {
        "FIGMA_API_TOKEN": "figd_xxxxx"
      }
    }
  }
}
```

---

## Shared Module: REST API Client

Create a shared module at `src/figma_rest_api.ts` that wraps the Figma REST API. All REST-backed tools use this module.

```typescript
// src/figma_rest_api.ts

const BASE_URL = 'https://api.figma.com';

interface FigmaRestClient {
  getFileComponents(fileKey: string): Promise<FileComponentsResponse>;
  getFileComponentSets(fileKey: string): Promise<FileComponentSetsResponse>;
  getComponentByKey(componentKey: string): Promise<ComponentMetadata>;
}
```

### Key Types

```typescript
interface ComponentMetadata {
  key: string;           // The published component key (40-char hex)
  file_key: string;      // File that contains the component
  node_id: string;       // Node ID within that file
  name: string;          // e.g. "Button"
  description: string;
  thumbnail_url: string;
  containing_frame: {
    name: string;        // e.g. "Buttons" (the page/section)
    pageName: string;
  };
}

interface ComponentSetMetadata extends ComponentMetadata {
  // Same shape — represents a component set (variant group)
}
```

### Caching

The REST client should cache responses for `getFileComponents` and `getFileComponentSets` keyed by `fileKey`. Library component catalogs change infrequently (only on publish). Cache lifetime: duration of the MCP server process (in-memory Map). Provide a `clearCache(fileKey?)` method.

### Error Handling

- 403: Token doesn't have required scopes → return clear error message about required scopes
- 404: File not found or not accessible → return message suggesting the token needs access to the library file
- 429: Rate limited → return the `Retry-After` header value in the error message

---

## Tool 1: `get_library_components`

**Purpose**: Discover published components and component sets in a library file. This is the catalog browsing tool that the agent uses first.

### MCP Tool Definition

```typescript
{
  name: "get_library_components",
  description: "Get published components and component sets from a Figma library file. Returns the component name, published key (needed for import), description, and containing frame/page. Use this to discover what components are available in a design system library before importing them.",
  inputSchema: {
    type: "object",
    properties: {
      fileKey: {
        type: "string",
        description: "The Figma file key of the library. Extract from a Figma URL: https://www.figma.com/design/<fileKey>/..."
      },
      query: {
        type: "string",
        description: "Optional search filter. Case-insensitive match against component name, description, and containing frame name. Examples: 'button', 'card', 'input'."
      },
      includeComponentSets: {
        type: "boolean",
        description: "If true (default), also fetch component sets (variant groups). Set false to only get individual components.",
        default: true
      }
    },
    required: ["fileKey"]
  }
}
```

### Implementation

1. Call `GET https://api.figma.com/v1/files/{fileKey}/components` with header `X-Figma-Token: {token}`
2. If `includeComponentSets` is true, also call `GET https://api.figma.com/v1/files/{fileKey}/component_sets`
3. Extract from `response.meta.components` (and `response.meta.component_sets`)
4. If `query` is provided, filter results by case-insensitive substring match on `name`, `description`, and `containing_frame.name`
5. Return a formatted list

### Response Format

Return structured data, not raw JSON. Format for LLM consumption:

```
Found 12 components matching "button" in WPDS (Gutenberg 22.3):

COMPONENT SETS (variant groups):
  Name: Button
  Key: abc123def456...
  Description: Primary action button with multiple variants
  Page: Components
  Frame: Buttons
  ---
  Name: IconButton
  Key: xyz789...
  Description: Icon-only button
  Page: Components
  Frame: Buttons

INDIVIDUAL COMPONENTS:
  Name: Button / Type=Primary, Size=Large, State=Default
  Key: aaa111bbb222...
  Page: Components
  Frame: Buttons
  ---
  ...

Use the "key" value with import_library_component to add these to your file.
```

### Critical Details

- The REST API paginates. If the library has many components, handle the `cursor` in the response and fetch all pages.
- Component keys from this endpoint are the 40-character hex strings that `figma.importComponentByKeyAsync()` requires.
- This endpoint returns only **published** components. Unpublished drafts won't appear.

---

## Tool 2: `search_library_components`

**Purpose**: A convenience wrapper for quick lookup when the agent knows roughly what it needs.

### MCP Tool Definition

```typescript
{
  name: "search_library_components",
  description: "Search for a specific component in a Figma library by name. Returns matching components with their published keys. Faster than get_library_components for targeted lookups. Searches both component sets and individual component variants.",
  inputSchema: {
    type: "object",
    properties: {
      fileKey: {
        type: "string",
        description: "The Figma file key of the library."
      },
      query: {
        type: "string",
        description: "Search term. Matches against component name, description, and containing frame. Examples: 'Button', 'Card', 'DataViews', 'Tabs'."
      },
      limit: {
        type: "number",
        description: "Maximum results to return. Default 10.",
        default: 10
      }
    },
    required: ["fileKey", "query"]
  }
}
```

### Implementation

This uses the same cached data from `get_library_components` but:

1. Scores results by relevance: exact name match > name starts-with > name contains > description contains > frame name contains
2. Returns top N results sorted by score
3. For component sets, also searches the variant names (the individual components within the set)

### Why Two Tools?

`get_library_components` is for browsing ("show me everything in the Button section"). `search_library_components` is for targeted lookup ("find me the Tabs component"). The agent can pick the right one based on context, and the search tool keeps context usage minimal for common cases.

---

## Tool 3: `import_library_component`

**Purpose**: Import a published component or component set into the working file and create an instance. This is the action tool — it bridges REST API data into Plugin API mutations.

### MCP Tool Definition

```typescript
{
  name: "import_library_component",
  description: "Import a published component from a Figma library into the current file and create an instance. Requires the component's published key (get this from get_library_components or search_library_components). The instance is created at the specified position, or appended to a target parent node.",
  inputSchema: {
    type: "object",
    properties: {
      componentKey: {
        type: "string",
        description: "The published component key (40-char hex string from the library catalog)."
      },
      parentNodeId: {
        type: "string",
        description: "Optional. Node ID of the parent frame to insert the instance into. If omitted, the instance is added to the current page root."
      },
      position: {
        type: "object",
        description: "Optional. Position for the new instance.",
        properties: {
          x: { type: "number" },
          y: { type: "number" }
        }
      },
      variantProperties: {
        type: "object",
        description: "Optional. If the component is part of a component set, specify variant properties to select a specific variant. Example: { 'Type': 'Primary', 'Size': 'Large', 'State': 'Default' }",
        additionalProperties: { type: "string" }
      },
      name: {
        type: "string",
        description: "Optional. Override the instance layer name."
      }
    },
    required: ["componentKey"]
  }
}
```

### Implementation

This tool sends a message to the Figma plugin via WebSocket. The plugin executes:

```typescript
// Plugin-side handler (add to the plugin's message handler)
async function handleImportComponent(params: {
  componentKey: string;
  parentNodeId?: string;
  position?: { x: number; y: number };
  variantProperties?: Record<string, string>;
  name?: string;
}) {
  // 1. Import the component into the file
  const component = await figma.importComponentByKeyAsync(params.componentKey);

  // 2. If variantProperties specified and this is a ComponentSetNode,
  //    find the matching variant
  let targetComponent = component;
  if (params.variantProperties && component.type === 'COMPONENT_SET') {
    // Component sets contain variants as children
    const variant = component.children.find(child => {
      if (child.type !== 'COMPONENT') return false;
      const props = child.variantProperties;
      return Object.entries(params.variantProperties!).every(
        ([key, value]) => props?.[key] === value
      );
    });
    if (variant && variant.type === 'COMPONENT') {
      targetComponent = variant;
    }
  }

  // 3. Create instance
  const instance = (targetComponent as ComponentNode).createInstance();

  // 4. Position
  if (params.position) {
    instance.x = params.position.x;
    instance.y = params.position.y;
  }

  // 5. Parent
  if (params.parentNodeId) {
    const parent = await figma.getNodeByIdAsync(params.parentNodeId);
    if (parent && 'appendChild' in parent) {
      parent.appendChild(instance);
    }
  }

  // 6. Name
  if (params.name) {
    instance.name = params.name;
  }

  return {
    instanceId: instance.id,
    instanceName: instance.name,
    componentName: targetComponent.name,
    width: instance.width,
    height: instance.height
  };
}
```

### Important: Component Sets vs Components

When the agent gets a key from the library catalog, it may be a **component set key** (the variant group) or an **individual component key** (a specific variant). 

- `importComponentByKeyAsync` with a **component set key** returns a `ComponentSetNode`. You cannot call `.createInstance()` on a ComponentSetNode directly. You must pick a child variant (ComponentNode) first.
- `importComponentByKeyAsync` with an **individual component key** returns a `ComponentNode`. You can call `.createInstance()` directly.

The implementation must handle both cases. If a component set is imported without `variantProperties`, default to the **first child** (which is typically the default variant).

### Error Cases

- Invalid key → return "Component key not found. Verify with search_library_components."
- Component set imported without variant match → return "This is a component set with variants: [list variant property names]. Specify variantProperties to select one, or the default variant will be used."
- Parent node not found → fall back to current page, note in response

---

## Tool 4: `get_component_variants`

**Purpose**: After finding a component set, the agent needs to know what variants are available before it can pick the right one.

### MCP Tool Definition

```typescript
{
  name: "get_component_variants",
  description: "Get the available variants for a component set in a library. Returns variant property names, possible values, and the individual component keys for each variant combination. Use after finding a component set with get_library_components to understand what variants you can instantiate.",
  inputSchema: {
    type: "object",
    properties: {
      fileKey: {
        type: "string",
        description: "The library file key."
      },
      componentSetNodeId: {
        type: "string",
        description: "The node_id of the component set (from get_library_components results)."
      }
    },
    required: ["fileKey", "componentSetNodeId"]
  }
}
```

### Implementation

1. Call `GET https://api.figma.com/v1/files/{fileKey}/nodes?ids={componentSetNodeId}` with header `X-Figma-Token: {token}`
2. Parse the returned node tree. The component set's children are the variant components.
3. Each variant component's `name` is a comma-separated list of property=value pairs (e.g., "Type=Primary, Size=Large, State=Default")
4. Extract the unique property names and their possible values
5. Return the variant map and individual component keys

### Response Format

```
Component Set: Button
Variant Properties:
  Type: Primary, Secondary, Tertiary
  Size: Small, Medium, Large  
  State: Default, Hover, Focus, Disabled
  Destructive: True, False

Example variants:
  Type=Primary, Size=Large, State=Default → key: abc123...
  Type=Primary, Size=Large, State=Hover → key: def456...
  Type=Tertiary, Size=Medium, State=Default → key: ghi789...
  ... (showing first 10 of 48 variants)

Use import_library_component with the component key, or specify variantProperties on the component set key.
```

### Critical Detail

The REST API `GET /v1/files/:key/nodes` returns a node's children but does NOT include the published `key` field for child components. To get individual variant keys, you need to cross-reference with the full component list from `GET /v1/files/:key/components` — each component there has both a `node_id` and `key`. Match child node IDs against the component list to resolve keys.

---

## Tool 5: `get_library_variables`

**Purpose**: Complement the component tools with structured variable/token extraction from the library, accessible via the REST API without needing the plugin to be running in the library file.

### MCP Tool Definition

```typescript
{
  name: "get_library_variables",
  description: "Get published design token variables from a Figma library file via REST API. Returns variable collections, modes, and variable names/types. Use this to understand what design tokens are available for styling when building with library components.",
  inputSchema: {
    type: "object",
    properties: {
      fileKey: {
        type: "string",
        description: "The Figma file key of the library."
      },
      collectionName: {
        type: "string",
        description: "Optional. Filter to a specific collection by name (e.g., 'Color', 'Spacing')."
      },
      format: {
        type: "string",
        enum: ["summary", "full"],
        description: "summary (default): collection names, variable counts, and modes. full: all variable names, types, and values.",
        default: "summary"
      }
    },
    required: ["fileKey"]
  }
}
```

### Implementation

1. Call `GET https://api.figma.com/v1/files/{fileKey}/variables/local` (this returns both local values and published variables)
2. Parse and structure the response by collection
3. If `collectionName` is provided, filter to that collection
4. Format based on `format` parameter

### Note on Variables API

The REST API variables endpoints (`/variables/local` and `/variables/published`) are available to Enterprise org members. If the token doesn't have access, return a clear error explaining the limitation and suggesting the agent fall back to the Plugin API's `getAvailableLibraryVariableCollectionsAsync` path (which the existing tools already support).

---

## Plugin-Side Changes

The Figma plugin needs a new message handler for `import_library_component`. Add this to the existing plugin message handler switch/dispatch:

```typescript
// In the plugin's message handler (src/claude_mcp_plugin/code.ts or equivalent)

case 'import_library_component': {
  const { componentKey, parentNodeId, position, variantProperties, name } = msg.params;
  
  try {
    const imported = await figma.importComponentByKeyAsync(componentKey);
    
    let targetComponent: ComponentNode;
    
    if (imported.type === 'COMPONENT_SET') {
      // Find matching variant or use default (first child)
      if (variantProperties) {
        const match = imported.children.find(child => {
          if (child.type !== 'COMPONENT') return false;
          return Object.entries(variantProperties).every(
            ([k, v]) => child.variantProperties?.[k] === v
          );
        }) as ComponentNode | undefined;
        targetComponent = match || (imported.defaultVariant as ComponentNode);
      } else {
        targetComponent = imported.defaultVariant as ComponentNode;
      }
    } else if (imported.type === 'COMPONENT') {
      targetComponent = imported;
    } else {
      throw new Error(`Imported node is type ${imported.type}, expected COMPONENT or COMPONENT_SET`);
    }
    
    const instance = targetComponent.createInstance();
    
    if (position) {
      instance.x = position.x;
      instance.y = position.y;
    }
    
    if (parentNodeId) {
      const parent = await figma.getNodeByIdAsync(parentNodeId);
      if (parent && 'appendChild' in parent) {
        (parent as FrameNode).appendChild(instance);
      }
    }
    
    if (name) {
      instance.name = name;
    }
    
    // Select and focus the new instance
    figma.currentPage.selection = [instance];
    figma.viewport.scrollAndZoomIntoView([instance]);
    
    respond({
      success: true,
      instanceId: instance.id,
      instanceName: instance.name,
      componentName: targetComponent.name,
      width: instance.width,
      height: instance.height,
      variantProperties: instance.variantProperties || {}
    });
  } catch (err) {
    respond({
      success: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  break;
}
```

### Manifest Permissions

Ensure the plugin manifest includes the `teamlibrary` permission:

```json
{
  "permissions": ["teamlibrary"]
}
```

This is required for `figma.importComponentByKeyAsync()` to work with remote library components.

---

## File Structure

```
src/
  figma_rest_api.ts              # NEW — REST API client module
  talk_to_figma_mcp/
    server.ts                     # MODIFIED — register new tools
    tools/
      get_library_components.ts   # NEW
      search_library_components.ts # NEW
      import_library_component.ts # NEW
      get_component_variants.ts   # NEW
      get_library_variables.ts    # NEW
  claude_mcp_plugin/
    code.ts                       # MODIFIED — add import handler
    manifest.json                 # MODIFIED — add teamlibrary permission
```

---

## Agent Workflow Example

This is the intended agent workflow for "rebuild this screen using WPDS components":

```
1. Agent receives library file URL from user
2. Agent extracts fileKey from URL: "jMgzw8IhsMC4gpMbMko4lv"
3. Agent calls get_library_components(fileKey, query: "button")
   → Gets component set "Button" with key "abc123..."
4. Agent calls get_component_variants(fileKey, componentSetNodeId: "16507:33913")
   → Learns variants: Type=[Primary, Secondary, Tertiary], Size=[S, M, L], etc.
5. Agent calls import_library_component(
     componentKey: "abc123...",
     variantProperties: { Type: "Primary", Size: "Large", State: "Default" },
     parentNodeId: "1:5",
     position: { x: 100, y: 200 }
   )
   → Instance created in the working file
6. Repeat for each component needed (Card, Tabs, Input, etc.)
7. Agent uses existing tools (set_fill_color, set_auto_layout, etc.) to wire up 
   layout, spacing, and apply library variables for styling
```

---

## Testing Plan

### Unit Tests (REST client)

- Mock API responses for `/files/:key/components` and `/files/:key/component_sets`
- Test pagination handling (multiple pages of components)
- Test search/filter logic with edge cases (special characters, empty results)
- Test caching behavior (second call uses cache, clearCache works)
- Test error handling for 403, 404, 429 responses

### Integration Tests (with live Figma file)

Use a dedicated test library file with known components:

1. `get_library_components` returns expected component count and keys
2. `search_library_components` finds "Button" and returns correct key
3. `get_component_variants` returns correct variant properties for a known component set
4. `import_library_component` with a component key creates an instance in the working file
5. `import_library_component` with a component set key + variant properties creates the correct variant instance
6. `import_library_component` with a component set key and NO variant properties defaults to first variant

### Edge Cases to Cover

- Library file with 500+ components (pagination)
- Component set with 50+ variants (e.g., Button with many state/size/type combos)
- Component key that was valid but library was unpublished/deleted since cache
- Network timeout on REST API call
- Plugin not connected when import is attempted
- Token doesn't have required scopes