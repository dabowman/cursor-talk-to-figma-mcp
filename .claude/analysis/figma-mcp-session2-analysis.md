# Figma MCP Session 2 Analysis

## Session Overview

**Transcript:** `aa24885d-a428-4a1b-a995-a257aa451621` (14 pages)  
**Duration:** ~80 minutes (21:44–23:10 UTC, March 6 2026)  
**Task:** Phase 3 of DataViews component — adding State variant property (Loading, Empty, Selection) across 4 layout variants, then binding design system variables/styles  
**Context restarts:** At least 1 (page 7 starts with continuation summary)  
**MCP restarts:** 4 (pages 3, 9, 11, 13 — user reconnected MCP to pick up new tools or fix bugs)

## Metrics

| Metric | Session 1 | Session 2 | Change |
|---|---|---|---|
| Total Figma tool calls | ~308 | 389 | +26% (larger scope) |
| Meta/overhead calls (ToolSearch, Read, Glob, etc.) | ~66 | 64 | -3% |
| ToolSearch calls | 33 (10.7%) | 28 (7.2%) | -15% |
| Estimated waste % | 25–33% | ~17.7% | Improved |

## Tool Call Distribution

| Tool | Calls | Notes |
|---|---|---|
| `bind_variable` | 132 | **#1 by far.** No batch version exists. |
| `get_node_info` | 85 | 29 redundant (same node re-inspected). 22 nodes hit >1 time. |
| `set_text_style` | 55 | 9 failed with sync/async bug. |
| `ToolSearch` | 28 | 4 consecutive failed searches for `bind_variable` on pages 10–11. |
| `Read` (file system) | 23 | Reading plan file + source code. |
| `set_layout_sizing` | 16 | — |
| `create_component_instance` | 13 | — |
| `swap_component_variant` | 12 | — |
| `export_node_as_image` | 11 | Visual verification. |
| `set_multiple_text_contents` | 10 | — |
| `join_channel` | 9 | 5+ were reconnects, not initial joins. |
| `scan_text_nodes` | 9 | — |
| `delete_multiple_nodes` | 7 | Working well. |
| `create_frame_tree` | 7 | **New tool, working well.** 41 nodes in 1 call for skeleton rows. |
| `clone_node` | 4 | Used efficiently for variant cloning (was 0 in session 1). |

---

## Efficiency Issues

### 1. `bind_variable` needs a batch version (CRITICAL — saves ~100+ calls)

132 individual `bind_variable` calls dominated the session. The longest uninterrupted run was **28 consecutive calls**. The agent spent ~13 minutes (22:56–23:09) almost exclusively calling `bind_variable` one at a time.

**Pattern observed:** The agent frequently needs to bind multiple fields on the same node (fill + stroke, or fill + stroke + cornerRadius). 16 nodes received multiple bindings. But even across different nodes, the agent is applying the same variable to dozens of nodes in a batch (e.g., binding `gray-700` to 18 text fill colors).

**Proposed tool — `batch_bind_variables`:**

```json
{
  "bindings": [
    { "nodeId": "31306:16974", "field": "fill", "variableId": "VariableID:15613:5786" },
    { "nodeId": "31306:16975", "field": "fill", "variableId": "VariableID:15613:5784" },
    { "nodeId": "31306:16970", "field": "fill", "variableId": "VariableID:15613:5791" },
    { "nodeId": "31306:16970", "field": "stroke", "variableId": "VariableID:15613:5780" },
    { "nodeId": "31306:16970", "field": "cornerRadius", "variableId": "VariableID:2272:18561" }
  ]
}
```

This would collapse most of those 132 calls into ~8–10 batch calls. The agent already groups conceptually ("Now the 18 Text cells → gray-700"), it just has no batch tool to execute them.

**Estimated savings:** ~120 calls → ~10 calls.

### 2. `set_text_style` also needs a batch version (saves ~45 calls)

55 individual `set_text_style` calls. The agent applies the same style (e.g., "Heading MD") to 9+ nodes at a time.

**Proposed tool — `batch_set_text_styles`:**

```json
{
  "assignments": [
    { "nodeId": "18464:37474", "styleId": "S:5a04..." },
    { "nodeId": "18464:37498", "styleId": "S:5a04..." }
  ]
}
```

**Estimated savings:** ~55 calls → ~6 calls.

### 3. `get_node_info` still redundant (29 extra calls)

85 total calls, but only 56 unique nodes inspected. 22 nodes were queried more than once. The worst offender was node `31306:16961` (Activity Item Default) — inspected **5 times** at different depths.

**Root causes:**
- Agent inspects a node at depth=1, then needs depth=2 later — could have gone deeper the first time
- Context window restart (page 7) forces re-inspection of previously known nodes
- Agent inspects a node, does work, then inspects again to verify

**Proposed improvements:**
- `get_node_info` should default to depth=2 (not depth=1) to reduce follow-up requests
- Agent skill should instruct: "request depth=3 on first inspection of component internals"
- Consider a `get_multiple_nodes_info` batch tool for parallel inspection

### 4. ToolSearch discovery still fragile (28 calls, 4 failed searches)

On pages 10–11, the agent tried 4 different search queries to find `bind_variable` and `set_text_style`:

1. `"bind variable style node figma"` → loaded wrong tools
2. `"set variable bind apply"` → loaded wrong tools
3. `"+TalkToFigma variable"` → loaded wrong tools
4. `"+TalkToFigma bind set style apply text"` → loaded wrong tools

The tools weren't available because the MCP hadn't been restarted to pick them up. But the agent couldn't distinguish "tool doesn't exist" from "tool exists but my search query didn't match." It burned 4 calls trying different search strategies before the user restarted the MCP.

**Proposed improvement:** ToolSearch should return more explicit feedback like "No tools matching 'bind_variable' found in the TalkToFigma server" vs "Found 0 results" — so the agent knows to ask the user to restart rather than keep searching.

---

## Error Analysis

### 1. `set_text_style` sync/async bug (9 failed calls + 3 code fix attempts + user restart)

At 22:59:50, all `set_text_style` calls started failing with:

> Error setting text style: in set_textStyleId: Cannot call with documentAccess: dynamic-page. Use node.setTextStyleIdAsync instead.

The agent correctly diagnosed the issue (sync vs async API in Figma plugin), then spent 3 calls trying to fix the plugin code itself (Grep → Read → attempted Edit). The user rejected the edit and fixed it themselves, then restarted the MCP.

**Total waste:** 9 failed tool calls + 3 code fix attempts + MCP restart time ≈ 12 calls + ~5 minutes.

**Plugin fix needed:** The `set_text_style` handler in `code.js` must use `setTextStyleIdAsync` instead of the sync `textStyleId` setter when running with `documentAccess: "dynamic-page"`. This is a Figma API requirement.

**Agent behavior note:** The agent did the right thing by trying to fix the code. But per the existing skill guidance ("fail fast after 2 failed attempts"), it should have told the user after the first 2 failures instead of continuing to fire 7 more identical calls.

### 2. Timeouts on page 8 (5 failures, ~4 minutes lost)

Five consecutive `get_node_info` calls timed out between 22:23–22:25. The Figma plugin had disconnected.

**Agent recovery timeline:**
1. Two `get_node_info` calls with `depth: 3` → timeout
2. Retried with `depth: 2` → timeout
3. Tried `join_channel` → succeeded but next call still timed out
4. Asked user to check plugin → user restarted → agent tried auto-discover → failed → then used channel name → success

**Issue:** The agent correctly reduced depth on first retry (good), then correctly identified connection issue and asked the user (good). But it made 5 timeout calls before escalating. The timeout itself is 30 seconds per call, so this was ~2.5 minutes of waiting.

**Proposed improvements:**
- Agent skill: "After 2 consecutive timeouts, assume connection is lost and ask the user immediately"
- `get_node_info` could have a shorter timeout (10s instead of 30s) to fail faster
- `join_channel` auto-discover should be more reliable (failed 3 times in this session)

### 3. `get_local_components` output too large (page 6)

The `get_local_components` response was 107,546 characters, exceeding the token limit. The agent then tried to parse the result via Bash but hit a Python error, then tried to read the saved file but it was 50,420 tokens — also too large.

**Proposed fix:** `get_local_components` should accept a `filter` parameter (name pattern, type) to reduce response size. Or return a paginated/summarized result.

---

## What Worked Well

1. **`create_frame_tree` is a huge win.** Built 41 nodes (8 skeleton rows with 4 rectangles each) in a single call. In session 1, this would have been ~50+ individual calls.

2. **`delete_multiple_nodes` working smoothly.** Deleted 11 nodes in 1 call. Clean success.

3. **`set_multiple_text_contents` used correctly.** 10 calls for batch text updates.

4. **Clone-and-modify workflow.** The agent cloned variants efficiently (12 clones in rapid succession) then renamed them systematically. Much better than building from scratch.

5. **The agent's variable binding strategy was sound.** It systematically worked through component hierarchy: sub-components first, then internal text nodes, grouping by variable type. The problem is purely tool-level — it needs a batch tool.

6. **`scan_text_nodes` provided good discovery.** Used 9 times to discover text node IDs before binding, reducing the need for deep `get_node_info` traversal.

---

## Priority Improvements

### Tool Changes (ranked by call savings)

1. **`batch_bind_variables`** — Accept array of `{nodeId, field, variableId}`. Saves ~120 calls per session.
2. **`batch_set_text_styles`** — Accept array of `{nodeId, styleId}`. Saves ~45 calls per session.
3. **`get_local_components` filtering** — Add `nameFilter` parameter. Avoids oversized responses.
4. **`set_text_style` async fix** — Use `setTextStyleIdAsync` in plugin code. Eliminates 9 error calls.
5. **`get_node_info` default depth** — Increase default to depth=2. Saves ~15 redundant re-inspections.
6. **`join_channel` auto-discover reliability** — Fix so it works after MCP restart. Saves 3–5 calls per session.

### Agent Skill Updates

1. **"Fail fast on repeated identical errors"** — After 2 identical error responses, stop and tell the user. Don't fire 7 more.
2. **"After 2 timeouts, assume disconnection"** — Don't retry 3+ times with the same call. Ask user to check connection.
3. **"Request depth=3 for component internals on first inspection"** — Reduce follow-up depth escalation.
4. **"Group bind_variable calls by concept and tell user what you're about to do"** — The agent already does this well. Once batch tools exist, the grouping maps directly to batch calls.

---

## Session 1 vs Session 2 Comparison

| Issue from Session 1 | Status in Session 2 |
|---|---|
| No composite tools (create_frame + set_layout_sizing always paired) | ✅ `create_frame_tree` solved this — 41 nodes in 1 call |
| ToolSearch overhead (33 calls / 10.7%) | ⬆️ Slightly improved (28 calls / 7.2%) but still significant |
| Excessive get_node_info (21 calls) | ⬇️ Worse (85 calls) but session scope was larger |
| Delete-recreate cycles from missing reorder_children | ✅ Not observed — clone workflow avoided this |
| Rectangle vs frame confusion | ✅ Not observed |
| No batch operations | 🔴 Still the #1 problem — `bind_variable` ×132 |
