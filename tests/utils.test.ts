import { describe, test, expect } from "bun:test";
import { rgbaToHex, filterFigmaNode } from "../src/talk_to_figma_mcp/utils.js";

describe("rgbaToHex", () => {
  test("converts full-opacity white", () => {
    expect(rgbaToHex({ r: 1, g: 1, b: 1, a: 1 })).toBe("#ffffff");
  });

  test("converts full-opacity black", () => {
    expect(rgbaToHex({ r: 0, g: 0, b: 0, a: 1 })).toBe("#000000");
  });

  test("converts primary red", () => {
    expect(rgbaToHex({ r: 1, g: 0, b: 0, a: 1 })).toBe("#ff0000");
  });

  test("converts mid-gray", () => {
    expect(rgbaToHex({ r: 0.5, g: 0.5, b: 0.5, a: 1 })).toBe("#808080");
  });

  test("includes alpha when not fully opaque", () => {
    expect(rgbaToHex({ r: 1, g: 0, b: 0, a: 0.5 })).toBe("#ff000080");
  });

  test("includes alpha for fully transparent", () => {
    expect(rgbaToHex({ r: 0, g: 0, b: 0, a: 0 })).toBe("#00000000");
  });

  test("passes through string values unchanged", () => {
    expect(rgbaToHex("#abcdef")).toBe("#abcdef");
    expect(rgbaToHex("rgb(255,0,0)")).toBe("rgb(255,0,0)");
  });

  test("rounds fractional channel values", () => {
    // 0.33 * 255 = 84.15 → rounds to 84 = 0x54
    expect(rgbaToHex({ r: 0.33, g: 0.33, b: 0.33, a: 1 })).toBe("#545454");
  });
});

describe("filterFigmaNode", () => {
  test("returns basic node properties", () => {
    const node = { id: "1:2", name: "Frame", type: "FRAME" };
    const result = filterFigmaNode(node);
    expect(result).toEqual({ id: "1:2", name: "Frame", type: "FRAME" });
  });

  test("returns null for VECTOR nodes", () => {
    const node = { id: "1:3", name: "Vector", type: "VECTOR" };
    expect(filterFigmaNode(node)).toBeNull();
  });

  test("includes cornerRadius when present", () => {
    const node = { id: "1:4", name: "Rect", type: "RECTANGLE", cornerRadius: 8 };
    expect(filterFigmaNode(node).cornerRadius).toBe(8);
  });

  test("includes absoluteBoundingBox when present", () => {
    const bbox = { x: 10, y: 20, width: 100, height: 50 };
    const node = { id: "1:5", name: "Rect", type: "RECTANGLE", absoluteBoundingBox: bbox };
    expect(filterFigmaNode(node).absoluteBoundingBox).toEqual(bbox);
  });

  test("includes characters for text nodes", () => {
    const node = { id: "1:6", name: "Label", type: "TEXT", characters: "Hello" };
    expect(filterFigmaNode(node).characters).toBe("Hello");
  });

  test("includes filtered style properties", () => {
    const node = {
      id: "1:7",
      name: "Text",
      type: "TEXT",
      style: {
        fontFamily: "Inter",
        fontStyle: "Regular",
        fontWeight: 400,
        fontSize: 16,
        textAlignHorizontal: "LEFT",
        letterSpacing: 0,
        lineHeightPx: 24,
        extraProp: "should be excluded",
      },
    };
    const result = filterFigmaNode(node);
    expect(result.style.fontFamily).toBe("Inter");
    expect(result.style.fontSize).toBe(16);
    expect(result.style.extraProp).toBeUndefined();
  });

  test("converts solid fill colors to hex", () => {
    const node = {
      id: "1:8",
      name: "Rect",
      type: "RECTANGLE",
      fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }],
    };
    const result = filterFigmaNode(node);
    expect(result.fills[0].color).toBe("#ff0000");
  });

  test("strips boundVariables and imageRef from fills", () => {
    const node = {
      id: "1:9",
      name: "Rect",
      type: "RECTANGLE",
      fills: [
        {
          type: "SOLID",
          color: { r: 0, g: 0, b: 0, a: 1 },
          boundVariables: { color: "var-id" },
          imageRef: "img-ref",
        },
      ],
    };
    const result = filterFigmaNode(node);
    expect(result.fills[0].boundVariables).toBeUndefined();
    expect(result.fills[0].imageRef).toBeUndefined();
  });

  test("converts gradient stop colors to hex", () => {
    const node = {
      id: "1:10",
      name: "Rect",
      type: "RECTANGLE",
      fills: [
        {
          type: "GRADIENT_LINEAR",
          gradientStops: [
            { color: { r: 1, g: 0, b: 0, a: 1 }, position: 0, boundVariables: {} },
            { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 },
          ],
        },
      ],
    };
    const result = filterFigmaNode(node);
    expect(result.fills[0].gradientStops[0].color).toBe("#ff0000");
    expect(result.fills[0].gradientStops[0].boundVariables).toBeUndefined();
    expect(result.fills[0].gradientStops[1].color).toBe("#0000ff");
  });

  test("converts stroke colors to hex and strips boundVariables", () => {
    const node = {
      id: "1:11",
      name: "Rect",
      type: "RECTANGLE",
      strokes: [{ type: "SOLID", color: { r: 0, g: 1, b: 0, a: 1 }, boundVariables: { color: "x" } }],
    };
    const result = filterFigmaNode(node);
    expect(result.strokes[0].color).toBe("#00ff00");
    expect(result.strokes[0].boundVariables).toBeUndefined();
  });

  test("skips empty fills and strokes arrays", () => {
    const node = { id: "1:12", name: "Frame", type: "FRAME", fills: [], strokes: [] };
    const result = filterFigmaNode(node);
    expect(result.fills).toBeUndefined();
    expect(result.strokes).toBeUndefined();
  });

  test("recursively filters children", () => {
    const node = {
      id: "1:0",
      name: "Parent",
      type: "FRAME",
      children: [
        { id: "1:1", name: "Child", type: "RECTANGLE" },
        { id: "1:2", name: "Vec", type: "VECTOR" },
      ],
    };
    const result = filterFigmaNode(node);
    expect(result.children).toHaveLength(1);
    expect(result.children[0].id).toBe("1:1");
  });

  test("respects depth limit and returns childCount", () => {
    const node = {
      id: "1:0",
      name: "Root",
      type: "FRAME",
      children: [
        {
          id: "1:1",
          name: "Child",
          type: "FRAME",
          children: [{ id: "1:2", name: "Grandchild", type: "RECTANGLE" }],
        },
      ],
    };

    const atDepth1 = filterFigmaNode(node, 1);
    expect(atDepth1.children).toHaveLength(1);
    expect(atDepth1.children[0].childCount).toBe(1);
    expect(atDepth1.children[0].children).toBeUndefined();
  });

  test("depth=0 returns childCount for root children", () => {
    const node = {
      id: "1:0",
      name: "Root",
      type: "FRAME",
      children: [
        { id: "1:1", name: "A", type: "RECTANGLE" },
        { id: "1:2", name: "B", type: "RECTANGLE" },
      ],
    };
    const result = filterFigmaNode(node, 0);
    expect(result.childCount).toBe(2);
    expect(result.children).toBeUndefined();
  });

  test("default depth traverses full tree", () => {
    const node = {
      id: "1:0",
      name: "Root",
      type: "FRAME",
      children: [
        {
          id: "1:1",
          name: "L1",
          type: "FRAME",
          children: [
            {
              id: "1:2",
              name: "L2",
              type: "FRAME",
              children: [{ id: "1:3", name: "L3", type: "RECTANGLE" }],
            },
          ],
        },
      ],
    };
    const result = filterFigmaNode(node);
    expect(result.children[0].children[0].children[0].id).toBe("1:3");
  });
});
