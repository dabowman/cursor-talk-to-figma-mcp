# Components and Variants Guide

## Table of Contents
- Component fundamentals
- Creating components
- Variants and component sets
- Component properties (boolean, text, instance swap, slot)
- Component property naming (the #suffix gotcha)
- Overrides and how they transfer
- Atomic design patterns
- Naming and organization
- Component documentation
- Library publishing
- Working with instances programmatically
- Common mistakes

---

## Component Fundamentals

A **main component** defines a reusable element. It has a purple diamond ◆ icon and acts as the source of truth — changes propagate to all instances.

An **instance** is a linked copy with an empty diamond ◇ icon. Instances inherit from their main component but can override certain properties. Deleting a main component does not remove instances — they become unlinked but still functional.

The **main component is itself a frame**. It supports everything a FrameNode supports: auto layout, fills, strokes, effects, constraints, clip content. Build components with auto layout for responsive behavior.

---

## Creating Components

### From scratch
1. Create a frame with the desired structure
2. Convert to component (`figma.createComponent()` or `figma.createComponentFromNode(node)`)
3. Add component properties as needed

### From existing node
`figma.createComponentFromNode(existingFrame)` converts a frame to a component, preserving all children and properties.

### Component set (variants)
`figma.combineAsVariants([comp1, comp2, ...], parentFrame)` creates a ComponentSetNode containing the components as variants.

---

## Variants and Component Sets

A **ComponentSetNode** is a special container (purple dashed border) that holds multiple variant components. Rules:
- Can ONLY contain ComponentNodes — no text, frames, groups, or other node types
- Each variant must have a unique combination of property values — no duplicates
- The **default variant** is the top-left component in the set
- Variant component names follow `Property=Value, Property=Value` format

### Creating Variants

Two approaches:

**Approach 1: Combine existing components**
1. Create individual components with names like `Size=Small`, `Size=Medium`, `Size=Large`
2. Call `figma.combineAsVariants([small, medium, large], parent)`
3. Figma auto-creates variant properties from the name segments

**Approach 2: Add properties to existing component**
1. Start with a single component
2. Add variant properties via `addComponentProperty(name, 'VARIANT', defaultValue)`
3. Duplicate the component within the set for each variant value

### Variant Property Values

Variant property values are always **strings**. Common patterns:
- Size: `'Small'`, `'Medium'`, `'Large'`
- State: `'Default'`, `'Hover'`, `'Pressed'`, `'Disabled'`
- Type: `'Primary'`, `'Secondary'`, `'Outline'`, `'Ghost'`
- Boolean-like: `'True'`, `'False'` (as strings, NOT boolean type)

---

## Component Properties

Four non-variant property types provide customization without creating additional variants:

### Boolean Properties
- Toggle **layer visibility only** — they cannot control anything else
- The linked layer becomes visible (`true`) or hidden (`false`)
- Cannot be used to swap variants, change colors, or alter any non-visibility attribute
- Consolidating interactive components using boolean properties loses prototyping connections

### Text Properties
- Expose editable text content on instances
- Default value syncs bidirectionally with the main component's text layer content
- Each text property links to one text layer in the component

### Instance Swap Properties
- Define which nested component instances can be swapped
- Support **preferred values** — a curated shortlist of components shown first in the picker
- Nested instance must already exist in the component structure

### Slot Properties
- Create flexible content areas where instance users can freely add and rearrange layers
- Similar to React's `children` or slot pattern
- **Destructive warning**: Removing a slot from a main component destroys all instance modifications
- Available through the exposed `isExposedInstance` property on nested instances

---

## Component Property Naming — The #Suffix Gotcha

This is one of the most common sources of "property not found" errors.

**Variant properties** have plain names: `'Size'`, `'State'`, `'Type'`

**Boolean, Text, and Instance Swap properties** have a `#uniqueId` suffix appended automatically: `'Show Icon#12:0'`, `'Label#0:1'`, `'Icon#5:3'`

The suffix is assigned by Figma and cannot be controlled. You MUST use the full suffixed name in:
- `setProperties()` on instances
- `editComponentProperty()`
- `deleteComponentProperty()`

`addComponentProperty()` returns the full name with suffix — capture and store this.

To discover existing property names, read `componentPropertyDefinitions` on the component or `componentProperties` on an instance.

---

## Overrides and How They Transfer

### What Can Be Overridden on Instances
- Text content
- Fill and stroke colors
- Effects (shadows, blurs)
- Layout grid visibility
- Nested instance swaps
- Export settings
- Layer names
- Component property values

### What CANNOT Be Overridden
- Layer order (child sequence)
- Position within the component tree
- Constraints
- Text layer bounding box dimensions
- Adding/removing children

### Override Transfer During Instance Swap

When swapping an instance to a different component, overrides transfer if **layer names match** between source and target. This is why consistent layer naming across component variants is critical.

Example: If a button's label layer is named `"Label"` in both Primary and Secondary variants, text overrides transfer when swapping. If Primary uses `"ButtonText"` and Secondary uses `"Label"`, overrides are lost.

### Resetting Overrides
- `resetOverrides()` on an instance reverts all overrides to main component values
- Individual properties can be reset through the UI but require targeted property resets via API

---

## Atomic Design Patterns

### Token Layer (Variables and Styles)
Design tokens implemented as Figma variables and styles. These aren't components but form the foundation.
- Colors: `color/primary/500`, `color/neutral/100`
- Spacing: `space/xs` (4), `space/sm` (8), `space/md` (16)
- Typography: Text styles like `heading/lg`, `body/md`
- Effects: Shadow styles like `elevation/100`, `elevation/200`

### Atom Components
Smallest functional units. Should be fully self-contained.
- `_Icon/ChevronRight` (prefixed with `_` — internal only)
- `Button` with variants: Size, Type, State
- `Badge` with variants: Color, Size
- `Input` with variants: State, Size
- `Avatar` with variants: Size, Shape

### Molecule Components
Combine atoms into functional groups:
- `SearchBar` = Input + Button + Icon instances
- `CardHeader` = Avatar + Text + Badge
- `MenuItem` = Icon + Text + Shortcut text
- `FormField` = Label text + Input + Helper text

### Organism Components
Complex, self-contained sections:
- `NavigationBar` = Logo + NavItems + SearchBar + Avatar
- `DataTable` = Header row + Data rows + Pagination
- `Modal` = Overlay + Card + Header + Content + Footer

### Page Templates
Full page layouts using organisms:
- `DashboardPage` = NavBar + Sidebar + MainContent + Footer

---

## Naming and Organization

### Slash Convention
`Category/Subcategory/Name` creates hierarchy in the Assets panel:
```
Button/Primary/Large
Button/Primary/Medium
Button/Secondary/Large
Icon/Navigation/ChevronRight
Icon/Action/Delete
```

### Prefix Conventions
- `_ComponentName` or `.ComponentName` — hidden from library publishing
- Use for internal-only atoms and utility components

### File Organization
- Dedicate pages to component categories: "Buttons", "Forms", "Navigation"
- Group related components with sections on the canvas
- Place main components in clearly labeled areas — don't scatter them among design mockups
- Use a "Component Playground" page for testing and documentation

### Component Documentation
Every published component should have:
- **Description**: Searchable text explaining purpose and usage
- **Links**: URLs to Storybook, code docs, or design guidelines
- Both appear in Assets panel hover, instance sidebar, and Dev Mode

---

## Library Publishing

### What Gets Published
- Components not prefixed with `_` or `.`
- Styles
- Variables (respect `hiddenFromPublishing` flag on collections)

### Publishing Best Practices
- Always add descriptions before publishing
- Set up a dedicated library file (don't publish from design files)
- Use branches for library changes to avoid breaking consumers
- Test changes with a preview before publishing

---

## Working with Instances Programmatically

### Creating Instances
```
const instance = component.createInstance()
```
Instance is created at the same position as the component. Move it to desired location.

### Setting Properties
```
instance.setProperties({
  'Size': 'Large',              // Variant property (no suffix)
  'Label#12:0': 'Click Me',     // Text property (with suffix)
  'Show Icon#0:1': true,        // Boolean property (with suffix)
})
```

### Swapping Component
```
instance.swapComponent(otherComponent)
```
Or set `instance.mainComponent = otherComponent` (but this clears nested overrides).

### Reading Properties
```
instance.componentProperties  // Returns current values
instance.mainComponent         // Returns the main ComponentNode
```

### Detaching
```
const frame = instance.detachInstance()
```
Returns a FrameNode. All component linkage is severed. Warning: detaching also detaches all ancestor instances.

---

## Common Mistakes

**Creating a component set with non-component children**: Component sets can ONLY contain ComponentNodes. Adding a text layer or frame inside a ComponentSetNode throws an error.

**Duplicate variant combinations**: Every variant in a set must have a unique combination of property values. Two variants with `Size=Small, State=Default` causes validation errors.

**Using boolean properties for non-visibility behavior**: Boolean properties only toggle visibility. For toggle states (on/off switch), use a variant property with `'True'`/`'False'` string values.

**Forgetting the #suffix on property names**: See the naming section above. Always use the full suffixed name for non-variant properties.

**Modifying instance children directly**: You cannot add, remove, or reorder children on an instance. Modify the main component instead, or use instance swap properties for flexibility.

**Assuming override transfer without matching names**: Overrides only transfer during instance swaps when layer names match between source and target components.
