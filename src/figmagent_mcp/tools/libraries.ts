import { z } from "zod";
import { server } from "../instance.js";
import { sendCommandToFigma } from "../connection.js";
import {
  getFileComponents,
  getFileComponentSets,
  getFileNodes,
  getFileVariables,
  type ComponentMetadata,
} from "../figma_rest_api.js";

// --- Helpers ---

function filterByQuery(items: ComponentMetadata[], query: string): ComponentMetadata[] {
  const q = query.toLowerCase();
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      (item.containing_frame?.name?.toLowerCase().includes(q) ?? false) ||
      (item.containing_frame?.pageName?.toLowerCase().includes(q) ?? false),
  );
}

function formatComponent(item: ComponentMetadata): string {
  const lines = [`  Name: ${item.name}`, `  Key: ${item.key}`];
  if (item.description) {
    lines.push(`  Description: ${item.description}`);
  }
  if (item.containing_frame?.pageName) {
    lines.push(`  Page: ${item.containing_frame.pageName}`);
  }
  if (item.containing_frame?.name) {
    lines.push(`  Frame: ${item.containing_frame.name}`);
  }
  return lines.join("\n");
}

function scoreMatch(item: ComponentMetadata, query: string): number {
  const q = query.toLowerCase();
  const name = item.name.toLowerCase();

  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  // Match on the last segment (e.g. "Button" in "Controls / Button")
  const lastSegment = name.split("/").pop()?.trim().toLowerCase() || "";
  if (lastSegment === q) return 90;
  if (lastSegment.startsWith(q)) return 70;
  if (name.includes(q)) return 50;
  if (item.description.toLowerCase().includes(q)) return 30;
  if (item.containing_frame?.name?.toLowerCase().includes(q)) return 20;
  if (item.containing_frame?.pageName?.toLowerCase().includes(q)) return 10;
  return 0;
}

// --- Tool 1: get_library_components ---

server.tool(
  "get_library_components",
  "Get published components and component sets from a Figma library file. Returns component names, published keys (needed for import), descriptions, and containing frame/page. Use this to discover what components are available in a design system library before importing them.",
  {
    fileKey: z
      .string()
      .describe(
        "The Figma file key of the library. Extract from a Figma URL: https://www.figma.com/design/<fileKey>/...",
      ),
    query: z
      .string()
      .optional()
      .describe(
        "Optional search filter. Case-insensitive match against component name, description, and containing frame name.",
      ),
    includeComponentSets: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "If true (default), also fetch component sets (variant groups). Set false to only get individual components.",
      ),
  },
  async ({ fileKey, query, includeComponentSets }: any) => {
    try {
      let components = await getFileComponents(fileKey);
      let componentSets: ComponentMetadata[] = [];

      if (includeComponentSets !== false) {
        componentSets = await getFileComponentSets(fileKey);
      }

      if (query) {
        components = filterByQuery(components, query);
        componentSets = filterByQuery(componentSets, query);
      }

      const parts: string[] = [];
      const queryNote = query ? ` matching "${query}"` : "";

      if (componentSets.length > 0) {
        parts.push(
          `COMPONENT SETS (${componentSets.length} variant groups${queryNote}):`,
          "NOTE: Component set keys CANNOT be imported directly. Use get_component_variants with the node_id to find individual variant keys first.\n",
        );
        for (const cs of componentSets) {
          parts.push(formatComponent(cs));
          parts.push(`  Node ID: ${cs.node_id}`);
          parts.push("  ---");
        }
      }

      if (components.length > 0) {
        parts.push(
          `\nINDIVIDUAL COMPONENTS (${components.length}${queryNote}):`,
          "These keys can be used directly with import_library_component.\n",
        );
        // Limit individual components to 50 to avoid huge responses
        const shown = components.slice(0, 50);
        parts.push(shown.map((c) => formatComponent(c)).join("\n  ---\n"));
        if (components.length > 50) {
          parts.push(`\n  ... and ${components.length - 50} more. Use search_library_components for targeted lookup.`);
        }
      }

      if (parts.length === 0) {
        parts.push(
          query
            ? `No components found matching "${query}" in file ${fileKey}.`
            : `No published components found in file ${fileKey}.`,
        );
      } else {
        parts.push(
          "\nWorkflow: For component sets, call get_component_variants(fileKey, node_id) to get individual variant keys, then import_library_component with a variant key.",
          "For individual components, use import_library_component directly with the key.",
        );
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting library components: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// --- Tool 2: search_library_components ---

server.tool(
  "search_library_components",
  "Search for a specific component in a Figma library by name. Returns matching components with their published keys. Faster than get_library_components for targeted lookups. Searches both component sets and individual component variants.",
  {
    fileKey: z.string().describe("The Figma file key of the library."),
    query: z.string().describe("Search term. Matches against component name, description, and containing frame."),
    limit: z.coerce.number().optional().default(10).describe("Maximum results to return. Default 10."),
  },
  async ({ fileKey, query, limit }: any) => {
    try {
      const [components, componentSets] = await Promise.all([
        getFileComponents(fileKey),
        getFileComponentSets(fileKey),
      ]);

      const maxResults = limit || 10;

      // Score and rank all items
      const scored = [
        ...componentSets.map((item) => ({
          item,
          score: scoreMatch(item, query),
          type: "component_set" as const,
        })),
        ...components.map((item) => ({
          item,
          score: scoreMatch(item, query),
          type: "component" as const,
        })),
      ]
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

      if (scored.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No components found matching "${query}" in file ${fileKey}.`,
            },
          ],
        };
      }

      const lines = [`Found ${scored.length} results for "${query}":\n`];

      for (const { item, type } of scored) {
        if (type === "component_set") {
          lines.push("[SET] (cannot import directly — use get_component_variants first)");
          lines.push(formatComponent(item));
          lines.push(`  Node ID: ${item.node_id}`);
        } else {
          lines.push("[COMPONENT] (can import directly)");
          lines.push(formatComponent(item));
        }
        lines.push("  ---");
      }

      lines.push(
        "\nFor [COMPONENT] results: use import_library_component directly with the key.",
        "For [SET] results: call get_component_variants(fileKey, node_id) first to get individual variant keys.",
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error searching library components: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// --- Tool 3: import_library_component ---

server.tool(
  "import_library_component",
  "Import a published component from a Figma library into the current file and create an instance. IMPORTANT: Only use individual component keys, NOT component set keys. For component sets (variant groups), first call get_component_variants to find the specific variant key you need, then import that. The instance is created at the specified position, or appended to a target parent node.",
  {
    componentKey: z
      .string()
      .describe(
        "The published key of an individual component (not a component set). Get variant keys from get_component_variants.",
      ),
    parentNodeId: z
      .string()
      .optional()
      .describe(
        "Optional. Node ID of the parent frame to insert the instance into. If omitted, the instance is added to the current page root.",
      ),
    position: z
      .object({
        x: z.number(),
        y: z.number(),
      })
      .optional()
      .describe("Optional. Position for the new instance."),
    name: z.string().optional().describe("Optional. Override the instance layer name."),
  },
  async ({ componentKey, parentNodeId, position, name }: any) => {
    try {
      const result = await sendCommandToFigma("import_library_component", {
        componentKey,
        parentNodeId,
        position,
        name,
      });
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
            text: `Error importing library component: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// --- Tool 4: get_component_variants ---

server.tool(
  "get_component_variants",
  "Get the available variants for a component set in a library. Returns variant property names, possible values, and the individual component keys for each variant combination. Use after finding a component set with get_library_components to understand what variants you can instantiate.",
  {
    fileKey: z.string().describe("The library file key."),
    componentSetNodeId: z.string().describe("The node_id of the component set (from get_library_components results)."),
  },
  async ({ fileKey, componentSetNodeId }: any) => {
    try {
      // Fetch the node tree and the full component list in parallel
      const [nodesData, allComponents] = await Promise.all([
        getFileNodes(fileKey, [componentSetNodeId]),
        getFileComponents(fileKey),
      ]);

      const nodeData = nodesData.nodes[componentSetNodeId];
      if (!nodeData) {
        return {
          content: [
            {
              type: "text",
              text: `Component set node "${componentSetNodeId}" not found in file ${fileKey}.`,
            },
          ],
        };
      }

      const doc = nodeData.document;
      const children: any[] = doc.children || [];

      // Build a map of node_id → published key from the components list
      const keyByNodeId = new Map<string, string>();
      for (const comp of allComponents) {
        keyByNodeId.set(comp.node_id, comp.key);
      }

      // Parse variant properties from child names
      // Names look like "Type=Primary, Size=Large, State=Default"
      const variantPropertyValues = new Map<string, Set<string>>();
      const variants: Array<{
        name: string;
        key: string | undefined;
        nodeId: string;
      }> = [];

      for (const child of children) {
        if (child.type !== "COMPONENT") continue;

        const name: string = child.name || "";
        const key = keyByNodeId.get(child.id);

        variants.push({ name, key, nodeId: child.id });

        // Parse "Prop=Value, Prop2=Value2" format
        const pairs = name.split(",").map((s: string) => s.trim());
        for (const pair of pairs) {
          const eqIdx = pair.indexOf("=");
          if (eqIdx === -1) continue;
          const propName = pair.substring(0, eqIdx).trim();
          const propValue = pair.substring(eqIdx + 1).trim();
          if (!variantPropertyValues.has(propName)) {
            variantPropertyValues.set(propName, new Set());
          }
          variantPropertyValues.get(propName)!.add(propValue);
        }
      }

      // Format output
      const lines = [`Component Set: ${doc.name}\n`];

      if (variantPropertyValues.size > 0) {
        lines.push("Variant Properties:");
        for (const [prop, values] of variantPropertyValues) {
          lines.push(`  ${prop}: ${[...values].join(", ")}`);
        }
      }

      lines.push(`\nVariants (${variants.length} total):`);
      const shown = variants.slice(0, 20);
      for (const v of shown) {
        const keyStr = v.key || "(key not published)";
        lines.push(`  ${v.name} → key: ${keyStr}`);
      }
      if (variants.length > 20) {
        lines.push(`  ... and ${variants.length - 20} more variants`);
      }

      lines.push(
        "\nUse import_library_component with an individual variant key, or use the component set key with variantProperties.",
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting component variants: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// --- Tool 5: get_library_variables ---

server.tool(
  "get_library_variables",
  "Get published design token variables from a Figma library file via REST API. Returns variable collections, modes, and variable names/types. Use this to understand what design tokens are available for styling when building with library components.",
  {
    fileKey: z.string().describe("The Figma file key of the library."),
    collectionName: z
      .string()
      .optional()
      .describe("Optional. Filter to a specific collection by name (e.g., 'Color', 'Spacing')."),
    format: z
      .enum(["summary", "full"])
      .optional()
      .default("summary")
      .describe(
        "summary (default): collection names, variable counts, and modes. full: all variable names, types, and values.",
      ),
  },
  async ({ fileKey, collectionName, format }: any) => {
    try {
      const data = await getFileVariables(fileKey);
      const collections = Object.values(data.meta.variableCollections);
      const variables = data.meta.variables;

      let filteredCollections = collections;
      if (collectionName) {
        const q = collectionName.toLowerCase();
        filteredCollections = collections.filter((c) => c.name.toLowerCase().includes(q));
      }

      if (filteredCollections.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: collectionName
                ? `No variable collections matching "${collectionName}" found in file ${fileKey}.`
                : `No variable collections found in file ${fileKey}.`,
            },
          ],
        };
      }

      const lines: string[] = [];

      for (const collection of filteredCollections) {
        const modeNames = collection.modes.map((m) => m.name).join(", ");
        const collVars = collection.variableIds.map((id) => variables[id]).filter(Boolean);

        lines.push(`Collection: ${collection.name}`);
        lines.push(`  Modes: ${modeNames}`);
        lines.push(`  Variables: ${collVars.length}`);

        if (format === "full") {
          lines.push("");
          for (const v of collVars) {
            lines.push(`  ${v.name} (${v.resolvedType})`);
            if (v.description) {
              lines.push(`    Description: ${v.description}`);
            }
            // Show values per mode
            for (const mode of collection.modes) {
              const val = v.valuesByMode[mode.modeId];
              if (val !== undefined) {
                lines.push(`    ${mode.name}: ${JSON.stringify(val)}`);
              }
            }
          }
        }

        lines.push("---");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      // Provide helpful guidance for Enterprise-only endpoints
      if (errMsg.includes("403")) {
        return {
          content: [
            {
              type: "text",
              text:
                `Error accessing variables API: ${errMsg}\n\n` +
                `The variables REST API endpoint requires a Figma Enterprise plan. ` +
                `As an alternative, you can use the Plugin API's getAvailableLibraryVariableCollectionsAsync ` +
                `through the existing MCP tools when the plugin is connected to the library file.`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Error getting library variables: ${errMsg}`,
          },
        ],
      };
    }
  },
);
