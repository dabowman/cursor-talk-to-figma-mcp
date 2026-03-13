// Custom logging functions that write to stderr instead of stdout to avoid being captured
export const logger = {
  info: (message: string) => process.stderr.write(`[INFO] ${message}\n`),
  debug: (message: string) => process.stderr.write(`[DEBUG] ${message}\n`),
  warn: (message: string) => process.stderr.write(`[WARN] ${message}\n`),
  error: (message: string) => process.stderr.write(`[ERROR] ${message}\n`),
  log: (message: string) => process.stderr.write(`[LOG] ${message}\n`),
};

// ─── Output Budget System ────────────────────────────────────────────────────

export const DEFAULT_MAX_OUTPUT_CHARS = 30_000;

export interface GuardOptions {
  /** Override default budget (chars). */
  maxChars?: number;
  /** Extract a preserved header (meta/summary) from the output. */
  metaExtractor?: (text: string) => string | null;
  /** Tool name for the truncation message. */
  toolName: string;
  /** Tool-specific hints for narrowing the query. */
  narrowingHints?: string[];
}

export interface GuardResult {
  text: string;
  truncated: boolean;
}

/**
 * Check output string against a character budget.
 * If under budget, return as-is. If over, return a truncation message
 * with the preserved meta/summary and actionable instructions.
 */
export function guardOutput(text: string, options: GuardOptions): GuardResult {
  const max = options.maxChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  if (text.length <= max) {
    return { text, truncated: false };
  }

  // Try to extract a meta/summary section to preserve
  let preserved = "";
  if (options.metaExtractor) {
    const meta = options.metaExtractor(text);
    if (meta) preserved = meta + "\n\n";
  }

  const hints = options.narrowingHints ?? [];
  const hintBlock = hints.length > 0 ? "\n" + hints.join("\n") + "\n" : "";
  const msg = [
    `Output truncated: ${text.length.toLocaleString()} chars exceeds budget of ${max.toLocaleString()}.`,
    hintBlock,
    `To get full output, pass maxOutputChars: ${Math.min(text.length + 1000, 200_000)}.`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    text: preserved + msg,
    truncated: true,
  };
}

/** Extract YAML meta section (everything from "meta:" to the next top-level key). */
export function extractYamlMeta(text: string): string | null {
  // Match "meta:" through the end of its indented block, stopping at the next
  // top-level key (a line starting with a non-space character followed by colon).
  const match = text.match(/^meta:\n(?:[ \t]+.*\n?)*/m);
  return match ? match[0].trim() : null;
}

/** Extract top-level JSON summary (scalar values + array lengths). */
export function extractJsonSummary(text: string): string | null {
  try {
    const obj = JSON.parse(text);
    const summary: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined || typeof v !== "object") {
        summary[k] = v;
      } else if (Array.isArray(v)) {
        summary[k] = `[${v.length} items]`;
      } else {
        const keys = Object.keys(v);
        summary[k] = `{${keys.length} keys}`;
      }
    }
    return JSON.stringify(summary, null, 2);
  } catch {
    return text.slice(0, 500) + "...";
  }
}
