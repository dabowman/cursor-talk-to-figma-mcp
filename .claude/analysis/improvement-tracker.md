# Figmagent Improvement Tracker

Last updated: 2026-03-14
Sessions analyzed: 2

## Active Issues

### [TOOL-001] bind_variable needs batch version
- **Status**: implemented
- **Priority**: P0
- **Category**: missing-batch-tool
- **First seen**: Session 2 (2026-03-06)
- **Sessions affected**: 2
- **Estimated savings**: ~120 calls/session
- **Description**: 132 individual `bind_variable` calls dominated session 2. Longest uninterrupted run was 28 consecutive calls. Agent groups conceptually but has no batch tool to execute.
- **Current status**: Implemented via `apply` tool with `variables` field — accepts map of field→variableId for design token bindings on one or many nodes.
- **Auto-fixable**: no (tool-level change)

### [TOOL-002] set_text_style needs batch version
- **Status**: implemented
- **Priority**: P0
- **Category**: missing-batch-tool
- **First seen**: Session 2 (2026-03-06)
- **Sessions affected**: 2
- **Estimated savings**: ~45 calls/session
- **Description**: 55 individual `set_text_style` calls. Agent applies same style to 9+ nodes at a time.
- **Current status**: Implemented via `apply` tool with `textStyleId` field — deduplicates font loading across multiple nodes automatically.
- **Auto-fixable**: no (tool-level change)

### [BUG-001] set_text_style sync/async bug
- **Status**: implemented
- **Priority**: P0
- **Category**: plugin-bug
- **First seen**: Session 2 (2026-03-06)
- **Sessions affected**: 2
- **Estimated savings**: 12 calls + ~5 minutes per occurrence
- **Description**: `set_text_style` handler used sync `textStyleId` setter, fails with `documentAccess: dynamic-page`. Needs `setTextStyleIdAsync`. 9 failed calls + 3 code fix attempts in session 2.
- **Fix pattern**: sync-to-async
- **Current status**: Fixed — async API used throughout plugin code.
- **Auto-fixable**: yes (sync-to-async pattern)

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

### [TOOL-005] ToolSearch overhead
- **Status**: identified
- **Priority**: P1
- **Category**: infrastructure
- **First seen**: Session 1 (2026-03-05)
- **Sessions affected**: 1, 2
- **Estimated savings**: ~28-33 calls/session
- **Description**: Agent rediscovers same tools repeatedly. 33 calls in session 1 (10.7%), 28 in session 2 (7.2%). 4 consecutive failed searches when tools hadn't been loaded after MCP restart.
- **Proposed fix**: Pre-load tool schemas at session start; add complete tool reference to skill file; make ToolSearch return explicit "not found in server" vs "0 results".

### [AGENT-001] Fail fast on repeated identical errors
- **Status**: implemented
- **Priority**: P1
- **Category**: agent-behavior
- **First seen**: Session 2 (2026-03-06)
- **Sessions affected**: 2
- **Description**: Agent fired 7 more identical `set_text_style` calls after first 2 failures. Should stop after 2 and tell user.
- **Current status**: CLAUDE.md now includes "After 2 consecutive identical errors on the same tool, stop retrying and diagnose the root cause".

### [AGENT-002] After 2 timeouts assume disconnection
- **Status**: implemented
- **Priority**: P1
- **Category**: agent-behavior
- **First seen**: Session 2 (2026-03-06)
- **Sessions affected**: 2
- **Description**: 5 consecutive timeout calls before escalating. 30s per call = ~2.5 minutes wasted.
- **Current status**: CLAUDE.md now includes "After 2 timeouts in a row, assume the WebSocket connection is lost — call join_channel to re-establish before retrying".

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
- **Status**: improved
- **Priority**: P2
- **Category**: infrastructure
- **First seen**: Session 1 (2026-03-05)
- **Sessions affected**: 1, 2
- **Description**: 8 reconnections in session 1 consuming ~40+ overhead calls. Each MCP restart forces new channel + ToolSearch + context re-establishment.
- **Current status**: Auto-reconnect improved; plugin now uses channel named after file and auto-rejoins. Still 4 MCP restarts needed in session 2 for picking up new tools/fixing bugs.

### [AGENT-003] Verify instance vs component before modifying
- **Status**: implemented
- **Priority**: P2
- **Category**: agent-behavior
- **First seen**: Session 1 (2026-03-05)
- **Sessions affected**: 1
- **Description**: Agent modified INSTANCE instead of COMPONENT_SET. Wasted planning work on wrong node.
- **Current status**: CLAUDE.md key patterns now document instance vs component handling. `get` returns `componentRef` in `defs.components` for instances.

### [TOOL-007] Composite create tool
- **Status**: implemented
- **Priority**: P0
- **Category**: missing-tool
- **First seen**: Session 1 (2026-03-05)
- **Sessions affected**: 1
- **Estimated savings**: ~104 calls (create_frame + set_layout_sizing were #1 and #2 most-called tools)
- **Current status**: `create` tool handles single nodes, nested trees, components, and instances. FILL sizing applied in second pass. Built 41 nodes in 1 call in session 2.
- **Verified in**: Session 2

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

## Resolved Issues

### [TOOL-007] Composite create tool
- **Resolved in**: Session 2
- **Original savings estimate**: ~104 calls
- **Actual improvement**: `create_frame_tree` built 41 nodes in 1 call

### [TOOL-008] reorder_children tool
- **Resolved in**: Session 2
- **Verification**: No delete-recreate cycles observed for ordering in session 2

### [AGENT-001] Fail fast on repeated identical errors
- **Resolved in**: Post-session 2 (CLAUDE.md update)

### [AGENT-002] After 2 timeouts assume disconnection
- **Resolved in**: Post-session 2 (CLAUDE.md update)

### [AGENT-003] Verify instance vs component before modifying
- **Resolved in**: Post-session 2 (CLAUDE.md update)

## Metrics Over Time

| Session | Date | Tool Calls | Errors | Waste % | ToolSearch | New Issues | Resolved |
|---------|------|------------|--------|---------|------------|------------|----------|
| 1 | 2026-03-05 | 308 | 16 | 25-33% | 33 (10.7%) | 15 | 0 |
| 2 | 2026-03-06 | 389 | 14 | ~17.7% | 28 (7.2%) | 4 | 3 |

## Issue Categories

- `missing-batch-tool` — tool exists but lacks batch variant
- `plugin-bug` — bug in Figma plugin code
- `type-coercion` — MCP server rejects valid-but-wrong-type input
- `missing-tool` — capability gap requiring new tool
- `agent-behavior` — prompt/skill improvement needed
- `infrastructure` — WebSocket, reconnection, schema freshness
