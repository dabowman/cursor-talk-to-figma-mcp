import { z } from "zod";
import { server } from "../instance.js";
import { sendCommandToFigma } from "../connection.js";
import type { getInstanceOverridesResult, setInstanceOverridesResult } from "../types.js";

// Get Styles Tool
server.tool("get_styles", "Get all styles from the current Figma document", {}, async () => {
  try {
    const result = await sendCommandToFigma("get_styles");
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
          text: `Error getting styles: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
});

// Get Local Variables Tool
server.tool(
  "get_local_variables",
  "Get all local design token variables from the Figma document. Returns variable collections with their modes and all variables (colors, numbers, strings, booleans). Works on any Figma plan — no Enterprise required.",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_local_variables");
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
            text: `Error getting local variables: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Get Local Components Tool
server.tool(
  "get_local_components",
  "Get local components from the Figma document. Use nameFilter to search by name substring (case-insensitive) and reduce response size.",
  {
    nameFilter: z.string().optional().describe("Filter components by name substring (case-insensitive)"),
  },
  async ({ nameFilter }: any) => {
    try {
      const result = await sendCommandToFigma("get_local_components");
      const allComponents = (result as any).components || [];
      let components = allComponents;
      if (nameFilter) {
        const filter = nameFilter.toLowerCase();
        components = allComponents.filter((c: any) => c.name.toLowerCase().includes(filter));
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: components.length, components }),
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

// Get Annotations Tool
server.tool(
  "get_annotations",
  "Get all annotations in the current document or specific node",
  {
    nodeId: z.string().describe("node ID to get annotations for specific node"),
    includeCategories: z.boolean().optional().default(true).describe("Whether to include category information"),
  },
  async ({ nodeId, includeCategories }: any) => {
    try {
      const result = await sendCommandToFigma("get_annotations", {
        nodeId,
        includeCategories,
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
            text: `Error getting annotations: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Annotation Tool
server.tool(
  "set_annotation",
  "Create or update an annotation",
  {
    nodeId: z.string().describe("The ID of the node to annotate"),
    annotationId: z
      .string()
      .optional()
      .describe("The ID of the annotation to update (if updating existing annotation)"),
    labelMarkdown: z.string().describe("The annotation text in markdown format"),
    categoryId: z.string().optional().describe("The ID of the annotation category"),
    properties: z
      .array(
        z.object({
          type: z.string(),
        }),
      )
      .optional()
      .describe("Additional properties for the annotation"),
  },
  async ({ nodeId, annotationId, labelMarkdown, categoryId, properties }: any) => {
    try {
      const result = await sendCommandToFigma("set_annotation", {
        nodeId,
        annotationId,
        labelMarkdown,
        categoryId,
        properties,
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
            text: `Error setting annotation: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Multiple Annotations Tool
server.tool(
  "set_multiple_annotations",
  "Set multiple annotations parallelly in a node",
  {
    nodeId: z.string().describe("The ID of the node containing the elements to annotate"),
    annotations: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the node to annotate"),
          labelMarkdown: z.string().describe("The annotation text in markdown format"),
          categoryId: z.string().optional().describe("The ID of the annotation category"),
          annotationId: z
            .string()
            .optional()
            .describe("The ID of the annotation to update (if updating existing annotation)"),
          properties: z
            .array(
              z.object({
                type: z.string(),
              }),
            )
            .optional()
            .describe("Additional properties for the annotation"),
        }),
      )
      .min(1)
      .describe("Array of annotations to apply"),
  },
  async ({ nodeId, annotations }: any) => {
    try {
      if (!annotations || annotations.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No annotations provided",
            },
          ],
        };
      }

      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting annotation process for ${annotations.length} nodes. This will be processed in batches of 5...`,
      };

      // Track overall progress
      const totalToProcess = annotations.length;

      // Use the plugin's set_multiple_annotations function with chunking
      const result = await sendCommandToFigma("set_multiple_annotations", {
        nodeId,
        annotations,
      });

      // Cast the result to a specific type to work with it safely
      interface AnnotationResult {
        success: boolean;
        nodeId: string;
        annotationsApplied?: number;
        annotationsFailed?: number;
        totalAnnotations?: number;
        completedInChunks?: number;
        results?: Array<{
          success: boolean;
          nodeId: string;
          error?: string;
          annotationId?: string;
        }>;
      }

      const typedResult = result as AnnotationResult;

      // Format the results for display
      const progressText = `
      Annotation process completed:
      - ${typedResult.annotationsApplied || 0} of ${totalToProcess} successfully applied
      - ${typedResult.annotationsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;

      // Detailed results
      const detailedResults = typedResult.results || [];
      const failedResults = detailedResults.filter((item) => !item.success);

      // Create the detailed part of the response
      let detailedResponse = "";
      if (failedResults.length > 0) {
        detailedResponse = `\n\nNodes that failed:\n${failedResults
          .map((item) => `- ${item.nodeId}: ${item.error || "Unknown error"}`)
          .join("\n")}`;
      }

      return {
        content: [
          initialStatus,
          {
            type: "text" as const,
            text: progressText + detailedResponse,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting multiple annotations: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Create Component Tool
server.tool(
  "create_component",
  "Create a new COMPONENT node in Figma. Use this to build variant components that can later be combined into a COMPONENT_SET with combine_as_variants.",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().positive().optional().describe("Width (default 100)"),
    height: z.number().positive().optional().describe("Height (default 100)"),
    name: z.string().optional().describe("Component name (e.g. 'Layout=Table')"),
    parentId: z.string().optional().describe("Optional parent node ID"),
  },
  async ({ x, y, width, height, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_component", {
        x,
        y,
        width,
        height,
        name,
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
            text: `Error creating component: ${error instanceof Error ? error.message : String(error)}`,
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

// Create Component Instance Tool
server.tool(
  "create_component_instance",
  "Create an instance of a component in Figma. Use componentId for local/unpublished components (node ID), or componentKey for published library components (hash key).",
  {
    componentKey: z
      .string()
      .optional()
      .describe("Key of a published component to instantiate (use for library components)"),
    componentId: z
      .string()
      .optional()
      .describe("Node ID of a local COMPONENT to instantiate (use for unpublished components)"),
    x: z.number().optional().describe("X position (default 0)"),
    y: z.number().optional().describe("Y position (default 0)"),
    parentId: z.string().optional().describe("Optional parent node ID to place the instance into"),
  },
  async ({ componentKey, componentId, x, y, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_component_instance", {
        componentKey,
        componentId,
        x,
        y,
        parentId,
      });
      const typedResult = result as any;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(typedResult),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating component instance: ${error instanceof Error ? error.message : String(error)}`,
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

// Swap Component Variant Tool
server.tool(
  "swap_component_variant",
  "Swap an instance to a different variant within the same component set (e.g. change 'Bulk selection=False' to 'Bulk selection=True'). The instance keeps its position and overrides where compatible. newVariantId must be a COMPONENT node inside the same COMPONENT_SET.",
  {
    instanceId: z.string().describe("ID of the instance node to update"),
    newVariantId: z.string().describe("ID of the target COMPONENT variant to swap to"),
  },
  async ({ instanceId, newVariantId }: any) => {
    try {
      const result = await sendCommandToFigma("swap_component_variant", {
        instanceId,
        newVariantId,
      });
      const typedResult = result as any;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(typedResult),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error swapping component variant: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Get Component Properties Tool
server.tool(
  "get_component_properties",
  "Get all property definitions from a COMPONENT or COMPONENT_SET. Returns property names (with #suffix for non-variant properties), types (BOOLEAN, TEXT, INSTANCE_SWAP, VARIANT), default values, variant options, and preferred values. Essential for discovering property names before mutation.",
  {
    nodeId: z.string().describe("The ID of the COMPONENT or COMPONENT_SET node"),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("get_component_properties", { nodeId });
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
            text: `Error getting component properties: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Add Component Property Tool
server.tool(
  "add_component_property",
  "Add a new property to a COMPONENT or COMPONENT_SET. Supports BOOLEAN (toggle layer visibility), TEXT (editable text), INSTANCE_SWAP (nested instance swap with optional preferred values), and VARIANT (variant dimension on component sets). Returns the full property name with auto-generated #suffix.",
  {
    nodeId: z.string().describe("The ID of the COMPONENT or COMPONENT_SET node"),
    name: z.string().describe("Property name (e.g. 'Show Icon', 'Label', 'Size')"),
    type: z
      .enum(["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT"])
      .describe("Property type"),
    defaultValue: z
      .union([z.string(), z.boolean()])
      .describe(
        "Default value. Boolean for BOOLEAN type, string for TEXT/VARIANT, node ID for INSTANCE_SWAP.",
      ),
    preferredValues: z
      .array(
        z.object({
          type: z.enum(["COMPONENT", "COMPONENT_SET"]).describe("Value type"),
          key: z.string().describe("Component key"),
        }),
      )
      .optional()
      .describe("Preferred values for INSTANCE_SWAP properties (curated shortlist in picker)"),
  },
  async ({ nodeId, name, type, defaultValue, preferredValues }: any) => {
    try {
      const result = await sendCommandToFigma("add_component_property", {
        nodeId,
        name,
        type,
        defaultValue,
        preferredValues,
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
            text: `Error adding component property: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Edit Component Property Tool
server.tool(
  "edit_component_property",
  "Edit an existing property definition on a COMPONENT or COMPONENT_SET. Can rename, change default value, or update preferred values. Use get_component_properties first to discover the full property name (with #suffix).",
  {
    nodeId: z.string().describe("The ID of the COMPONENT or COMPONENT_SET node"),
    propertyName: z
      .string()
      .describe("Full property name including #suffix (e.g. 'Label#12:0')"),
    newName: z.string().optional().describe("New name for the property"),
    defaultValue: z
      .union([z.string(), z.boolean()])
      .optional()
      .describe("New default value"),
    preferredValues: z
      .array(
        z.object({
          type: z.enum(["COMPONENT", "COMPONENT_SET"]).describe("Value type"),
          key: z.string().describe("Component key"),
        }),
      )
      .optional()
      .describe("New preferred values for INSTANCE_SWAP properties"),
  },
  async ({ nodeId, propertyName, newName, defaultValue, preferredValues }: any) => {
    try {
      const result = await sendCommandToFigma("edit_component_property", {
        nodeId,
        propertyName,
        newName,
        defaultValue,
        preferredValues,
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
            text: `Error editing component property: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Delete Component Property Tool
server.tool(
  "delete_component_property",
  "Delete a property from a COMPONENT or COMPONENT_SET. Use get_component_properties first to discover the full property name (with #suffix).",
  {
    nodeId: z.string().describe("The ID of the COMPONENT or COMPONENT_SET node"),
    propertyName: z
      .string()
      .describe("Full property name including #suffix (e.g. 'Label#12:0')"),
  },
  async ({ nodeId, propertyName }: any) => {
    try {
      const result = await sendCommandToFigma("delete_component_property", {
        nodeId,
        propertyName,
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
            text: `Error deleting component property: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Exposed Instance (Slot) Tool
server.tool(
  "set_exposed_instance",
  "Set isExposedInstance on a nested INSTANCE inside a COMPONENT, creating or removing a slot. When exposed, instance users can freely add/rearrange layers in that area (like React children/slot pattern).",
  {
    nodeId: z.string().describe("The ID of the INSTANCE node inside a component"),
    exposed: z.boolean().describe("Whether to expose this instance as a slot"),
  },
  async ({ nodeId, exposed }: any) => {
    try {
      const result = await sendCommandToFigma("set_exposed_instance", {
        nodeId,
        exposed,
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
            text: `Error setting exposed instance: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Bind Variable Tool
server.tool(
  "bind_variable",
  "Bind a design token variable to a node property. Use get_local_variables first to find variable IDs. Supports binding color variables to fills/strokes, and number/boolean/string variables to properties like corner radius, padding, spacing, dimensions, opacity, and visibility.",
  {
    nodeId: z.string().describe("The ID of the node to bind the variable to"),
    field: z
      .enum([
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
      ])
      .describe("The property to bind the variable to"),
    variableId: z.string().describe("The ID of the variable to bind (from get_local_variables)"),
  },
  async ({ nodeId, field, variableId }: any) => {
    try {
      const result = await sendCommandToFigma("bind_variable", {
        nodeId,
        field,
        variableId,
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
            text: `Error binding variable: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Batch Bind Variables Tool
server.tool(
  "batch_bind_variables",
  "Bind multiple design token variables to node properties in a single call. Much more efficient than calling bind_variable repeatedly. Use get_local_variables first to find variable IDs.",
  {
    bindings: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the node"),
          field: z
            .enum([
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
            ])
            .describe("The property to bind"),
          variableId: z.string().describe("The variable ID to bind"),
        }),
      )
      .min(1)
      .describe("Array of variable bindings to apply"),
  },
  async ({ bindings }: any) => {
    try {
      const result = await sendCommandToFigma("batch_bind_variables", { bindings }, 60000);
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
            text: `Error batch binding variables: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Text Style Tool
server.tool(
  "set_text_style",
  "Apply a text style to a text node. Use get_styles first to find text style IDs. This sets the full text style (font family, size, weight, line height, letter spacing, etc.) in one call.",
  {
    nodeId: z.string().describe("The ID of the text node"),
    styleId: z.string().describe("The ID of the text style to apply (from get_styles)"),
  },
  async ({ nodeId, styleId }: any) => {
    try {
      const result = await sendCommandToFigma("set_text_style", {
        nodeId,
        styleId,
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
            text: `Error setting text style: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Batch Set Text Styles Tool
server.tool(
  "batch_set_text_styles",
  "Apply text styles to multiple text nodes in a single call. Much more efficient than calling set_text_style repeatedly. Deduplicates font loading across all nodes. Use get_styles first to find style IDs.",
  {
    assignments: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the text node"),
          styleId: z.string().describe("The text style ID to apply"),
        }),
      )
      .min(1)
      .describe("Array of text style assignments"),
  },
  async ({ assignments }: any) => {
    try {
      const result = await sendCommandToFigma("batch_set_text_styles", { assignments }, 60000);
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
            text: `Error batch setting text styles: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Get Main Component Tool
server.tool(
  "get_main_component",
  "Get the main component of an instance node. Use this to find the source component when you have an instance, preventing instance-vs-component confusion.",
  {
    nodeId: z.string().describe("The ID of the instance node"),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("get_main_component", { nodeId });
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
            text: `Error getting main component: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);
