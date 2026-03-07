# Auto Layout Guide

## Table of Contents
- Property reference table
- Direction and spacing
- Alignment
- Child sizing (HUG, FILL, FIXED)
- Padding
- Wrap mode
- Absolute positioning
- Strokes in layout
- Stacking order
- Nested auto layout patterns
- Common responsive patterns
- Troubleshooting

---

## Property Reference Table

| UI Concept | API Property | Values | Set On |
|---|---|---|---|
| Direction | `layoutMode` | `'NONE'` / `'HORIZONTAL'` / `'VERTICAL'` | Parent frame |
| Gap between children | `itemSpacing` | number (px) | Parent frame |
| Wrap gap (cross-axis) | `counterAxisSpacing` | number (px) | Parent frame (wrap mode only) |
| Padding top | `paddingTop` | number | Parent frame |
| Padding right | `paddingRight` | number | Parent frame |
| Padding bottom | `paddingBottom` | number | Parent frame |
| Padding left | `paddingLeft` | number | Parent frame |
| Primary axis alignment | `primaryAxisAlignItems` | `'MIN'` / `'CENTER'` / `'MAX'` / `'SPACE_BETWEEN'` | Parent frame |
| Counter axis alignment | `counterAxisAlignItems` | `'MIN'` / `'CENTER'` / `'MAX'` / `'BASELINE'` | Parent frame |
| Child horizontal sizing | `layoutSizingHorizontal` | `'FIXED'` / `'HUG'` / `'FILL'` | Child node |
| Child vertical sizing | `layoutSizingVertical` | `'FIXED'` / `'HUG'` / `'FILL'` | Child node |
| Absolute positioning | `layoutPositioning` | `'AUTO'` / `'ABSOLUTE'` | Child node |
| Wrap | `layoutWrap` | `'NO_WRAP'` / `'WRAP'` | Parent frame |
| Strokes in layout | `strokesIncludedInLayout` | boolean | Parent frame |
| Canvas stacking | `itemReverseZIndex` | boolean | Parent frame |
| Min width | `minWidth` | number or null | Auto layout frame or child |
| Max width | `maxWidth` | number or null | Auto layout frame or child |
| Min height | `minHeight` | number or null | Auto layout frame or child |
| Max height | `maxHeight` | number or null | Auto layout frame or child |

---

## Direction and Spacing

**Horizontal** (`layoutMode = 'HORIZONTAL'`): Children flow left to right. Primary axis = horizontal, counter axis = vertical.

**Vertical** (`layoutMode = 'VERTICAL'`): Children flow top to bottom. Primary axis = vertical, counter axis = horizontal.

**Gap** (`itemSpacing`): Space between each child in the flow direction. Set to a numeric value. For `space-between` behavior (children spread evenly), set `primaryAxisAlignItems = 'SPACE_BETWEEN'` — this overrides `itemSpacing`.

**Negative spacing**: You can set negative `itemSpacing` values to create overlapping children. Combined with `itemReverseZIndex`, this creates stacked-chip or avatar-pile effects.

---

## Alignment

Alignment is set on the **parent frame**, not on individual children.

**Primary axis** (flow direction): `MIN` (start), `CENTER`, `MAX` (end), `SPACE_BETWEEN` (spread evenly).

**Counter axis** (perpendicular): `MIN`, `CENTER`, `MAX`, `BASELINE` (aligns by text baselines — useful for rows mixing text of different sizes).

When `primaryAxisAlignItems = 'SPACE_BETWEEN'`, children distribute evenly along the primary axis. `itemSpacing` is ignored.

---

## Child Sizing

This is the most important auto layout concept. Every child in an auto layout frame has sizing on both axes:

### HUG Contents
- The child shrinks to fit its own children (if it's a frame) or content (if it's text).
- Only works on frames and text nodes.
- A parent cannot HUG on an axis where any child is set to FILL on that same axis.

### FILL Container
- The child stretches to fill the available space in the parent.
- Only valid when the child's parent has auto layout.
- Multiple FILL children share space equally unless `layoutGrow` differs.
- Cannot set FILL on a child if the parent HUGs on that axis.

### FIXED
- Explicit size. Use `resize(width, height)` to set dimensions.
- Position is still controlled by the layout engine (spacing, alignment).

### The HUG-FILL Conflict Rule

If a child is FILL, the parent on that axis must be FIXED or FILL (not HUG). If a parent is HUG, all children on that axis must be FIXED or HUG (not FILL). This is a hard constraint — violating it causes errors.

**Valid combinations for a horizontal auto layout frame:**
- Parent FIXED width → children can be FIXED, HUG, or FILL horizontally
- Parent FILL width → children can be FIXED, HUG, or FILL horizontally
- Parent HUG width → children must be FIXED or HUG horizontally (no FILL)

---

## Padding

Padding adds space between the frame boundary and its children. Four independent values: `paddingTop`, `paddingRight`, `paddingBottom`, `paddingLeft`.

Uniform padding: set all four to the same value.
Symmetric padding: top=bottom, left=right.

Padding does NOT accept variables directly on the individual properties in all cases. Bind variables via `setBoundVariable('paddingTop', variable)`.

---

## Wrap Mode

Set `layoutWrap = 'WRAP'` on a horizontal auto layout frame. When children overflow the frame width, they wrap to the next line.

- Only works with `layoutMode = 'HORIZONTAL'`.
- `counterAxisSpacing` sets the gap between wrapped lines (vertical gap).
- `itemSpacing` controls horizontal gap between items in a line.
- Counter-axis alignment (`counterAxisAlignItems`) aligns wrapped lines.

Wrap mode is essential for tag clouds, pill groups, responsive grids, and any content that should reflow at different widths.

---

## Absolute Positioning

Set `layoutPositioning = 'ABSOLUTE'` on a child to pull it out of the auto layout flow. The child stays nested in the frame but is positioned using **constraints** (like CSS `position: absolute`).

Use cases: floating action buttons, overlapping badges, decorative elements, close/dismiss buttons in corners.

Constraints on absolutely positioned children: `constraints = { horizontal: 'MIN', vertical: 'MIN' }` pins to top-left. Options: `MIN`, `MAX`, `CENTER`, `SCALE`, `MIN_MAX` (stretch).

**Bug warning**: Using `figma.group()` on absolutely positioned nodes resets their `layoutPositioning` to `AUTO`, losing their position.

---

## Strokes in Layout

By default, strokes are NOT included in layout calculations. The auto layout positions children based on their bounding box without strokes.

Set `strokesIncludedInLayout = true` on the parent frame to match CSS `border-box` behavior where borders are part of the element's size.

---

## Stacking Order

Default: last child in the children array renders on top (like CSS).

Set `itemReverseZIndex = true` to flip this — first child renders on top. Useful with negative spacing for layered effects (avatar stacks where the first avatar should be on top).

---

## Nested Auto Layout Patterns

### Card Layout (Vertical Stack)
```
Card Frame (VERTICAL, padding: 16, gap: 12)
├── Image Frame (FILL horizontal, FIXED 200 height)
├── Title Text (FILL horizontal, HUG vertical)
├── Description Text (FILL horizontal, HUG vertical)
└── Actions Frame (HORIZONTAL, gap: 8, FILL horizontal)
    ├── Button (HUG both)
    └── Button (HUG both)
```

### Full-Width Header
```
Header Frame (HORIZONTAL, padding: 0 24, gap: 0, FILL horizontal, FIXED 64 height)
├── Logo (FIXED both)
├── Spacer Frame (FILL horizontal, FIXED 1 height) ← pushes nav right
└── Nav Frame (HORIZONTAL, gap: 16, HUG both)
    ├── NavItem (HUG)
    └── NavItem (HUG)
```

For space-between without a spacer: set `primaryAxisAlignItems = 'SPACE_BETWEEN'` on the header frame.

### Responsive Two-Column
```
Container (HORIZONTAL, gap: 24, FILL horizontal, HUG vertical)
├── Sidebar (FIXED 280 width, HUG vertical)
└── Main Content (FILL horizontal, HUG vertical)
```

### Centered Content with Max Width
```
Page Frame (VERTICAL, counterAxisAlignItems: CENTER, FILL both)
└── Content Frame (FIXED 1200 width, maxWidth: 1200, HUG vertical)
    └── ... page content
```

---

## Common Responsive Patterns

Figma has no breakpoints, but auto layout patterns simulate responsive behavior:

**Flexible width items**: Use FILL to make items grow/shrink with container.

**Wrap for reflow**: Horizontal auto layout with wrap makes content reflow at different container widths.

**Min/max constraints**: Set `minWidth`/`maxWidth` on FILL children to prevent them from becoming too narrow or too wide.

**Stack switching**: To simulate mobile (vertical) vs desktop (horizontal), create separate component variants with different `layoutMode` values.

---

## Troubleshooting

**"Cannot set layoutSizingHorizontal on this node"**
The node is not inside an auto layout frame. Enable auto layout on the parent first.

**"Can only set maxHeight on auto layout nodes and their children"**
Min/max constraints require the node to be an auto layout frame or a direct child of one.

**Children appear stacked at 0,0**
Auto layout was removed (`layoutMode = 'NONE'`) without repositioning children. Removing auto layout does not restore original positions.

**Child isn't stretching with FILL**
Check that the parent's sizing on that axis is not HUG. Change parent to FIXED or FILL.

**Gap looks wrong after wrap**
In wrap mode, `itemSpacing` controls horizontal gap and `counterAxisSpacing` controls vertical gap between rows. Make sure both are set.
