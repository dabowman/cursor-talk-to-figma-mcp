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
]);

// Recursive node operation schema
const nodeOpSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    nodeId: z.string().describe("ID of the existing node to modify"),

    // Visual properties (direct values)
    fillColor: colorSchema.describe("Fill color"),
    strokeColor: colorSchema.describe("Stroke color"),
    strokeWeight: z.number().positive().optional().describe("Stroke weight"),
    cornerRadius: z.number().min(0).optional().describe("Corner radius"),
    opacity: z.number().min(0).max(1).optional().describe("Node opacity (0-1)"),
    width: z.number().positive().optional().describe("Width (resizes the node)"),
    height: z.number().positive().optional().describe("Height (resizes the node)"),

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
        "Map of field names to variable IDs. Binds design tokens to node properties. Fields: fill, stroke, cornerRadius, padding*, itemSpacing, width, height, opacity, visible, characters, etc.",
      ),

    // Text style reference
    textStyleId: z.string().optional().describe("Text style ID to apply (from get_styles). Loads fonts automatically."),

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
  `Apply visual properties, layout settings, design token variables, and text styles to one or more existing nodes.

Replaces individual tools for fill color, stroke, corner radius, layout mode, padding, alignment, sizing, spacing, variable binding, and text style application.

For a single node:
  { nodes: [{ nodeId: "123", fillColor: { r: 1, g: 0, b: 0 } }] }

For multiple nodes:
  { nodes: [
    { nodeId: "123", cornerRadius: 8, variables: { fill: "VariableID:abc" } },
    { nodeId: "456", textStyleId: "S:style123," }
  ]}

For nested structures (mirrors create tool pattern):
  { nodes: [{ nodeId: "parent", layoutMode: "VERTICAL", paddingTop: 16, children: [
    { nodeId: "child1", variables: { fill: "VariableID:abc" } },
    { nodeId: "child2", textStyleId: "S:style123," }
  ]}]}

Execution order per node: layout mode → direct values → variable bindings → text style.
Variable bindings override direct values (set both to get a fallback + token).
Width and height resize the node. Use variables.width/height to bind dimension tokens.`,
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
