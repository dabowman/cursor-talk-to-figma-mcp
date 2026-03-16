# Figma MCP Session 17 Analysis

## Session Overview

- **Transcript**: `85b6b194-79ec-44dc-94cc-fa3cf5d8b7f3.json`
- **Duration**: ~210 minutes (3.5 hours)
- **Total tool calls**: 99 (main) + 117 (7 sub-agents) = 216 total
- **Total errors**: 10 (main: 1 multi-file, 2 Read oversized, 3 timeouts, 1 user rejection, 1 output overflow, 1 create FILL error, plus update_styles partial failures)
- **Reconnections**: 2 (calls #74, #76 — both `join_channel` after timeout cascade)
- **Context restarts**: 0
- **Task**: Populate a blank Figma file with a complete design system from a Storybook project: variable collections (color/viewport/static), text styles with variable bindings, and initial component building (Separator). First variable attempt used wrong naming — full delete-recreate cycle.
- **Cross-project**: Session ran from the `storybook` project. Extracted via `--file` flag on `extract-sessions`.

## Metrics

| Metric | Session 16 | Session 17 | Change |
|---|---|---|---|
| Total tool calls (main) | 77 | 99 | +29% |
| Total tool calls (with sub-agents) | 77 | 216 | +180% (heavy delegation) |
| Figma MCP calls (main) | 58 | 40 | -31% (delegated to sub-agents) |
| Figma MCP calls (total) | 58 | ~65 | +12% |
| ToolSearch calls (main) | 9 (11.7%) | 14 (14.1%) | Worse |
| Agent calls | 2 | 6 (6.1%) | Heavy sub-agent use |
| Errors (main) | 5 (6.5%) | 10 (10.1%) | Worse (timeout cascade + style binding issues) |
| Estimated waste % | ~25% | ~35% | Worse (delete-recreate + timeouts + style binding retries) |

## Tool Call Distribution

### Main Agent (99 calls)

| Tool | Calls | Notes |
|---|---|---|
| `Bash` | 24 | Hex→RGBA conversion, token parsing, batch files, variable ID extraction |
| `create_variables` | 15 | 8 consecutive in first pass (wrong names), 7 in second pass |
| `ToolSearch` | 14 | 14.1% overhead. 7 in Phase 1, 7 in Phases 2-3 |
| `get_design_system` | 9 | 3 timeouts, 1 user rejection, 2 truncated (95K/110K chars), 3 succeeded |
| `update_styles` | 7 | 2 fully failed (wrong variable IDs/types), 5 succeeded |
| `Read` | 7 | 2 failed (>25K tokens), 5 succeeded |
| `Agent` | 6 | 2 Explore, 3 variable creation, 1 SCSS component reading |
| `update_variables` | 4 | Deleting ~200 wrong variables |
| `join_channel` | 3 | 1 initial (multi-file), 2 reconnections after timeouts |
| `get_document_info` | 2 | 1 failed (multi-file), 1 succeeded |
| `create` | 2 | 1 failed (FILL sizing on page-level), 1 succeeded |
| `create_styles` | 1 | 18 text styles created in one call |
| `find` | 1 | Timed out (during timeout cascade) |
| `combine_as_variants` | 1 | Separator: 2 variants → COMPONENT_SET |
| `rename_node` | 1 | Rename COMPONENT_SET → "Separator" |
| `Write` | 1 | Memory file for storybook project |
| `Edit` | 1 | Memory index update |

### Sub-Agents (7 total, 117 calls)

| Agent | Task | Tool Calls | Figma Calls |
|---|---|---|---|
| Explore #1 | Examine 26 React components | 28 (all Read) | 0 |
| Explore #2 | Examine token file structure | 25 (all Read) | 0 |
| General #1 | Create remaining 207 color aliases | 30 | ~13 create_variables |
| General #2 | Create static collection (46 vars) | 5 | ~2 create_variables |
| General #3 | Create viewport collection (133 vars) | 9 | ~4 create_variables |
| General #4 | Read component SCSS files | 12 (all Read/Bash) | 0 |
| Side question | Context check mid-session | 8 | 2 (get_document_info, get_design_system) |

**Totals**: 99 main + 117 sub-agent = 216.

## Session Phases

| Phase | Calls | Description |
|---|---|---|
| 1. Discovery | #1–#9 | Explore components + token system via sub-agents |
| 2. Variables (attempt 1) | #10–#19 | Created ~200 vars with wrong naming |
| 3. Verification + correction | #20–#39 | Read pipeline output, deleted all vars |
| 4. Variables (attempt 2) | #40–#65 | Recreated correctly + sub-agents for bulk |
| 5. Text styles + bindings | #66–#88 | Created 18 styles, bound variables (timeouts + retries) |
| 6. Component building | #89–#99 | Separator component with variants |

## Efficiency Issues

### 1. Delete-recreate cycle for variables (~23 wasted calls)

The agent created ~200 variables with wrong naming (no `color/` prefix). After discovering the mismatch, all were deleted and recreated.

**Pattern observed:** calls #12–#19 created 199 variables, calls #36–#39 deleted them all, calls #48–#60 recreated 150+ correctly.

**Root cause:** Agent inferred naming from base token files (`tokens/base/`) instead of pipeline output (`tokens/figma/`). User intervened.

**Estimated savings:** ~23 calls (4 delete + 8 wrong creates + ~11 Bash scripts).

### 2. Timeout cascade + reconnection overhead (~8 wasted calls, ~3 minutes)

Calls #70–#73: three consecutive timeouts (`get_design_system`, `find`, `get_design_system`), then reconnection at #74. Call #75 was rejected by user. Second reconnection at #76. Finally succeeded at #77.

**Pattern observed:** 3 timeouts before first `join_channel`. Agent followed the 2-timeout rule on the third attempt but the intervening `find` call reset its count.

**Root cause:** WebSocket dropped after ~90 minutes of session. The `find` call (#71) between the two `get_design_system` timeouts may have confused the "2 consecutive identical errors" heuristic since it was a different tool.

**Proposed fix:** Track consecutive timeouts across ALL tools, not just identical tool names. Any timeout should count toward the "2 timeouts → reconnect" threshold.

**Estimated savings:** ~4 calls (skip the 3rd timeout + user rejection).

### 3. `update_styles` variable binding failures (2 fully failed batches)

Call #82: 6 failures — "not a font property" when trying to bind variables to effect-style properties. Call #83: 12 failures — "Variable not found" with wrong variable IDs. Agent iterated to fix, eventually succeeding at #84, #87, #88.

**Pattern observed:** 7 `update_styles` calls, 2 fully failed. Agent tried binding `fontFamily` variables to non-text styles (#82) and used wrong variable IDs (#83) before correcting.

**Root cause:** The `get_design_system` output (95K chars, truncated) didn't provide enough context for the agent to correctly map variable IDs to style properties. Agent had to dump to Bash (#79) to extract the right IDs.

**Proposed fix:** `get_design_system` should include variable IDs in a more accessible format, or a dedicated `get_variable_ids_by_name` query should exist. Also, `update_styles` error messages could suggest the correct property type.

**Estimated savings:** ~2 calls.

### 4. `get_design_system` output overflow (6 calls for one successful read)

After 540+ variables and 18 styles, `get_design_system` output was 95-110K chars. Calls #77 and #78 both exceeded budgets (10K and MCP infrastructure limit). Agent fell back to Bash to parse the dumped file.

**Pattern observed:** 9 total `get_design_system` calls — 3 timeouts, 1 rejection, 2 truncated/overflow, 3 succeeded. The design system grew beyond what the output budget can handle.

**Root cause:** Large design systems (540+ variables) exceed the 30K default budget and even the MCP infrastructure's file-dump limit. No way to query specific parts of the design system.

**Proposed fix:** Add filtering to `get_design_system` — e.g. `collection` (filter by collection name), `type` ("variables" or "styles" only), `namePattern` (regex filter). This would let agents query just what they need.

**Estimated savings:** ~4 calls per large-design-system session.

### 5. Excessive Bash scripting for token conversion (24 Bash calls)

24 Bash/Node scripts for hex→RGBA conversion, JSON parsing, batch file generation, variable ID extraction, and diffing.

**Root cause:** No built-in token conversion utility. (Already tracked as [INFRA-003].)

**Estimated savings:** ~18 calls.

### 6. `create` FILL sizing error on page-level component (1 error)

Call #94 failed: "FILL can only be set on children of auto-layout frames." Agent tried to create a Separator component with FILL sizing at page level.

**Root cause:** Known pattern (documented in CLAUDE.md) — FILL sizing requires an auto-layout parent. Agent should have created without FILL sizing first. Recovered immediately in #95 by removing FILL.

**Estimated savings:** ~1 call.

## Error Analysis

### 1. Timeout cascade (#70–#73) — 3 failures, ~3 minutes lost

Three consecutive timeouts across `get_design_system` and `find`. Agent reconnected after the third timeout.

**Agent recovery:** Acceptable but slow — the interleaved `find` call disrupted the "2 timeouts → reconnect" heuristic. Should have reconnected after #72 (2nd timeout).

### 2. `update_styles` binding errors (#82, #83, #85) — 30 failures across 3 calls

- #82: "not a font property" — tried binding font variables to non-text styles
- #83: "Variable not found" — used wrong variable IDs from truncated design system dump
- #85: Unclear failures — possibly stale variable references

**Agent recovery:** Good — iterated through different approaches, eventually found correct variable IDs via Bash extraction (#79) and succeeded at #84, #87, #88.

**Fix needed:** Better error messages from `update_styles` (suggest correct property types). `get_design_system` filtering to avoid truncation.

### 3. Previously documented errors (calls #1–#65)

- Multi-file open (#2): 1 failure, immediate recovery
- Read oversized (#22, #23): 2 failures, switched to Bash

## What Worked Well

1. **Sub-agent delegation.** 7 sub-agents handled bulk work across all phases: component discovery, token exploration, variable creation (3 parallel agents), SCSS reading, and a context check. 117 calls delegated effectively.

2. **Batch variable creation.** `create_variables` handled 20-42 variables per call. ~540 variables created across main agent + sub-agents with zero individual variable calls.

3. **Style creation efficiency.** 18 text styles created in a single `create_styles` call (#69) — no sequential single-style calls.

4. **Component building pattern.** Separator built efficiently: 2 variant components created in parallel via `nodes` array (#95), combined via `combine_as_variants` (#97), renamed (#98). Clean 3-call pattern.

5. **Error recovery on style bindings.** Despite 3 failed `update_styles` batches, agent diagnosed the root cause (wrong variable IDs from truncated output), extracted correct IDs via Bash, and succeeded. No infinite retry loop.

## Priority Improvements

### Tool Changes (ranked by call savings)

1. **Token-to-Figma conversion utility** — Saves ~18 Bash calls per token-import session. (Existing [INFRA-003])

2. **`get_design_system` filtering** — Add `collection`, `type`, `namePattern` params to query subsets. Saves ~4 calls for large design systems. (New issue)

3. **Sub-agent tool pre-loading** — Pass discovered tool schemas in sub-agent prompts. Saves ~5 ToolSearch calls per session. (Existing [TOOL-005])

### Agent Behavior Updates

1. **Cross-tool timeout tracking** — Count timeouts across all tools toward the "2 timeouts → reconnect" threshold, not just identical tool names. (New issue)

2. **"Read pipeline output, not source tokens"** — Existing [AGENT-012]. Saves ~23 calls.

3. **Validate on 1 before mass rollout** — Existing [AGENT-011]. Recurred in this session.
