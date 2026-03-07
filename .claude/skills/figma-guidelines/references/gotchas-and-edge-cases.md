# Gotchas and Edge Cases

## Table of Contents
- Immutable properties (fills, strokes, effects)
- Font loading traps
- Auto layout property conflicts
- Coordinate system confusion
- Instance manipulation limits
- Component property naming
- Rectangle vs frame confusion
- Node lifecycle and stale references
- Color format
- Image handling
- SectionNode restrictions
- Min/max constraint requirements
- Boolean property limitations
- Variable resolution surprises
- Performance cliffs
- Undo management
- Sub-pixel precision
- Group coordinate math
- Fill type hazards
- WebSocket communication issues

---

## Immutable Properties

**The problem**: Fills, strokes, effects, and layout grids on nodes are readonly frozen objects. Any attempt to mutate them in place throws an error.

**What fails**:
```
node.fills[0].color.r = 1              // "Cannot assign to read only property"
node.fills.push(newFill)               // "object is not extensible"
node.effects[0].radius = 10            // "Cannot assign to read only property"
```

**What works**:
```
const fills = JSON.parse(JSON.stringify(node.fills))
fills[0].color.r = 1
node.fills = fills
```

Always: clone the entire array → modify the clone → reassign the whole property. This applies to `fills`, `strokes`, `effects`, `layoutGrids`, and `backgroundFilters`.

**Helper for solid colors**: `figma.util.solidPaint('#FF00FF')` creates a properly formatted solid paint.

---

## Font Loading Traps

### Trap 1: Setting text without loading
Every text content or layout property change requires `await figma.loadFontAsync(fontName)` first. Without it: `"Cannot write to node with unloaded font"`.

### Trap 2: Loading wrong font
If you load Font B but the node currently uses Font A, and you set `.characters` without first changing `.fontName` to Font B, the error message says it can't write with Font A (the existing font) — not Font B (the one you loaded).

**Correct sequence**: Load font → set `.fontName` → set `.characters`.

### Trap 3: Mixed-font text nodes
A text node with multiple fonts (e.g., bold and regular) requires ALL fonts to be loaded before any layout property change. Use `getStyledTextSegments(['fontName'])` to discover all fonts, then `Promise.all()` to load them.

### Trap 4: Missing fonts
`node.hasMissingFont` returns true if any font is unavailable. Missing fonts CANNOT be loaded. Attempting to modify text on a node with missing fonts will fail. Workaround: change the fontName to an available font first (after loading it).

### Properties that DON'T require font loading
`.fills`, `.fillStyleId`, `.strokes`, `.strokeWeight`, `.strokeAlign`, `.opacity`, `.visible`, `.blendMode` — these can be changed without loading fonts.

---

## Auto Layout Property Conflicts

### Setting child properties before parent has auto layout
`layoutSizingHorizontal`, `layoutSizingVertical`, `layoutGrow`, and `layoutAlign` throw errors when set on nodes not inside an auto layout frame. Always enable auto layout on the parent FIRST.

### The HUG-FILL contradiction
A parent set to HUG cannot have a child set to FILL on the same axis. Error: the child silently gets ignored or throws. Solution: make the parent FIXED or FILL on that axis.

### FILL + STRETCH conflict
A child set to `layoutAlign = 'STRETCH'` that is itself an auto layout frame must have its corresponding axis sizing set to `FIXED`. It cannot simultaneously stretch to fill parent and hug its children.

### Removing auto layout doesn't reposition children
Setting `layoutMode` back to `'NONE'` does NOT restore children to their pre-auto-layout positions. They stay wherever the layout engine last placed them, often stacked at (0,0). This is irreversible without manual repositioning.

### Strokes excluded by default
Auto layout calculates sizes without strokes unless `strokesIncludedInLayout = true`. This causes visual misalignment when elements have visible strokes.

---

## Coordinate System Confusion

### Multiple coordinate systems coexist
- `node.x` / `node.y` — relative to **parent**
- `node.absoluteBoundingBox` — absolute canvas position
- `node.absoluteRenderBounds` — includes visual effects (shadows etc.), can be null
- `node.relativeTransform` — 2D affine matrix relative to containing **frame** (skips groups/booleans)

### Auto layout overrides manual positioning
Inside auto layout frames, `x` and `y` are managed by the engine. Setting them is silently ignored (for flow children). Only `layoutPositioning = 'ABSOLUTE'` children can use manual coordinates.

### Group coordinate inheritance
Children inside groups have coordinates relative to the nearest ancestor **frame**, not the group. This is counterintuitive and causes position miscalculations.

### Sub-pixel values
Figma stores coordinates with many decimal places internally but displays 2. Auto layout recalculation produces sub-pixel values. Round to 2 decimal places for UI parity.

---

## Instance Manipulation Limits

### Hard restrictions
- Cannot add children to an instance
- Cannot remove children from an instance
- Cannot reorder children in an instance
- Cannot modify properties of layers that don't have exposed component properties

### Swap side effects
- `instance.swapComponent(newComponent)` preserves overrides (if layer names match)
- `instance.mainComponent = newComponent` clears ALL nested instance overrides
- Always use `swapComponent()` over direct `mainComponent` assignment

### Detach cascading
`detachInstance()` converts the instance to a FrameNode. But it ALSO detaches all ancestor instances in the tree. This is rarely the desired behavior.

### Remote component limitation
Components from external libraries (`node.remote === true`) are read-only. Their main component structure cannot be modified — only the instance's overridable properties.

### Performance with instances
Alternating writes to a ComponentNode and reads from its InstanceNodes is explicitly documented as slow. Batch all component modifications first, then read instances.

---

## Component Property Naming

Boolean, Text, and Instance Swap properties have `#uniqueId` suffixes (e.g., `'Label#12:0'`). Variant properties do NOT have suffixes.

Using the wrong name (without suffix) in `setProperties()` silently fails or throws "property not found". Always read `componentPropertyDefinitions` to get full names.

`addComponentProperty()` returns the full suffixed name. Capture this return value.

---

## Rectangle vs Frame Confusion

**RectangleNode** cannot:
- Have children
- Have auto layout
- Clip content
- Be converted to a component
- Support `layoutSizingVertical` or `layoutSizingHorizontal`

If you need a colored background WITH children, use a **FrameNode** with a fill. This is one of the most common mistakes — trying to use a rectangle as a container.

---

## Node Lifecycle and Stale References

### Deletion detection
Node IDs persist within a file, but nodes can be deleted at any time (by the user or by another operation). Always check `node.removed` before operating.

### Stale references
A node reference captured earlier may be invalid by the time you use it. Re-fetch with `figma.getNodeByIdAsync(id)` if there's been an intervening operation.

### Race conditions
In MCP contexts, multiple operations are queued. Between fetching node info and modifying the node:
- The user may have deleted it
- Another operation may have changed its type
- Auto layout recalculation may have moved it
- Font loading may not have completed

Always validate before modifying.

---

## Color Format

Figma uses 0–1 floats, not 0–255 integers.

```
// Converting hex to Figma color:
// #FF6B35 = { r: 1.0, g: 0.42, b: 0.21, a: 1 }
// Formula: value / 255

// Common color values:
// White: { r: 1, g: 1, b: 1, a: 1 }
// Black: { r: 0, g: 0, b: 0, a: 1 }
// 50% gray: { r: 0.5, g: 0.5, b: 0.5, a: 1 }
```

Alpha (opacity) is also 0–1. It's part of the color object for fills/effects AND a separate `opacity` property on the paint/effect itself.

---

## Image Handling

### Images are fills, not nodes
There is no `ImageNode` in Figma. Images are applied as fills on frames or rectangles:
```
{ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL' }
```

Scale modes: `'FILL'` (cover), `'FIT'` (contain), `'CROP'` (manual crop), `'TILE'` (repeat).

### Size limit
Maximum image size is 4096×4096 pixels. Larger images are silently downscaled.

### Image retrieval returns originals
`figma.getImageByHash(hash).getBytesAsync()` returns the **original uploaded bytes**, not any visual edits (opacity, contrast). To get the edited appearance, use `node.exportAsync()`.

### Creating images
`figma.createImage(bytes)` takes a Uint8Array of image data and returns an `Image` handle with a `.hash`. The handle is NOT a node — you must assign it as a fill to a node.

---

## SectionNode Restrictions

Sections are exclusively top-level canvas elements:
- Cannot be inside frames, groups, or other sections
- Cannot have auto layout
- Cannot have constraints
- Cannot have clip content
- Cannot have corner radius
- Cannot have effects (shadows, blurs)
- CAN have fills and strokes
- CAN have `devStatus` ('NONE', 'READY_FOR_DEV', 'COMPLETED')

Attempting to place a section inside a frame fails silently or throws.

---

## Min/Max Constraint Requirements

`minWidth`, `maxWidth`, `minHeight`, and `maxHeight` ONLY work on:
1. Auto layout frames themselves
2. Direct children of auto layout frames

Setting them on any other node type produces: `"Can only set maxHeight on auto layout nodes and their children."`

Set to `null` to remove a constraint.

---

## Boolean Property Limitations

Boolean component properties:
- Toggle layer **visibility only** — not fill, opacity, size, or anything else
- Cannot control variant switching
- Consolidating interactive components using boolean properties loses prototyping connections
- Boolean **variables** cannot be applied to boolean **component properties** — they're different systems

For toggle behavior between visual states, use a variant property with `'True'`/`'False'` string values instead.

---

## Variable Resolution Surprises

### valuesByMode doesn't resolve aliases
`variable.valuesByMode[modeId]` returns either a raw value or a `VariableAlias` object. Use `variable.resolveForConsumer(node)` for the final resolved value.

### Mode resolution walks the tree
A variable bound to a deep child resolves based on the nearest ancestor with an explicit mode set. If no ancestor has a mode, the collection default (leftmost column) is used.

### Cross-collection alias chains
A variable in Collection A can alias a variable in Collection B. If both have modes, the resolved value depends on which modes are active at the consuming node. With 2 modes each, this can produce 4 different resolved values.

### PageNode doesn't support mode queries
`PageNode.resolvedVariableModes` and `explicitVariableModes` return `undefined`. Check a child frame instead.

---

## Performance Cliffs

### Traversal with hidden instances
`findAll()` and `findOne()` become extremely slow when encountering hidden instance children. Figma lazily instantiates invisible children, so traversing them forces instantiation. Use `figma.skipInvisibleInstanceChildren = true` for 100x+ speedup.

### Typed search is faster
`findAllWithCriteria({ types: ['TEXT'] })` is significantly faster than `findAll(n => n.type === 'TEXT')` because it uses an internal index.

### Text style queries
`getStyledTextSegments()` is 10x–500x faster than per-character style queries. Always use it for text analysis.

### Large variant sets
Components with hundreds of variants cause slow instance updates and creation. Keep variant counts reasonable (under 50 per set).

### Component-instance write-read alternation
Alternating between writing to a ComponentNode and reading from its InstanceNodes triggers expensive recalculations. Batch component writes first.

---

## Undo Management

By default, all Plugin API operations within a session form a single undo step. An AI agent performing 50 operations creates one giant undo that reverts everything.

Insert `figma.commitUndo()` between logical operations to give users granular undo. Example: commit after creating a component, commit again after modifying its variants, commit again after creating instances.

`figma.triggerUndo()` programmatically triggers an undo action.

---

## Group Coordinate Math

`relativeTransform` on nodes inside groups is relative to the nearest ancestor **frame**, skipping groups and boolean operations entirely.

A Rectangle inside a Group inside a Frame has `relativeTransform` relative to the Frame — not the Group. This means position calculations that assume group-relative coordinates will be wrong.

**Bug**: `figma.group()` on absolutely positioned auto layout children resets `layoutPositioning` to `'AUTO'`, losing their absolute position.

---

## Fill Type Hazards

### PATTERN fills
Cloning PATTERN fills with `JSON.parse(JSON.stringify())` can cause `"Invalid discriminator value"` errors. Use `setFillsAsync()` for pattern fills.

### VIDEO fills
Multiple bugs: `videoHash` can be `null`, `imageTransform` exists but isn't in type definitions, cloning identical VIDEO fills throws `"Invalid SHA1 hash"`. Workaround: filter out VIDEO fills before clone-and-reassign operations.

### Gradient stops with variables
Variable-bound gradient stops need special handling. Bind the variable to the specific stop's color, not to the entire fill.

---

## WebSocket Communication Issues

### Plugin must be running
All write operations require the Figma plugin to be actively running. If the user closes the plugin window, all write capability is silently lost. Check connection status before attempting operations.

### Port conflicts
Different MCP projects use different default ports (3055, 1994, 9223–9232). Port conflicts cause silent connection failures. The MCP server and plugin must agree on the port.

### Connection lifecycle
The WebSocket connection can drop due to network issues, Figma tab switching, or browser sleep. Implement reconnection logic and always verify connection before operations.

### Message ordering
Most MCP servers process messages sequentially (one at a time, return result before accepting next). Sending operations faster than the plugin can process them causes dropped messages or race conditions.
