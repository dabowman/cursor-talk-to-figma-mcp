import { z } from "zod";
import { server } from "../instance.js";
import { sendCommandToFigma } from "../connection.js";

// Color schema shared across fill/stroke/font
const colorSchema = z
  .object({
    r: z.number().min(0).max(1).describe("Red (0-1)"),
    g: z.number().min(0).max(1).describe("Green (0-1)"),
    b: z.number().min(0).max(1).describe("Blue (0-1)"),
    a: z.number().min(0).max(1).optional().describe("Alpha (0-1)"),
  })
  .optional();

// Variable binding fields — matches FIELD_MAP in the plugin
const variableFieldEnum = z.enum([
  "fill",
  "stroke",
  "opacity",
  "cornerRadius",
  "topLeftRadius",
  "topRightRadius",
  "bottomLeftRadius",
  "bottomRightRadius",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "itemSpacing",
  "counterAxisSpacing",
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "visible",
  "characters",
  "fontSize",
  "fontFamily",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "paragraphSpacing",
  "paragraphIndent",
]);

// Recursive node operation schema
const nodeOpSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    nodeId: z.string().describe("ID of the existing node to modify"),

    // Visual properties (direct values)
    fillColor: colorSchema.describe("Fill color (also sets font color on TEXT nodes)"),
    strokeColor: colorSchema.describe("Stroke color"),
    strokeWeight: z.number().positive().optional().describe("Stroke weight"),
    cornerRadius: z.number().min(0).optional().describe("Corner radius"),
    opacity: z.number().min(0).max(1).optional().describe("Node opacity (0-1)"),
    clipsContent: z.boolean().optional().describe("Clip content (frames only). true = overflow hidden, false = overflow visible."),
    width: z.number().positive().optional().describe("Width (resizes the node)"),
    height: z.number().positive().optional().describe("Height (resizes the node)"),

    // Font properties (TEXT nodes only — loads fonts automatically)
    fontFamily: z.string().optional().describe("Font family (e.g. 'Inter', 'Space Grotesk'). TEXT nodes only."),
    fontWeight: z
      .number()
      .optional()
      .describe("Font weight (100-900, e.g. 400=Regular, 600=Semi Bold, 700=Bold). TEXT nodes only."),
    fontSize: z.number().positive().optional().describe("Font size in pixels. TEXT nodes only."),
    fontColor: colorSchema.describe("Font color (convenience alias for fillColor on TEXT nodes)."),

    // Layout properties
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional().describe("Auto-layout direction"),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether auto-layout wraps children"),
    paddingTop: z.number().optional(),
    paddingRight: z.number().optional(),
    paddingBottom: z.number().optional(),
    paddingLeft: z.number().optional(),
    primaryAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]).optional(),
    counterAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional(),
    layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional(),
    layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional(),
    itemSpacing: z.number().optional().describe("Spacing between children"),
    counterAxisSpacing: z.number().optional().describe("Spacing between wrapped rows/columns (requires WRAP)"),

    // Design token variable bindings
    variables: z
      .record(variableFieldEnum, z.string())
      .optional()
      .describe(
        "Map of field names to variable IDs. Binds design tokens to node properties. Fields: fill, stroke, cornerRadius, padding*, itemSpacing, width, height, opacity, visible, characters, fontSize, fontFamily, fontStyle, lineHeight, letterSpacing, paragraphSpacing, paragraphIndent.",
      ),

    // Component operations (INSTANCE nodes only)
    swapVariantId: z
      .string()
      .optional()
      .describe(
        "Swap an INSTANCE to a different variant. Value is the COMPONENT node ID to swap to. Instance keeps position and compatible overrides.",
      ),
    isExposedInstance: z
      .boolean()
      .optional()
      .describe(
        "Set isExposedInstance on a nested INSTANCE inside a COMPONENT. Surfaces the instance's properties at the parent level.",
      ),

    // Style references
    textStyleId: z.string().optional().describe("Text style ID to apply (from get_styles). Loads fonts automatically."),
    effectStyleId: z
      .string()
      .optional()
      .describe("Effect style ID to apply (from get_design_system). Applies drop shadows, inner shadows, blurs."),

    // Nested children — apply to child nodes in the same call
    children: z
      .array(z.lazy(() => nodeOpSchema))
      .optional()
      .describe("Child node operations — apply properties to nested nodes in one call"),
  }),
);

// Apply Tool — unified property application for existing nodes
server.tool(
  "apply",
  `Apply visual properties, font properties, layout settings, design token variables, text styles, and component operations to one or more existing nodes.

Handles fill color, stroke, corner radius, opacity, width, height, font family/weight/size/color, layout mode, padding, alignment, sizing, spacing, variable bindings, text style application, variant swapping (swapVariantId), and exposed instances (isExposedInstance).

For a single node:
  { nodes: [{ nodeId: "123", fillColor: { r: 1, g: 0, b: 0 } }] }

For multiple nodes:
  { nodes: [
    { nodeId: "123", cornerRadius: 8, variables: { fill: "VariableID:abc" } },
    { nodeId: "456", textStyleId: "S:style123," }
  ]}

Change fonts on existing TEXT nodes (never delete and recreate text just to change font):
  { nodes: [
    { nodeId: "title", fontFamily: "Space Grotesk", fontWeight: 700, fontSize: 32 },
    { nodeId: "body", fontFamily: "Inter", fontWeight: 400, fontSize: 15, fontColor: { r: 0.3, g: 0.3, b: 0.3 } }
  ]}

For nested structures (mirrors create tool pattern):
  { nodes: [{ nodeId: "parent", layoutMode: "VERTICAL", paddingTop: 16, children: [
    { nodeId: "child1", variables: { fill: "VariableID:abc" } },
    { nodeId: "child2", textStyleId: "S:style123," }
  ]}]}

Swap an instance to a different variant (keeps position and compatible overrides):
  { nodes: [{ nodeId: "instance1", swapVariantId: "targetComponentId" }] }

Expose a nested instance's properties at the parent component level:
  { nodes: [{ nodeId: "nestedInstance", isExposedInstance: true }] }

Execution order per node: component ops → layout mode → direct values → font properties → variable bindings → text style → effect style.
Variable bindings override direct values (set both to get a fallback + token).
Width and height resize the node. Use variables.width/height to bind dimension tokens.
Font properties load fonts automatically. fontColor is a convenience alias for fillColor on TEXT nodes.
Effect styles apply drop shadows, inner shadows, and blurs from the design system.
Colors use RGBA 0-1 range (e.g. { r: 0.2, g: 0.4, b: 1.0 }), not 0-255.

IMPORTANT: Bind variables and text styles on COMPONENT nodes, not instances — bindings propagate from component to all instances automatically.`,
  {
    nodes: z
      .array(nodeOpSchema)
      .min(1)
      .describe("Array of node operations — flat list or nested tree of property applications"),
  },
  async ({ nodes }: any) => {
    try {
      const result = await sendCommandToFigma("apply", { nodes }, 60000);
      const typedResult = result as {
        success: boolean;
        totalNodes: number;
        successCount: number;
        failureCount: number;
        results: Array<{ success: boolean; nodeId: string; nodeName?: string; error?: string }>;
      };

      const failed = typedResult.results.filter((r) => !r.success);
      const summary: any = {
        success: typedResult.success,
        nodesApplied: typedResult.successCount,
        totalNodes: typedResult.totalNodes,
      };
      if (failed.length > 0) {
        summary.failures = failed.map((f) => ({ nodeId: f.nodeId, error: f.error }));
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(summary),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error applying properties: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);
