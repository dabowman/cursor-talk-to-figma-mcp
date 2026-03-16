import { z } from "zod";
import { server } from "../instance.js";
import { sendCommandToFigma } from "../connection.js";

// Shared color schema
const colorSchema = z
  .object({
    r: z.number().min(0).max(1).describe("Red (0-1)"),
    g: z.number().min(0).max(1).describe("Green (0-1)"),
    b: z.number().min(0).max(1).describe("Blue (0-1)"),
    a: z.number().min(0).max(1).optional().describe("Alpha (0-1)"),
  })
  .optional();

// Recursive node spec schema
const nodeSpecSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    type: z
      .enum(["FRAME", "TEXT", "RECTANGLE", "COMPONENT", "INSTANCE"])
      .optional()
      .describe(
        "Node type (default: FRAME). COMPONENT works like FRAME but creates a component. INSTANCE requires componentId or componentKey.",
      ),
    name: z.string().optional().describe("Node name"),
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    width: z.number().optional().describe("Width"),
    height: z.number().optional().describe("Height"),
    // Frame layout
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional(),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional(),
    paddingTop: z.number().optional(),
    paddingRight: z.number().optional(),
    paddingBottom: z.number().optional(),
    paddingLeft: z.number().optional(),
    primaryAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]).optional(),
    counterAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional(),
    layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional(),
    layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional(),
    itemSpacing: z.number().optional(),
    cornerRadius: z.number().min(0).optional(),
    // Colors
    fillColor: colorSchema,
    strokeColor: colorSchema,
    strokeWeight: z.number().optional(),
    // Text-specific
    text: z.string().optional().describe("Text content (for TEXT nodes)"),
    fontSize: z.number().optional(),
    fontWeight: z.number().optional(),
    fontFamily: z.string().optional().describe("Font family (default: Inter)"),
    fontStyle: z.string().optional().describe("Font style (default: Regular)"),
    fontColor: colorSchema,
    // Instance-specific (type: INSTANCE)
    componentId: z.string().optional().describe("Node ID of a local COMPONENT to instantiate (for INSTANCE type)"),
    componentKey: z
      .string()
      .optional()
      .describe("Key of a published library component to instantiate (for INSTANCE type)"),
    // Children
    children: z
      .array(z.lazy(() => nodeSpecSchema))
      .optional()
      .describe("Child nodes"),
  }),
);

// Helper: send one create command and format the result
async function createOne(parentId: string | undefined, nodeSpec: any) {
  const result = (await sendCommandToFigma("create", { parentId, tree: nodeSpec }, 60000)) as {
    success: boolean;
    totalNodesCreated: number;
    tree: { id: string; name: string; type: string; children?: any[] };
  };
  return {
    rootId: result.tree.id,
    rootName: result.tree.name,
    rootType: result.tree.type,
    totalNodesCreated: result.totalNodesCreated,
    nodes: result.tree,
  };
}

// Create Tool — the single entry point for creating any nodes in Figma
server.tool(
  "create",
  `Create one or more nodes in Figma. Accepts a single node spec, a nested tree, or multiple root nodes.

Node types: FRAME (default), TEXT, RECTANGLE, COMPONENT, INSTANCE.

For a single node, pass a flat spec:
  { node: { type: "TEXT", text: "Hello", fontSize: 24 } }

For nested structures, add children:
  { node: { type: "FRAME", name: "Card", layoutMode: "VERTICAL", children: [
    { type: "TEXT", text: "Title", fontWeight: 700 },
    { type: "TEXT", text: "Body text" }
  ]}}

For multiple root nodes (e.g. variant components), use the nodes array:
  { nodes: [
    { type: "COMPONENT", name: "Variant=SM", ... },
    { type: "COMPONENT", name: "Variant=MD", ... },
    { type: "COMPONENT", name: "Variant=LG", ... }
  ]}
Each node spec in the array is created in parallel. Use this when building multiple sibling components (e.g. variants before combine_as_variants).

FRAME and COMPONENT nodes support auto-layout (layoutMode, padding, alignment, spacing, sizing), fill/stroke colors, and cornerRadius.
TEXT nodes support text, fontSize, fontWeight, fontFamily, fontStyle, and fontColor.
RECTANGLE nodes support fillColor, strokeColor, strokeWeight, and cornerRadius. IMPORTANT: RECTANGLE cannot use FILL sizing — use a FRAME with fillColor instead when you need a shape that stretches.
INSTANCE nodes require componentId or componentKey. Position and parentId work as usual.
All nodes support width, height, x, y, and name.

FILL sizing is applied in a second pass after children exist, so it works correctly even at creation time.
Use parentId to append the created node(s) inside an existing frame.
Colors use RGBA 0-1 range (e.g. { r: 0.2, g: 0.4, b: 1.0 }), not 0-255.`,
  {
    parentId: z.string().optional().describe("Parent node ID to append the created node(s) to"),
    node: nodeSpecSchema
      .optional()
      .describe("Single node spec — a node or nested tree with children. Mutually exclusive with 'nodes'."),
    nodes: z
      .array(nodeSpecSchema)
      .optional()
      .describe(
        "Array of node specs to create in parallel. Each spec is a root node (with optional children). Mutually exclusive with 'node'.",
      ),
  },
  async ({ parentId, node, nodes }: any) => {
    try {
      // Validate mutual exclusivity
      if (node && nodes) {
        return {
          content: [{ type: "text" as const, text: "Error: provide either 'node' or 'nodes', not both." }],
        };
      }
      if (!node && !nodes) {
        return {
          content: [{ type: "text" as const, text: "Error: provide either 'node' (single) or 'nodes' (array)." }],
        };
      }

      // Single node
      if (node) {
        const result = await createOne(parentId, node);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      }

      // Multiple nodes — create in parallel
      const results = await Promise.all(nodes.map((spec: any) => createOne(parentId, spec)));
      const totalNodes = results.reduce((sum: number, r: any) => sum + r.totalNodesCreated, 0);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              totalRoots: results.length,
              totalNodesCreated: totalNodes,
              roots: results,
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error creating node(s): ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);
