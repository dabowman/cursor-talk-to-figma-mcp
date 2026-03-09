# Parallel Agent Architecture for Figma MCP

## Can It Be Done?

Yes. The existing architecture is closer to parallel-ready than expected. Request ID correlation is already built. The main work is adding concurrency control in the plugin.

---

## Current Architecture (What We Have)

```
Claude Code Agent (or sub-agents)
    │
    ▼
MCP Server (single process, stdio)
    │  ← generates UUID per request, tracks in pendingRequests Map
    ▼
WebSocket Relay (socket.ts, port 3055)
    │  ← dumb pipe, broadcasts within channel
    ▼
Plugin UI (ui.html iframe)
    │  ← WebSocket client, forwards via postMessage
    ▼
Plugin Main (code.js, QuickJS sandbox)
    │  ← async handleCommand(), no concurrency control
    ▼
Figma Document API
```

### What Already Works for Parallelism

1. **Request ID correlation** — `connection.ts` generates UUIDs, `pendingRequests` Map correlates responses. Multiple in-flight requests are already supported.
2. **Async event handler** — `figma.ui.onmessage` is `async`. Multiple messages arriving concurrently each spawn their own async execution, interleaving at `await` points.
3. **Sub-agents share MCP server** — Claude Code's Agent tool spawns sub-agents that use the same MCP tools → same server process → same WebSocket → same channel. No multi-channel needed.

### What's Missing

1. **No node-level write protection** — Two concurrent writes to the same node can corrupt state.
2. **No concurrency cap** — Unlimited in-flight operations could exceed Figma's CPU budget.
3. **No operation classification** — Plugin doesn't distinguish reads from writes.
4. **No orchestration guidance** — No skill file tells agents how to partition work for parallel execution.

---

## The Three Layers — Validated

### Layer 1: Figma Plugin (code.js) — The Hard Constraint

The plugin runs in a **single-threaded QuickJS sandbox** with an event loop. `async/await` enables concurrent I/O — multiple promises can be in-flight simultaneously.

**Safe to parallelize:**
- All read operations (`getNodeByIdAsync`, `exportAsync`, `getLocalVariablesAsync`, property reads)
- Write operations to **different nodes** (each node property set is atomic)
- Create operations (new nodes don't conflict)

**Must serialize:**
- Multiple writes to the **same node** (last-write-wins, interleaving of multi-step mutations like `loadFont → setCharacters → setRangeFontSize`)
- Parent mutations while children are being modified (e.g., `delete_multiple_nodes` on parent + `bind_variable` on child)
- **Global operations** that touch the whole tree (`create_frame_tree`, `delete_multiple_nodes`, `read_my_design`)

**Not a concern:**
- The plan worried about `create_*` inside the same parent frame conflicting on child ordering. In practice, `appendChild` is atomic and order-preserving — two concurrent `createRectangle` + `appendChild` calls will both succeed, just in nondeterministic order. Use `reorder_children` after if ordering matters.

### Layer 2: WebSocket Relay (socket.ts) — No Changes Needed

The relay is a dumb pipe. It broadcasts messages within a channel to all other clients. Request IDs flow through transparently. The relay doesn't need to understand request/response pairing — that's handled by `connection.ts` (MCP server side) and `ui.html` (plugin side).

**No changes required.** The relay already supports the parallel architecture.

### Layer 3: Agent Team — Shared MCP Server Model

Claude Code sub-agents (Agent tool) share the parent's MCP server. This is the key insight that simplifies everything:

```
┌────────────────────────────────────────────────────┐
│  CLAUDE CODE ORCHESTRATOR                           │
│                                                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐           │
│  │ Agent:   │ │ Agent:   │ │ Agent:   │           │
│  │ Styler A │ │ Styler B │ │ Styler C │           │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘           │
│       │             │             │                 │
│       └─────────────┼─────────────┘                 │
│                     ▼                               │
│          MCP Server (single process)                │
│          pendingRequests Map ← UUID correlation     │
│                     │                               │
└─────────────────────┼───────────────────────────────┘
                      ▼
              WebSocket Relay
                      │ (single channel)
                      ▼
              Figma Plugin
              ┌─────────────────────┐
              │ Concurrency Control │
              │ • Node write locks  │
              │ • Global op mutex   │
              │ • Max 6 in-flight   │
              └─────────────────────┘
```

Each sub-agent's tool calls go through the same `sendCommandToFigma()`, get unique UUIDs, and the correct promise resolves when the matching response arrives. **No multi-channel, no extra WebSocket connections, no relay changes.**

---

## Implementation Plan

### Phase 1: Plugin Concurrency Control (code.js)

This is the core work. Add a request router to `code.js` that manages concurrent operations safely.

**1a. Operation classification**

Categorize all 55+ commands into read/write/global:

```javascript
// In code.js
var READ_OPS = {
  'get_document_info': true, 'get_selection': true, 'get_node_info': true,
  'get_nodes_info': true, 'read_my_design': true, 'scan_text_nodes': true,
  'scan_nodes_by_types': true, 'get_styles': true, 'get_local_variables': true,
  'get_local_components': true, 'get_library_variables': true,
  'get_library_components': true, 'search_library_components': true,
  'get_annotations': true, 'get_reactions': true, 'get_comments': true,
  'get_component_variants': true, 'get_instance_overrides': true,
  'get_main_component': true, 'export_node_as_image': true,
  'get_selection': true, 'set_selections': true, 'set_focus': true
};

// These touch multiple nodes or the tree structure — serialize globally
var GLOBAL_OPS = {
  'create_frame_tree': true, 'delete_multiple_nodes': true,
  'combine_as_variants': true, 'reorder_children': true,
  'create_connections': true
};

// Everything else is a node-level write (uses params.nodeId for locking)
```

**1b. Node-level write locks**

```javascript
// In code.js — ES2017-safe (no optional chaining, no nullish coalescing)
var nodeLocks = {};  // nodeId → { queue: Promise }

function acquireNodeLock(nodeId) {
  if (!nodeId) return Promise.resolve(function noop() {});

  var entry = nodeLocks[nodeId];
  if (!entry) {
    entry = { queue: Promise.resolve() };
    nodeLocks[nodeId] = entry;
  }

  var release;
  var prev = entry.queue;
  entry.queue = new Promise(function(resolve) { release = resolve; });

  return prev.then(function() { return release; });
}
```

**1c. Global operation mutex**

```javascript
var globalLock = { queue: Promise.resolve() };

function acquireGlobalLock() {
  var release;
  var prev = globalLock.queue;
  globalLock.queue = new Promise(function(resolve) { release = resolve; });
  return prev.then(function() { return release; });
}
```

**1d. Concurrency-limited request router**

```javascript
var inFlightCount = 0;
var MAX_CONCURRENT = 6;
var waitQueue = [];

function waitForSlot() {
  if (inFlightCount < MAX_CONCURRENT) {
    inFlightCount++;
    return Promise.resolve();
  }
  return new Promise(function(resolve) { waitQueue.push(resolve); });
}

function releaseSlot() {
  inFlightCount--;
  if (waitQueue.length > 0 && inFlightCount < MAX_CONCURRENT) {
    inFlightCount++;
    waitQueue.shift()();
  }
}

// Replace the current execute-command handler:
case "execute-command":
  routeCommand(msg.id, msg.command, msg.params);
  break;

async function routeCommand(id, command, params) {
  await waitForSlot();
  try {
    var result;
    if (GLOBAL_OPS[command]) {
      var release = await acquireGlobalLock();
      try { result = await handleCommand(command, params); }
      finally { release(); }
    } else if (!READ_OPS[command] && params && params.nodeId) {
      var release = await acquireNodeLock(params.nodeId);
      try { result = await handleCommand(command, params); }
      finally { release(); }
    } else {
      result = await handleCommand(command, params);
    }
    figma.ui.postMessage({ type: "command-result", id: id, result: result });
  } catch (error) {
    figma.ui.postMessage({ type: "command-error", id: id, error: error.message || "Error executing command" });
  } finally {
    releaseSlot();
  }
}
```

**1e. Batch operation node locking**

Batch operations (`set_multiple_properties`, `batch_bind_variables`, `batch_set_text_styles`) already chunk internally. They should be classified as GLOBAL_OPS since they touch multiple nodes and manage their own chunking.

**Effort:** ~4-6 hours. All changes in `code.js` only. No MCP server or relay changes.

**Testing approach:**
- Unit test: send two concurrent writes to the same node, verify they serialize
- Unit test: send two concurrent writes to different nodes, verify they parallelize
- Unit test: send 10 concurrent reads, verify all complete
- Stress test: send 20 concurrent requests, verify max 6 in-flight
- Integration test: verify existing single-agent workflow is unaffected

---

### Phase 2: Agent Orchestration Skill

A skill file that teaches the orchestrator how to partition work across sub-agents for parallel execution.

**Key patterns:**

```
SERIAL PHASES (must be in order):
  1. Discovery → 2. Planning → 3. Building → 4. Styling → 5. Verification

PARALLEL WITHIN BUILDING:
  ┌─ Agent A: Build variants for State=Loading (nodes A1-A5)
  ├─ Agent B: Build variants for State=Empty (nodes B1-B5)
  └─ Agent C: Build variants for State=Selection (nodes C1-C5)

PARALLEL WITHIN STYLING:
  ┌─ Agent A: Bind variables to Loading variants
  ├─ Agent B: Bind variables to Empty variants
  └─ Agent C: Bind variables to Selection variants
```

**Orchestrator rules:**
1. Join channel ONCE in the orchestrator before spawning sub-agents
2. Partition work by **node subtree** — each agent operates on a disjoint set of nodes
3. Never assign the same node to two agents
4. Keep build phases separate from style phases (don't build and style in parallel)
5. Use `run_in_background: true` for parallel Agent launches, wait for all to complete
6. After parallel phase completes, verify with `get_node_info` before proceeding

**Sub-agent prompt template:**
```
You are a Figma [builder/styler] agent. The channel is already joined.
Your assigned nodes: [list of nodeIds].
Do NOT touch nodes outside your assignment.
[specific instructions for what to create/style]
```

**Effort:** ~3-4 hours for the skill file.

---

### Phase 3 (Future): Multi-Channel Isolation

Only needed if we find that shared-channel has issues (e.g., noisy logging, debugging difficulty). Not needed for correctness since request IDs handle correlation.

If desired later:
- Plugin UI tracks multiple channels (change `state.channel` from string to Set)
- Response routing includes source channel
- Each sub-agent calls `join_channel` with a unique sub-channel name
- Relay needs no changes (already supports multiple channels)

**Not recommended now.** Adds complexity without functional benefit.

---

## Revised Honest Assessment

The plan document's original assessment said "probably not worth building now." After code review, I disagree — **Phase 1 is worth building now** because:

1. **It's smaller than estimated.** The original plan estimated ~16 hours across 4 phases. The revised plan is ~4-6 hours for Phase 1 (the only infrastructure change needed) because request IDs and multi-channel are already done / unnecessary.

2. **It's defensive, not just offensive.** Even without parallel agents, the concurrency control protects against edge cases where the MCP server sends overlapping requests (e.g., timeout-triggered retries while the original is still processing).

3. **It enables background agents immediately.** Claude Code's `run_in_background: true` Agent parameter means we can parallelize styling phases TODAY if the plugin is protected.

4. **Zero changes to MCP server or relay.** All work is in `code.js`. Low blast radius.

**Build sequence:**
1. **Phase 1: Plugin concurrency control** → protects against concurrent writes, enables parallelism
2. **Phase 2: Orchestration skill** → teaches agents how to partition work
3. **Phase 3: Multi-channel** → only if debugging parallel sessions proves difficult

---

## Risks and Mitigations

### Risk: Figma CPU Budget
Too many concurrent operations triggers Figma's "plugin is slow" warning or termination.
**Mitigation:** MAX_CONCURRENT = 6 cap in the request router. Empirically tune.

### Risk: Undo Stack
Parallel operations from multiple agents create interleaved undo entries.
**Mitigation:** Accept this limitation. Document that parallel sessions should use `figma.commitUndo()` at phase boundaries (not available in current API — would need `figma.commitUndo` support which doesn't exist). Practically: users should not rely on granular undo during parallel operations.

### Risk: Lock Starvation
A long-running global operation (e.g., `create_frame_tree` taking 30s) blocks all writes.
**Mitigation:** Global lock is a queue, not a spinlock. Writes queue up and execute in order after the global op completes. Reads proceed unblocked.

### Risk: Lock Leaks
If `handleCommand` throws after acquiring a lock but before the `finally` block runs.
**Mitigation:** The `try/finally` pattern in `routeCommand` ensures locks are always released. QuickJS supports `try/finally`.

### Risk: Batch Operations and Node Locking
`set_multiple_properties` operates on multiple nodeIds — can't lock a single node.
**Mitigation:** Classify as GLOBAL_OP. These already chunk internally with progress updates.

---

## What This Doesn't Solve

- **Multiple Figma files** — The plugin connects to one file. Parallel operations across files would need multiple plugin instances.
- **Multiple Figma pages** — The plugin operates on `figma.currentPage`. Page switches are global state changes that would break parallel operations. All parallel agents must work on the same page.
- **Real-time collaboration conflicts** — If a human designer is editing the same nodes an agent is modifying, both the plugin concurrency control AND human edits create race conditions. This is unsolvable at the plugin level.
