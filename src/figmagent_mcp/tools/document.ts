import { z } from "zod";
import { server } from "../instance.js";
import { sendCommandToFigma } from "../connection.js";
import { serializeYaml } from "../yaml.js";

// ─── FSGN helpers ────────────────────────────────────────────────────────────

function replaceRefStr(
  str: string,
  varMap: Map<string, string>,
  styleMap: Map<string, string>,
  compMap: Map<string, string>,
): string {
  if (str.startsWith("VAR::")) return varMap.get(str.slice(5)) ?? str;
  if (str.startsWith("STYLE::")) return styleMap.get(str.slice(7)) ?? str;
  if (str.startsWith("COMP::")) return compMap.get(str.slice(6)) ?? str;
  return str;
}

function replaceRefs(
  obj: unknown,
  varMap: Map<string, string>,
  styleMap: Map<string, string>,
  compMap: Map<string, string>,
): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === "string") {
        obj[i] = replaceRefStr(obj[i] as string, varMap, styleMap, compMap);
      } else {
        replaceRefs(obj[i], varMap, styleMap, compMap);
      }
    }
  } else {
    const rec = obj as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (typeof rec[key] === "string") {
        rec[key] = replaceRefStr(rec[key] as string, varMap, styleMap, compMap);
      } else {
        replaceRefs(rec[key], varMap, styleMap, compMap);
      }
    }
  }
}

function buildFsgn(raw: any, params: any): string {
  const detail: string = params.detail ?? "layout";
  const depth: number | undefined = params.depth;

  const varMap = new Map<string, string>();
  const styleMap = new Map<string, string>();
  const compMap = new Map<string, string>();
  let vi = 1,
    si = 1,
    ci = 1;

  const defs: Record<string, Record<string, unknown>> = { vars: {}, styles: {}, components: {} };

  for (const [id, info] of Object.entries(raw.collectedVars ?? {})) {
    const ref = `v${vi++}`;
    varMap.set(id, ref);
    defs.vars[ref] = info as Record<string, unknown>;
  }
  for (const [id, info] of Object.entries(raw.collectedStyles ?? {})) {
    const ref = `s${si++}`;
    styleMap.set(id, ref);
    defs.styles[ref] = info as Record<string, unknown>;
  }
  for (const [id, info] of Object.entries(raw.collectedComponents ?? {})) {
    const ref = `c${ci++}`;
    compMap.set(id, ref);
    defs.components[ref] = info as Record<string, unknown>;
  }

  // Deep-clone rawTree before mutating refs
  const treeClone = JSON.parse(JSON.stringify(raw.rawTree ?? []));
  replaceRefs(treeClone, varMap, styleMap, compMap);

  const nodeCount: number = raw.nodeCount ?? 0;
  const defCount = vi - 1 + (si - 1) + (ci - 1);
  const tokenMultiplier = detail === "structure" ? 5 : detail === "full" ? 30 : 15;
  const tokenEstimate = nodeCount * tokenMultiplier + defCount * 10;
  const truncated = tokenEstimate > 8000;

  const meta: Record<string, unknown> = {
    nodeId: raw.rootId,
    name: raw.rootName,
    type: raw.rootType,
    detail,
    nodeCount,
    tokenEstimate,
  };
  if (depth !== undefined) meta.depth = depth;
  if (truncated) {
    meta.truncated = true;
    meta.truncationWarning =
      "Response exceeds 8000 token estimate. Consider narrowing with depth, filter, or detail=structure.";
  }
  if (raw.variantAxes && Object.keys(raw.variantAxes).length > 0) {
    meta.variantAxes = raw.variantAxes;
    if (raw.defaultVariant) meta.defaultVariant = raw.defaultVariant;
  }

  return serializeYaml({ meta, defs, nodes: treeClone });
}

// ─── Tools ───────────────────────────────────────────────────────────────────

// Document Info Tool
server.tool("get_document_info", "Get detailed information about the current Figma document", {}, async () => {
  try {
    const result = await sendCommandToFigma("get_document_info");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error getting document info: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
});

// Selection Tool
server.tool("get_selection", "Get information about the current selection in Figma", {}, async () => {
  try {
    const result = await sendCommandToFigma("get_selection");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error getting selection: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
});

// Get Tool — read nodes and their subtrees
server.tool(
  "get",
  `Read one or more Figma nodes and their subtrees. Returns structured YAML (FSGN format) with deduplicated variable, style, and component definitions.

Use detail levels strategically:
  - "structure": IDs, names, types, child counts only (~5 tokens/node). Use first for orientation.
  - "layout": + dimensions, auto-layout, text content, componentRef/properties (~15 tokens/node). Use for building.
  - "full": + fills, strokes, variable bindings, text styles (~30 tokens/node). Use for styling.

Pass a single nodeId for one node, or nodeIds for multiple nodes (returns one FSGN block per node, separated by "---").
Start with depth=3 for component internals. For large responses (tokenEstimate >8000), narrow with depth or filter.
Instances are shown as leaf nodes by default — call get on the instance ID to expand its internals.`,
  {
    nodeId: z.string().optional().describe("ID of a single node to read"),
    nodeIds: z.array(z.string()).optional().describe("IDs of multiple nodes to read in parallel"),
    detail: z
      .enum(["structure", "layout", "full"])
      .optional()
      .describe(
        'Detail level. "structure": id/name/type/childCount only. "layout": + dimensions, auto-layout, text, component refs. "full": + fills, strokes, variable bindings, text styles. Default: "layout"',
      ),
    depth: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Max traversal depth. Omit for unlimited (instances treated as leaf nodes). depth=0: root only. depth=1: root + children. depth=3 recommended for component internals.",
      ),
    filter: z
      .object({
        types: z
          .array(z.string())
          .optional()
          .describe(
            'Whitelist of node types to include (e.g. ["FRAME","TEXT"]). Container nodes are always traversed; non-matching nodes are excluded from output.',
          ),
        namePattern: z
          .string()
          .optional()
          .describe(
            "Regex matched against node name. Non-matching nodes excluded from output, containers still traversed.",
          ),
        visibleOnly: z.boolean().optional().describe("Skip invisible nodes. Default: true"),
      })
      .optional(),
    includeVariables: z
      .boolean()
      .optional()
      .describe("Resolve bound variable names and collections in defs.vars. Default: true"),
    includeStyles: z.boolean().optional().describe("Resolve named text/effect style IDs in defs.styles. Default: true"),
    includeComponentMeta: z
      .boolean()
      .optional()
      .describe("Include component key, parent info for instances in defs.components. Default: true"),
  },
  async (params: any) => {
    try {
      // Collect all node IDs from nodeId and/or nodeIds
      const ids: string[] = [];
      if (params.nodeId) ids.push(params.nodeId);
      if (params.nodeIds) ids.push(...params.nodeIds);

      if (ids.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: provide either nodeId or nodeIds",
            },
          ],
        };
      }

      // Fetch all nodes in parallel, each via the plugin's get_node_tree command
      const results = await Promise.all(
        ids.map((id) =>
          sendCommandToFigma("get_node_tree", { ...params, nodeId: id, nodeIds: undefined }, 60000),
        ),
      );

      // Build FSGN for each result
      const yamls = results.map((result) => buildFsgn(result, params));
      const output = yamls.length === 1 ? yamls[0] : yamls.join("\n---\n");

      // Guard against responses that would overflow the MCP transport layer
      const MAX_CHARS = 100_000;
      if (output.length > MAX_CHARS) {
        // Extract meta section to give the agent useful context
        const metaMatch = output.match(/^meta:[\s\S]*?(?=\ndefs:|$)/m);
        const metaSnippet = metaMatch ? metaMatch[0].trim() : "";
        return {
          content: [
            {
              type: "text",
              text: [
                `Response too large (${output.length.toLocaleString()} chars). Narrow the query and retry:`,
                `  • Lower depth — try depth=1 or depth=2`,
                `  • Use detail="structure" (cheapest, ~5 tokens/node)`,
                `  • Target a specific child node instead of the whole section`,
                `  • Use find() to locate the nodes you need first`,
                metaSnippet ? `\nMeta from the attempted query:\n${metaSnippet}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: output,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error reading nodes: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);
