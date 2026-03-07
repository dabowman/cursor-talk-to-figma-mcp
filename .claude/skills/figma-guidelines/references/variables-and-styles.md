# Variables and Styles Guide

## Table of Contents
- Variable types and what they bind to
- Variable collections and modes
- Three-tier token architecture
- Variable aliasing
- Variable scoping
- Binding variables to nodes
- Mode resolution
- Style types
- Variables vs styles decision guide
- Style naming conventions
- Creating and managing variables
- Creating and managing styles
- Migrating styles to variables
- Common mistakes

---

## Variable Types and What They Bind To

| Type | API Resolved Type | Can Bind To |
|------|-------------------|-------------|
| Color | `'COLOR'` | Fills (solid only), strokes, effect colors (shadow, blur), gradient stops |
| Number | `'FLOAT'` | Corner radius, width, height, min/max dimensions, padding (all 4), gap, font size, line height, letter spacing, paragraph spacing, stroke weight, opacity, effect offset/blur/spread |
| String | `'STRING'` | Text content (`.characters`), font family, font style |
| Boolean | `'BOOLEAN'` | Layer visibility (`.visible`) |

### What Variables CANNOT Do
- Gradients (use paint styles)
- Multiple fills on one layer (use paint styles)
- Image fills (no variable type for this)
- Blend modes
- Complete typography definitions (use text styles)
- Complex effect stacks (use effect styles)

---

## Variable Collections and Modes

A **variable collection** groups related variables. Each collection can hold up to 5,000 variables and supports multiple **modes**.

**Modes** are named columns in a collection. Each variable has a value (or alias) per mode. Common mode patterns:
- Theme modes: Light, Dark, High Contrast
- Breakpoint modes: Mobile, Tablet, Desktop
- Brand modes: Brand A, Brand B
- Density modes: Comfortable, Compact
- Locale modes: English, Arabic (RTL), Japanese

**Mode limits by plan:**
- Free/Starter: 1 mode (no switching)
- Professional: 4 modes per collection
- Organization: 4 modes per collection
- Enterprise: 40 modes per collection

### Setting Modes on Nodes

Modes are set on **frames and components**, not on individual layers. All children inherit the parent's mode. Set with `node.setExplicitVariableModeForCollection(collection, modeId)`.

---

## Three-Tier Token Architecture

This is the recommended structure for design systems. It maps directly to how code-side design tokens work.

### Tier 1: Primitives Collection
Raw color, spacing, and sizing values. No semantic meaning.

```
primitives/
├── color/
│   ├── blue/50    = #E3F2FD
│   ├── blue/100   = #BBDEFB
│   ├── blue/500   = #2196F3
│   ├── blue/900   = #0D47A1
│   ├── neutral/0  = #FFFFFF
│   ├── neutral/50 = #FAFAFA
│   └── neutral/900 = #212121
├── space/
│   ├── 0  = 0
│   ├── 1  = 4
│   ├── 2  = 8
│   ├── 3  = 12
│   ├── 4  = 16
│   ├── 6  = 24
│   └── 8  = 32
├── radius/
│   ├── none = 0
│   ├── sm   = 4
│   ├── md   = 8
│   └── full = 9999
└── size/
    ├── icon/sm  = 16
    ├── icon/md  = 24
    └── icon/lg  = 32
```

**Hide this collection from publishing** — designers should use semantic tokens, not primitives.

### Tier 2: Semantic Tokens Collection
Purpose-based names that alias primitives. This is where modes live.

```
tokens/ (modes: Light, Dark)
├── color/
│   ├── surface/primary    → Light: neutral/0    | Dark: neutral/900
│   ├── surface/secondary  → Light: neutral/50   | Dark: neutral/800
│   ├── text/primary       → Light: neutral/900  | Dark: neutral/0
│   ├── text/secondary     → Light: neutral/600  | Dark: neutral/400
│   ├── brand/primary      → Light: blue/500     | Dark: blue/300
│   ├── border/default     → Light: neutral/200  | Dark: neutral/700
│   └── interactive/hover  → Light: blue/50      | Dark: blue/900
├── space/
│   ├── component/padding  → space/4
│   ├── component/gap      → space/3
│   ├── page/margin        → space/8
│   └── section/gap        → space/6
└── radius/
    ├── component/default  → radius/md
    └── component/pill     → radius/full
```

### Tier 3: Component-Specific Tokens (Optional)
Tokens scoped to individual components for fine-grained control.

```
button-tokens/
├── color/
│   ├── bg/primary     → brand/primary
│   ├── bg/secondary   → surface/secondary
│   ├── text/primary   → neutral/0 (always white on primary)
│   └── text/secondary → text/primary
└── space/
    ├── padding/sm  → space/2
    ├── padding/md  → space/4
    └── padding/lg  → space/6
```

---

## Variable Aliasing

A variable can reference another variable of the same type, creating alias chains. This is how the three-tier architecture works — semantic tokens alias primitives, and component tokens alias semantic tokens.

Creating an alias:
```
const alias = figma.variables.createVariableAlias(sourceVariable)
targetVariable.setValueForMode(modeId, alias)
```

Alias chains resolve transitively: if A → B → C, resolving A gives C's raw value.

**Important**: `variable.valuesByMode` returns the raw/alias value WITHOUT resolving. To get the fully resolved value, use `variable.resolveForConsumer(node)` which considers the node's mode context.

---

## Variable Scoping

Scoping controls which Figma UI pickers show a variable. It does NOT limit API access — you can bind any compatible variable to any field via the API regardless of scope.

Scope options:
- `ALL_SCOPES` — appears everywhere
- `ALL_FILLS` — all fill pickers
- `FRAME_FILL` — frame fills only
- `SHAPE_FILL` — shape fills only
- `TEXT_FILL` — text fills only
- `STROKE_COLOR` — stroke color pickers
- `EFFECT_COLOR` — effect color pickers (shadows, etc.)
- `CORNER_RADIUS` — corner radius fields
- `WIDTH_HEIGHT` — width/height fields
- `GAP` — auto layout gap fields
- `OPACITY` — opacity field
- `FONT_FAMILY` — font family picker
- `FONT_SIZE` — font size field
- `LINE_HEIGHT` — line height field
- `LETTER_SPACING` — letter spacing field
- `PARAGRAPH_SPACING` — paragraph spacing field
- `FONT_STYLE` — font style picker

Set via `variable.scopes = ['FRAME_FILL', 'SHAPE_FILL']`.

Best practice: Scope primitives narrowly (color primitives to fill/stroke, spacing to gap/padding). Scope semantic tokens to their intended use (surface colors to fills, text colors to text fills).

---

## Binding Variables to Nodes

### Direct Binding
```
node.setBoundVariable('fills', 0, colorVariable)   // Bind to first fill
node.setBoundVariable('width', numberVariable)
node.setBoundVariable('itemSpacing', spacingVariable)
node.setBoundVariable('paddingTop', paddingVariable)
node.setBoundVariable('cornerRadius', radiusVariable)
node.setBoundVariable('visible', booleanVariable)
node.setBoundVariable('characters', stringVariable)
```

### Paint Binding (Fills/Strokes)
For fills and strokes, bind to specific indices:
```
node.setBoundVariable('fills', 0, colorVariable)    // First fill color
node.setBoundVariable('strokes', 0, colorVariable)   // First stroke color
```

### Reading Bindings
```
node.boundVariables  // Returns all variable bindings on the node
```

---

## Mode Resolution

When Figma resolves a variable value for a specific node, it follows this hierarchy:

1. Check the node itself for an explicit mode setting
2. Walk up the parent chain — first ancestor with an explicit mode wins
3. Page-level mode (if set)
4. Collection default mode (leftmost column)

This means you can set a frame to "Dark" mode and all children automatically resolve dark values — without setting modes on each child individually.

**PageNode quirk**: `PageNode` does NOT support `resolvedVariableModes` or `explicitVariableModes` (both return undefined). To check page-level modes, inspect a top-level child frame instead.

---

## Style Types

### Paint Styles
Store one or more fills or strokes. Support:
- Solid colors (with opacity)
- Linear, radial, angular, and diamond gradients
- Image fills (fill, fit, crop, tile modes)
- Multiple stacked fills (e.g., gradient over solid)
- Blend modes per fill

### Text Styles
Store typography definitions:
- Font family and style (weight/italic)
- Font size
- Line height (auto, fixed, percentage)
- Letter spacing
- Paragraph spacing and indentation
- **Does NOT include**: text color (use paint style or variable), alignment

### Effect Styles
Store one or more effects:
- Drop shadow (color, offset, blur, spread)
- Inner shadow (same parameters)
- Layer blur
- Background blur
- Noise and texture
- Multiple effects stack (e.g., subtle shadow + deeper shadow)

### Grid Styles
Store layout grid configurations:
- Column grids (count, width, gutter, offset, alignment)
- Row grids (same parameters)
- Uniform grids (fixed cell size)
- Multiple grids combine (e.g., 12-column + baseline row)

---

## Variables vs Styles Decision Guide

| Need | Use Variable | Use Style |
|------|-------------|-----------|
| Single solid color with theme modes | ✅ | |
| Gradient fill | | ✅ |
| Multiple stacked fills | | ✅ |
| Image fill | | ✅ |
| Spacing value (padding, gap) | ✅ | |
| Corner radius | ✅ | |
| Full typography definition | | ✅ |
| Font size alone | ✅ | |
| Single shadow | ✅ (bind individual props) | ✅ (easier) |
| Complex shadow stack | | ✅ |
| Layout grid | | ✅ |
| Value that changes per theme/mode | ✅ | |
| Opacity value | ✅ | |
| Layer visibility toggle | ✅ | |
| Text content | ✅ | |

**Best practice**: Use variables as the foundation, then use styles that reference variables for composite values. A text style's font size can be bound to a variable — the style defines the full typography, while the variable enables per-mode value switching.

---

## Style Naming Conventions

Use slash `/` separators for grouping, just like components:

```
Brand/Primary
Brand/Secondary
Neutral/50
Neutral/100

Heading/H1
Heading/H2
Body/Regular
Body/Small

Elevation/100
Elevation/200
Elevation/300

Grid/Mobile
Grid/Desktop
Grid/Baseline
```

Styles appear in the panel in the order they appear in the Local styles list. Drag to reorder.

---

## Creating and Managing Variables

### Create Collection
```
const collection = figma.variables.createVariableCollection('Primitives')
```

### Add Modes
```
const darkModeId = collection.addMode('Dark')
collection.renameMode(collection.modes[0].modeId, 'Light')
```

### Create Variable
```
const colorVar = figma.variables.createVariable('color/primary/500', collection, 'COLOR')
colorVar.setValueForMode(lightModeId, { r: 0.13, g: 0.59, b: 0.95, a: 1 })
colorVar.setValueForMode(darkModeId, { r: 0.46, g: 0.78, b: 1, a: 1 })
```

### Set Scoping
```
colorVar.scopes = ['ALL_FILLS', 'STROKE_COLOR', 'EFFECT_COLOR']
```

### Set Description
```
colorVar.description = 'Primary brand color for interactive elements'
```

### Hide from Publishing
```
collection.hiddenFromPublishing = true  // For primitive collections
```

### Retrieve Variables
```
const allVars = await figma.variables.getLocalVariablesAsync()
const colorVars = await figma.variables.getLocalVariablesAsync('COLOR')
const collections = await figma.variables.getLocalVariableCollectionsAsync()
const varById = await figma.variables.getVariableByIdAsync(id)
```

---

## Creating and Managing Styles

### Paint Style
```
const style = figma.createPaintStyle()
style.name = 'Brand/Primary'
style.paints = [{ type: 'SOLID', color: { r: 0.13, g: 0.59, b: 0.95 }, opacity: 1 }]
style.description = 'Primary brand color'
```

### Text Style
```
const style = figma.createTextStyle()
style.name = 'Heading/H1'
style.fontName = { family: 'Inter', style: 'Bold' }
style.fontSize = 32
style.lineHeight = { value: 40, unit: 'PIXELS' }
style.letterSpacing = { value: -0.5, unit: 'PIXELS' }
```

### Effect Style
```
const style = figma.createEffectStyle()
style.name = 'Elevation/200'
style.effects = [{
  type: 'DROP_SHADOW',
  color: { r: 0, g: 0, b: 0, a: 0.15 },
  offset: { x: 0, y: 4 },
  radius: 8,
  spread: 0,
  visible: true,
  blendMode: 'NORMAL'
}]
```

### Apply Style to Node
```
node.fillStyleId = style.id
node.textStyleId = textStyle.id
node.effectStyleId = effectStyle.id
node.gridStyleId = gridStyle.id
```

---

## Common Mistakes

**Trying to use a color variable for a gradient**: Variables only support solid RGBA colors. Use a paint style for gradients.

**Setting variable values with 0–255 color range**: Figma uses 0–1 floats. Divide by 255.

**Forgetting to hide primitives from publishing**: Designers should use semantic tokens. Set `collection.hiddenFromPublishing = true` on primitive collections.

**Not scoping variables**: Without scoping, every variable appears in every picker, creating a cluttered experience. Scope to intended uses.

**Cross-file variable conflicts**: When library variables gain new modes, consuming files may need explicit mode re-mapping. Updates must propagate through the entire chain of library files.

**Assuming valuesByMode resolves aliases**: `valuesByMode` returns raw values or alias references. Use `resolveForConsumer(node)` for the final resolved value.
