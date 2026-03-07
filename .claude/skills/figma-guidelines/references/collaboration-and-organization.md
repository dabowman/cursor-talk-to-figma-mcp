# Collaboration and Organization Guide

## Table of Contents
- File organization patterns
- Page structure
- Sections
- Comments
- Annotations and measurements
- Dev Mode
- Branching
- Library management
- Handoff best practices
- Boolean operations and vector editing
- Masks and clip content
- Effects and blend modes
- Constraints vs auto layout
- Prototyping overview

---

## File Organization Patterns

### Recommended Page Structure

**Cover page**: A frame sized to Figma's thumbnail dimensions (1600×960) with file name, project name, status, last updated date, and team/owner. This appears as the file thumbnail in the project browser.

**Design pages**: Organized by feature, user flow, or screen. Name pages descriptively: "Onboarding Flow", "Settings Screens", "Dashboard Views". Avoid generic names like "Page 1".

**Component page**: Dedicated space for all local components. Organize with sections by category (Buttons, Inputs, Cards, Navigation). Include usage documentation alongside components.

**Playground/Sandbox page**: A space for experimentation, testing component configurations, and exploring ideas without affecting production designs.

**Archive page**: Prefix with `_` (e.g., "_Archive") to push to bottom of page list. Store deprecated designs here instead of deleting them.

### Within-Page Organization

Use sections to group related designs. Space sections consistently — 100px between major groups is a common pattern. Align frames to a grid for visual cleanliness. Name all top-level frames descriptively.

---

## Sections

Sections are top-level canvas organizers with specific behavior:

### What Sections Can Do
- Contain any node type (frames, components, groups, text, shapes)
- Contain other sections (nesting is supported)
- Have fills and strokes
- Have a title (always visible)
- Have a `devStatus` property: `'NONE'`, `'READY_FOR_DEV'`, `'COMPLETED'`
- Be created via `figma.createSection()`

### What Sections Cannot Do
- Be placed inside frames or groups (top-level only)
- Have auto layout
- Have constraints
- Have clip content
- Have corner radius
- Have effects (shadows, blurs)
- Have opacity (they're always fully opaque)

### Using Sections Effectively

**Feature grouping**: One section per feature or user flow. Designers can see the full scope of related screens at a glance.

**Dev handoff**: Mark sections as "Ready for dev" to signal completion. Dev Mode uses section boundaries to organize what developers see — content outside sections is collapsed by default.

**Status tracking**: Use `devStatus` to track progress:
- `'NONE'` — work in progress
- `'READY_FOR_DEV'` — design complete, ready for implementation
- `'COMPLETED'` — implemented and verified

---

## Comments

### Adding Comments
- Anyone with view access can comment
- Comments pin to top-level frames, components, or groups and move with them
- Cannot attach to nested layers within groups or frames
- Use comment mode (`C` key) in the UI

### Comment Features
- **Threading**: Replies nest under original comments automatically
- **Resolution**: Resolving a comment hides it from the canvas but doesn't delete it
- **Mentions**: Tag team members with @
- **Emoji reactions**: Quick responses without adding threaded replies

### Through the Plugin API
The Plugin API does NOT have comment methods — comments are managed through the REST API. If your MCP needs comment support, it requires REST API integration alongside the Plugin API bridge.

### Comment Best Practices
- Use comments for specific feedback on design elements (not general discussion)
- Resolve comments when addressed — don't leave stale threads
- Pin comments to the relevant element so they move with design changes
- Use a dedicated channel (Slack, etc.) for general discussion

---

## Annotations and Measurements

### Annotations
Annotations communicate design intent directly on the canvas:
- Created via the UI (`Shift+T` in the toolbar)
- Support plain text descriptions
- Support **auto-updating property references** — mention a dimension, color, or other property and it updates when the design changes
- Color-coded by category for visual scanning
- Appear as green dots in Dev Mode
- Require a Full seat (not available on free/view-only plans)

### Measurements
Measurements visualize distances between elements:
- Created via `Shift+M` in the toolbar
- Show pixel distances between selected elements
- Auto-update when elements move
- Visible in Dev Mode for developer reference

### Through the Plugin API
Annotations are available via the Plugin API as `AnnotationNode`. MCP tools can create and manage annotations programmatically, including setting the annotation text and linking to properties.

---

## Dev Mode

Dev Mode (`Shift+D`) transforms the Figma interface for developers.

### What Dev Mode Surfaces
- **Component information**: Component name, description, properties, variants
- **Code generation**: CSS, iOS (Swift), Android (XML/Compose) code snippets
- **Layout details**: Spacing, padding, sizing, constraints
- **Variable bindings**: Shows which variables are bound to which properties
- **Asset export**: Export settings and downloadable assets
- **Annotations**: Green dots showing designer annotations

### Key Dev Mode Features

**Component Playground**: Developers can experiment with component property combinations without changing the file. Available when inspecting a component instance.

**Compare Changes**: Timeline showing design changes over time with before/after property diffs. Helps developers identify what changed since their last visit.

**Focus View**: Isolates a specific design element with version history. Developers can see the evolution of a single component or frame.

**Dev Statuses**: 
- `Ready for dev` — design is finalized, ready for implementation
- `Completed` — developer marks as implemented
- `Changed` — automatically applied when a "Completed" design is modified

**Code Connect**: Links actual code implementations to Figma components. When developers inspect a component, they see the real code (not generated CSS). Set up via Figma's Code Connect API.

### Sections in Dev Mode
Dev Mode organizes content by sections. Content outside sections is collapsed into an "Other layers" group. Always use sections to define what developers should see.

### Through the Plugin API
Plugins can detect Dev Mode via `figma.mode === 'dev'`. Dev Mode plugins have access to read operations but limited write access. Codegen plugins extend the code panel with custom code output.

---

## Branching

Branching creates safe copies of a file for exploration without affecting the main file.

### How Branching Works
- Create a branch from a main file
- Make changes on the branch freely
- All changes are tracked for comparison
- Merge branch back to main when ready

### Branch Limitations
- Available on Organization and Enterprise plans only
- Cannot publish library updates from a branch
- Merge is all-or-nothing (no selective merge)
- Branch-specific comments are NOT included when merging
- Cannot branch a branch (only branch from main)

### Through the Plugin API
The Plugin API does not have branch-specific methods. Plugins run identically on branches and main files. Branch management (create, merge, compare) is handled through the REST API or Figma UI.

### Best Practices
- Use branches for significant library updates that need review before publishing
- Keep branches short-lived — long-running branches increase merge conflict risk
- Update from main periodically to reduce divergence
- Add descriptive names to branches: "feature/new-button-variants", "fix/color-token-values"

---

## Library Management

### Publishing Components and Styles
Libraries are shared through team/organization publishing:
1. Organize components, styles, and variables in a dedicated library file
2. Add descriptions and documentation to all public components
3. Publish via the UI (Libraries panel)
4. Consuming files subscribe to updates

### Publishing Best Practices
- Use a dedicated library file — don't publish from active design files
- Prefix internal components with `_` or `.` to hide from publishing
- Set `hiddenFromPublishing = true` on primitive variable collections
- Test changes before publishing (use branches if available)
- Include version notes when publishing updates

### Through the Plugin API
- `figma.importComponentByKeyAsync(key)` — imports a component from an external library
- `figma.importComponentSetByKeyAsync(key)` — imports a component set
- `figma.importStyleByKeyAsync(key)` — imports a style
- Remote components are read-only (`node.remote === true`)

### Library Update Workflow
When a library publishes updates:
1. Consuming files see an update notification
2. Designers choose to accept or dismiss updates
3. Accepted updates apply to all instances of changed components
4. Overrides on instances are preserved (if layer names haven't changed)

---

## Handoff Best Practices

### Design Preparation
1. **Name all layers** meaningfully — `Header`, `SearchInput`, not `Frame 47`
2. **Use components** for repeated elements — developers can identify reusable code
3. **Bind variables** to values — developers see token names in Dev Mode
4. **Add annotations** for complex interactions or non-obvious behavior
5. **Mark sections** as "Ready for dev" when finalized
6. **Include all states** — hover, active, disabled, error, empty, loading

### Organization for Developers
- Group related screens in sections
- Order sections logically (by user flow, not by creation date)
- Include a "Component Documentation" section showing all component variants
- Add measurements for critical spacing relationships

### What to Communicate
- Interaction behavior (hover states, transitions, timing)
- Responsive rules (what happens at different widths)
- Edge cases (long text, empty states, error states)
- Animation specs (duration, easing, properties)
- Accessibility requirements (focus order, ARIA roles, contrast ratios)

---

## Boolean Operations

Four boolean operations combine shapes non-destructively:

| Operation | Result | Fill/Stroke from |
|-----------|--------|-----------------|
| Union | Combined outline of all shapes | Topmost layer |
| Subtract | Bottom minus top shapes | Bottom layer |
| Intersect | Only overlapping areas | Topmost layer |
| Exclude | Non-overlapping areas (XOR) | Topmost layer |

Through the API: `figma.union(nodes, parent)`, `figma.subtract(nodes, parent)`, etc. Returns a `BooleanOperationNode`.

Cannot apply boolean operations to sections or frames. Only works on shape nodes (rectangles, ellipses, polygons, vectors, other boolean groups).

Boolean operations now use both stroke AND fill geometry for calculations.

---

## Masks and Clip Content

### Masks
Any layer can serve as a mask. The mask layer must be positioned below the layers it masks in the layer order. Mask behavior:
- Alpha channel determines reveal amount (0% opacity = fully hidden)
- Can use any shape as a mask (rectangles, ellipses, vectors, text)
- Non-destructive — masked layers are not modified

### Clip Content
A simpler alternative to masks: enable `clipContent` on any frame to hide content extending beyond its bounds. The clip boundary is always rectangular (the frame's bounding box). Set via `node.clipsContent = true`.

---

## Effects and Blend Modes

### Effect Types
- **Drop shadow**: External shadow. Properties: color, offset (x/y), blur radius, spread.
- **Inner shadow**: Internal shadow. Same properties as drop shadow.
- **Layer blur**: Gaussian blur of the entire layer.
- **Background blur**: Blurs content behind the layer (frosted glass effect).
- **Noise**: Adds grain texture.

Multiple effects can be stacked on one layer — up to 8 shadows each, 1 layer blur, 1 background blur, 2 noise effects.

### Blend Modes
16 modes: Normal, Darken, Multiply, Color Burn, Lighten, Screen, Color Dodge, Overlay, Soft Light, Hard Light, Difference, Exclusion, Hue, Saturation, Color, Luminosity.

**Pass Through** (default for group-like containers) lets child blend modes interact with content below the container.

---

## Constraints vs Auto Layout

These are mutually exclusive systems for controlling how layers respond to parent resizing:

**Constraints** apply to children of frames WITHOUT auto layout:
- Horizontal: Left, Right, Left+Right (stretch), Center, Scale
- Vertical: Top, Bottom, Top+Bottom (stretch), Center, Scale

**Auto layout** sizing replaces constraints:
- `layoutSizingHorizontal/Vertical` controls how children size
- `layoutAlign` controls cross-axis stretching
- `layoutPositioning = 'ABSOLUTE'` children use constraints WITHIN auto layout

You cannot apply constraints to flow children in auto layout frames. Only absolutely positioned children within auto layout frames can use constraints.

---

## Prototyping Overview

Prototyping creates interactive flows between frames. The model is: **Interaction = Trigger + Action**.

### Triggers
Click, Drag, Hover, Mouse Enter/Leave, After Delay, Key Press, Touch Down, Video Completion.

### Actions
Navigate To, Scroll To, Open Overlay, Close Overlay, Swap Overlay, Back, Open Link, Set Variable, Conditional.

### Smart Animate
Matches layers by **name and hierarchy** across frames. Animates property differences (position, size, opacity, rotation, fills). Layer names must match exactly for animation pairing.

### Interactive Components
Prototype interactions between variants within a component set. These interactions are inherited by all instances. Example: hover state changes on a button variant.

### Through the Plugin API
Reactions (prototyping connections) are accessible on nodes via the `reactions` property. This is a read-write array of `Reaction` objects, each containing a trigger and an action.

Note: Prototyping is often secondary for MCP workflows focused on design system building. But if the user asks for interactive prototypes, the Plugin API fully supports creating connections.
