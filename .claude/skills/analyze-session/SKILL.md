---
name: analyze-session
description: "Analyze a Figma MCP test session transcript. Reads raw session data (JSON or HTML) and produces a structured analysis document with metrics, efficiency issues, error patterns, and prioritized improvements. Updates the cross-session improvement tracker. Use after completing a Figma session or when reviewing past sessions. Accepts an optional file path argument; if omitted, analyzes the most recent transcript."
---

# Analyze Session Transcript

Analyze a Figma MCP test session transcript and produce a structured efficiency/error audit. After large Figma sessions (50+ tool calls), run this skill to capture learnings and track improvement over time.

---

## Phase 1: Locate and Ingest Transcript

1. If a file path argument was provided, use that. Otherwise, find the most recent transcript:
   - **Primary**: Check `.claude/sessions-json/` for `.json` files (produced by `bun extract-sessions`)
   - **Fallback**: Check `.claude/transcripts/` for HTML files (produced by `bun transcribe`)
   - Sort by modification time, pick most recent.

2. **If no extracted JSON exists yet**, run `bun extract-sessions --latest --compact --no-thinking` to generate one from the most recent Claude Code session. This produces a structured JSON file in `.claude/sessions-json/`.

3. **Reading the JSON transcript** (produced by `scripts/extract-sessions.ts`):
   - Read the file. If >500 lines, read in 500-line chunks.
   - The format is an `ExtractedSession` object with this structure:

   ```json
   {
     "sessionId": "uuid",
     "extractedAt": "ISO-8601",
     "metadata": {
       "cwd": "/path/to/project",
       "branch": "branch-name",
       "version": "claude-code-version",
       "messageCount": 120,
       "toolCallCount": 89,
       "uniqueTools": ["create", "apply", "get", ...],
       "duration": { "start": "ISO-8601", "end": "ISO-8601", "minutes": 80 }
     },
     "messages": [
       {
         "role": "user" | "assistant" | "system",
         "timestamp": "ISO-8601",
         "content": [
           { "type": "text", "text": "..." },
           { "type": "tool_use", "id": "toolu_xxx", "name": "create", "input": { ... } },
           { "type": "tool_result", "tool_use_id": "toolu_xxx", "content": "...", "is_error": true }
         ],
         "model": "claude-opus-4-6",
         "usage": { "input_tokens": 1234, "output_tokens": 567 },
         "uuid": "msg-uuid",
         "parentUuid": "parent-msg-uuid"
       }
     ],
     "subAgents": {
       "agent-uuid": { /* same ExtractedSession structure */ }
     }
   }
   ```

   Key fields for analysis:
   - `metadata.toolCallCount` and `metadata.uniqueTools` — pre-computed totals
   - `metadata.duration.minutes` — session length
   - Content blocks with `type: "tool_use"` — tool calls (`.name` = tool name, `.input` = params)
   - Content blocks with `type: "tool_result"` — results (`.is_error` = true for failures, `.content` = error message or result)
   - `subAgents` — nested sub-agent sessions (same structure, analyze separately then merge)
   - `usage` on assistant messages — token consumption per turn

4. **Three-pass approach** (critical for large transcripts — 800+ events):
   - **Pass 1 (Extract)**: Read in chunks. For each message, scan content blocks. For each `tool_use` block, record: timestamp, tool name, input params (extract nodeId if present). For each `tool_result` block, record: tool_use_id, is_error, error message snippet. Output a compact one-line-per-tool-call summary. This reduces 300KB → ~15KB.
   - **Pass 2 (Analyze)**: Over the compact summary, compute all metrics and identify patterns.
   - **Pass 3 (Detail)**: For each flagged issue/error pattern, go back to the original transcript to extract specific context (full error messages, parameter values, cascading effects).

5. **For HTML transcripts** (fallback if no JSON available and `extract-sessions` cannot run):
   - Read page by page (each HTML file is one page).
   - Extract tool call blocks using pattern matching: look for tool names, parameters, results, and error messages.

---

## Phase 2: Compute Metrics

Calculate these standard metrics from the extracted events:

### Session Overview
- **Duration**: end time - start time
- **Total events**: count of all events
- **Total tool calls**: use `metadata.toolCallCount` or count `tool_use` content blocks
- **Total errors**: count `tool_result` blocks where `is_error: true`
- **Reconnections**: count `tool_use` blocks where `name` is `join_channel` (subtract 1 for initial join)
- **Context overflows**: detect by looking for continuation summaries or session restart markers
- **Phases completed**: identify distinct work phases from the transcript

### Tool Call Distribution Table
For each unique tool name:
- Count total invocations
- Note patterns:
  - "no batch version" if >20 sequential calls to same tool
  - "N redundant re-inspections" if same node ID appears in multiple `get` calls
  - "N failed" if error count > 0

### Error Extraction
- Group errors by error message pattern (normalize variable parts like node IDs)
- Count cascading errors: when one error in a parallel batch causes all parallel calls to fail, count the root error separately from cascaded ones
- Identify root cause vs symptom errors

### Efficiency Signals — Detect These Patterns

1. **Sequential same-tool runs**: 5+ consecutive calls to the same tool → batch candidate. Record: tool name, run length, what a batch version would look like.

2. **Inspect-after-create**: `create` or `clone_node` immediately followed by `get` on the created node → indicates create response should be richer. Count occurrences.

3. **Delete-recreate cycles**: `delete_node`/`delete_multiple_nodes` followed by `create` for the same purpose → indicates missing modify capability or wrong initial approach.

4. **ToolSearch overhead**: total ToolSearch calls, percentage of all calls, failed searches (found wrong tools or 0 results).

5. **Redundant re-inspections**: same node ID appearing in multiple `get` calls → count unique nodes vs total `get` calls.

6. **Timeout cascades**: 3+ consecutive timeouts → connection loss not detected fast enough.

7. **Error retry storms**: same error repeated 3+ times → fail-fast rule violated.

---

## Phase 3: Cross-Session Comparison

1. Read the improvement tracker at `.claude/analysis/improvement-tracker.md`
2. Read the most recent previous analysis from `.claude/analysis/` (by filename number)
3. Compute deltas:
   - Waste percentage change
   - Error rate change
   - ToolSearch overhead change
   - New tools used that didn't exist in previous session
   - Recurring issues vs new issues
4. Check which previously-identified issues were addressed:
   - Tool exists now that was flagged as missing? → Mark as `implemented`
   - Error pattern from previous session not observed? → Mark as `verified`
   - Same issue still present? → Increment sessions affected count

---

## Phase 4: Generate Analysis Document

Write the analysis to `.claude/analysis/figma-mcp-session<N>-analysis.md` where N is auto-incremented based on existing files in the directory.

Use this exact template structure (matching the format of existing session 1 and session 2 analyses):

```markdown
# Figma MCP Session <N> Analysis

## Session Overview

- **Transcript**: `<filename>`
- **Duration**: <duration>
- **Total tool calls**: <count>
- **Total errors**: <count>
- **Reconnections**: <count>
- **Context restarts**: <count>
- **Task**: <brief description>

## Metrics

| Metric | Previous Session | This Session | Change |
|---|---|---|---|
| Total Figma tool calls | ... | ... | ... |
| Meta/overhead calls | ... | ... | ... |
| ToolSearch calls | ... | ... | ... |
| Estimated waste % | ... | ... | ... |

## Tool Call Distribution

| Tool | Calls | Notes |
|---|---|---|
| ... | ... | ... |

## Efficiency Issues

### 1. <Issue title> (saves ~N calls)

<Description of the pattern observed. Include specific numbers — how many consecutive calls, which nodes, what the agent was trying to do.>

**Pattern observed:** <concrete example from the transcript>

**Root cause:** <why this happened — missing tool, wrong default, agent behavior>

**Proposed fix:** <specific actionable recommendation>

**Estimated savings:** ~N calls → ~M calls.

### 2. ...

## Error Analysis

### 1. <Error category> (<N> failures, ~<M> minutes lost)

<Description. Include the exact error message. Trace cascading effects.>

**Agent recovery:** <how the agent responded — did it fail fast? retry too many times?>

**Fix needed:** <specific code or behavior change>

### 2. ...

## What Worked Well

1. **<Tool/pattern>.** <Why it was effective, with specific numbers.>
2. ...

## Priority Improvements

### Tool Changes (ranked by call savings)

1. **<tool name>** — <what it should do>. Saves ~N calls per session.
2. ...

### Agent Skill Updates

1. **<behavior change>** — <description>.
2. ...
```

---

## Phase 5: Update Improvement Tracker

Update `.claude/analysis/improvement-tracker.md`:

1. **Add new issues**: For each efficiency issue or error pattern identified in this analysis that doesn't already exist in the tracker:
   - Assign an ID: `[CATEGORY-NNN]` where CATEGORY is TOOL, BUG, AGENT, or INFRA
   - Auto-increment NNN within the category
   - Set status to `identified`
   - Set priority based on estimated call savings: P0 (>50 calls), P1 (10-50 calls), P2 (<10 calls)
   - Classify as auto-fixable if it matches a known fix pattern (see Phase 6)

2. **Update existing issues**: For each tracker entry:
   - If the issue was not observed in this session and the fix is confirmed working → advance to `verified`, move to Resolved Issues
   - If the issue recurred → add this session number to "Sessions affected"
   - If a tool was implemented that addresses the issue → advance to `implemented`

3. **Deduplication**: Match new findings against existing entries by:
   - Category match
   - Tool name match (if issue references a specific tool)
   - Key phrase match (substring: "batch", "async", "timeout", "coercion", etc.)
   - If match found → increment occurrence count, don't create duplicate

4. **Update Metrics Over Time table**: Add a row for this session.

5. **Update "Last updated" date and "Sessions analyzed" count**.

---

## Phase 6: Generate Fix Plans (if applicable)

For issues marked `auto-fixable: yes` in the tracker, generate implementation plans. Plans go to `.claude/plans/<date>-<issue-id>.md`.

### Safe Fix Patterns (allowlist)

Only generate plans for these well-understood patterns:

#### `sync-to-async`
- **Trigger**: Error message contains "Cannot call with documentAccess: dynamic-page" or "Use node.setXxxAsync instead"
- **Fix**: Find the sync call in plugin source, replace with async equivalent
- **Plan content**: Exact file path, line number, old code → new code
- **Example**: `node.textStyleId = id` → `await node.setTextStyleIdAsync(id)`

#### `type-coercion`
- **Trigger**: Error message contains "expected number, received string" or similar type mismatch
- **Fix**: Add `toNumber()` coercion in the plugin handler (helper already exists in `src/figma_plugin/src/helpers.js`) or add `.or(z.string().transform(Number))` to the Zod schema in the MCP tool handler
- **Plan content**: File path, parameter name, Zod schema change or `toNumber()` wrapping

#### `missing-batch-tool`
- **Trigger**: Single-item tool called 20+ times consecutively
- **Fix**: Create batch variant following existing patterns (`set_multiple_text_contents`, `delete_multiple_nodes`)
- **Plan content**: Tool specification (name, parameters, behavior) for use with `/add-mcp-tool` skill. Include the proposed JSON input format based on observed usage patterns.

### Plan Format

```markdown
# Fix: [ISSUE-ID] <title>

**Pattern**: <sync-to-async | type-coercion | missing-batch-tool>
**Priority**: <P0 | P1 | P2>
**Estimated savings**: <N calls/session>

## Changes

### File: `<path>`
- Line N: `<old code>` → `<new code>`

## Verification
- [ ] Run `bun run lint`
- [ ] Run `bun run test`
- [ ] Run `bun run build:plugin`
- [ ] Test in a Figma session
```

**Important**: The skill NEVER applies code changes directly. It only generates plan files and marks issues as `planned` in the tracker. The user reviews and triggers implementation.

---

## Notes

- If the transcript is too large to fit in context even with the 3-pass approach, focus on the tool call distribution and error extraction (Phases 2a-2b) and skip detailed efficiency pattern analysis for the middle sections.
- Always validate numbers: total tool calls should equal sum of distribution table. Error count should match error analysis section.
- When comparing sessions, normalize for scope differences (session 2 had 26% more tool calls because the task was larger, not because it was less efficient).
- The analysis document is committed to git — it serves as a permanent record of the session and its learnings.
