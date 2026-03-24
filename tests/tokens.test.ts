import { describe, test, expect } from "bun:test";
import {
  hexToRgba,
  dtcgTypeToFigma,
  convertValue,
  inferScopes,
  walkDtcgTree,
} from "../src/figmagent_mcp/tools/tokens.js";

// ─── hexToRgba ────────────────────────────────────────────────────────────────

describe("hexToRgba", () => {
  test("parses 6-char hex", () => {
    const result = hexToRgba("#3366FF");
    expect(result.r).toBeCloseTo(0.2, 2);
    expect(result.g).toBeCloseTo(0.4, 2);
    expect(result.b).toBeCloseTo(1.0, 2);
    expect(result.a).toBe(1);
  });

  test("parses 3-char hex (expands to 6)", () => {
    const result = hexToRgba("#369");
    expect(result.r).toBeCloseTo(0.2, 2);
    expect(result.g).toBeCloseTo(0.4, 2);
    expect(result.b).toBeCloseTo(0.6, 2);
    expect(result.a).toBe(1);
  });

  test("parses 8-char hex with alpha", () => {
    const result = hexToRgba("#FF000080");
    expect(result.r).toBe(1);
    expect(result.g).toBe(0);
    expect(result.b).toBe(0);
    expect(result.a).toBeCloseTo(0.502, 2);
  });

  test("parses 4-char hex with alpha (expands to 8)", () => {
    const result = hexToRgba("#F00F");
    expect(result.r).toBe(1);
    expect(result.g).toBe(0);
    expect(result.b).toBe(0);
    expect(result.a).toBe(1);
  });

  test("throws on 5-char hex", () => {
    expect(() => hexToRgba("#12345")).toThrow("Invalid hex color");
  });

  test("throws on 7-char hex", () => {
    expect(() => hexToRgba("#1234567")).toThrow("Invalid hex color");
  });
});

// ─── dtcgTypeToFigma ──────────────────────────────────────────────────────────

describe("dtcgTypeToFigma", () => {
  test("color → COLOR", () => expect(dtcgTypeToFigma("color")).toBe("COLOR"));
  test("dimension → FLOAT", () => expect(dtcgTypeToFigma("dimension")).toBe("FLOAT"));
  test("number → FLOAT", () => expect(dtcgTypeToFigma("number")).toBe("FLOAT"));
  test("duration → FLOAT", () => expect(dtcgTypeToFigma("duration")).toBe("FLOAT"));
  test("fontWeight → FLOAT", () => expect(dtcgTypeToFigma("fontWeight")).toBe("FLOAT"));
  test("fontFamily → STRING", () => expect(dtcgTypeToFigma("fontFamily")).toBe("STRING"));
  test("fontStyle → STRING", () => expect(dtcgTypeToFigma("fontStyle")).toBe("STRING"));
  test("string → STRING", () => expect(dtcgTypeToFigma("string")).toBe("STRING"));
  test("boolean → BOOLEAN", () => expect(dtcgTypeToFigma("boolean")).toBe("BOOLEAN"));
  test("unknown type → STRING", () => expect(dtcgTypeToFigma("typography")).toBe("STRING"));
});

// ─── convertValue ─────────────────────────────────────────────────────────────

describe("convertValue", () => {
  test("converts hex color to RGBA object", () => {
    const r = convertValue("color", "#3366FF");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.value as { r: number }).r).toBeCloseTo(0.2, 2);
      expect((r.value as { a: number }).a).toBe(1);
    }
  });

  test("rejects DTCG alias reference", () => {
    const r = convertValue("color", "{color.primary.500}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Alias");
  });

  test("strips px units from dimension", () => {
    const r = convertValue("dimension", "8px");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(8);
  });

  test("converts rem to px with a warning (1rem=16px)", () => {
    const r = convertValue("dimension", "1.5rem");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(24);
      expect(r.warning).toContain("1rem=16px");
    }
  });

  test("rejects 'auto' dimension with error", () => {
    const r = convertValue("dimension", "auto");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("auto");
  });

  test("rejects composite typography object", () => {
    const r = convertValue("typography", { fontFamily: "Inter", fontSize: "16px" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Composite");
  });

  test("passes through plain number", () => {
    const r = convertValue("number", 42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  test("converts boolean string 'true'", () => {
    const r = convertValue("boolean", "true");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(true);
  });

  test("passes through boolean false", () => {
    const r = convertValue("boolean", false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(false);
  });

  test("passes through plain string", () => {
    const r = convertValue("string", "Inter");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("Inter");
  });
});

// ─── inferScopes ──────────────────────────────────────────────────────────────

describe("inferScopes", () => {
  test("generic color → ALL_FILLS", () => {
    expect(inferScopes("color/primary/500", "COLOR")).toEqual(["ALL_FILLS"]);
  });

  test("stroke color → STROKE_COLOR", () => {
    expect(inferScopes("color/stroke/default", "COLOR")).toEqual(["STROKE_COLOR"]);
  });

  test("border color → STROKE_COLOR", () => {
    expect(inferScopes("color/border/default", "COLOR")).toEqual(["STROKE_COLOR"]);
  });

  test("text color → TEXT_FILL", () => {
    expect(inferScopes("color/text/primary", "COLOR")).toEqual(["TEXT_FILL"]);
  });

  test("radius → CORNER_RADIUS", () => {
    expect(inferScopes("border/radius/sm", "FLOAT")).toEqual(["CORNER_RADIUS"]);
  });

  test("border/width slash path → STROKE_FLOAT", () => {
    expect(inferScopes("border/width/sm", "FLOAT")).toEqual(["STROKE_FLOAT"]);
  });

  test("border-width hyphenated → STROKE_FLOAT", () => {
    expect(inferScopes("border-width-sm", "FLOAT")).toEqual(["STROKE_FLOAT"]);
  });

  test("spacing → GAP", () => {
    expect(inferScopes("spacing/md", "FLOAT")).toEqual(["GAP"]);
  });

  test("font-size → FONT_SIZE", () => {
    expect(inferScopes("typography/font-size/base", "FLOAT")).toEqual(["FONT_SIZE"]);
  });

  test("font-family string → FONT_FAMILY", () => {
    expect(inferScopes("font-family/base", "STRING")).toEqual(["FONT_FAMILY"]);
  });
});

// ─── walkDtcgTree ─────────────────────────────────────────────────────────────

describe("walkDtcgTree", () => {
  function walk(obj: Record<string, unknown>, prefix = "") {
    const parsed: Array<{ name: string; type: string; value: unknown; scopes: string[] }> = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    walkDtcgTree(obj, [], prefix, undefined, parsed as never, errors, warnings);
    return { parsed, errors, warnings };
  }

  test("extracts a simple color token", () => {
    const { parsed, errors } = walk({
      color: { $type: "color", primary: { "500": { $value: "#3366FF" } } },
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("color/primary/500");
    expect(parsed[0].type).toBe("COLOR");
    expect(errors).toHaveLength(0);
  });

  test("extracts a dimension token", () => {
    const { parsed } = walk({
      spacing: { $type: "dimension", sm: { $value: "8px" } },
    });
    expect(parsed[0].value).toBe(8);
    expect(parsed[0].type).toBe("FLOAT");
  });

  test("strips prefix at segment boundary", () => {
    const { parsed } = walk({ figma: { color: { $type: "color", primary: { $value: "#FF0000" } } } }, "figma");
    expect(parsed[0].name).toBe("color/primary");
  });

  test("does NOT strip prefix mid-segment", () => {
    const { parsed } = walk({ colorful: { primary: { $type: "color", $value: "#FF0000" } } }, "col");
    // "col" is not a complete segment of "colorful", so name should be unchanged
    expect(parsed[0].name).toBe("colorful/primary");
  });

  test("records error for alias, skips variable", () => {
    const { parsed, errors } = walk({
      brand: { primary: { $type: "color", $value: "{color.primary.500}" } },
    });
    expect(parsed).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("brand/primary");
    expect(errors[0]).toContain("Alias");
  });

  test("records error for composite type, skips variable", () => {
    const { parsed, errors } = walk({
      heading: { $type: "typography", $value: { fontFamily: "Inter", fontSize: "24px" } },
    });
    expect(parsed).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("heading");
    expect(errors[0]).toContain("Composite");
  });

  test("records warning for rem values, still creates variable", () => {
    const { parsed, warnings } = walk({
      spacing: { md: { $type: "dimension", $value: "1rem" } },
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0].value).toBe(16);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("1rem=16px");
  });

  test("inherits $type from parent group", () => {
    const { parsed } = walk({
      colors: { $type: "color", brand: { primary: { $value: "#FF0000" } } },
    });
    expect(parsed[0].type).toBe("COLOR");
  });
});
