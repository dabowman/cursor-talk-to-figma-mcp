import { describe, test, expect } from "bun:test";
import {
  guardOutput,
  extractYamlMeta,
  extractJsonSummary,
  DEFAULT_MAX_OUTPUT_CHARS,
} from "../src/figmagent_mcp/utils.js";

// ─── guardOutput ─────────────────────────────────────────────────────────────

describe("guardOutput", () => {
  test("passes through output under budget", () => {
    const text = "short output";
    const result = guardOutput(text, { toolName: "test" });
    expect(result.text).toBe(text);
    expect(result.truncated).toBe(false);
  });

  test("truncates output over default budget", () => {
    const text = "x".repeat(DEFAULT_MAX_OUTPUT_CHARS + 1);
    const result = guardOutput(text, { toolName: "test" });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("Output truncated");
    expect(result.text).toContain("30,001");
    expect(result.text).toContain("maxOutputChars");
  });

  test("respects custom maxChars", () => {
    const text = "x".repeat(5000);
    const underResult = guardOutput(text, { toolName: "test", maxChars: 10000 });
    expect(underResult.truncated).toBe(false);

    const overResult = guardOutput(text, { toolName: "test", maxChars: 1000 });
    expect(overResult.truncated).toBe(true);
    expect(overResult.text).toContain("5,000");
  });

  test("preserves meta section via metaExtractor", () => {
    const yaml = `meta:\n  nodeId: "123"\n  name: Test\ndefs:\n  vars: {}`;
    const result = guardOutput(yaml, {
      toolName: "get",
      maxChars: 20,
      metaExtractor: extractYamlMeta,
    });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("nodeId");
    expect(result.text).toContain("Test");
  });

  test("includes narrowing hints in truncation message", () => {
    const text = "x".repeat(50000);
    const result = guardOutput(text, {
      toolName: "get",
      maxChars: 1000,
      narrowingHints: ["  • Use depth=1", "  • Use detail=structure"],
    });
    expect(result.text).toContain("Use depth=1");
    expect(result.text).toContain("Use detail=structure");
  });

  test("caps maxOutputChars suggestion at 200000", () => {
    const text = "x".repeat(250000);
    const result = guardOutput(text, { toolName: "test", maxChars: 1000 });
    expect(result.text).toContain("200000");
    expect(result.text).not.toContain("251000");
  });
});

// ─── extractYamlMeta ─────────────────────────────────────────────────────────

describe("extractYamlMeta", () => {
  test("extracts meta section from YAML", () => {
    const yaml = `meta:\n  nodeId: "123"\n  name: Test\n  nodeCount: 5\ndefs:\n  vars: {}`;
    const meta = extractYamlMeta(yaml);
    expect(meta).toContain("nodeId");
    expect(meta).toContain("nodeCount: 5");
    expect(meta).not.toContain("defs:");
  });

  test("returns null for non-YAML text", () => {
    expect(extractYamlMeta("just some text")).toBeNull();
  });

  test("handles meta at end of string", () => {
    const yaml = `meta:\n  nodeId: "123"`;
    const meta = extractYamlMeta(yaml);
    expect(meta).toContain("nodeId");
  });
});

// ─── extractJsonSummary ──────────────────────────────────────────────────────

describe("extractJsonSummary", () => {
  test("summarizes JSON with arrays and objects", () => {
    const json = JSON.stringify({
      count: 5,
      name: "test",
      items: [1, 2, 3],
      nested: { a: 1, b: 2 },
    });
    const summary = extractJsonSummary(json);
    expect(summary).not.toBeNull();
    const parsed = JSON.parse(summary!);
    expect(parsed.count).toBe(5);
    expect(parsed.name).toBe("test");
    expect(parsed.items).toBe("[3 items]");
    expect(parsed.nested).toBe("{2 keys}");
  });

  test("handles invalid JSON gracefully", () => {
    const result = extractJsonSummary("not json at all");
    expect(result).toContain("not json");
    expect(result).toContain("...");
  });

  test("handles empty object", () => {
    const result = extractJsonSummary("{}");
    expect(result).toBe("{}");
  });
});
