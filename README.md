# Talk to Figma MCP

MCP server that bridges AI agents (Claude Code, Cursor) with Figma through a WebSocket relay and Figma plugin. Forked from [sonnylazuardi/cursor-talk-to-figma-mcp](https://github.com/sonnylazuardi/cursor-talk-to-figma-mcp) with significant additions: 62 tools, design token binding, batch operations, component management, library access, file comments, plugin concurrency control, and sub-agent orchestration.

```
AI Agent <-(stdio)-> MCP Server <-(WebSocket)-> Relay <-(WebSocket)-> Figma Plugin
```

## Setup

### Prerequisites

- [Bun](https://bun.sh) runtime
- Figma desktop app

### Quick Start

1. Install dependencies and configure MCP:

```bash
bun setup
```

This writes MCP config for both Cursor (`.cursor/mcp.json`) and Claude Code (`.mcp.json`).

2. Start the WebSocket relay in a separate terminal:

```bash
bun socket
```

3. In Figma: Plugins > Development > Link existing plugin > select `src/cursor_mcp_plugin/manifest.json`

4. Run the plugin in Figma, click Connect, then call `join_channel` from your AI agent (no arguments needed — auto-discovers the active channel).

### Claude Code Setup

Add the MCP server manually:

```bash
claude mcp add TalkToFigma -- bun /path-to-repo/src/talk_to_figma_mcp/server.ts
```

### Cursor Setup

Add to your MCP configuration:

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

### Windows/WSL

Uncomment the `hostname: "0.0.0.0"` line in `src/socket.ts` to allow connections from the Windows host.

## Tools (62)

### Document & Navigation

| Tool | Description |
|------|-------------|
| `join_channel` | Join a Figma plugin channel (auto-discovers if no args) |
| `get_document_info` | Get current document structure |
| `get_selection` | Get current selection |
| `read_my_design` | Get detailed info about current selection |
| `get_node_info` | Get node details (supports `depth` param to limit tree) |
| `get_nodes_info` | Get details for multiple nodes by ID |
| `set_focus` | Select and scroll to a node |
| `set_selections` | Select multiple nodes |

### Creating Elements

| Tool | Description |
|------|-------------|
| `create_rectangle` | Create a rectangle |
| `create_frame` | Create a frame with optional auto layout and corner radius |
| `create_text` | Create a text node with font properties |
| `create_frame_tree` | Build an entire subtree from a recursive JSON spec in one call |

### Modifying Elements

| Tool | Description |
|------|-------------|
| `rename_node` | Rename a node |
| `set_fill_color` | Set fill color (RGBA 0-1) |
| `set_stroke_color` | Set stroke color and weight |
| `set_corner_radius` | Set corner radius (uniform or per-corner) |
| `move_node` | Move a node to x/y position |
| `resize_node` | Resize a node |
| `clone_node` | Clone a node with optional offset |
| `clone_and_modify` | Clone + reparent + modify in one call |
| `delete_node` | Delete a node |
| `delete_multiple_nodes` | Batch delete nodes |
| `reorder_children` | Reorder children of a frame |
| `set_multiple_properties` | Batch set fill, stroke, radius, sizing, padding, spacing |

### Text

| Tool | Description |
|------|-------------|
| `set_text_content` | Set text content of a node |
| `set_multiple_text_contents` | Batch update multiple text nodes |
| `scan_text_nodes` | Scan text nodes with chunking for large designs |

### Auto Layout

| Tool | Description |
|------|-------------|
| `set_layout_mode` | Set layout direction and wrap |
| `set_padding` | Set padding (top, right, bottom, left) |
| `set_axis_align` | Set primary/counter axis alignment |
| `set_layout_sizing` | Set sizing modes (FIXED, HUG, FILL) |
| `set_item_spacing` | Set spacing between children |

### Components & Instances

| Tool | Description |
|------|-------------|
| `get_styles` | Get local text/paint/effect styles |
| `get_local_variables` | Get all variable collections, modes, and values |
| `get_local_components` | Get local components (optional name filter) |
| `create_component` | Create a new component |
| `combine_as_variants` | Combine components into a variant set |
| `create_component_instance` | Create an instance (supports `componentId` + `parentId`) |
| `get_instance_overrides` | Extract overrides from an instance |
| `set_instance_overrides` | Apply overrides to target instances |
| `swap_component_variant` | Swap an instance to a different variant |
| `get_main_component` | Resolve instance to its main component |

### Design Tokens & Styles

| Tool | Description |
|------|-------------|
| `bind_variable` | Bind a variable to a node property |
| `batch_bind_variables` | Batch bind variables (chunked, with progress) |
| `set_text_style` | Apply a text style to a node |
| `batch_set_text_styles` | Batch apply text styles (deduplicates font loading) |

### Library (REST API)

Requires `FIGMA_API_TOKEN` environment variable.

| Tool | Description |
|------|-------------|
| `get_library_components` | Browse library component catalog |
| `search_library_components` | Search library components |
| `import_library_component` | Import and instantiate a library component |
| `get_component_variants` | Get variants for a component set |
| `get_library_variables` | Get design token variables from a library |

### Annotations & Scanning

| Tool | Description |
|------|-------------|
| `get_annotations` | Get annotations on a node |
| `set_annotation` | Create/update an annotation |
| `set_multiple_annotations` | Batch create/update annotations |
| `scan_nodes_by_types` | Scan for nodes of specific types |

### Prototyping & Connections

| Tool | Description |
|------|-------------|
| `get_reactions` | Get prototype reactions from nodes |
| `set_default_connector` | Set default connector style |
| `create_connections` | Create connector lines between nodes |

### Comments (REST API)

Requires `FIGMA_API_TOKEN` with `file_comments:read` and `file_comments:write` scopes.

| Tool | Description |
|------|-------------|
| `get_comments` | Read file comments |
| `post_comment` | Post a comment or reply |
| `delete_comment` | Delete a comment |

### Export

| Tool | Description |
|------|-------------|
| `export_node_as_image` | Export a node as PNG, JPG, SVG, or PDF |

## MCP Prompts

| Prompt | Description |
|--------|-------------|
| `design_strategy` | Best practices for creating Figma designs |
| `read_design_strategy` | Best practices for reading designs |
| `text_replacement_strategy` | Systematic text replacement with chunking |
| `annotation_conversion_strategy` | Converting manual annotations to native Figma annotations |
| `swap_overrides_instances` | Transferring overrides between instances |
| `reaction_to_connector_strategy` | Converting prototype reactions to connector lines |

## Development

```bash
bun install              # Install dependencies
bun run build            # Build MCP server (tsup -> dist/)
bun run dev              # Build in watch mode
bun socket               # Start WebSocket relay (port 3055)
bun run test             # Run tests
bun run lint             # Lint with Biome
bun run lint:fix         # Auto-fix lint + format
bun run check            # Lint + format check
```

### Architecture

The MCP server is modular (`src/talk_to_figma_mcp/`):
- `server.ts` — entry point
- `tools/` — domain-grouped tool registrations (document, create, modify, text, layout, components, export, scan, libraries, comments)
- `prompts/` — AI prompt definitions
- `connection.ts` — WebSocket management and channel auto-discovery
- `types.ts`, `utils.ts` — shared types and utilities

The Figma plugin (`src/cursor_mcp_plugin/code.js`) is **not bundled** — it runs directly in Figma's sandboxed JS VM. It includes concurrency control (node-level locks, global mutex, max 6 concurrent operations) for safe parallel agent execution.

See [CLAUDE.md](CLAUDE.md) for detailed agent guidance, design patterns, and known gotchas.

## License

MIT
