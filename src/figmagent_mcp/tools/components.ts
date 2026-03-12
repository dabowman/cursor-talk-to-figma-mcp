import { z } from "zod";
import { server } from "../instance.js";
import { sendCommandToFigma } from "../connection.js";
import type { getInstanceOverridesResult, setInstanceOverridesResult } from "../types.js";

// Get Local Components Tool
server.tool(
  "get_local_components",
  "Get local components from the Figma document. Returns COMPONENT_SETs (multi-variant) and standalone COMPONENTs. Use nameFilter to search by component name (case-insensitive). COMPONENT_SET results include variantAxes showing the structure (e.g. Type × Size × State). Variants are listed when ≤10; for larger sets they are omitted — use includeVariants to force inclusion, or use get_component_variants on the set ID.",
  {
    nameFilter: z
      .string()
      .optional()
      .describe(
        "Filter components by name substring (case-insensitive). Matches COMPONENT_SET names and standalone COMPONENT names.",
      ),
    includeVariants: z
      .boolean()
      .optional()
      .describe("Force include full variant list even for large (>10) component sets. Default: false."),
  },
  async ({ nameFilter, includeVariants }: any) => {
    try {
      const result = await sendCommandToFigma("get_local_components");
      const allComponents = (result as any).components || [];
      let components = allComponents;
      if (nameFilter) {
        const filter = nameFilter.toLowerCase();
        components = allComponents.filter((c: any) => c.name.toLowerCase().includes(filter));
      }
      // Truncate variant lists for large component sets unless explicitly requested
      const VARIANT_THRESHOLD = 10;
      const processed = components.map((c: any) => {
        if (c.type !== "COMPONENT_SET" || !c.variants) return c;
        if (c.variants.length <= VARIANT_THRESHOLD || includeVariants) return c;
        return {
          ...c,
          variants: [],
          variantsOmitted: true,
          variantsOmittedHint: `${c.variantCount} variants omitted. Use includeVariants:true or get_component_variants to see them.`,
        };
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: processed.length, components: processed }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting local components: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Combine as Variants Tool
server.tool(
  "combine_as_variants",
  "Combine multiple COMPONENT nodes into a COMPONENT_SET (variant group). Each component's name should follow the variant format (e.g. 'Layout=Table', 'Layout=List'). Figma will parse the names into variant properties.",
  {
    componentIds: z.array(z.string()).min(1).describe("Array of COMPONENT node IDs to combine"),
    parentId: z.string().optional().describe("Optional parent node ID for the resulting COMPONENT_SET"),
  },
  async ({ componentIds, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("combine_as_variants", {
        componentIds,
        parentId,
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
            text: `Error combining as variants: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Component Properties Tool — batch add/edit/delete property definitions
server.tool(
  "component_properties",
  `Batch add, edit, and delete property definitions on a COMPONENT or COMPONENT_SET. Use get(nodeId, detail="layout") to discover existing property definitions first (componentPropertyDefinitions is included in FSGN output).

Operations:
  - add: Create a new property. Requires name, type (BOOLEAN/TEXT/INSTANCE_SWAP/VARIANT), defaultValue. Optional: preferredValues for INSTANCE_SWAP.
  - edit: Modify an existing property. Requires propertyName (full name with #suffix). Optional: newName, defaultValue, preferredValues.
  - delete: Remove a property. Requires propertyName (full name with #suffix).

Example — add two properties and rename one:
  { nodeId: "123:456", operations: [
    { action: "add", name: "Show Icon", type: "BOOLEAN", defaultValue: true },
    { action: "add", name: "Label", type: "TEXT", defaultValue: "Button" },
    { action: "edit", propertyName: "OldName#12:0", newName: "NewName" }
  ]}

Returns updated componentPropertyDefinitions after all operations.`,
  {
    nodeId: z.string().describe("The ID of the COMPONENT or COMPONENT_SET node"),
    operations: z
      .array(
        z.object({
          action: z.enum(["add", "edit", "delete"]).describe("Operation type"),
          // For add:
          name: z.string().optional().describe("Property name (for add)"),
          type: z
            .enum(["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT"])
            .optional()
            .describe("Property type (for add)"),
          defaultValue: z
            .union([z.string(), z.boolean()])
            .optional()
            .describe("Default value (for add/edit). Boolean for BOOLEAN, string for TEXT/VARIANT, node ID for INSTANCE_SWAP."),
          // For edit/delete:
          propertyName: z
            .string()
            .optional()
            .describe("Full property name including #suffix (for edit/delete)"),
          newName: z.string().optional().describe("New name for the property (for edit)"),
          preferredValues: z
            .array(
              z.object({
                type: z.enum(["COMPONENT", "COMPONENT_SET"]).describe("Value type"),
                key: z.string().describe("Component key"),
              }),
            )
            .optional()
            .describe("Preferred values for INSTANCE_SWAP properties (for add/edit)"),
        }),
      )
      .min(1)
      .describe("Array of property operations to execute in order"),
  },
  async ({ nodeId, operations }: any) => {
    try {
      const result = await sendCommandToFigma("component_properties", { nodeId, operations });
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
            text: `Error modifying component properties: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Copy Instance Overrides Tool
server.tool(
  "get_instance_overrides",
  "Get all override properties from a selected component instance. These overrides can be applied to other instances, which will swap them to match the source component.",
  {
    nodeId: z
      .string()
      .optional()
      .describe(
        "Optional ID of the component instance to get overrides from. If not provided, currently selected instance will be used.",
      ),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("get_instance_overrides", {
        instanceNodeId: nodeId || null,
      });
      const typedResult = result as getInstanceOverridesResult;

      return {
        content: [
          {
            type: "text",
            text: typedResult.success
              ? `Successfully got instance overrides: ${typedResult.message}`
              : `Failed to get instance overrides: ${typedResult.message}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error copying instance overrides: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Instance Overrides Tool
server.tool(
  "set_instance_overrides",
  "Apply previously copied overrides to selected component instances. Target instances will be swapped to the source component and all copied override properties will be applied.",
  {
    sourceInstanceId: z.string().describe("ID of the source component instance"),
    targetNodeIds: z
      .array(z.string())
      .min(1)
      .describe("Array of target instance IDs. Currently selected instances will be used."),
  },
  async ({ sourceInstanceId, targetNodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("set_instance_overrides", {
        sourceInstanceId: sourceInstanceId,
        targetNodeIds: targetNodeIds || [],
      });
      const typedResult = result as setInstanceOverridesResult;

      if (typedResult.success) {
        const successCount = typedResult.results?.filter((r) => r.success).length || 0;
        return {
          content: [
            {
              type: "text",
              text: `Successfully applied ${typedResult.totalCount || 0} overrides to ${successCount} instances.`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Failed to set instance overrides: ${typedResult.message}`,
            },
          ],
        };
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting instance overrides: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);
