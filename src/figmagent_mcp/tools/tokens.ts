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

// Prepare Figma Variables Tool — DTCG JSON to create_variables payloads (MCP-server-side, no Figma connection needed)

export function hexToRgba(hex: string): { r: number; g: number; b: number; a: number } {
  let h = hex.replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  if (h.length !== 6 && h.length !== 8) {
    throw new Error(`Invalid hex color "${hex}" — expected #RGB, #RGBA, #RRGGBB, or #RRGGBBAA`);
  }
  const r = Number.parseInt(h.slice(0, 2), 16) / 255;
  const g = Number.parseInt(h.slice(2, 4), 16) / 255;
  const b = Number.parseInt(h.slice(4, 6), 16) / 255;
  const a = h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r: Math.round(r * 1000) / 1000, g: Math.round(g * 1000) / 1000, b: Math.round(b * 1000) / 1000, a: Math.round(a * 1000) / 1000 };
}

type FigmaVariableType = "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";

interface ParsedVariable {
  name: string;
  type: FigmaVariableType;
  value: unknown;
  scopes: string[];
}

type ConvertResult =
  | { ok: true; value: unknown; warning?: string }
  | { ok: false; error: string };

export function dtcgTypeToFigma(dtcgType: string): FigmaVariableType {
  switch (dtcgType) {
    case "color":
      return "COLOR";
    case "number":
    case "dimension":
    case "duration":
    case "fontWeight":
      return "FLOAT";
    case "fontFamily":
    case "string":
    case "fontStyle":
      return "STRING";
    case "boolean":
      return "BOOLEAN";
    default:
      return "STRING";
  }
}

export function convertValue(dtcgType: string, value: unknown): ConvertResult {
  if (value === null || value === undefined) return { ok: true, value };

  switch (dtcgType) {
    case "color": {
      if (typeof value === "string" && value.startsWith("{") && value.endsWith("}")) {
        return { ok: false, error: `Alias "${value}" cannot be resolved — provide resolved values or use create_variables with alias references directly` };
      }
      if (typeof value === "string" && value.startsWith("#")) {
        return { ok: true, value: hexToRgba(value) };
      }
      if (typeof value === "object") return { ok: true, value };
      return { ok: false, error: `Unsupported color value: ${String(value)}` };
    }
    case "number":
    case "dimension":
    case "duration":
    case "fontWeight": {
      if (typeof value === "number") return { ok: true, value };
      if (typeof value === "string") {
        if (value.toLowerCase() === "auto") {
          return { ok: false, error: `"auto" cannot be converted to a FLOAT variable` };
        }
        const remMatch = value.match(/^([\d.]+)rem$/i);
        if (remMatch) {
          const px = Number.parseFloat(remMatch[1]) * 16;
          return { ok: true, value: px, warning: `"${value}" converted assuming 1rem=16px (→${px}px); verify if your base font size differs` };
        }
        const num = Number.parseFloat(value);
        if (Number.isNaN(num)) return { ok: false, error: `Cannot parse "${value}" as a number` };
        return { ok: true, value: num };
      }
      return { ok: false, error: `Unsupported numeric value: ${String(value)}` };
    }
    case "boolean": {
      if (typeof value === "boolean") return { ok: true, value };
      return { ok: true, value: value === "true" };
    }
    default: {
      if (typeof value === "object" && value !== null) {
        return { ok: false, error: `Composite $type "${dtcgType}" has an object value — cannot be represented as a single Figma variable` };
      }
      return { ok: true, value: typeof value === "string" ? value : String(value) };
    }
  }
}

export function inferScopes(path: string, figmaType: FigmaVariableType): string[] {
  const lower = path.toLowerCase();

  if (figmaType === "COLOR") {
    if (lower.includes("stroke")) return ["STROKE_COLOR"];
    if (lower.includes("text") || lower.includes("font-color") || lower.includes("foreground")) return ["TEXT_FILL"];
    if (lower.includes("fill") || lower.includes("background") || lower.includes("bg") || lower.includes("surface")) return ["ALL_FILLS"];
    if (lower.includes("effect") || lower.includes("shadow")) return ["EFFECT_COLOR"];
    if (lower.includes("border")) return ["STROKE_COLOR"];
    return ["ALL_FILLS"];
  }

  if (figmaType === "FLOAT") {
    if (lower.includes("radius") || lower.includes("corner")) return ["CORNER_RADIUS"];
    if (lower.includes("spacing") || lower.includes("gap")) return ["GAP"];
    if (lower.includes("padding")) return ["GAP"];
    if (lower.includes("opacity") || lower.includes("alpha")) return ["OPACITY"];
    if (lower.includes("font-size") || lower.includes("fontsize") || lower.includes("text-size")) return ["FONT_SIZE"];
    if (lower.includes("font-weight") || lower.includes("fontweight")) return ["FONT_WEIGHT"];
    if (lower.includes("line-height") || lower.includes("lineheight")) return ["LINE_HEIGHT"];
    if (lower.includes("letter-spacing") || lower.includes("letterspacing")) return ["LETTER_SPACING"];
    if (lower.includes("stroke") || lower.includes("border-width") || lower.includes("border/width")) return ["STROKE_FLOAT"];
    if (lower.includes("size") || lower.includes("width") || lower.includes("height")) return ["WIDTH_HEIGHT"];
    return ["ALL_SCOPES"];
  }

  if (figmaType === "STRING") {
    if (lower.includes("font-family") || lower.includes("fontfamily")) return ["FONT_FAMILY"];
    if (lower.includes("font-style") || lower.includes("fontstyle")) return ["FONT_STYLE"];
    return ["ALL_SCOPES"];
  }

  return ["ALL_SCOPES"];
}

export function walkDtcgTree(
  obj: Record<string, unknown>,
  path: string[],
  prefix: string,
  inheritedType: string | undefined,
  results: ParsedVariable[],
  errors: string[],
  warnings: string[],
): void {
  // Check if this is a leaf token (has $value)
  if (obj["$value"] !== undefined) {
    const dtcgType = (typeof obj["$type"] === "string" ? obj["$type"] : inheritedType) || "string";
    const figmaType = dtcgTypeToFigma(dtcgType);
    let name = path.join("/");
    if (prefix && (name === prefix || name.startsWith(`${prefix}/`))) {
      name = name.slice(prefix.length);
    }
    // Remove leading slashes after prefix strip
    name = name.replace(/^\/+/, "");
    if (!name) return;

    const result = convertValue(dtcgType, obj["$value"]);
    if (!result.ok) {
      errors.push(`${name}: ${result.error}`);
      return;
    }
    if (result.warning) warnings.push(`${name}: ${result.warning}`);
    const scopes = inferScopes(name, figmaType);
    results.push({ name, type: figmaType, value: result.value, scopes });
    return;
  }

  // Recurse into child objects
  const groupType = typeof obj["$type"] === "string" ? (obj["$type"] as string) : inheritedType;
  for (const key of Object.keys(obj)) {
    if (key.startsWith("$")) continue; // skip DTCG metadata keys
    const child = obj[key];
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      walkDtcgTree(child as Record<string, unknown>, [...path, key], prefix, groupType, results, errors, warnings);
    }
  }
}

server.tool(
  "prepare_figma_variables",
  `Convert DTCG-format design tokens to create_variables-ready payloads. Handles hex→RGBA conversion, $value/$type parsing, scope inference, and batch chunking.

Runs entirely on the MCP server — no Figma connection needed. Feed the output batches directly to create_variables.

Input a DTCG token tree:
  { tokens: { "color": { "$type": "color", "primary": { "500": { "$value": "#3366FF" } } }, "spacing": { "$type": "dimension", "sm": { "$value": "8px" } } } }

Returns batches plus errors and warnings:
  { totalVariables: 2, totalBatches: 1, errors: [], warnings: [], batches: [{ collection: "Tokens", modes: ["Default"], variables: [...] }] }

Supported DTCG $type values: color, number, dimension, duration, fontWeight, fontFamily, fontStyle, string, boolean.
Hex formats: #RGB, #RGBA, #RRGGBB, #RRGGBBAA. Dimension "8px" strips units; "1.5rem" converts to px (assumes 1rem=16px, warned).
Aliases like "{color.primary.500}" are NOT resolved — they appear as errors. Composite types (typography, shadow, etc.) are skipped with errors.
Scopes are inferred from path segments (e.g. "fill"→ALL_FILLS, "radius"→CORNER_RADIUS, "spacing"→GAP, "font-size"→FONT_SIZE).`,
  {
    tokens: z
      .record(z.string(), z.any())
      .describe("DTCG JSON object with $value/$type entries (can be deeply nested). Top-level keys become path prefixes."),
    collectionName: z
      .string()
      .optional()
      .describe("Name for the Figma variable collection. Default: 'Tokens'"),
    modes: z
      .array(z.string())
      .optional()
      .describe("Mode names for the collection. Default: ['Default']"),
    batchSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Variables per batch payload. Default: 25"),
    prefix: z
      .string()
      .optional()
      .describe("Prefix to strip from variable paths (e.g. 'figma/'). Removed from the start of each variable name."),
  },
  async (params: {
    tokens: Record<string, unknown>;
    collectionName?: string;
    modes?: string[];
    batchSize?: number;
    prefix?: string;
  }) => {
    try {
      const collection = params.collectionName || "Tokens";
      const modes = params.modes || ["Default"];
      const batchSize = params.batchSize || 25;
      const prefix = params.prefix || "";

      // Walk the DTCG tree
      const parsed: ParsedVariable[] = [];
      const errors: string[] = [];
      const warnings: string[] = [];
      walkDtcgTree(params.tokens, [], prefix, undefined, parsed, errors, warnings);

      if (parsed.length === 0 && errors.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: "No DTCG tokens found. Ensure the input has leaf nodes with $value fields." }),
          }],
        };
      }

      // Build create_variables payloads in batches
      const batches: Array<{
        collection: string;
        modes: string[];
        variables: Array<{
          name: string;
          type: FigmaVariableType;
          scopes: string[];
          values: Record<string, unknown>;
        }>;
      }> = [];

      for (let i = 0; i < parsed.length; i += batchSize) {
        const chunk = parsed.slice(i, i + batchSize);
        const variables = chunk.map((v) => {
          const values: Record<string, unknown> = {};
          for (const mode of modes) {
            values[mode] = v.value;
          }
          return { name: v.name, type: v.type, scopes: v.scopes, values };
        });
        batches.push({ collection, modes, variables });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            totalVariables: parsed.length,
            totalBatches: batches.length,
            batchSize,
            ...(errors.length > 0 && { errors }),
            ...(warnings.length > 0 && { warnings }),
            batches,
          }),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error preparing variables: ${error instanceof Error ? error.message : String(error)}`,
        }],
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
