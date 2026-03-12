// Document, selection, node info, and export commands

import { filterFigmaNode, sendProgressUpdate, generateCommandId, customBase64Encode, rgbaToHex } from "../helpers.js";

export async function getDocumentInfo() {
  await figma.currentPage.loadAsync();
  const page = figma.currentPage;
  return {
    name: page.name,
    id: page.id,
    type: page.type,
    children: page.children.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
    })),
    currentPage: {
      id: page.id,
      name: page.name,
      childCount: page.children.length,
    },
    pages: [
      {
        id: page.id,
        name: page.name,
        childCount: page.children.length,
      },
    ],
  };
}

export async function getSelection() {
  return {
    selectionCount: figma.currentPage.selection.length,
    selection: figma.currentPage.selection.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      visible: node.visible,
    })),
  };
}

export async function getNodeInfo(nodeId) {
  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  const response = await node.exportAsync({
    format: "JSON_REST_V1",
  });

  return filterFigmaNode(response.document);
}

export async function getNodesInfo(nodeIds) {
  try {
    const nodes = await Promise.all(nodeIds.map((id) => figma.getNodeByIdAsync(id)));
    const validNodes = nodes.filter((node) => node !== null);

    const responses = await Promise.all(
      validNodes.map(async (node) => {
        const response = await node.exportAsync({
          format: "JSON_REST_V1",
        });
        return {
          nodeId: node.id,
          document: filterFigmaNode(response.document),
        };
      }),
    );

    return responses;
  } catch (error) {
    throw new Error(`Error getting nodes info: ${error.message}`);
  }
}

export async function readMyDesign() {
  try {
    const nodes = await Promise.all(figma.currentPage.selection.map((node) => figma.getNodeByIdAsync(node.id)));
    const validNodes = nodes.filter((node) => node !== null);

    const responses = await Promise.all(
      validNodes.map(async (node) => {
        const response = await node.exportAsync({
          format: "JSON_REST_V1",
        });
        return {
          nodeId: node.id,
          document: filterFigmaNode(response.document),
        };
      }),
    );

    return responses;
  } catch (error) {
    throw new Error(`Error getting nodes info: ${error.message}`);
  }
}

export async function getReactions(nodeIds) {
  try {
    const commandId = generateCommandId();
    sendProgressUpdate(
      commandId,
      "get_reactions",
      "started",
      0,
      nodeIds.length,
      0,
      `Starting deep search for reactions in ${nodeIds.length} nodes and their children`,
    );

    async function findNodesWithReactions(node, processedNodes = new Set(), depth = 0, results = []) {
      if (processedNodes.has(node.id)) {
        return results;
      }

      processedNodes.add(node.id);

      let filteredReactions = [];
      if (node.reactions && node.reactions.length > 0) {
        filteredReactions = node.reactions.filter((r) => {
          if (r.action && r.action.navigation === "CHANGE_TO") return false;
          if (Array.isArray(r.actions)) {
            return !r.actions.some((a) => a.navigation === "CHANGE_TO");
          }
          return true;
        });
      }
      const hasFilteredReactions = filteredReactions.length > 0;

      if (hasFilteredReactions) {
        results.push({
          id: node.id,
          name: node.name,
          type: node.type,
          depth: depth,
          hasReactions: true,
          reactions: filteredReactions,
          path: getNodePath(node),
        });
        await highlightNodeWithAnimation(node);
      }

      if (node.children) {
        for (const child of node.children) {
          await findNodesWithReactions(child, processedNodes, depth + 1, results);
        }
      }

      return results;
    }

    async function highlightNodeWithAnimation(node) {
      const originalStrokeWeight = node.strokeWeight;
      const originalStrokes = node.strokes ? [...node.strokes] : [];

      try {
        node.strokeWeight = 4;
        node.strokes = [
          {
            type: "SOLID",
            color: { r: 1, g: 0.5, b: 0 },
            opacity: 0.8,
          },
        ];

        setTimeout(() => {
          try {
            node.strokeWeight = originalStrokeWeight;
            node.strokes = originalStrokes;
          } catch (restoreError) {
            console.error(`Error restoring node stroke: ${restoreError.message}`);
          }
        }, 1500);
      } catch (highlightError) {
        console.error(`Error highlighting node: ${highlightError.message}`);
      }
    }

    function getNodePath(node) {
      const path = [];
      let current = node;

      while (current && current.parent) {
        path.unshift(current.name);
        current = current.parent;
      }

      return path.join(" > ");
    }

    let allResults = [];
    let processedCount = 0;
    const totalCount = nodeIds.length;

    for (let i = 0; i < nodeIds.length; i++) {
      try {
        const nodeId = nodeIds[i];
        const node = await figma.getNodeByIdAsync(nodeId);

        if (!node) {
          processedCount++;
          sendProgressUpdate(
            commandId,
            "get_reactions",
            "in_progress",
            processedCount / totalCount,
            totalCount,
            processedCount,
            `Node not found: ${nodeId}`,
          );
          continue;
        }

        const processedNodes = new Set();
        const nodeResults = await findNodesWithReactions(node, processedNodes);

        allResults = allResults.concat(nodeResults);

        processedCount++;
        sendProgressUpdate(
          commandId,
          "get_reactions",
          "in_progress",
          processedCount / totalCount,
          totalCount,
          processedCount,
          `Processed node ${processedCount}/${totalCount}, found ${nodeResults.length} nodes with reactions`,
        );
      } catch (error) {
        processedCount++;
        sendProgressUpdate(
          commandId,
          "get_reactions",
          "in_progress",
          processedCount / totalCount,
          totalCount,
          processedCount,
          `Error processing node: ${error.message}`,
        );
      }
    }

    sendProgressUpdate(
      commandId,
      "get_reactions",
      "completed",
      1,
      totalCount,
      totalCount,
      `Completed deep search: found ${allResults.length} nodes with reactions.`,
    );

    return {
      nodesCount: nodeIds.length,
      nodesWithReactions: allResults.length,
      nodes: allResults,
    };
  } catch (error) {
    throw new Error(`Failed to get reactions: ${error.message}`);
  }
}

// ─── get_node_tree helpers ────────────────────────────────────────────────────

async function buildNodeOutput(n, detail, inclVars, inclStyles, inclComp, collVarIds, collStyleIds, collCompIds) {
  if (detail === "structure") {
    return { id: n.id, name: n.name, type: n.type };
  }

  const out = { id: n.id, name: n.name, type: n.type };

  // dimensions
  if (n.absoluteBoundingBox) {
    out.x = n.absoluteBoundingBox.x;
    out.y = n.absoluteBoundingBox.y;
    out.width = n.absoluteBoundingBox.width;
    out.height = n.absoluteBoundingBox.height;
  }

  // auto-layout (omit defaults)
  if (n.layoutMode && n.layoutMode !== "NONE") {
    out.layoutMode = n.layoutMode;
    if (n.primaryAxisSizingMode) out.primaryAxisSizingMode = n.primaryAxisSizingMode;
    if (n.counterAxisSizingMode) out.counterAxisSizingMode = n.counterAxisSizingMode;
    if (n.primaryAxisAlignItems && n.primaryAxisAlignItems !== "MIN")
      out.primaryAxisAlignItems = n.primaryAxisAlignItems;
    if (n.counterAxisAlignItems && n.counterAxisAlignItems !== "MIN")
      out.counterAxisAlignItems = n.counterAxisAlignItems;
    if (n.itemSpacing && n.itemSpacing > 0) out.itemSpacing = n.itemSpacing;
    if (n.paddingLeft && n.paddingLeft > 0) out.paddingLeft = n.paddingLeft;
    if (n.paddingRight && n.paddingRight > 0) out.paddingRight = n.paddingRight;
    if (n.paddingTop && n.paddingTop > 0) out.paddingTop = n.paddingTop;
    if (n.paddingBottom && n.paddingBottom > 0) out.paddingBottom = n.paddingBottom;
    if (n.layoutWrap === "WRAP") out.layoutWrap = "WRAP";
  }

  if (n.clipsContent) out.clipsContent = true;

  // text content
  if (n.type === "TEXT" && n.characters) {
    out.text = n.characters;
  }

  // instance: componentRef + componentProperties
  if (n.type === "INSTANCE" && inclComp) {
    const mc = await n.getMainComponentAsync();
    if (mc) {
      out.componentRef = "COMP::" + mc.id;
      collCompIds[mc.id] = true;
    } else {
      out.componentRef = "(unresolved)";
    }
    if (n.componentProperties) {
      out.componentProperties = n.componentProperties;
    }
  }

  // component property definitions (COMPONENT and COMPONENT_SET nodes)
  if ((n.type === "COMPONENT" || n.type === "COMPONENT_SET") && n.componentPropertyDefinitions) {
    out.componentPropertyDefinitions = n.componentPropertyDefinitions;
  }

  // variant properties (COMPONENT nodes)
  if (n.variantProperties) {
    out.variantProperties = n.variantProperties;
  }

  // full level: fills, strokes, variable bindings, text style
  if (detail === "full") {
    if (n.fills && n.fills.length > 0) {
      out.fills = n.fills.map((fill) => {
        const f = { type: fill.type };
        if (fill.color) f.color = rgbaToHex(fill.color);
        if (fill.opacity !== undefined && fill.opacity !== 1) f.opacity = fill.opacity;
        if (fill.visible !== undefined && !fill.visible) f.visible = false;
        return f;
      });
    }

    if (n.strokes && n.strokes.length > 0) {
      out.strokes = n.strokes.map((stroke) => {
        const s = { type: stroke.type };
        if (stroke.color) s.color = rgbaToHex(stroke.color);
        if (n.strokeWeight) s.weight = n.strokeWeight;
        if (n.strokeAlign) s.align = n.strokeAlign;
        return s;
      });
    }

    if (n.cornerRadius !== undefined && n.cornerRadius !== null) {
      out.cornerRadius = n.cornerRadius;
    }

    if (n.opacity !== undefined && n.opacity !== 1) {
      out.opacity = n.opacity;
    }

    // variable bindings
    if (inclVars && n.boundVariables) {
      const bindings = {};
      const bvKeys = Object.keys(n.boundVariables);
      for (const field of bvKeys) {
        const binding = n.boundVariables[field];
        if (Array.isArray(binding)) {
          const refs = [];
          for (const slot of binding) {
            if (slot && slot.id) {
              refs.push("VAR::" + slot.id);
              collVarIds[slot.id] = true;
            }
          }
          if (refs.length > 0) bindings[field] = refs;
        } else if (binding && binding.id) {
          bindings[field] = "VAR::" + binding.id;
          collVarIds[binding.id] = true;
        }
      }
      if (Object.keys(bindings).length > 0) {
        out.variableBindings = bindings;
      }
    }

    // text style
    if (inclStyles && n.textStyleId && typeof n.textStyleId === "string") {
      out.textStyle = "STYLE::" + n.textStyleId;
      collStyleIds[n.textStyleId] = true;
    }
  }

  return out;
}

export async function getNodeTree(params) {
  const nodeId = params && params.nodeId ? params.nodeId : null;
  const detail = params && params.detail ? params.detail : "layout";
  const userDepth = params && params.depth !== undefined && params.depth !== null ? params.depth : undefined;
  const filter = params && params.filter ? params.filter : {};
  const visibleOnly = filter.visibleOnly !== false;
  const typeWhitelist = filter.types && filter.types.length > 0 ? filter.types : null;
  const namePattern = filter.namePattern && filter.namePattern.length > 0 ? filter.namePattern : null;
  const inclVars = params && params.includeVariables !== false;
  const inclStyles = params && params.includeStyles !== false;
  const inclComp = params && params.includeComponentMeta !== false;

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  let nameRegex = null;
  if (namePattern) {
    try {
      nameRegex = new RegExp(namePattern);
    } catch (_e) {
      throw new Error("Invalid namePattern regex: " + namePattern);
    }
  }

  const root = await figma.getNodeByIdAsync(nodeId);
  if (!root) {
    throw new Error("Node not found: " + nodeId);
  }

  // Collectors (keyed by full ID, deduplicated)
  const collVarIds = {};
  const collStyleIds = {};
  const collCompIds = {};
  let nodeCount = 0;

  // walkNode returns an array of output nodes.
  // When a node is filtered out (type/name mismatch), its matching children are promoted up.
  async function walkNode(n, currentDepthFromRoot) {
    nodeCount++;

    const isVisible = n.visible !== false;
    if (visibleOnly && !isVisible) return [];

    const typeOk = !typeWhitelist || typeWhitelist.indexOf(n.type) !== -1;
    const nameOk = !nameRegex || nameRegex.test(n.name);

    const isInstance = n.type === "INSTANCE";
    const hasChildren = n.children && n.children.length > 0;
    const atDepthLimit = userDepth !== undefined && currentDepthFromRoot >= userDepth;
    // Stop at instance boundary when no explicit depth, except at root
    const stopAtInstance = isInstance && userDepth === undefined && currentDepthFromRoot > 0;
    const shouldExpand = hasChildren && !atDepthLimit && !stopAtInstance;

    // Collect child results (always descend even if this node is filtered)
    const childResults = [];
    if (shouldExpand) {
      for (const child of n.children) {
        const sub = await walkNode(child, currentDepthFromRoot + 1);
        for (const item of sub) {
          childResults.push(item);
        }
      }
    }

    // If this node is filtered, promote children
    if (!typeOk || !nameOk) {
      return childResults;
    }

    const out = await buildNodeOutput(n, detail, inclVars, inclStyles, inclComp, collVarIds, collStyleIds, collCompIds);

    if (childResults.length > 0) {
      out.children = childResults;
    }

    if (hasChildren && (atDepthLimit || stopAtInstance)) {
      out.childCount = n.children.length;
    }

    return [out];
  }

  const treeNodes = await walkNode(root, 0);

  // Phase 2: batch async resolution of collected IDs
  const resolvedVars = {};
  const resolvedStyles = {};
  const resolvedComponents = {};

  if (inclVars && figma.variables) {
    const varIdList = Object.keys(collVarIds);
    const varResults = await Promise.all(
      varIdList.map(async (vid) => {
        try {
          const v = await figma.variables.getVariableByIdAsync(vid);
          if (!v) return null;
          let coll = null;
          if (v.variableCollectionId) {
            coll = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
          }
          return {
            id: vid,
            name: v.name,
            resolvedType: v.resolvedType,
            collection: coll ? coll.name : null,
          };
        } catch (_e) {
          return null;
        }
      }),
    );
    for (const entry of varResults) {
      if (entry) resolvedVars[entry.id] = entry;
    }
  }

  if (inclStyles) {
    const styleIdList = Object.keys(collStyleIds);
    const styleResults = await Promise.all(
      styleIdList.map(async (sid) => {
        try {
          const s = await figma.getStyleByIdAsync(sid);
          if (!s) return null;
          return { id: sid, name: s.name, type: s.type };
        } catch (_e) {
          return null;
        }
      }),
    );
    for (const entry of styleResults) {
      if (entry) resolvedStyles[entry.id] = entry;
    }
  }

  if (inclComp) {
    const compIdList = Object.keys(collCompIds);
    const compResults = await Promise.all(
      compIdList.map(async (cid) => {
        try {
          const comp = await figma.getNodeByIdAsync(cid);
          if (!comp) return null;
          return {
            id: cid,
            name: comp.name,
            key: comp.key || null,
            description: comp.description || null,
            parentType: comp.parent ? comp.parent.type : null,
            parentName: comp.parent ? comp.parent.name : null,
          };
        } catch (_e) {
          return null;
        }
      }),
    );
    for (const entry of compResults) {
      if (entry) resolvedComponents[entry.id] = entry;
    }
  }

  // COMPONENT_SET: build variantAxes from children
  let variantAxes = null;
  let defaultVariant = null;
  if (root.type === "COMPONENT_SET" && root.children) {
    const axesMap = {};
    for (const child of root.children) {
      if (child.type !== "COMPONENT") continue;
      const pairs = child.name.split(",");
      for (const pairRaw of pairs) {
        const pair = pairRaw.trim();
        const eqIdx = pair.indexOf("=");
        if (eqIdx === -1) continue;
        const propName = pair.substring(0, eqIdx).trim();
        const propVal = pair.substring(eqIdx + 1).trim();
        if (!axesMap[propName]) axesMap[propName] = [];
        if (axesMap[propName].indexOf(propVal) === -1) axesMap[propName].push(propVal);
      }
    }
    variantAxes = axesMap;
    defaultVariant = root.defaultVariant && root.defaultVariant.name ? root.defaultVariant.name : null;
  }

  return {
    rootId: root.id,
    rootName: root.name,
    rootType: root.type,
    nodeCount: nodeCount,
    rawTree: treeNodes,
    collectedVars: resolvedVars,
    collectedStyles: resolvedStyles,
    collectedComponents: resolvedComponents,
    variantAxes: variantAxes,
    defaultVariant: defaultVariant,
  };
}

export async function exportNodeAsImage(params) {
  const { nodeId, scale = 1 } = params || {};
  const format = "PNG";

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("exportAsync" in node)) {
    throw new Error(`Node does not support exporting: ${nodeId}`);
  }

  try {
    const settings = {
      format: format,
      constraint: { type: "SCALE", value: scale },
    };

    const bytes = await node.exportAsync(settings);

    let mimeType;
    switch (format) {
      case "PNG":
        mimeType = "image/png";
        break;
      case "JPG":
        mimeType = "image/jpeg";
        break;
      case "SVG":
        mimeType = "image/svg+xml";
        break;
      case "PDF":
        mimeType = "application/pdf";
        break;
      default:
        mimeType = "application/octet-stream";
    }

    const base64 = customBase64Encode(bytes);

    return {
      nodeId,
      format,
      scale,
      mimeType,
      imageData: base64,
    };
  } catch (error) {
    throw new Error(`Error exporting node as image: ${error.message}`);
  }
}
