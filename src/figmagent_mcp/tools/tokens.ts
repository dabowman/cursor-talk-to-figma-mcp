import { z } from "zod";
import { server } from "../instance.js";
import { sendCommandToFigma } from "../connection.js";
import { guardOutput, extractJsonSummary } from "../utils.js";

// Get Design System Tool — unified styles + variables discovery
server.tool(
  "get_design_system",
  `Get all styles and design token variables from the current Figma document in one call.

Returns:
- styles: { colors (paint styles), texts (text styles with font info), effects, grids }
- variables: array of collections, each with modes and variables (id, name, type, values per mode)

Use this to discover the design system before applying styles/tokens with the apply tool.
Works on any Figma plan — no Enterprise required.`,
  {
    maxOutputChars: z
      .number()
      .int()
      .min(1000)
      .optional()
      .describe("Max response size in characters. Default: 30000. Raise for large design systems."),
  },
  async (params: { maxOutputChars?: number }) => {
    try {
      const result = await sendCommandToFigma("get_design_system");
      const jsonText = JSON.stringify(result);
      const guarded = guardOutput(jsonText, {
        maxChars: params.maxOutputChars,
        metaExtractor: extractJsonSummary,
        toolName: "get_design_system",
        narrowingHints: [
          "  • This file has a large design system",
          "  • Use find() to locate specific tokens by name or usage",
        ],
      });
      return {
        content: [
          {
            type: "text",
            text: guarded.text,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting design system: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Create Variables Tool — create collections, modes, and variables with values
server.tool(
  "create_variables",
  `Create design token variables in the current Figma document.

Creates a variable collection (or uses an existing one by name/ID), sets up modes, and creates variables with initial values per mode.

Create a color palette:
  { collectionName: "Colors", modes: ["Light", "Dark"], variables: [
    { name: "primary/500", type: "COLOR", values: { "Light": { r: 0.2, g: 0.4, b: 0.9, a: 1 }, "Dark": { r: 0.4, g: 0.6, b: 1, a: 1 } } },
    { name: "primary/100", type: "COLOR", values: { "Light": { r: 0.9, g: 0.95, b: 1, a: 1 }, "Dark": { r: 0.1, g: 0.15, b: 0.3, a: 1 } } }
  ]}

Create a spacing scale:
  { collectionName: "Spacing", variables: [
    { name: "spacing/xs", type: "FLOAT", values: { "Mode 1": 4 } },
    { name: "spacing/sm", type: "FLOAT", values: { "Mode 1": 8 } },
    { name: "spacing/md", type: "FLOAT", values: { "Mode 1": 16 } }
  ]}

Add variables to an existing collection:
  { collectionId: "VariableCollectionId:abc", variables: [
    { name: "new-token", type: "FLOAT", values: { "Default": 24 } }
  ]}

Alias one variable to another:
  { collectionName: "Semantic", modes: ["Light", "Dark"], variables: [
    { name: "bg/primary", type: "COLOR", values: { "Light": { alias: "VariableID:abc" }, "Dark": { alias: "VariableID:def" } } }
  ]}

Variable types: COLOR (rgba object), FLOAT (number), STRING (text), BOOLEAN (true/false).
If modes is omitted for a new collection, Figma creates a default "Mode 1".
If modes is provided, existing modes are renamed and new ones added as needed.
Scopes are validated before creation — invalid scopes return an error without creating the variable.
Duplicate variable names in the same collection are skipped with an error suggesting update_variables instead.`,
  {
    collectionName: z
      .string()
      .optional()
      .describe("Name of the collection to create or find. Creates new if not found."),
    collectionId: z.string().optional().describe("ID of an existing collection. Takes precedence over collectionName."),
    modes: z
      .array(z.string())
      .optional()
      .describe(
        "Mode names for the collection. For new collections, renames the default mode and adds extras. For existing collections, renames/adds as needed.",
      ),
    variables: z
      .array(
        z.object({
          name: z.string().describe("Variable name (use / for grouping, e.g. 'color/primary/500')"),
          type: z
            .enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"])
            .describe("Variable type. COLOR = rgba, FLOAT = number, STRING = text, BOOLEAN = true/false"),
          description: z.string().optional().describe("Variable description"),
          scopes: z
            .array(z.string())
            .optional()
            .describe(
              "Variable scopes — controls where the variable appears in the Figma UI picker. " +
                "COLOR: ALL_FILLS, FRAME_FILL, SHAPE_FILL, TEXT_FILL, STROKE_COLOR, EFFECT_COLOR. " +
                "FLOAT: CORNER_RADIUS, WIDTH_HEIGHT, GAP, OPACITY, STROKE_FLOAT, EFFECT_FLOAT, FONT_SIZE, FONT_WEIGHT, LINE_HEIGHT, LETTER_SPACING, PARAGRAPH_SPACING, PARAGRAPH_INDENT. " +
                "STRING: TEXT_CONTENT, FONT_FAMILY, FONT_STYLE. " +
                "ALL_SCOPES can be used for any type (cannot combine with other scopes).",
            ),
          values: z
            .record(z.string(), z.any())
            .describe(
              "Values per mode name. COLOR: { r, g, b, a } object. FLOAT: number. STRING: text. BOOLEAN: true/false. Alias: { alias: 'VariableID:xxx' }.",
            ),
        }),
      )
      .min(1)
      .describe("Array of variables to create with their initial values per mode"),
  },
  async ({ collectionName, collectionId, modes, variables }: any) => {
    try {
      const result = await sendCommandToFigma(
        "create_variables",
        { collectionName, collectionId, modes, variables },
        60000,
      );
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
            text: `Error creating variables: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Update Variables Tool — modify values, rename, or delete existing variables
server.tool(
  "update_variables",
  `Update, rename, or delete existing design token variables.

Update variable values (uses mode names, not IDs):
  { updates: [
    { variableId: "VariableID:abc", values: { "Light": { r: 1, g: 0, b: 0, a: 1 }, "Dark": { r: 0.8, g: 0, b: 0, a: 1 } } }
  ]}

Rename a variable:
  { updates: [{ variableId: "VariableID:abc", name: "color/danger/500" }] }

Delete variables:
  { updates: [
    { variableId: "VariableID:abc", delete: true },
    { variableId: "VariableID:def", delete: true }
  ]}

Set alias references:
  { updates: [
    { variableId: "VariableID:abc", values: { "Light": { alias: "VariableID:xyz" } } }
  ]}

Multiple operations in one call:
  { updates: [
    { variableId: "VariableID:1", values: { "Default": 24 } },
    { variableId: "VariableID:2", name: "spacing/lg" },
    { variableId: "VariableID:3", delete: true }
  ]}`,
  {
    updates: z
      .array(
        z.object({
          variableId: z.string().describe("ID of the variable to update or delete"),
          name: z.string().optional().describe("New name for the variable"),
          description: z.string().optional().describe("New description"),
          scopes: z.array(z.string()).optional().describe("New scopes array"),
          values: z
            .record(z.string(), z.any())
            .optional()
            .describe("New values per mode name. Same format as create_variables."),
          delete: z.boolean().optional().describe("Set true to delete this variable"),
        }),
      )
      .min(1)
      .describe("Array of variable update operations"),
  },
  async ({ updates }: any) => {
    try {
      const result = await sendCommandToFigma("update_variables", { updates }, 60000);
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
            text: `Error updating variables: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Create Styles Tool — create paint, text, effect, and grid styles in batch
server.tool(
  "create_styles",
  `Create local styles in the current Figma document.

Supports four style types: PAINT (colors/gradients), TEXT (typography), EFFECT (shadows/blurs), GRID (layout grids).

Create paint styles:
  { styles: [
    { type: "PAINT", name: "Brand/Primary", color: { r: 0.2, g: 0.4, b: 0.9, a: 1 } },
    { type: "PAINT", name: "Brand/Gradient", paints: [{ type: "GRADIENT_LINEAR", gradientStops: [...], gradientTransform: [...] }] }
  ]}

Create text styles:
  { styles: [
    { type: "TEXT", name: "Heading/H1", fontFamily: "Inter", fontStyle: "Bold", fontSize: 32, lineHeight: 40, letterSpacing: -0.5 },
    { type: "TEXT", name: "Body/Regular", fontFamily: "Inter", fontStyle: "Regular", fontSize: 16, lineHeight: { value: 150, unit: "PERCENT" } }
  ]}

Create effect styles:
  { styles: [
    { type: "EFFECT", name: "Elevation/200", effects: [
      { type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.15 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0, visible: true, blendMode: "NORMAL" }
    ]}
  ]}

Create grid styles:
  { styles: [
    { type: "GRID", name: "Grid/12Column", grids: [
      { pattern: "COLUMNS", count: 12, gutterSize: 16, offset: 0, alignment: "STRETCH" }
    ]}
  ]}

Bind variables to style properties:
  { styles: [
    { type: "TEXT", name: "Body/MD", fontFamily: "Inter", fontStyle: "Regular", fontSize: 16, lineHeight: 24,
      variables: { fontSize: "VariableID:abc", lineHeight: "VariableID:def" } },
    { type: "PAINT", name: "Brand/Primary", color: { r: 0.2, g: 0.4, b: 0.9, a: 1 },
      variables: { color: "VariableID:ghi" } }
  ]}

Notes:
- PAINT styles accept either a 'color' object (solid color shorthand) or a 'paints' array (full Figma paint objects for gradients/images/stacks).
- TEXT styles require valid fontFamily+fontStyle — fonts are loaded automatically. lineHeight accepts a number (pixels), "AUTO", or { value, unit: "PIXELS"|"PERCENT" }.
- Colors use RGBA 0-1 range.
- Duplicate style names within the same type are skipped with an error suggesting update_styles.
- Use 'variables' to bind design token variables to style properties. TEXT: fontSize, fontFamily, fontStyle, lineHeight, letterSpacing, paragraphSpacing, paragraphIndent. PAINT: color (binds to first paint).`,
  {
    styles: z
      .array(
        z.object({
          type: z.enum(["PAINT", "TEXT", "EFFECT", "GRID"]).describe("Style type"),
          name: z.string().describe("Style name (use / for grouping, e.g. 'Brand/Primary')"),
          description: z.string().optional().describe("Style description"),
          // Paint style properties
          color: z
            .object({
              r: z.number(),
              g: z.number(),
              b: z.number(),
              a: z.number().optional(),
            })
            .optional()
            .describe("Solid color shorthand for PAINT styles (RGBA 0-1)"),
          paints: z
            .array(z.any())
            .optional()
            .describe("Full Figma paint objects array for PAINT styles (gradients, images, stacks)"),
          // Text style properties
          fontFamily: z.string().optional().describe("Font family for TEXT styles (default: 'Inter')"),
          fontStyle: z.string().optional().describe("Font style for TEXT styles (default: 'Regular')"),
          fontSize: z.number().optional().describe("Font size for TEXT styles"),
          lineHeight: z
            .any()
            .optional()
            .describe("Line height: number (pixels), 'AUTO', or { value, unit: 'PIXELS'|'PERCENT' }"),
          letterSpacing: z
            .any()
            .optional()
            .describe("Letter spacing: number (pixels) or { value, unit: 'PIXELS'|'PERCENT' }"),
          paragraphSpacing: z.number().optional().describe("Paragraph spacing in pixels"),
          paragraphIndent: z.number().optional().describe("Paragraph indent in pixels"),
          textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional().describe("Text decoration"),
          textCase: z
            .enum(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"])
            .optional()
            .describe("Text case transformation"),
          // Effect style properties
          effects: z.array(z.any()).optional().describe("Figma effect objects array for EFFECT styles"),
          // Grid style properties
          grids: z.array(z.any()).optional().describe("Figma layout grid objects array for GRID styles"),
          // Variable bindings
          variables: z
            .record(z.string(), z.string())
            .optional()
            .describe(
              "Map of style property → variable ID. TEXT: fontSize, fontFamily, fontStyle, lineHeight, letterSpacing, paragraphSpacing, paragraphIndent. PAINT: color (binds to first paint).",
            ),
        }),
      )
      .min(1)
      .describe("Array of styles to create"),
  },
  async ({ styles }: any) => {
    try {
      const result = await sendCommandToFigma("create_styles", { styles }, 60000);
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
            text: `Error creating styles: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Update Styles Tool — modify properties, rename, or delete existing styles
server.tool(
  "update_styles",
  `Update, rename, or delete existing local styles.

Update paint style color:
  { updates: [
    { styleId: "S:abc...", color: { r: 1, g: 0, b: 0, a: 1 } }
  ]}

Update text style properties:
  { updates: [
    { styleId: "S:abc...", fontSize: 24, fontFamily: "Roboto", fontStyle: "Medium" }
  ]}

Rename a style:
  { updates: [{ styleId: "S:abc...", name: "Brand/NewName" }] }

Delete styles:
  { updates: [
    { styleId: "S:abc...", delete: true },
    { styleId: "S:def...", delete: true }
  ]}

Update effect style:
  { updates: [
    { styleId: "S:abc...", effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.2 }, offset: { x: 0, y: 8 }, radius: 16, spread: 0, visible: true, blendMode: "NORMAL" }] }
  ]}

Bind variables to style properties:
  { updates: [
    { styleId: "S:abc...", variables: { fontSize: "VariableID:abc", lineHeight: "VariableID:def" } }
  ]}

Multiple operations in one call:
  { updates: [
    { styleId: "S:1", name: "NewName" },
    { styleId: "S:2", fontSize: 20, lineHeight: 28 },
    { styleId: "S:3", delete: true }
  ]}`,
  {
    updates: z
      .array(
        z.object({
          styleId: z.string().describe("ID of the style to update or delete"),
          delete: z.boolean().optional().describe("Set true to delete this style"),
          name: z.string().optional().describe("New name for the style"),
          description: z.string().optional().describe("New description"),
          // Paint style properties
          color: z
            .object({
              r: z.number(),
              g: z.number(),
              b: z.number(),
              a: z.number().optional(),
            })
            .optional()
            .describe("New solid color for PAINT styles (RGBA 0-1)"),
          paints: z.array(z.any()).optional().describe("New paints array for PAINT styles"),
          // Text style properties
          fontFamily: z.string().optional().describe("New font family for TEXT styles"),
          fontStyle: z.string().optional().describe("New font style for TEXT styles"),
          fontSize: z.number().optional().describe("New font size for TEXT styles"),
          lineHeight: z.any().optional().describe("New line height: number (pixels), 'AUTO', or { value, unit }"),
          letterSpacing: z.any().optional().describe("New letter spacing: number (pixels) or { value, unit }"),
          paragraphSpacing: z.number().optional().describe("New paragraph spacing"),
          paragraphIndent: z.number().optional().describe("New paragraph indent"),
          textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional().describe("New text decoration"),
          textCase: z
            .enum(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"])
            .optional()
            .describe("New text case"),
          // Effect style properties
          effects: z.array(z.any()).optional().describe("New effects array for EFFECT styles"),
          // Grid style properties
          grids: z.array(z.any()).optional().describe("New grids array for GRID styles"),
          // Variable bindings
          variables: z
            .record(z.string(), z.string())
            .optional()
            .describe(
              "Map of style property → variable ID to bind. TEXT: fontSize, fontFamily, fontStyle, lineHeight, letterSpacing, paragraphSpacing, paragraphIndent. PAINT: color.",
            ),
        }),
      )
      .min(1)
      .describe("Array of style update operations"),
  },
  async ({ updates }: any) => {
    try {
      const result = await sendCommandToFigma("update_styles", { updates }, 60000);
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
            text: `Error updating styles: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);
