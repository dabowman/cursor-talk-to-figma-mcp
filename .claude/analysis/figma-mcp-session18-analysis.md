# Figma MCP Session 18 Analysis

## Session Overview

- **Transcript**: `a9dc0f98-5cd9-47f9-a7c7-b68ecdfe347f.json`
- **Duration**: 73 minutes
- **Total tool calls**: 279
- **Total errors**: 0 (formal), 16 soft errors (15 timeouts + 1 font error returned as success)
- **Reconnections**: 14 (all in a 10-minute burst during Block Editor component imports)
- **Context restarts**: 0
- **Sub-agents**: 0
- **Task**: Import all 48 WPDS library component sets into a blank Figma file as an organized component reference page. Build a 2-column grid layout with 8 categorized sections (Actions, Input & Selection, Containers, Feedback, Overlays, Data Views, Block Editor, Site Editor).

## Metrics

| Metric | Session 17 | Session 18 | Change |
|---|---|---|---|
| Total tool calls | 216 | 279 | +29% (larger scope) |
| Figma tool calls | 99 | 273 | +176% |
| ToolSearch calls | 14 (14.1%) | 6 (2.2%) | Improved significantly |
| Errors (soft) | 10 | 16 | +60% (timeout-heavy) |
| Estimated waste % | ~35% | ~18% | Improved |

## Tool Call Distribution

| Tool | Calls | Notes |
|---|---|---|
| `clone_and_modify` | 82 | Reparenting instances into category frames (no native reparent tool) |
| `import_library_component` | 76 | 60 unique components, 16 retries after timeouts |
| `get_component_variants` | 48 | Variant discovery — 2 runs of 24 and 22 consecutive calls |
| `join_channel` | 14 | All reconnections during timeout cascade |
| `move_node` | 12 | Manual repositioning in 2-column grid |
| `get` | 11 | Structure/layout inspection |
| `ToolSearch` | 6 | Low overhead — good batch discovery |
| `create` | 6 | Section frames, wrapper frames |
| `delete_multiple_nodes` | 6 | Cleanup of originals after reparenting |
| `set_focus` | 5 | View navigation |
| `search_library_components` | 3 | Finding Secondary/Tertiary button variants |
| `delete_node` | 3 | Individual cleanup |
| `apply` | 2 | Styling sections (fill, radius, padding) |
| `reorder_children` | 2 | Logical ordering in sections |
| `get_document_info` | 2 | Initial discovery + verification |
| `get_library_components` | 1 | Library catalog discovery |

**Totals**: 6 ToolSearch + 273 Figma = 279. Soft errors: 16 (15 timeouts + 1 font error).

## Efficiency Issues

### 1. Timeout cascade on complex library components (saves ~29 calls)

15 `import_library_component` calls timed out importing Block Editor components (Canvas, ColorPalette, BlockInserter, EditorHeader, DuotonePicker, DuotoneSwatch, Inspector/Block, DataForm, DataviewsOptions, SampleMenu, CommandInput). Each timeout triggered a `join_channel` reconnection before the next retry. 14 reconnections consumed 14 calls. All 15 components eventually imported successfully on retry.

**Pattern observed:** Calls #200-235 — a cycle of `import → timeout → join_channel → import → timeout → join_channel` for 10 minutes straight. Agent correctly diagnosed connection drops after 2 timeouts but the root cause was import complexity (large component trees), not actual connection loss.

**Root cause:** `import_library_component` shares the same 30-second timeout as simple tools, but importing complex library components (with deep nested structures and multiple fonts) can take significantly longer. The plugin doesn't send progress updates during library imports, so the inactivity timer expires.

**Proposed fix:** Either (a) increase timeout for `import_library_component` specifically (e.g., 60s), or (b) send periodic progress updates from the plugin during library component import to keep the inactivity timer alive. Also: agent should recognize that repeated timeouts on the same type of operation (library import) with successful reconnections suggest the operation itself is slow, not that the connection is flaky.

**Estimated savings:** ~29 calls (14 join_channel + 15 timed-out imports that had to be retried).

### 2. No batch `import_library_component` (saves ~50+ calls)

76 sequential `import_library_component` calls — the single most-called tool. Agent imported components one at a time, sometimes in rapid-fire runs of 34 consecutive calls. A batch variant accepting an array of `{componentKey, name, parentNodeId}` would collapse these into ~3-4 calls.

**Pattern observed:** Calls #33-74 — 42 consecutive `import_library_component` calls importing all initial components.

**Root cause:** No batch variant exists. Previously identified as [TOOL-012].

**Proposed fix:** Add `import_library_components` (plural) accepting array of component keys. Chunked execution in plugin (e.g., 10 per batch) with progress updates.

**Estimated savings:** 76 calls → ~8 calls (10 components per batch).

### 3. No batch `get_component_variants` (saves ~40+ calls)

48 sequential `get_component_variants` calls in two bursts (24 and 22 consecutive). Agent discovered variants for all 48 component sets by calling one at a time.

**Pattern observed:** Calls #5-30 (24 consecutive) and #176-197 (22 consecutive). All used the same `fileKey`.

**Root cause:** No batch variant exists. Previously identified as [TOOL-013].

**Proposed fix:** Add batch variant accepting array of componentSetNodeIds. Return all variants in one response.

**Estimated savings:** 48 calls → ~5 calls.

### 4. Clone-and-modify reparenting pattern (saves ~40 calls)

82 `clone_and_modify` calls used solely for reparenting (moving instances from page root into categorized section frames). Since `move_node` only changes x/y and there's no `reparent_node`, the agent had to clone each node into the target parent, then delete the originals in batches.

**Pattern observed:** Import 38 components to page root → clone all 38 into section frames → delete 38 originals. Then again for the second batch of 23 components.

**Root cause:** Font loading bug in `import_library_component` with `parentNodeId` ([BUG-004]) forces importing to page root. No native reparent tool exists.

**Proposed fix:** Fix [BUG-004] so `import_library_component` can import directly into target frames. This eliminates the entire clone+delete cycle.

**Estimated savings:** ~82 clone + ~6 delete_multiple = ~88 calls → 0 if direct import works. More realistically, even a batch reparent tool would save ~60 calls.

### 5. Manual grid positioning (saves ~10 calls)

12 `move_node` calls to position 6 frames in a 2-column grid, done twice (first attempt + repositioning after size changes). Agent calculated x/y coordinates manually.

**Pattern observed:** Calls #131-136 (first layout pass), #160-165 (second pass after padding changed sizes).

**Root cause:** No auto-layout at the page level (Figma limitation). Agent eventually solved this by creating a wrapper frame with horizontal wrap auto-layout (call #167), eliminating future manual positioning.

**Self-corrected:** Agent recognized the problem and created a wrapper frame with auto-layout. Good adaptation.

## Error Analysis

### 1. Import timeout cascade (15 timeouts, ~10 minutes lost)

15 `import_library_component` calls timed out on complex Block Editor components. Error messages returned as `"Error importing library component: Request to Figma timed out"` but with `is_error: false` — the MCP server wraps timeouts in successful responses.

**Agent recovery:** Agent correctly identified connection drops after 2 timeouts, reconnected via `join_channel`, and retried. However, it continued the same pattern for 14 reconnection cycles (10 minutes) before trying a different strategy (skipping complex components and retrying later). Eventually all components imported after the Figma process caught up.

**Fix needed:** (1) Plugin should send progress updates during library imports. (2) MCP server should set `is_error: true` for timeout responses so agents can distinguish timeouts from actual errors. (3) Agent should recognize pattern: if same operation times out 3+ times across reconnections, the operation is slow, not the connection.

### 2. Font loading error on direct parent insertion (1 failure)

Call #32: `import_library_component` with `parentNodeId=1:6` failed with `"unloaded font 'SF Pro Regular'"`. Agent adapted immediately — imported to page root instead and used clone_and_modify for reparenting.

**Agent recovery:** Excellent — recognized the issue in 1 call, adapted strategy immediately.

**Fix needed:** [BUG-004] — `import_library_component` should load fonts before appendChild.

## What Worked Well

1. **Low ToolSearch overhead.** Only 6 calls (2.2%) — best ratio across all sessions. Agent batched tool discovery effectively with multi-tool `select:` queries.

2. **Clean page organization.** Agent built a well-structured 8-section reference page with 48 component sets, logical categorization, and proper cleanup. Zero stray nodes at the end.

3. **Quick error adaptation.** When `import_library_component` with `parentNodeId` failed, agent adapted in 1 call and found a working workaround. When timeouts persisted, agent correctly diagnosed connection issues and reconnected.

4. **Auto-layout wrapper insight.** Agent recognized manual positioning was fragile and created a wrapper frame with horizontal wrap auto-layout — good self-correction that eliminated future positioning overhead.

5. **Thorough cleanup.** 6 `delete_multiple_nodes` calls removed all originals and stray instances. Final `get_document_info` verified clean state.

6. **Effective use of `get` tool.** 11 calls with appropriate detail levels (structure for orientation, layout for dimensions). No redundant re-inspections.

## Priority Improvements

### Tool Changes (ranked by call savings)

1. **Batch `import_library_component`** — [TOOL-012]. Accept array of `{componentKey, name, parentNodeId}`. Saves ~68 calls/session. This was 27% of all calls in this session.
2. **Batch `get_component_variants`** — [TOOL-013]. Accept array of componentSetNodeIds. Saves ~43 calls/session. Was 17% of all calls.
3. **Fix `import_library_component` font loading** — [BUG-004]. Load fonts before appendChild when `parentNodeId` specified. Eliminates entire clone+delete reparenting cycle (~88 calls).
4. **Import timeout handling** — Increase timeout or add progress updates for library imports. Saves ~29 calls (14 reconnections + 15 retries).

### Agent Behavior Updates

1. **Distinguish slow operations from connection drops.** If the same operation type times out 3+ times but reconnection succeeds immediately each time, the operation is slow — increase per-call timeout or skip and retry later. Don't reconnect 14 times.
2. **Import directly with `parentNodeId` for simple components.** The font error only affects components with custom fonts. Simple components (pure frames/shapes) could import directly.
