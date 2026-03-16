// Find command: unified search across a Figma subtree.
// Supports searching by componentId, variableId, styleId, text, name, type.
// Returns matches grouped by nearest component/frame ancestor with ancestry paths.

import { sendProgressUpdate, generateCommandId, delay } from "../helpers.js";

// ─── Predicate builders ─────────────────────────────────────────────────────

function buildRegex(pattern) {
  try {
    return new RegExp(pattern);
  } catch (_e) {
    // Invalid regex — fall back to literal substring match
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
}

function buildIdSet(ids) {
  const set = {};
  for (let i = 0; i < ids.length; i++) {
    set[ids[i]] = true;
  }
  return set;
}

// Check if a node has any bound variable IDs in the target set.
// Variable bindings live in two places:
// 1. node.boundVariables[field] — scalar props ({id} or [{id}])
// 2. node.fills[i].boundVariables.color / node.strokes[i].boundVariables.color — paint props
function checkVariableBindings(node, targetSet) {
  const matched = [];

  // 1. Scalar bindings via node.boundVariables
  const bv = node.boundVariables;
  if (bv) {
    const keys = Object.keys(bv);
    for (let i = 0; i < keys.length; i++) {
      const binding = bv[keys[i]];
      if (Array.isArray(binding)) {
        for (let j = 0; j < binding.length; j++) {
          if (binding[j] && binding[j].id && targetSet[binding[j].id]) {
            matched.push(binding[j].id);
          }
        }
      } else if (binding && binding.id && targetSet[binding.id]) {
        matched.push(binding.id);
      }
    }
  }

  // 2. Paint bindings via fills[].boundVariables.color
  if (node.fills && Array.isArray(node.fills)) {
    for (let fi = 0; fi < node.fills.length; fi++) {
      const fill = node.fills[fi];
      if (fill && fill.boundVariables && fill.boundVariables.color) {
        const colorBinding = fill.boundVariables.color;
        if (colorBinding && colorBinding.id && targetSet[colorBinding.id]) {
          matched.push(colorBinding.id);
        }
      }
    }
  }

  // 3. Paint bindings via strokes[].boundVariables.color
  if (node.strokes && Array.isArray(node.strokes)) {
    for (let si = 0; si < node.strokes.length; si++) {
      const stroke = node.strokes[si];
      if (stroke && stroke.boundVariables && stroke.boundVariables.color) {
        const strokeBinding = stroke.boundVariables.color;
        if (strokeBinding && strokeBinding.id && targetSet[strokeBinding.id]) {
          matched.push(strokeBinding.id);
        }
      }
    }
  }

  return matched.length > 0 ? matched : null;
}

// Check if a node uses any style IDs in the target set.
// Guards against figma.mixed (Symbol) on text nodes with mixed styles.
const STYLE_FIELDS = ["fillStyleId", "strokeStyleId", "textStyleId", "effectStyleId", "gridStyleId"];

function checkStyleBindings(node, targetSet) {
  const matched = [];
  for (let i = 0; i < STYLE_FIELDS.length; i++) {
    const field = STYLE_FIELDS[i];
    if (field in node) {
      const val = node[field];
      if (typeof val === "string" && val !== "" && targetSet[val]) {
        matched.push(val);
      }
    }
  }
  return matched.length > 0 ? matched : null;
}

// ─── Grouping ───────────────────────────────────────────────────────────────

const GROUP_TYPES = {
  COMPONENT: true,
  COMPONENT_SET: true,
  FRAME: true,
  SECTION: true,
  PAGE: true,
};

function isGroupNode(node, scopeId) {
  if (!GROUP_TYPES[node.type]) return false;
  // Pages always count as groups (for document-wide searches).
  if (node.type === "PAGE") return true;
  // Only top-level frames (direct children of page/scope) count as groups,
  // not every nested frame. Components/component_sets always count.
  if (node.type === "FRAME" || node.type === "SECTION") {
    const parent = node.parent;
    if (!parent) return false;
    return parent.id === scopeId || parent.type === "PAGE";
  }
  return true;
}

// ─── Main find function ─────────────────────────────────────────────────────

export async function find(params) {
  const scope = params.scope;
  const componentIds = params.componentId;
  const variableIds = params.variableId;
  const styleIds = params.styleId;
  const textPattern = params.text;
  const namePattern = params.name;
  const typeFilter = params.type;
  const annotationPattern = params.annotation;
  const hasAnnotationFilter = params.hasAnnotation;
  const excludeDefs = params.excludeDefinitions !== false; // default true
  const maxResults = params.maxResults || 200;
  const commandId = params.commandId || generateCommandId();

  // Resolve scope node
  let scopeNode;
  if (scope === "DOCUMENT") {
    scopeNode = figma.root;
  } else if (scope) {
    scopeNode = await figma.getNodeByIdAsync(scope);
    if (!scopeNode) {
      throw new Error("Scope node not found: " + scope);
    }
  } else {
    scopeNode = figma.currentPage;
  }
  const scopeId = scopeNode.id;

  // Validate: at least one criterion
  const hasCriteria =
    (componentIds && componentIds.length > 0) ||
    (variableIds && variableIds.length > 0) ||
    (styleIds && styleIds.length > 0) ||
    textPattern ||
    namePattern ||
    annotationPattern ||
    hasAnnotationFilter === true ||
    (typeFilter && typeFilter.length > 0);

  if (!hasCriteria) {
    throw new Error(
      "At least one search criterion is required (componentId, variableId, styleId, text, name, type, annotation, or hasAnnotation)",
    );
  }

  // Build lookup structures
  const compIdSet = componentIds ? buildIdSet(componentIds) : null;
  const varIdSet = variableIds ? buildIdSet(variableIds) : null;
  const styleIdSet = styleIds ? buildIdSet(styleIds) : null;
  const nameRegex = namePattern ? buildRegex(namePattern) : null;
  const textRegex = textPattern ? buildRegex(textPattern) : null;
  const annotationRegex = annotationPattern ? buildRegex(annotationPattern) : null;
  let typeSet = null;
  if (typeFilter && typeFilter.length > 0) {
    typeSet = {};
    for (let ti = 0; ti < typeFilter.length; ti++) {
      typeSet[typeFilter[ti]] = true;
    }
  }

  // Excluded definition IDs (component/component_set IDs we're searching for)
  const excludedDefIds = excludeDefs && compIdSet ? compIdSet : null;

  sendProgressUpdate(
    commandId,
    "find",
    "started",
    0,
    0,
    0,
    'Starting search in "' + (scopeNode.name || scopeId) + '"',
    null,
  );

  // Traversal state
  const matches = [];
  let nodesVisited = 0;
  let truncated = false;
  const groupMap = {}; // groupId -> { name, id, type, matches: [] }

  // Recursive traversal
  async function traverse(node, path, currentGroup, insideExcludedDef) {
    if (truncated) return;
    if (node.visible === false) return;

    nodesVisited++;

    // Progress updates every 500 nodes
    if (nodesVisited % 500 === 0) {
      sendProgressUpdate(
        commandId,
        "find",
        "in_progress",
        0,
        0,
        nodesVisited,
        "Searched " + nodesVisited + " nodes, " + matches.length + " matches so far",
        null,
      );
    }

    // Yield every 100 nodes
    if (nodesVisited % 100 === 0) {
      await delay(5);
    }

    // Update group tracking
    let group = currentGroup;
    if (node.id !== scopeId && isGroupNode(node, scopeId)) {
      group = { id: node.id, name: node.name || "Unnamed", type: node.type };
    }

    // Track if we're inside an excluded definition
    let inExcluded = insideExcludedDef;
    if (!inExcluded && excludedDefIds && (node.type === "COMPONENT" || node.type === "COMPONENT_SET")) {
      if (excludedDefIds[node.id]) {
        inExcluded = true;
      }
    }

    // Build path for this node (skip the scope root itself)
    const nodePath = node.id === scopeId ? path : path.concat([node.name || "Unnamed " + node.type]);

    // Evaluate predicates (AND logic — all active criteria must match)
    if (!inExcluded && node.id !== scopeId) {
      let allPass = true;
      const matchDetails = {};

      // type filter
      if (typeSet) {
        if (!typeSet[node.type]) {
          allPass = false;
        }
      }

      // name filter
      if (allPass && nameRegex) {
        const nodeName = node.name || "";
        if (!nameRegex.test(nodeName)) {
          allPass = false;
        }
      }

      // text filter
      if (allPass && textRegex) {
        if (node.type !== "TEXT" || typeof node.characters !== "string" || !textRegex.test(node.characters)) {
          allPass = false;
        }
      }

      // componentId filter
      if (allPass && compIdSet) {
        if (node.type !== "INSTANCE") {
          allPass = false;
        } else {
          const mc = await node.getMainComponentAsync();
          if (!mc) {
            allPass = false;
          } else {
            let compMatch = false;
            // Check direct component ID
            if (compIdSet[mc.id]) {
              matchDetails.componentId = mc.id;
              compMatch = true;
            }
            // Check parent component set ID
            if (!compMatch && mc.parent && mc.parent.type === "COMPONENT_SET" && compIdSet[mc.parent.id]) {
              matchDetails.componentId = mc.parent.id;
              compMatch = true;
            }
            if (!compMatch) {
              allPass = false;
            }
          }
        }
      }

      // variableId filter
      if (allPass && varIdSet) {
        const varMatches = checkVariableBindings(node, varIdSet);
        if (!varMatches) {
          allPass = false;
        } else {
          matchDetails.variableId = varMatches;
        }
      }

      // styleId filter
      if (allPass && styleIdSet) {
        const styleMatches = checkStyleBindings(node, styleIdSet);
        if (!styleMatches) {
          allPass = false;
        } else {
          matchDetails.styleId = styleMatches;
        }
      }

      // annotation filter (hasAnnotation or annotation regex)
      if (allPass && (annotationRegex || hasAnnotationFilter === true)) {
        if (!("annotations" in node) || !node.annotations || node.annotations.length === 0) {
          allPass = false;
        } else if (annotationRegex) {
          // Check if any annotation label matches the regex
          let anyMatch = false;
          const matchedLabels = [];
          for (let ai = 0; ai < node.annotations.length; ai++) {
            const label = node.annotations[ai].labelMarkdown || node.annotations[ai].label || "";
            if (annotationRegex.test(label)) {
              anyMatch = true;
              matchedLabels.push(label);
            }
          }
          if (!anyMatch) {
            allPass = false;
          } else {
            matchDetails.annotation = matchedLabels;
          }
        } else {
          // hasAnnotation: true — just include all labels
          const labels = [];
          for (let ai = 0; ai < node.annotations.length; ai++) {
            labels.push(node.annotations[ai].labelMarkdown || node.annotations[ai].label || "");
          }
          matchDetails.annotation = labels;
        }
      }

      // All predicates passed — record match
      if (allPass) {
        if (matches.length >= maxResults) {
          truncated = true;
          return;
        }

        // Build match object (only include criteria that were searched)
        const match = {};
        if (matchDetails.componentId) match.componentId = matchDetails.componentId;
        if (matchDetails.variableId) match.variableId = matchDetails.variableId;
        if (matchDetails.styleId) match.styleId = matchDetails.styleId;
        if (matchDetails.annotation) match.annotation = matchDetails.annotation;

        const item = {
          id: node.id,
          name: node.name || "Unnamed " + node.type,
          type: node.type,
          match: match,
          path: nodePath.slice(1), // exclude scope root name from path
        };

        matches.push(item);

        // Add to group
        const groupKey = group ? group.id : "(ungrouped)";
        if (!groupMap[groupKey]) {
          groupMap[groupKey] = {
            name: group ? group.name : "(ungrouped)",
            id: group ? group.id : null,
            type: group ? group.type : null,
            matches: [],
          };
        }
        groupMap[groupKey].matches.push(item);
      }
    }

    // Recurse into children
    if ("children" in node && !truncated) {
      // Load non-current pages for document-wide search (dynamic-page access)
      if (node.type === "PAGE" && node !== figma.currentPage) {
        await node.loadAsync();
      }
      for (let ci = 0; ci < node.children.length; ci++) {
        await traverse(node.children[ci], nodePath, group, inExcluded);
        if (truncated) return;
      }
    }
  }

  await traverse(scopeNode, [], null, false);

  // Build sorted group list
  const groupKeys = Object.keys(groupMap);
  const groups = [];
  for (let gi = 0; gi < groupKeys.length; gi++) {
    groups.push(groupMap[groupKeys[gi]]);
  }
  // Sort: named groups first (alphabetical), ungrouped last
  groups.sort((a, b) => {
    if (!a.id && b.id) return 1;
    if (a.id && !b.id) return -1;
    return (a.name || "").localeCompare(b.name || "");
  });

  sendProgressUpdate(
    commandId,
    "find",
    "completed",
    100,
    matches.length,
    nodesVisited,
    "Search complete. Found " +
      matches.length +
      " matches in " +
      groups.length +
      " groups (" +
      nodesVisited +
      " nodes searched).",
    null,
  );

  return {
    success: true,
    matchCount: matches.length,
    groupCount: groups.length,
    nodesSearched: nodesVisited,
    truncated: truncated,
    scope: scopeId,
    groups: groups,
  };
}
