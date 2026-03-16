import { z } from "zod";
import { server } from "../instance.js";
import { sendCommandToFigma } from "../connection.js";
import { guardOutput, extractJsonSummary } from "../utils.js";

const lintableProperties = z.enum([
  "fills",
  "strokes",
  "cornerRadius",
  "opacity",
  "itemSpacing",
  "counterAxisSpacing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontSize",
  "fontFamily",
]);

server.tool(
  "lint_design",
  `Scan a Figma subtree for properties not bound to design token variables. Reports unbound fills, strokes, corner radii, spacing, opacity, and font properties. Compares values against local variables using perceptual color distance (CIE76 deltaE) for colors and numeric proximity for scalars. Returns structured issues with severity levels and suggested variable matches.

Use after building or modifying a design to verify all properties are tokenized. With autoFix=true, automatically binds exact matches.

Severity levels:
- exact_match: variable exists with identical value (deltaE < 1.0 for colors, exact equality for scalars). Auto-fixable.
- near_match: variable exists within threshold (deltaE < threshold for colors, within 10% for scalars). Review suggested.
- no_match: no matching variable found. Manual action needed.`,
  {
    nodeId: z
      .string()
      .describe(
        "Root node ID to scan. All visible descendants will be linted. Accepts PAGE node IDs (e.g. '0:1') to lint all top-level components on the page in one call.",
      ),
    autoFix: z
      .boolean()
      .default(false)
      .describe("When true, automatically bind exact-match variables to unbound properties. Skips instance children."),
    properties: z
      .array(lintableProperties)
      .optional()
      .describe("Filter to specific properties. Default: all lintable properties."),
    threshold: z
      .number()
      .min(0)
      .max(20)
      .default(5.0)
      .describe("Color distance threshold (deltaE) for near_match suggestions. Default: 5.0"),
    maxIssues: z
      .number()
      .min(1)
      .max(1000)
      .default(200)
      .describe("Maximum number of issues to return in detail. Summary counts are always complete."),
  },
  async ({ nodeId, autoFix, properties, threshold, maxIssues }: any) => {
    try {
      const result = await sendCommandToFigma("lint_design", {
        nodeId,
        autoFix,
        properties,
        threshold,
        maxIssues,
      });

      const jsonText = JSON.stringify(result, null, 2);
      const guarded = guardOutput(jsonText, {
        metaExtractor: extractJsonSummary,
        toolName: "lint_design",
        narrowingHints: [
          "  • Lower maxIssues to reduce output",
          "  • Filter with the properties param to lint specific property types",
          "  • Lint a smaller subtree",
        ],
      });
      return {
        content: [
          {
            type: "text" as const,
            text: guarded.text,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error running lint_design: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);
