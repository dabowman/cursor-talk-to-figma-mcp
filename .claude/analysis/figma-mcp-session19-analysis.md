# Figma MCP Session 19 Analysis

## Session Overview

- **Transcript**: `9f1a8326-0e27-41ff-9dfc-5c4afc7efe87.json`
- **Project**: storybook (`/Users/davidbowman/Github/storybook`)
- **Duration**: 5 minutes (16:37–16:41)
- **Total tool calls**: 46
- **Figma tool calls**: 16
- **Non-Figma tool calls**: 30 (Read, Grep, Bash, ToolSearch)
- **Total errors**: 3 (1 truncation, 1 MCP overflow, 1 wrong variable IDs)
- **Reconnections**: 0
- **Context restarts**: 0
- **Task**: Rebuild Tooltip component in Figma with full design token bindings, matching the code implementation (Tooltip.tsx, Tooltip.scss, component.tokens.json)

## Metrics

| Metric | Session 18 | This Session | Change |
|---|---|---|---|
| Total Figma tool calls | 279 | 16 | -94% (different scope) |
| Meta/overhead calls | 6 ToolSearch + 0 join | 7 ToolSearch + 0 join | Similar ratio |
| ToolSearch calls | 6 (2.2%) | 7 (15.2%) | +13pp (short session effect) |
| Estimated waste % | ~18% | ~22% | +4pp |

## Tool Call Distribution

| Tool | Calls | Notes |
|---|---|---|
| Read | 5 | Code files (tsx, scss, stories, mixins, tokens) — efficient research |
| Grep | 5 | Targeted token/variable lookups — good use |
| ToolSearch | 7 | 15.2% overhead — 7 separate calls for tool discovery |
| Bash | 1 | python3 extraction from dumped design system file |
| get_document_info | 1 | Initial orientation |
| get_selection | 1 | Parallel with get_document_info |
| get | 4 | 1 initial inspection + 1 arrow structure + 2 verification |
| get_design_system | 2 | Both failed/truncated — design system too large |
| find | 2 | 1 failed (case-sensitive), 1 succeeded |
| delete_node | 2 | 1 old component + 1 arrow frame replacement |
| create | 2 | 1 component tree (4 nodes) + 1 SVG arrow |
| apply | 5 | 1 failed (wrong IDs) + 4 successful batched operations |
| reorder_children | 1 | Arrow before Popup |
| component_properties | 1 | Label TEXT property + auto-bind |
| lint_design | 1 | Final quality check with autoFix |
| set_focus | 1 | Focus on completed component |

## Efficiency Issues

### 1. Wrong variable IDs from config file (saves ~3 calls)

Agent read `figma-variables.json` from the storybook project's `config/` directory to get variable IDs (VariableID:30:145, etc.) but these didn't match the actual Figma file's variable IDs (VariableID:1:212, etc.). This caused the first `apply` call to fail on all 3 nodes.

**Pattern observed:** `apply` with 3 nodes → all 3 failed "Variable not found" → agent re-extracted IDs from the get_design_system dump via Bash → second `apply` succeeded.

**Root cause:** The `figma-variables.json` config file appears to be a mapping/export file with different IDs than what's in the live Figma file. The agent should have used IDs from the `get` tool's FSGN output (which showed the correct v1-v4 IDs) or from the `get_design_system` output.

**Proposed fix:** Agent should prefer variable IDs from Figma API responses (`get` FSGN defs, `get_design_system`) over local config files. The FSGN output from the initial `get` call already showed 4 variables with correct IDs.

**Estimated savings:** 1 failed `apply` + 1 Bash extraction = ~2 wasted calls.

### 2. get_design_system unusable for large design systems (saves ~3 calls)

Two `get_design_system` calls failed — first truncated at 50K budget (output was 96K), second exceeded MCP infrastructure limit at 97K (output was 111K). Agent fell back to Bash/python3 extraction from the dumped file.

**Pattern observed:** `get_design_system(maxOutputChars=50000)` → truncated → `get_design_system(maxOutputChars=97515)` → MCP overflow to file → `Grep` on file → omitted line → `Bash` python3 extraction → success.

**Root cause:** Known issue [TOOL-014]. The storybook design system is too large (540+ variables, 18 styles = 96-111K chars). No filtering parameters exist.

**Estimated savings:** With filtering (e.g. `namePattern: "shadow|Shadow"`), the agent could have gotten just the effect styles in 1 call instead of 4 calls (2 failed get_design_system + 1 grep + 1 bash).

### 3. Case-sensitive `find` miss (saves ~1 call)

Agent searched `find(name: "^tooltip")` — 0 matches. Then `find(name: "^Tooltip")` — 1 match. Figma node names are case-sensitive.

**Pattern observed:** find with lowercase → 0 matches → find with uppercase → 1 match.

**Root cause:** Agent forgot that Figma names are case-sensitive. Could use case-insensitive regex `(?i)^tooltip` but the `find` tool may not support regex flags in the name field.

**Estimated savings:** 1 call.

### 4. Arrow create-then-delete cycle (saves ~2 calls)

Agent created the Arrow as a FRAME child in the initial `create` tree, then immediately deleted it and replaced it with an SVG. Should have used SVG from the start.

**Pattern observed:** `create` with Arrow FRAME → `delete_node(17:3)` → `create(SVG Arrow)`.

**Root cause:** Agent initially thought a colored FRAME would work for the arrow, then realized SVG was needed for the triangle shape. Planning ahead would have avoided this.

**Estimated savings:** 2 calls (the initial FRAME creation + deletion).

### 5. ToolSearch overhead in short sessions (recurring)

7 ToolSearch calls = 15.2% of all tool calls. Each fetches tool schemas that should already be known. The agent made separate ToolSearch calls for: (1) get_document_info+get_selection+get_design_system, (2) get+create+apply+delete_node, (3) find, (4) get_library_variables, (5) reorder_children, (6) component_properties+set_focus, (7) lint_design.

**Pattern observed:** 7 separate ToolSearch calls scattered through the session.

**Root cause:** Known issue [TOOL-005]. Tools are deferred and require explicit fetching. Short sessions are proportionally impacted more.

**Estimated savings:** If batched into 1-2 calls upfront, saves ~5 calls.

### 6. Corner radius bound only to topLeftRadius (saves ~1 call)

Agent's first `apply` bound `cornerRadius` (which only binds `topLeftRadius`), then had to make a second `apply` call to bind all four individual corners.

**Pattern observed:** `apply` with `variables: { cornerRadius: ... }` → inspection shows only topLeftRadius bound → second `apply` with all four `topLeftRadius/topRightRadius/bottomLeftRadius/bottomRightRadius`.

**Root cause:** The `apply` tool's `cornerRadius` variable binding only affects `topLeftRadius`. To bind all corners, each must be specified individually. This is a known Figma API behavior but the tool should ideally accept `cornerRadius` and expand to all four.

**Estimated savings:** 1 extra `apply` call.

## Error Analysis

### 1. Variable ID mismatch (3 failures, ~1 minute lost)

All 3 nodes in the first `apply` call failed with "Variable not found: VariableID:30:145". The IDs came from the local `figma-variables.json` config file, which uses a different ID scheme than the live Figma file.

**Agent recovery:** Good — diagnosed immediately ("The variable IDs from the mapping file don't match the actual Figma file"), extracted correct IDs via Bash, and succeeded on retry. Did not retry with the same wrong IDs.

**Fix needed:** Agent should cross-reference the FSGN `defs.vars` output (which showed the correct IDs) rather than relying on local config files.

### 2. get_design_system overflow (2 soft failures, ~30 seconds lost)

First call truncated, second exceeded MCP limit. Agent recovered via Bash extraction from the dumped file.

**Agent recovery:** Good — adapted strategy quickly, used `python3` to extract just the effects section.

**Fix needed:** [TOOL-014] filtering parameters for `get_design_system`.

## What Worked Well

1. **Efficient research phase.** 6 code file reads in rapid succession (~4 seconds), gathering all design specs before touching Figma. No wasted reads.

2. **Parallel Figma calls.** `get_document_info` and `get_selection` ran in parallel at session start.

3. **Batched apply calls.** The successful `apply` call bound variables to 3 nodes simultaneously (Popup, Label, Arrow vector). Later calls batched 2 nodes at a time.

4. **Good use of component_properties with auto-bind.** Single call added the Label TEXT property and bound it to the Label node — no separate `bind` step needed.

5. **lint_design for quality assurance.** Used after building to catch unbound properties. Found 2 invisible default fills and cleaned them up.

6. **set_focus at the end.** Navigated the Figma view to show the completed component — good UX for the user.

7. **Fast session.** 5 minutes for a complete component rebuild with full token bindings, effect style, SVG arrow, and component property. 16 Figma calls for a production-quality component.

8. **Error recovery.** All 3 issues were handled gracefully — no repeated identical errors, no retry storms.

## Priority Improvements

### Tool Changes (ranked by call savings)

1. **`get_design_system` filtering** — [TOOL-014] already tracked. This session confirms the need: 2 failed calls + 2 workaround calls = 4 wasted. Saves ~3-4 calls per session with large design systems.

2. **`cornerRadius` variable binding should expand to all corners** — When `variables: { cornerRadius: "..." }` is specified, bind all four corner radius properties. Saves ~1 call per component.

### Agent Skill Updates

1. **Prefer Figma API variable IDs over local config files** — When the `get` tool returns `defs.vars` with variable IDs, use those. Don't cross-reference external mapping files that may have different ID schemes.

2. **Plan SVG creation upfront** — When the design spec includes arrows/triangles/icons, use `type: "SVG"` in the initial `create` tree rather than creating placeholder frames.

3. **Use case-insensitive regex in `find`** — Or at least match the exact capitalization from `get_document_info` output.
