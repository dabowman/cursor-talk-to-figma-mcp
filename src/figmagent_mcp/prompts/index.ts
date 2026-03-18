import { server } from "../instance.js";

// ─── Design Workflow ────────────────────────────────────────────────────────
// Replaces: design_strategy + read_design_strategy
server.prompt("design_workflow", "End-to-end workflow for reading, creating, and modifying Figma designs", (extra) => {
  return {
    messages: [
      {
        role: "assistant",
        content: {
          type: "text",
          text: `# Figma Design Workflow

## Phase 0: Connect (required before anything else)

\`join_channel()\` — connects to the active Figma plugin. Call with no arguments to auto-discover. If multiple channels are listed, ask the user which file they want to work in, then call \`join_channel({ channel: "name" })\`.

## Phase 1: Orient

1. \`get_document_info()\` — understand pages and top-level frames.
2. \`get_selection()\` — find what the user is looking at. If empty, ask them to select something.
3. \`get(nodeId, detail="structure", depth=2)\` — lightweight overview (~5 tokens/node). Increase depth or switch to \`detail="layout"\` when you need auto-layout properties.

**Detail levels** (pick the cheapest one that works):
- \`structure\` — names, types, hierarchy. Good for orientation.
- \`layout\` — adds auto-layout, sizing, spacing, dimensions. Good for building or cloning.
- \`full\` — adds variables, styles, bound tokens. Good for auditing design system usage.

If \`tokenEstimate > 8000\` in the response, narrow with \`depth\` or \`filter\` before reading more.

## Phase 2: Plan

Before creating anything, decide the **layout hierarchy**. Figma's auto-layout is the primary layout mechanism — avoid manual x/y positioning.

**Auto-layout essentials:**
- \`layoutMode: "VERTICAL" | "HORIZONTAL"\` — direction children flow
- \`itemSpacing\` — gap between children
- \`paddingTop/Right/Bottom/Left\` — inner padding
- \`primaryAxisAlignItems: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN"\` — main axis alignment
- \`counterAxisAlignItems: "MIN" | "CENTER" | "MAX" | "BASELINE"\` — cross axis alignment
- \`layoutSizingHorizontal/Vertical: "FIXED" | "HUG" | "FILL"\` — how the frame sizes itself
- \`layoutWrap: "WRAP"\` — enables wrapping (grid-like layouts)

**Sizing rules:**
- \`HUG\` = shrink to fit content (good for buttons, tags)
- \`FILL\` = stretch to fill parent (requires parent to have auto-layout). Cannot be set at creation time — the \`create\` tool handles this automatically in a second pass.
- \`FIXED\` = explicit width/height
- Use FRAME with a fill color instead of RECTANGLE when the node needs \`FILL\` sizing.

## Phase 3: Build

Use \`create()\` for all node creation. It handles single nodes, nested trees, COMPONENTs, and INSTANCEs.

\`\`\`
create({
  parentId: "target-frame",
  node: {
    type: "FRAME",
    name: "Card",
    layoutMode: "VERTICAL",
    itemSpacing: 12,
    paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16,
    layoutSizingHorizontal: "FILL",
    layoutSizingVertical: "HUG",
    fillColor: { r: 1, g: 1, b: 1 },
    cornerRadius: 8,
    children: [
      { type: "TEXT", name: "Title", text: "Card Title", fontSize: 18, fontWeight: 600 },
      { type: "TEXT", name: "Body", text: "Description text here.", fontSize: 14, fontWeight: 400 }
    ]
  }
})
\`\`\`

**Node types:** FRAME (default), TEXT, RECTANGLE, COMPONENT, INSTANCE, SVG (pass an svg string).
- COMPONENT works exactly like FRAME but creates a reusable component.
- INSTANCE requires \`componentId\` (local) or \`componentKey\` (library).
- SVG requires an \`svg\` property with a valid SVG string — use for icons, arrows, dividers, illustrations.

## Phase 4: Modify

Use \`apply()\` for all property changes on existing nodes — fills, strokes, fonts, layout, variables, styles.

\`\`\`
apply({
  nodes: [
    { nodeId: "abc", fillColor: { r: 0.2, g: 0.4, b: 1 }, cornerRadius: 12 },
    { nodeId: "def", fontWeight: 700, fontSize: 24 }
  ]
})
\`\`\`

**Key capabilities of \`apply\`:**
- Visual: fillColor, strokeColor, strokeWeight, cornerRadius, opacity, width, height
- Font (TEXT only): fontFamily, fontWeight, fontSize, fontColor
- Layout: layoutMode, padding, alignment, sizing, spacing
- Design tokens: \`variables\` field maps property names → variable IDs
- Styles: \`textStyleId\`, \`effectStyleId\` (from \`get_design_system\`)
- Components: \`swapVariantId\` (swap instance variant), \`isExposedInstance\`

**Do not** delete and recreate text nodes to change fonts — use \`apply\` with font properties.

## Phase 5: Design System

1. \`get_design_system()\` — discover all styles and variables in one call.
2. \`apply({ nodes: [{ nodeId, variables: { fill: "VariableID:xxx" } }] })\` — bind tokens.
3. \`apply({ nodes: [{ nodeId, textStyleId: "S:xxx" }] })\` — apply text styles.
4. \`lint_design({ nodeId })\` — scan for unbound properties; use \`autoFix: true\` to bind exact matches.

Prefer variable bindings over hardcoded values — this keeps designs connected to the token system.

**Variable CRUD:** \`create_variables\` / \`update_variables\` for collections, modes, and values.
**Style CRUD:** \`create_styles\` / \`update_styles\` for paint, text, effect, and grid styles.

## Phase 6: Verify

- \`get(nodeId, detail="structure")\` — confirm hierarchy looks right.
- \`export_node_as_image(nodeId, format="PNG", scale=1)\` — visual spot-check.
- \`lint_design(nodeId)\` — check token coverage.

## Common Pitfalls

These cause silent failures or wasted calls — learn them now:

1. **FRAME, not RECTANGLE, for stretchy shapes.** RECTANGLE nodes cannot have \`layoutSizingVertical: FILL\` or \`layoutSizingHorizontal: FILL\`. Use a FRAME with a fill color instead. Example: a 1px-wide FRAME replaces a RECTANGLE for a divider line.

2. **Bind variables on COMPONENTs, not instances.** Variable bindings and text style assignments propagate from a COMPONENT to all its instances automatically. Always bind at the component level.

3. **No reparenting.** \`move_node\` only changes x/y position, not hierarchy. To move a node to a new parent: \`clone_and_modify(nodeId, parentId=newParent)\` + \`delete_node(originalId)\`.

4. **Connection drops.** If 2+ commands time out in a row on any tool, the plugin↔relay WebSocket has likely dropped. The server auto-invalidates the channel on timeout and re-discovers on the next command. If auto-recovery fails, call \`join_channel()\` (no args) to re-discover manually.

5. **Stop after 2 identical errors.** If the same tool call fails twice with the same error, diagnose the root cause (wrong node ID, lost connection, type mismatch) instead of retrying.

6. **Colors are RGBA 0-1.** All color values (fillColor, strokeColor, fontColor) use \`{ r, g, b, a? }\` where each channel is a float from 0 to 1. Not 0-255.

7. **Use \`find\` → \`get\` → \`apply\` as your core loop.** \`find\` locates nodes by criteria, \`get\` reads their details, \`apply\` modifies them. Avoid brute-force traversals.

8. **Batch over repeated singles.** Prefer \`set_multiple_text_contents\`, \`delete_multiple_nodes\`, \`set_multiple_annotations\` over repeated single-node calls. Use \`apply\` with multiple node entries instead of separate calls.

9. **Instances are leaf nodes in \`get\`.** Call \`get(instanceId)\` separately to expand instance internals. The \`componentRef\` in \`defs.components\` resolves to the main component's id, name, key, and description.`,
        },
      },
    ],
    description: "End-to-end workflow for reading, creating, and modifying Figma designs",
  };
});

// ─── Text Replacement ───────────────────────────────────────────────────────
// Replaces: text_replacement_strategy
server.prompt("text_replacement", "Strategy for finding and replacing text content in Figma designs", (extra) => {
  return {
    messages: [
      {
        role: "assistant",
        content: {
          type: "text",
          text: `# Text Replacement Strategy

## 1. Discover
\`scan_text_nodes(nodeId)\` — returns all text nodes under a parent with their current content, node IDs, and layer paths.

Use the layer paths and content to understand the structure: tables, card groups, forms, lists, navigation.

## 2. Replace
\`set_multiple_text_contents({ nodeId: "parent", textNodes: [...] })\` — batch-replace up to ~50 text nodes in one call.

Each entry: \`{ nodeId: "text-node-id", text: "New content" }\`.

For very large designs (100+ text nodes), chunk into batches of 50 to avoid timeouts.

## 3. Instance Text Overrides
For text inside component instances, the nodeId format is:
- \`I<instanceId>;<componentTextNodeId>\` for direct children
- \`I<outerInstance>;<innerInstance>;<textNodeId>\` for nested instances

Use \`scan_text_nodes\` on the component first to discover the text node IDs, then construct the override path.

## 4. Font Changes
To change font properties (family, weight, size, color), use \`apply\` — not text replacement:
\`apply({ nodes: [{ nodeId: "text-id", fontFamily: "Space Grotesk", fontWeight: 600, fontSize: 16 }] })\`

## 5. Verify
\`get(nodeId, detail="structure")\` to confirm text content updated correctly. For visual verification, \`export_node_as_image(nodeId)\`.`,
        },
      },
    ],
    description: "Strategy for finding and replacing text content in Figma designs",
  };
});

// ─── Annotation Conversion ──────────────────────────────────────────────────
// Replaces: annotation_conversion_strategy
server.prompt(
  "annotation_conversion",
  "Convert manual design annotations to Figma's native annotation system",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Annotation Conversion Strategy

Convert manual annotations (numbered markers with descriptions) to Figma's native annotations.

## Step 1: Gather Data

Call these in parallel:
- \`scan_text_nodes(nodeId)\` — find all text (markers like "1", "2", "A", "B" and their descriptions)
- \`scan_nodes_by_types({ nodeId, types: ["COMPONENT", "INSTANCE", "FRAME"] })\` — find annotation targets
- \`get_annotations({ nodeId, includeCategories: true })\` — get available annotation categories

## Step 2: Identify Markers and Descriptions

Markers are typically short text (single character/number) inside containers named "Marker", "Dot", or similar. Descriptions are longer text nodes nearby or sharing a parent with the marker.

Group each marker with its description text.

## Step 3: Match Annotations to Target Nodes

For each annotation, find the target UI element using these strategies (in priority order):

1. **Path-based** — marker's parent container name matches a UI element name in the layer hierarchy. Most reliable.
2. **Name-based** — key terms from the description appear in UI element names.
3. **Proximity-based** (fallback) — closest UI element by center-to-center distance.

## Step 4: Apply Native Annotations

Use \`set_multiple_annotations\` for batch processing:

\`\`\`
set_multiple_annotations({
  nodeId: "parent-frame",
  annotations: [
    { nodeId: "target-1", labelMarkdown: "Primary action button", categoryId: "cat-id" },
    { nodeId: "target-2", labelMarkdown: "User avatar display", categoryId: "cat-id" }
  ]
})
\`\`\`

Choose the category that best fits the annotation content (from the categories returned in Step 1).`,
          },
        },
      ],
      description: "Convert manual design annotations to Figma's native annotation system",
    };
  },
);

// ─── Instance Override Transfer ─────────────────────────────────────────────
// Replaces: swap_overrides_instances
server.prompt(
  "instance_override_transfer",
  "Transfer content and property overrides between component instances",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Instance Override Transfer

Transfer overrides (text content, property values, styles) from a source instance to one or more target instances.

## Process

1. **Identify instances** — \`get_selection()\` or \`scan_nodes_by_types({ nodeId, types: ["INSTANCE"] })\`. Determine which instance has the content to copy (source) and which are targets.

2. **Extract overrides** — \`get_instance_overrides({ nodeId: "source-instance-id" })\`. Returns text content, property values, and style overrides.

3. **Apply to targets** — \`set_instance_overrides({ sourceInstanceId: "source-id", targetNodeIds: ["target-1", "target-2"] })\`.

4. **Verify** — \`get(nodeId, detail="structure")\` on targets to confirm overrides applied.

## Tips
- Preserve component relationships — use instance overrides rather than direct text manipulation.
- This works best when source and target are instances of the same component (or closely related variants).`,
          },
        },
      ],
      description: "Transfer content and property overrides between component instances",
    };
  },
);

// ─── Reaction to Connector ──────────────────────────────────────────────────
// Replaces: reaction_to_connector_strategy
server.prompt(
  "reaction_to_connector",
  "Convert prototype reactions to visual connector lines on the canvas",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Prototype Reactions → Connector Lines

Visualize prototype flows as connector lines on the Figma canvas.

## Step 1: Check Default Connector

Call \`set_default_connector()\` (no arguments) to check if a default connector exists.
- If confirmed → proceed.
- If not set → the user must paste a FigJam connector onto the page, select it, then call \`set_default_connector({ connectorId: "selected-node-id" })\`.

## Step 2: Get Reactions

\`get_reactions({ nodeId })\` — returns nodes with their prototype reactions.

## Step 3: Filter and Transform

Keep only reactions with navigation-type actions:
- **Include:** NAVIGATE, OPEN_OVERLAY, SWAP_OVERLAY
- **Ignore:** CHANGE_TO, CLOSE_OVERLAY, BACK, URL

Extract from each valid reaction:
- \`sourceNodeId\` — the node the reaction belongs to
- \`destinationNodeId\` — \`action.destinationId\`
- \`triggerType\` + \`actionType\` — for the label

## Step 4: Create Connections

Build descriptive labels (e.g., "On click → Screen Name") using node names from \`get()\`.

\`\`\`
create_connections({
  connections: [
    { startNodeId: "source-1", endNodeId: "dest-1", text: "On click → Dashboard" },
    { startNodeId: "source-2", endNodeId: "dest-2", text: "On drag → Settings overlay" }
  ]
})
\`\`\``,
          },
        },
      ],
      description: "Convert prototype reactions to visual connector lines on the canvas",
    };
  },
);

// ─── Component Architecture ─────────────────────────────────────────────────
// New prompt: covers component creation, variants, properties, and instances
server.prompt("component_architecture", "Guide to building components, variants, and instances in Figma", (extra) => {
  return {
    messages: [
      {
        role: "assistant",
        content: {
          type: "text",
          text: `# Component Architecture

## Creating Components

Use \`create\` with \`type: "COMPONENT"\` — works exactly like FRAME but produces a reusable component:

\`\`\`
create({
  parentId: "page-or-frame",
  node: {
    type: "COMPONENT",
    name: "Button",
    layoutMode: "HORIZONTAL",
    itemSpacing: 8,
    paddingTop: 12, paddingRight: 24, paddingBottom: 12, paddingLeft: 24,
    fillColor: { r: 0.2, g: 0.4, b: 1 },
    cornerRadius: 8,
    children: [
      { type: "TEXT", name: "Label", text: "Click me", fontSize: 14, fontWeight: 600, fontColor: { r: 1, g: 1, b: 1 } }
    ]
  }
})
\`\`\`

## Variants

Create individual COMPONENT nodes, then combine them into a COMPONENT_SET:

\`\`\`
combine_as_variants({ nodeIds: ["comp-1", "comp-2", "comp-3"], name: "Button" })
\`\`\`

Name each component with the variant property format: \`Property1=Value1, Property2=Value2\` (e.g., "Size=Medium, State=Default"). The resulting COMPONENT_SET automatically gets horizontal wrap auto-layout so variants are neatly arranged.

## Component Properties

Use \`component_properties\` to add, edit, delete, and **bind** property definitions in batch:

\`\`\`
component_properties({
  nodeId: "component-or-set-id",
  operations: [
    // Add properties AND bind them to child nodes in one step:
    { action: "add", name: "Show Icon", type: "BOOLEAN", defaultValue: true, targetNodeId: "icon-node-id" },
    { action: "add", name: "Label", type: "TEXT", defaultValue: "Button", targetNodeId: "text-node-id" },
    { action: "add", name: "Icon", type: "INSTANCE_SWAP", defaultValue: "icon-comp-id", targetNodeId: "icon-instance-id" },
    // Edit and delete existing properties:
    { action: "edit", propertyName: "Show Icon#123:0", newName: "Has Icon" },
    { action: "delete", propertyName: "Deprecated Prop#456:0" },
    // Bind an existing property to a different child node:
    { action: "bind", propertyName: "Label#12:0", targetNodeId: "other-text-node-id" }
  ]
})
\`\`\`

**Important**: Adding a property definition alone does NOT wire it to child nodes. Always pass \`targetNodeId\` on \`add\` operations (or use \`bind\` afterward) to connect the property to the actual child node. Auto-detection maps: BOOLEAN→visible, TEXT→characters, INSTANCE_SWAP→mainComponent.

Use \`get(nodeId)\` on a COMPONENT or COMPONENT_SET to discover existing \`componentPropertyDefinitions\` (names include a \`#suffix\`). Child nodes show \`componentPropertyReferences\` when wired to a property.

## Instances

Create instances with \`create\`:
\`\`\`
create({ parentId: "frame", node: { type: "INSTANCE", componentId: "local-component-id" } })
// or from library:
create({ parentId: "frame", node: { type: "INSTANCE", componentKey: "published-key" } })
\`\`\`

Swap to a different variant: \`apply({ nodes: [{ nodeId: "instance-id", swapVariantId: "target-variant-component-id" }] })\`

## Exposed Instances

Surface a nested instance's properties at the parent component level:
\`apply({ nodes: [{ nodeId: "nested-instance-inside-component", isExposedInstance: true }] })\`

**Important:** \`isExposedInstance\` does NOT create a picker/dropdown for swapping — it surfaces the nested instance's own properties (like text overrides) on the parent. To create a dropdown that lets users pick between components, use \`component_properties\` with type \`INSTANCE_SWAP\` instead.

## Key Rules

- **Bind variables on COMPONENT nodes**, not instances — bindings propagate automatically.
- **No reparenting** — to move a node to a new parent, use \`clone_and_modify(nodeId, parentId=newParent)\` + delete the original.
- Instances are leaf nodes in \`get\` output — call \`get(instanceId)\` to expand internals.`,
        },
      },
    ],
    description: "Guide to building components, variants, and instances in Figma",
  };
});
