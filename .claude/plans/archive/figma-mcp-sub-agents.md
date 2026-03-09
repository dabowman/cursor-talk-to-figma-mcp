# Sub-Agent Architecture for Figma MCP Sessions

## The Problem Sub-Agents Solve

The two session analyses reveal a core tension: Figma MCP sessions need both **broad context** (understanding the full component hierarchy, the design plan, the variable system) and **deep execution** (132 sequential `bind_variable` calls, 55 `set_text_style` calls). A single agent trying to hold both suffers from:

1. **Context pressure** — A 300K-character `read_my_design` response competes for context with the 50-node binding plan. Session 1 hit a context overflow; Session 2 needed a continuation.
2. **Attention drift** — After 28 consecutive `bind_variable` calls, the agent loses track of which nodes are done vs. remaining. Session 2 saw 29 redundant `get_node_info` calls, many from re-checking work already completed.
3. **Error recovery pollution** — When `set_text_style` fails 9 times, the error messages and recovery attempts consume context that should be holding the binding plan.

Sub-agents address this by giving each phase its own clean context window with only the tools and state it needs.

---

## Proposed Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                      PRIMARY ORCHESTRATOR                           │
│                                                                      │
│  Owns: Session plan, phase sequencing, user communication            │
│  Tools: Plan file I/O, export_node_as_image (verification),         │
│         user-facing messages                                         │
│                                                                      │
│  Delegates to sub-agents, reviews their results, decides next steps  │
└──────────┬──────────────┬──────────────────┬────────────────────────┘
           │              │                  │
     ┌─────▼─────┐  ┌────▼──────┐   ┌──────▼───────┐
     │ DISCOVERY  │  │ BUILDER   │   │  STYLER      │
     │ SUB-AGENT  │  │ SUB-AGENT │   │  SUB-AGENT   │
     │            │  │           │   │              │
     │ read_my_   │  │ create_   │   │ bind_        │
     │  design    │  │  frame_   │   │  variable    │
     │ get_node_  │  │  tree     │   │ set_text_    │
     │  info      │  │ clone_    │   │  style       │
     │ scan_text_ │  │  node     │   │ scan_text_   │
     │  nodes     │  │ create_   │   │  nodes       │
     │ get_local_ │  │  component│   │ get_node_    │
     │  components│  │  _instance│   │  info        │
     │ get_       │  │ delete_   │   │              │
     │  selection │  │  multiple │   │              │
     │            │  │  _nodes   │   │              │
     └────────────┘  └───────────┘   └──────────────┘

     Returns:          Returns:         Returns:
     Structured map     Node IDs of      Success/failure
     of nodes, IDs,     created items,   summary per
     hierarchy,         verification     binding group
     variables          screenshot
```

---

## Sub-Agent Specifications

### 1. Discovery Sub-Agent

**Purpose:** Understand the current state of the Figma document and produce a structured map the orchestrator can plan against.

**Input (from orchestrator):**
```json
{
  "task": "discover",
  "target": {
    "nodeId": "16547:36680",
    "description": "DataViews component set"
  },
  "questions": [
    "What variants exist?",
    "What is the internal structure of each variant?",
    "What variables are already bound?",
    "What text styles are applied?"
  ]
}
```

**Tools available:** `get_node_info` (depth=3), `scan_text_nodes`, `get_local_components`, `read_my_design` (filtered), `get_selection`

**Output (to orchestrator):**
```json
{
  "component_set": {
    "id": "16547:36680",
    "name": "DataViews",
    "variant_properties": ["Layout", "State"],
    "variants": [
      {
        "id": "16547:36681",
        "name": "Layout=List, State=Default",
        "children": [
          { "id": "...", "name": "Header", "type": "FRAME", "variables_bound": ["fill:surface-primary"] },
          { "id": "...", "name": "Row 1", "type": "INSTANCE", "componentName": "DataRow" }
        ]
      }
    ]
  },
  "text_nodes": [
    { "id": "...", "name": "Title", "content": "Activity", "style": "Heading MD", "fills_variable": null },
    { "id": "...", "name": "Cell 1", "content": "Name", "style": null, "fills_variable": "gray-700" }
  ],
  "unbound_nodes": 47,
  "summary": "4 variants exist. 47 nodes have no variable bindings. 12 text nodes have no text style."
}
```

**Why this works as a sub-agent:**
- The discovery phase is context-hungry (300K+ character responses) but produces a small, structured output
- Isolating it means the builder and styler never see the raw `read_my_design` dump
- The sub-agent can handle the chunked-reading and Python-parsing workflow without polluting the orchestrator's context
- It runs once per phase, not continuously

**Context savings:** ~50K tokens of raw node data stay in the sub-agent's context, never reaching the orchestrator. The orchestrator gets a ~2K structured summary.

---

### 2. Builder Sub-Agent

**Purpose:** Construct Figma node structures from a declarative specification.

**Input (from orchestrator):**
```json
{
  "task": "build",
  "parent_id": "16547:36681",
  "specification": {
    "method": "clone_and_modify",
    "source_id": "16547:36682",
    "clones": [
      { "rename": "Layout=Activity, State=Loading", "modifications": { "delete_children": ["Row 1", "Row 2", "Row 3"] } },
      { "rename": "Layout=Activity, State=Empty", "modifications": {} }
    ]
  }
}
```

Or for building from scratch:
```json
{
  "task": "build",
  "parent_id": "16547:36681",
  "specification": {
    "method": "create_tree",
    "tree": {
      "name": "Skeleton Row",
      "type": "FRAME",
      "layout": { "mode": "HORIZONTAL", "spacing": 8, "sizing": ["FILL", "HUG"] },
      "children": [
        { "name": "Avatar Placeholder", "type": "FRAME", "size": [32, 32], "fill": "#E5E7EB", "cornerRadius": 16 },
        { "name": "Text Placeholder", "type": "FRAME", "size": [200, 12], "fill": "#E5E7EB", "cornerRadius": 4 }
      ]
    },
    "repeat": 6
  }
}
```

**Tools available:** `create_frame_tree`, `clone_node`, `create_component_instance`, `delete_multiple_nodes`, `set_layout_sizing`, `set_fill_color`, `set_corner_radius`, `set_padding`, `create_text`

**Output (to orchestrator):**
```json
{
  "created_nodes": [
    { "id": "31306:16970", "name": "Layout=Activity, State=Loading" },
    { "id": "31306:16971", "name": "Layout=Activity, State=Empty" }
  ],
  "child_map": {
    "31306:16970": [
      { "id": "31306:16972", "name": "Skeleton Row 1" },
      { "id": "31306:16973", "name": "Skeleton Row 2" }
    ]
  },
  "errors": [],
  "calls_made": 14
}
```

**Why this works as a sub-agent:**
- Building is mechanical once the spec is defined — the sub-agent doesn't need design judgment
- The orchestrator defines *what* to build; the sub-agent handles *how* (choosing between `create_frame_tree` vs individual calls, handling errors, retrying)
- The sub-agent owns the retry/recovery loop for creation failures without polluting the orchestrator
- Returns a clean node ID map the styler sub-agent can consume directly

**Context savings:** The 54 `create_frame` + 50 `set_layout_sizing` call/response pairs (~30K tokens in Session 1) stay in the sub-agent. The orchestrator gets a ~1K node map.

---

### 3. Styler Sub-Agent

**Purpose:** Apply variables, text styles, and other design tokens to a set of nodes.

**Input (from orchestrator):**
```json
{
  "task": "style",
  "bindings": {
    "variables": [
      { "group": "Text fills → gray-700", "nodes": ["...", "...", "..."], "field": "fill", "variableId": "VariableID:15613:5786" },
      { "group": "Backgrounds → surface-secondary", "nodes": ["...", "..."], "field": "fill", "variableId": "VariableID:15613:5791" },
      { "group": "Borders → border-default", "nodes": ["...", "..."], "field": "stroke", "variableId": "VariableID:15613:5780" },
      { "group": "Corner radius → radius-md", "nodes": ["...", "..."], "field": "cornerRadius", "variableId": "VariableID:2272:18561" }
    ],
    "text_styles": [
      { "group": "Headers → Heading MD", "nodes": ["...", "..."], "styleId": "S:5a04..." },
      { "group": "Body → Body SM", "nodes": ["...", "..."], "styleId": "S:7b12..." }
    ]
  }
}
```

**Tools available:** `bind_variable` (or `batch_bind_variables` when built), `set_text_style` (or `batch_set_text_styles`), `scan_text_nodes`, `get_node_info`

**Output (to orchestrator):**
```json
{
  "summary": "Bound 47 variables across 4 groups. Applied 12 text styles across 2 groups.",
  "results": {
    "variables": { "succeeded": 45, "failed": 2, "failures": [{ "nodeId": "...", "error": "Node not found" }] },
    "text_styles": { "succeeded": 12, "failed": 0 }
  },
  "calls_made": 57
}
```

**Why this works as a sub-agent:**
- This is the highest-volume phase (132 + 55 = 187 calls in Session 2 — 48% of all calls)
- The work is purely mechanical: apply binding X to node Y. No design decisions.
- Isolating it means the orchestrator's context isn't consumed by 187 tool call/response pairs
- The sub-agent can track its own progress (which nodes are done) without the orchestrator needing to hold that state
- Error recovery is self-contained: if `set_text_style` fails with the async bug, the sub-agent can report it cleanly without 9 retry attempts cluttering the orchestrator

**Context savings:** ~187 tool calls × ~500 tokens each = ~93K tokens that stay in the sub-agent. The orchestrator gets a ~500-token summary.

---

## Handoff Protocol

### Orchestrator → Sub-Agent

The orchestrator sends a structured JSON task specification. This must include:

1. **Task type** — `discover`, `build`, or `style`
2. **Target node IDs** — What to operate on
3. **Specification** — What to do (build spec, binding plan, discovery questions)
4. **Channel info** — The current MCP channel name (sub-agents need this to make Figma calls)
5. **Circuit breaker rules** — Inherit from the skill file (CB-1 through CB-4)

### Sub-Agent → Orchestrator

The sub-agent returns a structured JSON result. This must include:

1. **Status** — `success`, `partial` (some operations failed), or `blocked` (circuit breaker triggered)
2. **Created/modified node IDs** — So the orchestrator and downstream sub-agents can reference them
3. **Error details** — If `partial` or `blocked`, what went wrong and whether user action is needed
4. **Call count** — For efficiency tracking

### Sequencing

```
Orchestrator                    Sub-Agents
    │
    ├─── Phase 1: Discover ────► Discovery Sub-Agent
    │    (understand current       │
    │     document state)          │
    │◄── structured map ──────────┘
    │
    ├─── Phase 2: Plan
    │    (create build spec
    │     and binding plan)
    │
    ├─── Phase 3: Build ──────► Builder Sub-Agent
    │    (create/clone nodes)      │
    │◄── node ID map ─────────────┘
    │
    ├─── Phase 4: Verify
    │    (export_node_as_image,
    │     visual check with user)
    │
    ├─── Phase 5: Style ──────► Styler Sub-Agent
    │    (bind variables,          │
    │     apply text styles)       │
    │◄── binding summary ─────────┘
    │
    ├─── Phase 6: Verify
    │    (final visual check)
    │
    └─── Done
```

The orchestrator never runs phases 3 and 5 simultaneously — they're serial. This avoids concurrent MCP channel access issues.

---

## Implementation Considerations

### MCP Channel Sharing

The biggest question: can multiple agents share the same WebSocket channel?

**Current architecture:** The MCP server connects to the Figma plugin via a WebSocket relay. Each message is a request/response pair. There's no built-in multiplexing.

**Options:**

1. **Serial handoff (simplest):** Only one sub-agent is active at a time. The orchestrator waits for one to finish before launching the next. No channel contention. This is the recommended starting point.

2. **Separate channels (isolated but wasteful):** Each sub-agent joins its own channel. The Figma plugin would need to support multiple simultaneous channels. Adds complexity for minimal benefit since the phases are naturally sequential.

3. **Multiplexed channel (complex):** Add request IDs to the WebSocket protocol so multiple callers can share a channel. Only worth it if phases need to overlap (they currently don't).

**Recommendation:** Start with serial handoff. The phases are naturally sequential (you must discover before building, must build before styling). There's no parallelism to exploit yet.

### Claude Code Sub-Agent Support

As of the current Claude Code architecture:

- **Sub-agents run as separate Claude invocations** with their own context windows
- The orchestrator can launch them via the `Task` tool (in Claude Code) or equivalent delegation mechanism
- Each sub-agent gets a system prompt that includes the relevant subset of the skill file
- MCP tools are available to sub-agents if the MCP server is configured in the project

**Key constraint:** Sub-agents don't share context with the orchestrator. The handoff must be explicit — the orchestrator serializes the task spec into the sub-agent prompt, and the sub-agent's final message is the result.

### What to Put in Sub-Agent System Prompts

**Discovery sub-agent prompt additions:**
- The circuit breaker rules (CB-1 through CB-4)
- The depth-first inspection rule (depth=3 on first look)
- Instructions to output structured JSON, not conversational text
- The oversized response handling rule

**Builder sub-agent prompt additions:**
- The circuit breaker rules
- The Figma node type reference table (which types support what)
- The prototype-one-batch-the-rest pattern
- Instructions to track and return all created node IDs

**Styler sub-agent prompt additions:**
- The circuit breaker rules
- The batch-over-loops rule
- The group-by-concept pattern
- Instructions to track progress and report failures per group

---

## Estimated Impact

Based on Session 2 numbers:

| Metric | Without Sub-Agents | With Sub-Agents | Savings |
|--------|-------------------|-----------------|---------|
| Orchestrator context consumed | ~195K tokens (all 389 calls) | ~15K tokens (plan + summaries) | ~92% |
| Redundant `get_node_info` calls | 29 | ~5 (sub-agents track their own state) | ~83% |
| Context overflow risk | High (Session 1 overflowed) | Low (each sub-agent has fresh context) | — |
| Total tool calls | 389 | ~330 (same work, fewer re-inspections) | ~15% |
| User-visible latency | Same | Same (serial execution) | — |

The primary win isn't fewer total calls — it's **context efficiency**. The orchestrator stays clean, the sub-agents do the heavy lifting in isolation, and error recovery doesn't pollute the planning context.

---

## Rollout Sequence

1. **Now — Rules only.** Encode the skill file rules. No sub-agents. This alone should cut waste from ~17-25% to ~10% based on circuit breakers and inspection discipline.

2. **After batch tools are built.** Implement `batch_bind_variables` and `batch_set_text_styles`. This collapses the styler phase from 187 calls to ~15. At this point, sub-agents become less urgent because the volume is manageable for a single context.

3. **When sessions regularly exceed 300 tool calls.** Introduce the Discovery sub-agent first — it has the clearest context-isolation benefit (300K raw data → 2K summary). The orchestrator delegates discovery, then handles building and styling itself.

4. **When building + styling combined exceeds context.** Split out the Builder and Styler sub-agents. This is the full three-sub-agent architecture.

**The honest assessment:** If batch tools cut the styler phase from 187 calls to 15, and the skill file rules cut redundant inspections by 80%, a single agent with good discipline may handle most sessions without sub-agents. The sub-agent architecture is insurance against sessions that are genuinely too large for one context window — like building a full design system with 50+ components.