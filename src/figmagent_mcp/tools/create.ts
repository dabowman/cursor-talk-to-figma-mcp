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
      .describe("Node type (default: FRAME). COMPONENT works like FRAME but creates a component. INSTANCE requires componentId or componentKey."),
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

// Create Tool — the single entry point for creating any nodes in Figma
server.tool(
  "create",
  `Create one or more nodes in Figma. Accepts a single node spec or a nested tree of nodes.

Node types: FRAME (default), TEXT, RECTANGLE, COMPONENT, INSTANCE.

For a single node, pass a flat spec:
  { node: { type: "TEXT", text: "Hello", fontSize: 24 } }

For nested structures, add children:
  { node: { type: "FRAME", name: "Card", layoutMode: "VERTICAL", children: [
    { type: "TEXT", text: "Title", fontWeight: 700 },
    { type: "TEXT", text: "Body text" }
  ]}}

For components (works like FRAME but creates a COMPONENT node):
  { node: { type: "COMPONENT", name: "Button", layoutMode: "HORIZONTAL", children: [...] } }

For instances (componentId for local, componentKey for library):
  { node: { type: "INSTANCE", componentId: "123:456" } }

FRAME and COMPONENT nodes support auto-layout (layoutMode, padding, alignment, spacing, sizing), fill/stroke colors, and cornerRadius.
TEXT nodes support text, fontSize, fontWeight, fontFamily, fontStyle, and fontColor.
RECTANGLE nodes support fillColor, strokeColor, strokeWeight, and cornerRadius.
INSTANCE nodes require componentId or componentKey. Position and parentId work as usual.
All nodes support width, height, x, y, and name.

FILL sizing is applied in a second pass after children exist, so it works correctly even at creation time.
Use parentId to append the created node(s) inside an existing frame.`,
  {
    parentId: z.string().optional().describe("Parent node ID to append the created node(s) to"),
    node: nodeSpecSchema.describe("Node spec — a single node or a nested tree with children"),
  },
  async ({ parentId, node }: any) => {
    try {
      const result = await sendCommandToFigma("create", { parentId, tree: node }, 60000);
      const typedResult = result as {
        success: boolean;
        totalNodesCreated: number;
        tree: { id: string; name: string; type: string; children?: any[] };
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              rootId: typedResult.tree.id,
              rootName: typedResult.tree.name,
              rootType: typedResult.tree.type,
              totalNodesCreated: typedResult.totalNodesCreated,
              nodes: typedResult.tree,
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating node(s): ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);
