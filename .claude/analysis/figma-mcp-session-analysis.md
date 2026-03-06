# Figma MCP Session Analysis: Efficiency & Error Audit

## Session Overview

- **Duration**: Single extended session (with 1 context overflow / continuation)
- **Pages**: 15 HTML pages of conversation
- **Total events**: 866 message events
- **Total tool calls**: 308
- **Total errors**: 16
- **Channel reconnections**: 8 (channels: dbq4qehs → hsuv0m3z → z4y6ahdr → enlbbqiw → 5jc68ktd → vupkqh40 → oes1arny → pvh67iln)
- **Context overflow**: 1 (session continued at page 9)
- **Phases completed**: Phase 1 (text content) ✅, Phase 2 (Activity layout variant) ✅ (partially — structure built, not code-accurate)
- **Phases remaining**: Phase 3 (State variant property), Phase 4 (DataForm), Phase 5 (cleanup)

---

## 1. Efficiency Problems

### 1.1 ToolSearch Overhead — 33 calls (10.7% of all tool calls)

Every time the agent needed a Figma MCP tool, it called `ToolSearch` first. This happened repeatedly for the *same* tools across the session. The agent rediscovered `set_layout_sizing`, `create_frame`, `get_node_info`, etc. multiple times.

**Root cause**: Claude Code requires tool discovery before first use of an MCP tool, and the discovery cache doesn't persist across context windows or reconnections.

**Recommendations**:
- **Pre-load tool schemas at session start.** After joining a channel, immediately run a single ToolSearch to batch-discover all TalkToFigma tools. Cache the full list in a MEMORY.md or session context block so the agent doesn't need to rediscover.
- **Add a `list_tools` command to the MCP server** that returns all available tool names and schemas in one call. The agent reads this once at the start and never needs ToolSearch again.
- **In the system prompt / skill file**, include the complete tool schema reference so the agent already knows parameter names and types without discovery.

### 1.2 One-at-a-Time Frame Construction — 120 Figma calls on page 14 alone

Building 6 activity items required creating each frame, then setting its sizing, then creating children, then setting *their* sizing, etc. The agent made runs of 5-10 identical consecutive calls (`create_frame` × 5, `set_layout_sizing` × 5, `create_frame` × 5...) to build repetitive structures.

**The numbers tell the story:**
| Tool | Count | Notes |
|------|-------|-------|
| create_frame | 54 | Most-called tool in the entire session |
| set_layout_sizing | 50 | Almost always paired 1:1 with create_frame |
| create_text | 29 | Each text node is a separate call |
| set_corner_radius | 9 | Called individually per bullet |
| set_padding | 8 | Called individually per content frame |

**Recommendations**:
- **Build a `create_frame_with_layout` composite tool** that accepts layout mode, sizing, padding, spacing, and fill color in a single call. This would eliminate the create→set_sizing→set_padding→set_fill 4-call chain into 1.
- **Build a `create_activity_item` (or generic `create_structured_frame`) tool** that accepts a JSON tree describing nested frames + text and builds the entire subtree in one call. This would reduce the 20+ calls per activity item to 1.
- **Build a `batch_operations` tool** that accepts an array of operations to execute sequentially. This would allow the agent to send one request containing "create 5 frames, set all their sizing, add children" rather than 15 separate round-trips.
- **At minimum, add batch variants of common tools**: `create_multiple_frames`, `set_multiple_layout_sizings`, `set_multiple_paddings` (following the pattern of `set_multiple_text_contents` which already exists and was used effectively — 5 batch calls vs 2 individual calls).

### 1.3 Excessive get_node_info Calls — 21 calls

The agent frequently called `get_node_info` to inspect nodes it had *just created*. After creating a frame, it would immediately call `get_node_info` to check its properties, then decide what to set next.

**Recommendations**:
- **Make creation tools return richer responses.** `create_frame` should return the full node info (id, children, layout properties) in its response, not just the id. This eliminates the follow-up inspection call.
- **Have `create_frame_with_layout` return the complete node state** after applying all properties, so the agent can verify without a separate `get_node_info`.

### 1.4 Delete-and-Recreate Cycles (Wasted Work)

Three significant delete-and-recreate cycles occurred:

1. **Rectangles → Frames (p09-10)**: Agent created rectangles for timeline lines, discovered rectangles don't support `layoutSizingVertical`, deleted them, recreated as frames.
2. **Child reordering (p09-10)**: Agent created Bullet, Line top, Line bottom in wrong order, had no reorder tool, deleted all three and recreated in correct order.
3. **List items → Activity items (p14)**: Agent deleted 8 List/Item instances from the Activity variant, then manually recreated 6 activity items from scratch because `create_component_instance` couldn't be used (stale schema / componentKey issue).

**Recommendations**:
- **Add a `reorder_children` tool** to avoid delete-recreate just for ordering.
- **Document Figma node type capabilities in the skill file.** Make it explicit that rectangles don't support auto-layout sizing properties — only frames do. This prevents the agent from attempting operations that will fail.
- **Include a "Figma primitives cheat sheet"** in the system prompt or skill: which node types support which properties (auto-layout, layout sizing, constraints, etc.).

### 1.5 Channel Reconnection Tax — 8 reconnections

Each MCP server restart forced a new channel, which meant: join_channel call + ToolSearch to rediscover tools + re-establish context about what was being worked on. The 8 reconnections consumed ~40+ tool calls in overhead.

**Root cause**: The WebSocket relay between the MCP server and Figma plugin is fragile. Any code change to the MCP server requires a restart, which drops the connection.

**Recommendations**:
- **Implement auto-reconnect in the WebSocket relay** so server restarts don't require a new channel.
- **Consider hot-reloading** for MCP tool definitions so adding a new tool doesn't require a full server restart.
- **At minimum, make the channel persistent** — if the Figma plugin detects a disconnect, it should try to rejoin the same channel rather than requiring a new one.

---

## 2. Error Patterns

### 2.1 Type Mismatch Errors (p09) — 8 errors from 2 root causes

**Error**: `Invalid arguments for tool set_corner_radius: expected number, received string` and same for `set_fill_color`.

The agent passed string values like `"4"` instead of the number `4` for `radius`, and `"0.85"` instead of `0.85` for color values. When one call in a parallel batch errors, all parallel calls are cancelled — so 2 root errors cascaded into 8 total errors.

**Recommendations**:
- **Add type coercion in the MCP server tool handlers.** If a parameter schema says `number` but receives a string that parses as a number, coerce it rather than rejecting. This is a trivially fixable robustness issue.
- **Make tool schemas more permissive with `oneOf: [number, string]`** or use preprocessing to handle LLM output quirks.
- **In the skill file, add explicit type examples**: "radius expects a number: `4` not `"4"`".

### 2.2 Figma API Capability Gaps

**`set_layout_sizing` on rectangles (p09-10)**: Rectangles in Figma don't support `layoutSizingVertical` — they use `layoutGrow` instead. The agent had to discover this at runtime, delete the rectangles, and recreate as frames.

**`set_fill_color` with alpha (p11)**: The agent tried to set fills with `opacity: 0` to make frames transparent, but the tool ignored the alpha channel. The agent observed the fills were still fully opaque and worked around it.

**Recommendations**:
- **For `set_fill_color`**: ensure the plugin handler passes the `opacity` field through to Figma's fill object. Currently it appears to be silently dropped.
- **For `set_layout_sizing`**: either make the tool handle rectangles by internally converting `layoutSizingVertical: "FILL"` to `layoutGrow: 1`, or return a clear error message explaining that rectangles need `layoutGrow` instead.
- **Add a `remove_fills` tool** (or support `opacity: 0` correctly) since making nodes transparent is a common operation.

### 2.3 Instance/Component Confusion (p02-03)

The agent initially inspected and attempted to modify an INSTANCE of the DataViews component (`_Component Use Cases`, id `16547:36680`) rather than the main COMPONENT_SET. It made a plan based on the instance's structure, then discovered the scope was wrong when the user pointed it out.

**Root cause**: `read_my_design` returned the instance on the current page, and `get_selection` confirmed it was selected. The agent didn't distinguish between instance and component.

**Recommendations**:
- **In the skill file, add a "verify your target" protocol**: Before modifying anything, check whether the selected node is a COMPONENT, COMPONENT_SET, or INSTANCE. If it's an instance, find and navigate to the main component first.
- **Add a `get_main_component` tool** that, given any instance, returns the id and info of its main component.
- **Have `get_node_info` include an `isInstance` flag and `mainComponentId`** so the agent can immediately see when it's looking at an instance.

### 2.4 Stale Tool Schema / create_component_instance Saga (p11-14)

The agent spent ~30 tool calls across 4 pages trying to create component instances. The issue: the MCP tool schema exposed to Claude only had `componentKey` (which requires Figma's internal key hash), while the plugin code already supported `componentId` (which accepts node IDs). The schema wasn't being refreshed after server restarts.

**Recommendations**:
- **This is the single biggest efficiency fix available.** Ensure MCP tool schemas are always fresh after a server restart. Investigate whether Claude Code caches tool definitions and if so, how to force a refresh.
- **Add `componentId` as the primary parameter in the schema**, with `componentKey` as the fallback. Most agent workflows have node IDs readily available; component keys are harder to obtain.
- **Add a `get_component_key` tool** that returns the component key given a node ID, as a fallback if `componentId` support can't be fixed.

### 2.5 Bash/Python Script Errors (p02-03)

Two bash errors from malformed Python scripts: a line continuation character issue (`\!= name`) and a KeyError from incorrect JSON traversal. These happened during the initial analysis phase when the agent was parsing the large `read_my_design` output.

**Recommendations**:
- **The `read_my_design` tool returned 309,417 characters** — far too large for the context window. This forced the agent into a complex chunked-reading workflow with bash/python scripts, which introduced errors.
- **Add a `read_my_design` variant with depth limits and filters** (e.g., `read_design_summary` that returns only the top-level structure with node types, names, and IDs but not full property dumps).
- **Support `get_node_info` with `depth` parameter** that was attempted but not functional in this session.

---

## 3. Prioritized Recommendations

### Tier 1: Highest Impact (implement first)

1. **Composite `create_frame_with_layout` tool** — Eliminates the #1 and #2 most-called tools (create_frame + set_layout_sizing = 104 of 308 calls). Accept: name, parent, layoutMode, sizing, padding, spacing, fill, cornerRadius, children. Return: full node info.

2. **`batch_operations` tool** — Accept an array of `{tool, params}` objects, execute them sequentially, return all results. Reduces 120 calls on page 14 to ~10-15.

3. **Fix tool schema freshness** — Ensure MCP server restarts propagate new schemas to Claude Code immediately. This was the root cause of the entire p11-14 `create_component_instance` saga.

4. **`reorder_children` tool** — Eliminates delete-recreate cycles for ordering.

5. **Type coercion in tool handlers** — Accept strings where numbers are expected, coerce internally. Eliminates the p09 cascade of 8 errors.

### Tier 2: High Impact

6. **Pre-populated tool reference in skill file** — List all tools with parameter names, types, and brief examples. Eliminates most of the 33 ToolSearch calls.

7. **Richer `create_*` responses** — Return full node info (not just id) from creation tools. Eliminates most of the 21 get_node_info calls.

8. **`get_node_info` with working `depth` parameter** — Reduces the need for recursive manual inspection.

9. **Figma primitives cheat sheet in skill file** — Document which node types support auto-layout, layout sizing, constraints, etc. Prevents rectangle vs frame confusion.

10. **`remove_fills` / proper alpha support in `set_fill_color`** — Handle the common "make transparent" operation correctly.

### Tier 3: Quality of Life

11. **Auto-reconnect in WebSocket relay** — Reduce the 8-reconnection tax.

12. **`get_main_component` tool** — Prevent instance vs component confusion.

13. **`read_design_summary` tool** — Structured high-level overview without 300K character dumps.

14. **`create_component_instance` accepting node IDs** — The tool should work with the IDs the agent already has.

15. **`clone_and_modify` composite tool** — Clone a node and apply modifications (rename, set properties) in a single call, since clone-then-modify is a frequent pattern.

---

## 4. Agent Behavior Improvements (Prompt / Skill-Level)

Beyond tooling changes, the agent's *behavior* during this session suggests some prompt-level improvements:

1. **"Verify before modify" protocol**: Always check if a selected node is an instance vs component before planning changes. Add this as a mandatory first step in any Figma modification workflow.

2. **"Prototype one, batch the rest" pattern**: When building repetitive structures (like 6 activity items), build the first one step-by-step, verify it's correct, then use that as a template to batch-create the rest. The agent did attempt this on p14 but still made each call individually.

3. **"Read the code first" rule**: The agent built the Activity layout variant by cloning the List variant and renaming text — completely wrong. Only after the user pushed back did it read the actual Gutenberg source code. The skill file should mandate: "Before building any Figma representation, read and understand the code implementation first."

4. **"Fail fast, ask early" rule**: When the agent encountered the `create_component_instance` schema issue, it spent 30+ calls trying workarounds instead of immediately telling the user "this tool's schema is stale, I need a server restart." Encode a heuristic: after 2 failed attempts at the same operation, stop and explain the blocker to the user.

5. **"Prefer cloning over building from scratch"**: When the existing component has sub-components with the right structure, clone and modify rather than building from primitives. The agent eventually did this for the Hover/Selected variants but not for the Activity items.

---

## 5. Session Statistics Summary

| Metric | Value |
|--------|-------|
| Total tool calls | 308 |
| Figma MCP calls | 242 (78.6%) |
| ToolSearch calls (overhead) | 33 (10.7%) |
| Bash/Read/Grep calls (analysis) | 42 (13.6%) |
| Errors | 16 (5.2% error rate) |
| Cascaded errors (from parallel batches) | 8 of 16 |
| Root cause errors | 8 |
| Channel reconnections | 8 |
| Context overflows | 1 |
| Estimated wasted calls (overhead + errors + rework) | ~80-100 (25-33%) |
| Phases completed | 2 of 5 |

**Bottom line**: Roughly a quarter to a third of all tool calls were overhead, errors, or rework. The biggest wins come from composite/batch tools (eliminating the create→configure→inspect chain), fixing tool schema freshness, and adding a Figma primitives reference to the skill file.
