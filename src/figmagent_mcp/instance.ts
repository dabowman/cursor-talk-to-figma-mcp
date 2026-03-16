import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const instructions = `Figmagent bridges AI agents with Figma via a WebSocket relay. The Figma plugin must be running for tools to work.

## Quick Start
1. Call any tool — the server auto-joins the active Figma file. If multiple files are open, you'll get a list to pick from.
2. Use get_document_info() to see pages and top-level frames, then get_selection() to find what the user is looking at.
3. Use get(nodeId, detail="structure", depth=2) to orient before making changes.

## Core Workflow: find → get → apply
- find() — search for nodes by criteria (component usage, variable bindings, text, name, type)
- get() — read node details at three cost levels: "structure" (~5 tokens/node), "layout" (~15), "full" (~30)
- apply() — modify properties on existing nodes (fill, stroke, fonts, layout, variables, styles)
- create() — create new nodes (single or nested trees). Supports FRAME, TEXT, RECTANGLE, COMPONENT, INSTANCE.

## Critical Rules
- **FRAME not RECTANGLE for stretchy shapes.** RECTANGLE cannot use FILL sizing. Use a FRAME with fillColor instead.
- **Bind variables on COMPONENTs, not instances.** Bindings propagate from component to all instances automatically.
- **No reparenting.** move_node only changes x/y. To reparent: clone_and_modify(nodeId, parentId=newParent) + delete_node(original).
- **Colors are RGBA 0-1** (not 0-255). Example: { r: 0.2, g: 0.4, b: 1.0 }
- **Batch over singles.** Use apply() with multiple nodes, set_multiple_text_contents, delete_multiple_nodes.
- **Connection drops.** If 2+ commands time out, call join_channel() to reconnect, then retry.
- **Stop after 2 identical errors.** Diagnose the root cause instead of retrying.

## Design System
- get_design_system() — discover all styles and variables in one call
- apply() with variables field — bind design tokens to node properties
- apply() with textStyleId/effectStyleId — apply styles from the design system
- lint_design() — scan for unbound properties, auto-fix exact matches

## Available Tools

All 47 tools provided by this server, grouped by domain:

**Reading & Navigation:** get_document_info, get_selection, get, find, scan_text_nodes, scan_nodes_by_types, export_node_as_image
**Creating:** create
**Modifying:** apply, move_node, resize_node, rename_node, delete_node, delete_multiple_nodes, clone_node, clone_and_modify, reorder_children
**Text:** set_text_content, set_multiple_text_contents
**Components:** get_local_components, combine_as_variants, component_properties, get_instance_overrides, set_instance_overrides
**Design System:** get_design_system, create_variables, update_variables, create_styles, update_styles
**Libraries:** get_library_components, search_library_components, import_library_component, get_component_variants, get_library_variables
**Annotations & Comments:** get_annotations, set_annotation, set_multiple_annotations, get_comments, post_comment, delete_comment
**Linting:** lint_design
**Connections & Prototyping:** join_channel, get_reactions, set_default_connector, create_connections, set_focus, set_selections

## Prompts Available
Request these for detailed workflow guidance:
- design_workflow — full 6-phase workflow with examples and pitfalls
- text_replacement — finding and replacing text content
- component_architecture — building components, variants, and instances
- annotation_conversion — converting manual annotations to native Figma annotations
- instance_override_transfer — transferring overrides between instances
- reaction_to_connector — visualizing prototype flows as connector lines`;

// Create MCP server (exported for tool/prompt registration)
export const server = new McpServer(
  {
    name: "Figmagent",
    version: "1.0.0",
  },
  { instructions },
);
