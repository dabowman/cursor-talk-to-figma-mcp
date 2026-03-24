import { z } from "zod";
import { server } from "../instance.js";
import { sendCommandToFigma } from "../connection.js";
import { serializeYaml } from "../yaml.js";
import { guardOutput, extractYamlMeta } from "../utils.js";

server.tool(
  "find",
  `Search a Figma subtree for nodes matching criteria. Returns matches grouped by nearest component/frame ancestor with ancestry paths.

Criteria combine with AND (all must match). Within each criterion, values combine with OR.

Search criteria (at least one required):
- componentId: find instances of these components or component sets
- variableId: find nodes with direct variable bindings to these variable IDs
- styleId: find nodes using these fill/stroke/text/effect/grid styles
- text: find TEXT nodes whose content matches this regex
- name: find nodes whose name matches this regex
- type: find nodes of these types (FRAME, TEXT, INSTANCE, COMPONENT, etc.)
- annotation: find nodes whose annotation label matches this regex
- hasAnnotation: find all nodes that have any annotation (boolean)

Use \`find\` to locate nodes, then \`get\` for details on specific matches.`,
  {
    scope: z
      .string()
      .optional()
      .describe('Node ID to search within, or "DOCUMENT" to search all pages (default: current page)'),
    componentId: z.array(z.string()).optional().describe("Find instances of these component or component_set IDs"),
    variableId: z
      .array(z.string())
      .optional()
      .describe("Find nodes with direct variable bindings to these variable IDs"),
    styleId: z
      .array(z.string())
      .optional()
      .describe("Find nodes using these style IDs (fill, stroke, text, effect, or grid styles)"),
    text: z.string().optional().describe("Find TEXT nodes whose content matches this regex pattern"),
    name: z.string().optional().describe("Find nodes whose name matches this regex pattern"),
    type: z
      .array(z.string())
      .optional()
      .describe("Find nodes of these types (e.g. FRAME, TEXT, INSTANCE, COMPONENT, COMPONENT_SET)"),
    annotation: z.string().optional().describe("Find nodes whose annotation label matches this regex pattern"),
    hasAnnotation: z.boolean().optional().describe("Find all nodes that have any annotation (set to true)"),
    excludeDefinitions: z
      .boolean()
      .optional()
      .default(true)
      .describe("When searching by componentId, skip matches inside those component definitions (default: true)"),
    maxResults: z.coerce
      .number()
      .optional()
      .default(200)
      .describe("Maximum number of matches to return (default: 200)"),
    maxOutputChars: z.coerce
      .number()
      .int()
      .min(1000)
      .optional()
      .describe("Max response size in characters. Default: 30000. Raise when you need full unfiltered data."),
  },
  async ({
    scope,
    componentId,
    variableId,
    styleId,
    text,
    name,
    type,
    annotation,
    hasAnnotation,
    excludeDefinitions,
    maxResults,
    maxOutputChars,
  }: {
    scope?: string;
    componentId?: string[];
    variableId?: string[];
    styleId?: string[];
    text?: string;
    name?: string;
    type?: string[];
    annotation?: string;
    hasAnnotation?: boolean;
    excludeDefinitions?: boolean;
    maxResults?: number;
    maxOutputChars?: number;
  }) => {
    // Validate at least one search criterion
    const hasCriteria =
      (componentId && componentId.length > 0) ||
      (variableId && variableId.length > 0) ||
      (styleId && styleId.length > 0) ||
      text ||
      name ||
      annotation ||
      hasAnnotation === true ||
      (type && type.length > 0);

    if (!hasCriteria) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: at least one search criterion is required (componentId, variableId, styleId, text, name, type, annotation, or hasAnnotation)",
          },
        ],
      };
    }

    try {
      const result = await sendCommandToFigma(
        "find",
        {
          scope,
          componentId,
          variableId,
          styleId,
          text,
          name,
          type,
          annotation,
          hasAnnotation,
          excludeDefinitions,
          maxResults,
        },
        60000, // 60s timeout for large trees
      );

      const typedResult = result as {
        success: boolean;
        matchCount: number;
        groupCount: number;
        nodesSearched: number;
        truncated: boolean;
        scope: string;
        groups: Array<{
          name: string;
          id: string | null;
          type: string | null;
          matches: Array<{
            id: string;
            name: string;
            type: string;
            match: Record<string, unknown>;
            path: string[];
          }>;
        }>;
      };

      // Build criteria summary for meta
      const criteria: Record<string, unknown> = {};
      if (componentId) criteria.componentId = componentId;
      if (variableId) criteria.variableId = variableId;
      if (styleId) criteria.styleId = styleId;
      if (text) criteria.text = text;
      if (name) criteria.name = name;
      if (type) criteria.type = type;
      if (annotation) criteria.annotation = annotation;
      if (hasAnnotation) criteria.hasAnnotation = hasAnnotation;

      // Build YAML output
      const output = {
        meta: {
          scope: typedResult.scope,
          matchCount: typedResult.matchCount,
          groupCount: typedResult.groupCount,
          nodesSearched: typedResult.nodesSearched,
          truncated: typedResult.truncated || undefined,
          criteria,
        },
        groups: typedResult.groups,
      };

      const yamlText = serializeYaml(output);
      const guarded = guardOutput(yamlText, {
        maxChars: maxOutputChars,
        metaExtractor: extractYamlMeta,
        toolName: "find",
        narrowingHints: [
          "  • Lower maxResults",
          "  • Add more criteria to narrow matches",
          "  • Search a specific subtree instead of the whole page",
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
            text: `Error in find: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);
