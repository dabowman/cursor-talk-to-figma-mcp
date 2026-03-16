# Figmagent Improvement Tracker

Last updated: 2026-03-16
Sessions analyzed: 17

## Active Issues

### [TOOL-001] bind_variable needs batch version
- **Status**: verified
- **Priority**: P0
- **Category**: missing-batch-tool
- **First seen**: Session 2 (2026-03-06)
- **Sessions affected**: 2, 5
- **Estimated savings**: ~120 calls/session
- **Description**: 132 individual `bind_variable` calls dominated session 2. Longest uninterrupted run was 28 consecutive calls. Agent groups conceptually but has no batch tool to execute.
- **Current status**: Implemented via `apply` tool with `variables` field — accepts map of field→variableId for design token bindings on one or many nodes.
- **Verified in**: Session 4 — agent bound 93 nodes across 12 `apply` calls with zero individual bind_variable usage.
- **Note**: Session 5 still used 3 legacy `bind_variable` calls (predates `apply` consolidation).

### [TOOL-002] set_text_style needs batch version
- **Status**: verified
- **Priority**: P0
- **Category**: missing-batch-tool
- **First seen**: Session 2 (2026-03-06)
- **Sessions affected**: 2, 5
- **Estimated savings**: ~45 calls/session
- **Description**: 55 individual `set_text_style` calls. Agent applies same style to 9+ nodes at a time.
- **Current status**: Implemented via `apply` tool with `textStyleId` field — deduplicates font loading across multiple nodes automatically.
- **Verified in**: Session 4 — text styles applied via `apply` in batch, zero individual set_text_style calls.
- **Note**: Session 5 still used 3 legacy `set_text_style` calls.

### [BUG-001] set_text_style sync/async bug
- **Status**: verified
- **Priority**: P0
- **Category**: plugin-bug
- **First seen**: Session 2 (2026-03-06)
- **Sessions affected**: 2
- **Estimated savings**: 12 calls + ~5 minutes per occurrence
- **Description**: `set_text_style` handler used sync `textStyleId` setter, fails with `documentAccess: dynamic-page`. Needs `setTextStyleIdAsync`. 9 failed calls + 3 code fix attempts in session 2.
- **Fix pattern**: sync-to-async
- **Current status**: Fixed — async API used throughout plugin code.
- **Verified in**: Session 4 — zero sync/async errors across all text style operations.

### [TOOL-003] get_local_components output too large
- **Status**: implemented
- **Priority**: P1
- **Category**: missing-tool
- **First seen**: Session 2 (2026-03-06)
- **Sessions affected**: 2
- **Estimated savings**: avoids context overflow
- **Description**: Response was 107,546 characters, exceeding token limit. Agent tried Bash/Python parsing workarounds.
- **Current status**: Implemented via output budget system — 30K char default, `maxOutputChars` parameter to adjust. `preferredValues` arrays stripped from instance `componentProperties`.

### [TOOL-004] get_node_info default depth too shallow
- **Status**: implemented
- **Priority**: P1
- **Category**: agent-behavior
- **First seen**: Session 1 (2026-03-05)
- **Sessions affected**: 1, 2
- **Estimated savings**: ~15-29 redundant re-inspections per session
- **Description**: Agent inspects at depth=1 then needs depth=2 later. 22 nodes queried more than once in session 2.
- **Current status**: CLAUDE.md now instructs "Always start with detail=structure and depth=2" and the `get` tool enforces this guidance.
- **Verified in**: Session 4 — zero `get` calls needed for re-inspection (creation-focused session).

### [TOOL-005] ToolSearch overhead
- **Status**: identified
- **Priority**: P1
- **Category**: infrastructure
- **First seen**: Session 1 (2026-03-05)
- **Sessions affected**: 1, 2, 4, 5, 6, 7, 9, 10, 11, 13, 15, 16, 17
- **Estimated savings**: ~20-33 calls/session (long sessions), ~2-8 calls/session (short sessions)
- **Description**: Agent rediscovers same tools repeatedly. 33 calls in session 1 (10.7%), 28 in session 2 (7.2%), 35 in session 5 (13.5%), 8 in session 4 (14.3%), 3 in session 6 (4.4%), 2 in session 7 (8.3%), 7 in session 9 (43.8% — worst ratio, dominated a short exploration session). Worst after reconnections or in short sessions where overhead ratio is high.
- **Proposed fix**: Pre-load tool schemas at session start; auto-restore after reconnections; add complete tool reference to skill file.

### [AGENT-001] Fail fast on repeated identical errors
- **Status**: verified
- **Priority**: P1
- **Category**: agent-behavior
- **First seen**: Session 2 (2026-03-06)
- **Sessions affected**: 2
- **Description**: Agent fired 7 more identical `set_text_style` calls after first 2 failures. Should stop after 2 and tell user.
- **Current status**: CLAUDE.md now includes "After 2 consecutive identical errors on the same tool, stop retrying and diagnose the root cause".
- **Verified in**: Session 4 — both errors recovered in exactly 1 retry each.

### [AGENT-002] After 2 timeouts assume disconnection
- **Status**: verified
- **Priority**: P1
- **Category**: agent-behavior
- **First seen**: Session 2 (2026-03-06)
- **Sessions affected**: 2
- **Description**: 5 consecutive timeout calls before escalating. 30s per call = ~2.5 minutes wasted.
- **Current status**: CLAUDE.md now includes "After 2 timeouts in a row, assume the WebSocket connection is lost — call join_channel to re-establish before retrying".
- **Verified in**: Session 4 — zero timeouts observed.

### [TOOL-006] Type coercion for tool parameters
- **Status**: identified
- **Priority**: P1
- **Category**: type-coercion
- **First seen**: Session 1 (2026-03-05)
- **Sessions affected**: 1
- **Estimated savings**: eliminates cascading error batches (8 errors from 2 root causes in session 1)
- **Description**: Agent passes `"4"` instead of `4` for radius, `"0.85"` instead of `0.85` for colors. When one call in parallel batch errors, all parallel calls cancelled.
- **Fix pattern**: type-coercion
- **Auto-fixable**: yes (add `toNumber()` coercion or Zod `.transform(Number)`)

### [INFRA-001] Channel reconnection tax
- **Status**: mixed
- **Priority**: P2
- **Category**: infrastructure
- **First seen**: Session 1 (2026-03-05)
- **Sessions affected**: 1, 2, 5, 13, 17
- **Description**: 8 reconnections in session 1 consuming ~40+ overhead calls. Session 5 had ~8 reconnections (14 `join_channel` calls) over 139 minutes. Session 13 had 3 reconnections (model switch + wrong channel guess + multi-channel). Session 17 had 2 reconnections after ~90 minutes, preceded by 3 consecutive timeouts. Short sessions (4, 6, 7) had zero.
- **Current status**: Auto-join improved for short sessions. Long sessions (>1hr) still experience WebSocket drops requiring manual `join_channel`. Each reconnection triggers ToolSearch re-discovery overhead.
- **Verified in**: Sessions 4, 6, 7 — zero reconnections in short sessions.

### [AGENT-003] Verify instance vs component before modifying
- **Status**: implemented
- **Priority**: P2
- **Category**: agent-behavior
- **First seen**: Session 1 (2026-03-05)
- **Sessions affected**: 1
- **Description**: Agent modified INSTANCE instead of COMPONENT_SET. Wasted planning work on wrong node.
- **Current status**: CLAUDE.md key patterns now document instance vs component handling. `get` returns `componentRef` in `defs.components` for instances.

### [TOOL-007] Composite create tool
- **Status**: verified
- **Priority**: P0
- **Category**: missing-tool
- **First seen**: Session 1 (2026-03-05)
- **Sessions affected**: 1
- **Estimated savings**: ~104 calls (create_frame + set_layout_sizing were #1 and #2 most-called tools)
- **Current status**: `create` tool handles single nodes, nested trees, components, and instances. FILL sizing applied in second pass.
- **Verified in**: Session 2, Session 4 (79 nodes in 14 calls), Session 5 (39-node tree in 1 call)

### [TOOL-008] reorder_children tool
- **Status**: implemented
- **Priority**: P1
- **Category**: missing-tool
- **First seen**: Session 1 (2026-03-05)
- **Sessions affected**: 1
- **Description**: Agent had to delete and recreate nodes just to change ordering.
- **Current status**: `reorderChildren` command exists in modify.js.
- **Verified in**: Session 2 (no delete-recreate cycles observed for ordering)

### [TOOL-009] read_my_design response too large
- **Status**: implemented
- **Priority**: P1
- **Category**: missing-tool
- **First seen**: Session 1 (2026-03-05)
- **Sessions affected**: 1
- **Description**: `read_my_design` returned 309,417 characters. Forced complex chunked-reading with bash/python scripts.
- **Current status**: `get` tool with detail levels (structure/layout/full) and depth parameter. Output budget system caps at 30K chars by default.

### [INFRA-002] extract-sessions.ts hardcoded session path
- **Status**: implemented
- **Priority**: P2
- **Category**: infrastructure
- **First seen**: Session 3 (2026-03-14)
- **Sessions affected**: 3
- **Description**: `extract-sessions.ts` had a hardcoded macOS session directory path. Also `--latest` flag required a value argument.
- **Current status**: Fixed — auto-detects session directory from CWD, pre-processes `--latest` to accept bare flag.
- **Verified in**: Session 4 — extraction ran successfully to produce JSON transcript.

### [AGENT-004] Subagent context duplication
- **Status**: identified
- **Priority**: P2
- **Category**: agent-behavior
- **First seen**: Session 3 (2026-03-14)
- **Sessions affected**: 3
- **Estimated savings**: ~15-20 redundant reads/session
- **Description**: Agent subagents re-read files that the parent session already read. Not fully solvable for long idle gaps.
- **Proposed fix**: Provide key file contents or summaries in subagent prompts to reduce redundant reads.

### [BUG-002] lint_design doesn't traverse PAGE nodes — [#3](https://github.com/dabowman/Figmagent/issues/3) closed
- **Status**: implemented
- **Priority**: P1
- **Category**: plugin-bug
- **First seen**: Session 4 (2026-03-14)
- **Sessions affected**: 4, 5
- **Estimated savings**: ~6-12 calls/session
- **Description**: `lint_design(nodeId: "0:1")` returned 0 nodes scanned. Agent had to lint each component individually.
- **Current status**: Fixed in `743d11c` — `collectNodes` now handles PAGE nodes.
- **Note**: Session 5 also did per-component linting (12 calls, predates fix).

### [TOOL-010] Multi-root create for batch variant building — [#4](https://github.com/dabowman/Figmagent/issues/4) / [PR #7](https://github.com/dabowman/Figmagent/pull/7)
- **Status**: implemented (PR #7)
- **Priority**: P2
- **Category**: missing-tool
- **First seen**: Session 4 (2026-03-14)
- **Sessions affected**: 4, 5, 10
- **Estimated savings**: ~8 calls/session when building variant sets
- **Description**: 4 alert variants created sequentially (4 calls), 6 button variants created sequentially (6 calls). Session 5 had similar pattern. Session 10: 4 alert variants sequentially.
- **Current status**: PR #7 adds `nodes` array parameter to `create` tool.

### [BUG-003] apply variable binding enum missing fontSize and text properties — [#5](https://github.com/dabowman/Figmagent/issues/5) / [PR #6](https://github.com/dabowman/Figmagent/pull/6)
- **Status**: implemented (PR #6)
- **Priority**: P2
- **Category**: plugin-bug
- **First seen**: Session 4 (2026-03-14)
- **Sessions affected**: 4
- **Estimated savings**: ~1 call + 1 error per session
- **Description**: `apply` with `variables: { fontSize: "VariableID:..." }` rejected by Zod validation. Missing 7 text property fields.
- **Current status**: PR #6 adds fontSize, fontFamily, fontStyle, lineHeight, letterSpacing, paragraphSpacing, paragraphIndent to both Zod enum and FIELD_MAP.

### [TOOL-011] Legacy tools not deprecated in descriptions — [#8](https://github.com/dabowman/Figmagent/issues/8) closed
- **Status**: resolved (already done)
- **Priority**: P1
- **Category**: agent-behavior
- **First seen**: Session 5 (2026-03-12)
- **Sessions affected**: 5
- **Estimated savings**: ~16 calls/session
- **Description**: Session 5 used 9 `set_layout_sizing`, 3 `bind_variable`, 3 `set_text_style`, 1 `set_fill_color` — all superseded by `apply`. The legacy tools still exist for backward compat but have no deprecation notices in their descriptions.
- **Proposed fix**: Add "DEPRECATED: Use `apply` instead" to each legacy tool's description. Eventually remove them.

### [AGENT-005] Delete-recreate TEXT nodes instead of apply for font changes — [#9](https://github.com/dabowman/Figmagent/issues/9)
- **Status**: identified
- **Priority**: P1
- **Category**: agent-behavior
- **First seen**: Session 5 (2026-03-12)
- **Sessions affected**: 5
- **Estimated savings**: ~10 calls/session
- **Description**: Agent deleted and recreated TEXT nodes to change font properties instead of using `apply` with `fontFamily`/`fontWeight`. CLAUDE.md says "Never delete and recreate text nodes just to change their font" but the agent didn't follow.
- **Proposed fix**: Reinforce in tool descriptions and prompts. Add warning in `delete_node` tool description when target is a TEXT node.

### [AGENT-006] Use `find` instead of individual `get_annotations` for bulk discovery — [#10](https://github.com/dabowman/Figmagent/issues/10) closed
- **Status**: resolved (cross-reference already in description)
- **Priority**: P0
- **Category**: agent-behavior
- **First seen**: Session 6 (2026-03-13)
- **Sessions affected**: 6
- **Estimated savings**: ~49 calls/session
- **Description**: 51 individual `get_annotations` calls (68.9% of 74 calls in session 6) to find annotated nodes. Only 8% hit rate (3/50 had annotations). Agent tried `find` first with name regex but missed `hasAnnotation: true` criteria.
- **Proposed fix**: Add cross-reference to `find(hasAnnotation: true)` in the `get_annotations` tool description. Emphasize `nodeIds` batch support in description.

### [AGENT-007] Use `find` instead of `scan_nodes_by_types` for node discovery — [#11](https://github.com/dabowman/Figmagent/issues/11)
- **Status**: identified
- **Priority**: P1
- **Category**: agent-behavior
- **First seen**: Session 7 (2026-03-13)
- **Sessions affected**: 7
- **Estimated savings**: ~5 calls/session
- **Description**: `scan_nodes_by_types(INSTANCE)` returned 276K chars, overflowing to disk, then agent spent 4 calls processing the overflow. `find` with criteria would have returned targeted results within budget.
- **Proposed fix**: Add deprecation notice to `scan_nodes_by_types` description pointing to `find`. Already documented in CLAUDE.md but agent didn't follow.

### [AGENT-008] Generalize 403 fail-fast across REST API endpoints
- **Status**: identified
- **Priority**: P2
- **Category**: agent-behavior
- **First seen**: Session 9 (2026-03-16)
- **Sessions affected**: 9, 16
- **Estimated savings**: ~2 calls per occurrence
- **Description**: Agent got 403 on `search_library_components`, tried `get_library_components` (same 403), then `get_component_variants` (same 403). All REST API calls to the same file key fail with the same auth error. Session 16 also hit 403 on Enterprise-only endpoint.
- **Proposed fix**: Add to CLAUDE.md: "If a REST API call returns 403 on a file key, all REST API calls to that file will fail. Stop after the first 403 and ask about token scopes."

### [AGENT-009] Parallel cancellation cascade — don't mix Agent + speculative Reads — [#16](https://github.com/dabowman/Figmagent/issues/16)
- **Status**: identified
- **Priority**: P2
- **Category**: agent-behavior
- **First seen**: Session 14 (2026-03-16)
- **Sessions affected**: 14
- **Estimated savings**: ~2 calls + ~3 minutes per occurrence
- **Description**: A Read error on a non-existent file cancelled a parallel figma-discovery Agent call that was already running. The Agent had to be relaunched from scratch.
- **Proposed fix**: Never mix long-running Agent calls with speculative Reads in the same parallel batch. Verify file existence (Glob) before parallel launch if uncertain.

### [AGENT-010] Confused exposed instances with INSTANCE_SWAP properties — [#17](https://github.com/dabowman/Figmagent/issues/17)
- **Status**: identified
- **Priority**: P1
- **Category**: agent-behavior
- **First seen**: Session 12 (2026-03-16)
- **Sessions affected**: 12
- **Estimated savings**: ~85 calls (42 wrong + 43 undo)
- **Description**: Agent used `set_exposed_instance` 85 times (42 applying + 43 undoing) when the user wanted INSTANCE_SWAP component properties. `isExposedInstance` surfaces nested instance properties at the parent level — it does NOT create a slot/dropdown. The user had to correct via screenshot.
- **Proposed fix**: Clarify the distinction between exposed instances and INSTANCE_SWAP properties in CLAUDE.md, tool descriptions, and design_workflow prompt.

### [AGENT-011] Validate approach on 1 node before mass rollout — [#18](https://github.com/dabowman/Figmagent/issues/18)
- **Status**: identified
- **Priority**: P1
- **Category**: agent-behavior
- **First seen**: Session 12 (2026-03-16)
- **Sessions affected**: 12, 17
- **Estimated savings**: ~40 calls per wrong-approach session
- **Description**: Agent applied `set_exposed_instance` to 42 nodes before user corrected the approach. Should have applied to 1 node, confirmed with user, then batch.
- **Proposed fix**: Add to agent workflow: "For operations on 5+ nodes, apply to 1 first, show user, confirm, then batch."

### [TOOL-012] Batch `import_library_component` — [#19](https://github.com/dabowman/Figmagent/issues/19)
- **Status**: identified
- **Priority**: P1
- **Category**: missing-batch-tool
- **First seen**: Session 15 (2026-03-16)
- **Sessions affected**: 15
- **Estimated savings**: ~32 calls/session
- **Description**: 33 sequential `import_library_component` calls to import library components. No batch variant exists.
- **Proposed fix**: Add `import_library_components` (plural) accepting array of component keys.

### [BUG-004] Font loading bug in `import_library_component` with `parentNodeId` — [#20](https://github.com/dabowman/Figmagent/issues/20)
- **Status**: identified
- **Priority**: P1
- **Category**: plugin-bug
- **First seen**: Session 15 (2026-03-16)
- **Sessions affected**: 15
- **Estimated savings**: ~36 calls (clone-reparent workaround)
- **Description**: `import_library_component` with `parentNodeId` fails on components containing TEXT nodes — fonts are not loaded before the import. Agent had to work around with clone + reparent, costing 36 extra calls.
- **Fix pattern**: sync-to-async (load fonts before inserting)

### [TOOL-013] Batch `get_component_variants` — [#21](https://github.com/dabowman/Figmagent/issues/21)
- **Status**: identified
- **Priority**: P2
- **Category**: missing-batch-tool
- **First seen**: Session 15 (2026-03-16)
- **Sessions affected**: 15
- **Estimated savings**: ~20 calls/session
- **Description**: 24 sequential `get_component_variants` calls. 9 were for components that were never imported (wasted discovery).

### [BUG-005] `get_node_info` type coercion — depth as string — [#22](https://github.com/dabowman/Figmagent/issues/22)
- **Status**: identified
- **Priority**: P2
- **Category**: type-coercion
- **First seen**: Session 13 (2026-03-16)
- **Sessions affected**: 13
- **Estimated savings**: ~3 calls per occurrence
- **Description**: Agent passed `depth: "3"` (string) to `get_node_info` three consecutive times, never reading the error message. Related to [TOOL-006] but specific to depth parameter.
- **Fix pattern**: type-coercion
- **Auto-fixable**: yes

### [BUG-006] `getMainComponent` sync in FSGN traversal — [#23](https://github.com/dabowman/Figmagent/issues/23)
- **Status**: identified
- **Priority**: P2
- **Category**: plugin-bug
- **First seen**: Session 13 (2026-03-16)
- **Sessions affected**: 13
- **Description**: `getMainComponent` called synchronously instead of `getMainComponentAsync` in FSGN traversal, causing 2 failures on instance nodes.
- **Fix pattern**: sync-to-async

### [BUG-007] `create` tool: TEXT nodes fail with non-default fonts — [#30](https://github.com/dabowman/Figmagent/issues/30)
- **Status**: implemented (`bda7a09`)
- **Priority**: P1
- **Category**: plugin-bug
- **First seen**: Session 17 (2026-03-16)
- **Sessions affected**: 17
- **Estimated savings**: ~2 calls per TEXT node with custom font (20-40 calls in component-heavy sessions)
- **Description**: `create` with TEXT nodes and non-default fonts (e.g. "Public Sans") fails or silently falls back to Inter Regular. Agent forced into 3-step workaround: create empty text → apply font → set content. Root cause: `loadFontAsync` catch block silently falls back (line 60), weight style name mismatches (e.g. "Semi Bold" vs "SemiBold") are swallowed (line 85), and success is reported even when font wasn't loaded.
- **Fix pattern**: Align `create`'s font handling with `apply`'s (which works correctly). Try style name variations, report warnings/errors instead of silent fallback.
- **Related**: [BUG-004] (same class, different tool), [AGENT-005] (workaround pattern)

### [TOOL-014] `get_design_system` needs filtering params — [#28](https://github.com/dabowman/Figmagent/issues/28)
- **Status**: identified
- **Priority**: P1
- **Category**: missing-tool
- **First seen**: Session 17 (2026-03-16)
- **Sessions affected**: 17
- **Estimated savings**: ~4 calls per large-design-system session
- **Description**: With 540+ variables and 18 styles, `get_design_system` output was 95-110K chars — exceeding both the 30K default budget and MCP infrastructure limits. Agent needed 9 calls (3 timeouts, 1 rejection, 2 truncated, 3 succeeded) to get useful data, then fell back to Bash parsing of the dumped file.
- **Proposed fix**: Add filtering parameters: `collection` (filter by collection name), `type` ("variables" or "styles" only), `namePattern` (regex filter on variable/style names). This lets agents query subsets instead of the entire design system.

### [AGENT-013] Cross-tool timeout tracking for reconnection — [#29](https://github.com/dabowman/Figmagent/issues/29)
- **Status**: identified
- **Priority**: P2
- **Category**: agent-behavior
- **First seen**: Session 17 (2026-03-16)
- **Sessions affected**: 17
- **Estimated savings**: ~4 calls per timeout cascade
- **Description**: Three consecutive timeouts across `get_design_system` and `find` (calls #70-73). The interleaved `find` call reset the agent's "2 consecutive identical errors" counter, delaying reconnection. CLAUDE.md says "2 timeouts in a row" but agent interpreted "in a row on the same tool."
- **Proposed fix**: Clarify in CLAUDE.md: "After 2 timeouts in a row on ANY tool (not just the same tool), assume the WebSocket connection is lost."

### [AGENT-012] Read pipeline output, not source tokens — [#25](https://github.com/dabowman/Figmagent/issues/25)
- **Status**: identified
- **Priority**: P1
- **Category**: agent-behavior
- **First seen**: Session 17 (2026-03-16)
- **Sessions affected**: 17
- **Estimated savings**: ~23 calls per occurrence (delete-recreate cycle)
- **Description**: Agent created ~200 variables with wrong naming (inferred from base tokens `tokens/base/` instead of pipeline output `tokens/figma/`). User had to intervene to redirect. All 200 variables deleted and recreated correctly. 14 Figma calls + 9 Bash scripts wasted.
- **Proposed fix**: Add to agent workflow: "When a token pipeline exists, always read the pipeline's Figma-specific output files before creating variables. Don't infer naming or structure from base/source tokens."

### [INFRA-003] Token-to-Figma conversion utility — [#26](https://github.com/dabowman/Figmagent/issues/26)
- **Status**: identified
- **Priority**: P1
- **Category**: infrastructure
- **First seen**: Session 17 (2026-03-16)
- **Sessions affected**: 17
- **Estimated savings**: ~18 Bash calls per token-import session
- **Description**: Agent wrote 22 Bash/Node scripts for hex→RGBA conversion, DTCG JSON parsing, alias resolution, and batch chunking. Many were incremental iterations on the same logic. No reusable utility exists.
- **Proposed fix**: Create a `prepare-figma-variables` script or MCP tool that reads DTCG-format JSON files and outputs `create_variables` payloads with automatic hex→RGBA conversion, alias resolution via ID map, and batching (25 vars per batch).

## Resolved Issues

### [TOOL-001] bind_variable needs batch version
- **Resolved in**: Post-session 2 (apply tool with variables field)
- **Verified in**: Session 4

### [TOOL-002] set_text_style needs batch version
- **Resolved in**: Post-session 2 (apply tool with textStyleId field)
- **Verified in**: Session 4

### [BUG-001] set_text_style sync/async bug
- **Resolved in**: Post-session 2
- **Verified in**: Session 4

### [TOOL-007] Composite create tool
- **Resolved in**: Session 2
- **Original savings estimate**: ~104 calls
- **Actual improvement**: 79 nodes in 14 calls in session 4, 39-node tree in 1 call in session 5

### [TOOL-008] reorder_children tool
- **Resolved in**: Session 2
- **Verification**: No delete-recreate cycles observed for ordering in session 2

### [AGENT-001] Fail fast on repeated identical errors
- **Resolved in**: Post-session 2 (CLAUDE.md update)
- **Verified in**: Session 4 — both errors recovered in 1 attempt each

### [AGENT-002] After 2 timeouts assume disconnection
- **Resolved in**: Post-session 2 (CLAUDE.md update)
- **Verified in**: Session 4 — zero timeouts

### [AGENT-003] Verify instance vs component before modifying
- **Resolved in**: Post-session 2 (CLAUDE.md update)

### [INFRA-002] extract-sessions.ts hardcoded session path
- **Resolved in**: Session 3
- **Verified in**: Session 4

### [BUG-002] lint_design doesn't traverse PAGE nodes
- **Resolved in**: Session 4 analysis (commit 743d11c)

### [TOOL-011] Legacy tools not deprecated in descriptions
- **Resolved in**: Session 8 — legacy tools had already been removed from MCP server during earlier consolidation

### [AGENT-006] Use `find` instead of individual `get_annotations` for bulk discovery
- **Resolved in**: Session 8 — cross-reference to `find(hasAnnotation: true)` already existed in `get_annotations` description

## Metrics Over Time

| Session | Date | Tool Calls | Errors | Waste % | ToolSearch | Nodes Created | New Issues | Resolved |
|---------|------|------------|--------|---------|------------|---------------|------------|----------|
| 1 | 2026-03-05 | 308 | 16 | 25-33% | 33 (10.7%) | — | 15 | 0 |
| 2 | 2026-03-06 | 389 | 14 | ~17.7% | 28 (7.2%) | 41 | 4 | 3 |
| 3 | 2026-03-14 | 160 | 10 | ~18% | 0 (0%) | 0 (dev) | 2 | 0 |
| 4 | 2026-03-14 | 56 | 2 | ~12% | 8 (14.3%) | 79 | 3 | 7 |
| 5 | 2026-03-12 | 259 | 3 | ~23.6% | 35 (13.5%) | ~120+ | 2 | 0 |
| 6 | 2026-03-13 | 74 | 5 | ~68% | 3 (4.1%) | 0 | 1 | 0 |
| 7 | 2026-03-13 | 30 | 4 | ~40% | 3 (10%) | 0 | 1 | 0 |
| 8 | 2026-03-16 | 153 | 9 | ~10% | 0 (0%) | 0 (dev) | 0 | 2 |
| 9 | 2026-03-16 | 17 | 4 | ~53% | 7 (41.2%) | 0 | 1 | 0 |
| 10 | 2026-03-13 | 23 | 2 | ~30% | 5 (21.7%) | ~30 | 0 | 0 |
| 11 | 2026-03-16 | 52 | 4 | ~48% | 9 (17.3%) | ~10 | 1 | 0 |
| 12 | 2026-03-16 | 105 | 1 | ~81% | 2 (1.9%) | 0 | 3 | 0 |
| 13 | 2026-03-16 | 37 | 9 | ~38% | 5 (13.5%) | 0 | 2 | 0 |
| 14 | 2026-03-16 | 17 | 2 | ~18% | 0 (0%) | 0 | 1 | 0 |
| 15 | 2026-03-16 | 137 | 1 | ~25% | 5 (3.6%) | ~38 | 3 | 0 |
| 16 | 2026-03-16 | 77 | 5 | ~23% | 9 (11.7%) | ~15 | 0 | 0 |
| 17 | 2026-03-16 | 216* | 10 | ~35% | 14 (14.1%) | ~540 vars + 18 styles + 1 component | 4 | 0 |

## Issue Categories

- `missing-batch-tool` — tool exists but lacks batch variant
- `plugin-bug` — bug in Figma plugin code
- `type-coercion` — MCP server rejects valid-but-wrong-type input
- `missing-tool` — capability gap requiring new tool
- `agent-behavior` — prompt/skill improvement needed
- `infrastructure` — WebSocket, reconnection, schema freshness
