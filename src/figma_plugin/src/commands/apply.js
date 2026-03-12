// Apply command: unified property application for existing nodes.
// Handles direct values, layout properties, variable bindings, text styles,
// and effect styles in a single call. Accepts a flat list or nested tree of node references.

import { toNumber, sendProgressUpdate } from "../helpers.js";
import { FIELD_MAP } from "./styles.js";

// Flatten a potentially nested node list into a flat array of operations
function flattenNodes(nodeList) {
  const flat = [];
  for (let i = 0; i < nodeList.length; i++) {
    flat.push(nodeList[i]);
    if (nodeList[i].children && Array.isArray(nodeList[i].children)) {
      const childFlat = flattenNodes(nodeList[i].children);
      for (let j = 0; j < childFlat.length; j++) {
        flat.push(childFlat[j]);
      }
    }
  }
  return flat;
}

function applyFillColor(node, colorSpec) {
  node.fills = [
    {
      type: "SOLID",
      color: { r: parseFloat(colorSpec.r) || 0, g: parseFloat(colorSpec.g) || 0, b: parseFloat(colorSpec.b) || 0 },
      opacity: colorSpec.a !== undefined ? parseFloat(colorSpec.a) : 1,
    },
  ];
}

function applyStrokeColor(node, colorSpec) {
  node.strokes = [
    {
      type: "SOLID",
      color: { r: parseFloat(colorSpec.r) || 0, g: parseFloat(colorSpec.g) || 0, b: parseFloat(colorSpec.b) || 0 },
      opacity: colorSpec.a !== undefined ? parseFloat(colorSpec.a) : 1,
    },
  ];
}

async function bindVariableToNode(node, field, variableId) {
  const variable = await figma.variables.getVariableByIdAsync(variableId);
  if (!variable) throw new Error("Variable not found: " + variableId);

  const figmaField = FIELD_MAP[field];
  if (!figmaField) {
    throw new Error("Unsupported variable field: " + field + ". Supported: " + Object.keys(FIELD_MAP).join(", "));
  }

  if (figmaField === "fills" || figmaField === "strokes") {
    if (!(figmaField in node)) {
      throw new Error("Node does not support " + figmaField + ": " + node.id);
    }
    let paints = JSON.parse(JSON.stringify(node[figmaField]));
    if (!paints || paints.length === 0) {
      paints = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }];
      node[figmaField] = paints;
    }
    const paintCopy = JSON.parse(JSON.stringify(node[figmaField]));
    paintCopy[0] = figma.variables.setBoundVariableForPaint(paintCopy[0], "color", variable);
    node[figmaField] = paintCopy;
  } else {
    node.setBoundVariable(figmaField, variable);
  }
}

async function applyTextStyle(node, styleId, styleCache) {
  if (node.type !== "TEXT") throw new Error("Not a TEXT node: " + node.id + " (type: " + node.type + ")");

  const style = styleCache[styleId];
  if (!style) throw new Error("Text style not found or not cached: " + styleId);

  // Load the node's current fonts before restyling
  if (node.fontName !== figma.mixed) {
    await figma.loadFontAsync(node.fontName);
  } else {
    const len = node.characters.length;
    const fontsToLoad = {};
    for (let i = 0; i < len; i++) {
      const f = node.getRangeFontName(i, i + 1);
      const key = f.family + ":" + f.style;
      if (!fontsToLoad[key]) fontsToLoad[key] = f;
    }
    const fontEntries = Object.keys(fontsToLoad);
    for (let j = 0; j < fontEntries.length; j++) {
      await figma.loadFontAsync(fontsToLoad[fontEntries[j]]);
    }
  }

  await node.setTextStyleIdAsync(styleId);
}

async function applyEffectStyle(node, styleId, styleCache) {
  if (!("effects" in node)) throw new Error("Node does not support effects: " + node.id + " (type: " + node.type + ")");

  const style = styleCache[styleId];
  if (!style) throw new Error("Effect style not found or not cached: " + styleId);

  await node.setEffectStyleIdAsync(styleId);
}

async function processNode(op, styleCache) {
  const node = await figma.getNodeByIdAsync(op.nodeId);
  if (!node) throw new Error("Node not found: " + op.nodeId);

  // Phase 0: Component operations (swap variant, set exposed instance)
  if (op.swapVariantId) {
    if (node.type !== "INSTANCE") throw new Error("swapVariantId requires an INSTANCE node: " + op.nodeId);
    const newVariant = await figma.getNodeByIdAsync(op.swapVariantId);
    if (!newVariant) throw new Error("Variant component not found: " + op.swapVariantId);
    if (newVariant.type !== "COMPONENT") throw new Error("Target is not a COMPONENT: " + op.swapVariantId);
    node.swapComponent(newVariant);
  }

  if (op.isExposedInstance !== undefined) {
    if (node.type !== "INSTANCE") throw new Error("isExposedInstance requires an INSTANCE node: " + op.nodeId);
    node.isExposedInstance = op.isExposedInstance;
  }

  // Phase 1: Layout mode (must come first — enables padding/alignment/sizing)
  if (op.layoutMode !== undefined && "layoutMode" in node) {
    node.layoutMode = op.layoutMode;
    if (op.layoutWrap !== undefined) node.layoutWrap = op.layoutWrap;
  }

  // Phase 2: Direct values
  if (op.fillColor && "fills" in node) applyFillColor(node, op.fillColor);
  if (op.fontColor && node.type === "TEXT") applyFillColor(node, op.fontColor);
  if (op.strokeColor && "strokes" in node) applyStrokeColor(node, op.strokeColor);
  if (op.strokeWeight !== undefined && "strokeWeight" in node) node.strokeWeight = toNumber(op.strokeWeight, 1);
  if (op.cornerRadius !== undefined && "cornerRadius" in node) node.cornerRadius = toNumber(op.cornerRadius, 0);
  if (op.opacity !== undefined && "opacity" in node) node.opacity = toNumber(op.opacity, 1);

  if (op.width !== undefined && op.height !== undefined && "resize" in node) {
    node.resize(toNumber(op.width, node.width), toNumber(op.height, node.height));
  } else if (op.width !== undefined && "resize" in node) {
    node.resize(toNumber(op.width, node.width), node.height);
  } else if (op.height !== undefined && "resize" in node) {
    node.resize(node.width, toNumber(op.height, node.height));
  }

  // Phase 2.5: Font properties (TEXT nodes only — load current font first, then apply new one)
  if (node.type === "TEXT" && (op.fontFamily || op.fontWeight || op.fontSize)) {
    // Load current font to allow property mutations
    if (node.fontName !== figma.mixed) {
      await figma.loadFontAsync(node.fontName);
    } else {
      const len = node.characters.length;
      const fontsToLoad = {};
      for (let i = 0; i < len; i++) {
        const f = node.getRangeFontName(i, i + 1);
        const key = f.family + ":" + f.style;
        if (!fontsToLoad[key]) fontsToLoad[key] = f;
      }
      const fontEntries = Object.keys(fontsToLoad);
      for (let j = 0; j < fontEntries.length; j++) {
        await figma.loadFontAsync(fontsToLoad[fontEntries[j]]);
      }
    }

    const weightMap = {
      100: "Thin",
      200: "Extra Light",
      300: "Light",
      400: "Regular",
      500: "Medium",
      600: "Semi Bold",
      700: "Bold",
      800: "Extra Bold",
      900: "Black",
    };

    const family = op.fontFamily || (node.fontName !== figma.mixed ? node.fontName.family : "Inter");
    const currentStyle = node.fontName !== figma.mixed ? node.fontName.style : "Regular";
    const styleName = op.fontWeight ? weightMap[toNumber(op.fontWeight, 400)] || "Regular" : currentStyle;

    try {
      await figma.loadFontAsync({ family: family, style: styleName });
      node.fontName = { family: family, style: styleName };
    } catch (_fontErr) {
      // If exact weight not available, try Regular for the family
      try {
        await figma.loadFontAsync({ family: family, style: "Regular" });
        node.fontName = { family: family, style: "Regular" };
      } catch (_fallbackErr) {
        // Keep current font if family not available at all
      }
    }

    if (op.fontSize !== undefined) {
      node.fontSize = toNumber(op.fontSize, 14);
    }
  }

  // Layout direct values (require layoutMode !== "NONE")
  if (op.paddingTop !== undefined && "paddingTop" in node) node.paddingTop = toNumber(op.paddingTop, 0);
  if (op.paddingRight !== undefined && "paddingRight" in node) node.paddingRight = toNumber(op.paddingRight, 0);
  if (op.paddingBottom !== undefined && "paddingBottom" in node) node.paddingBottom = toNumber(op.paddingBottom, 0);
  if (op.paddingLeft !== undefined && "paddingLeft" in node) node.paddingLeft = toNumber(op.paddingLeft, 0);
  if (op.primaryAxisAlignItems !== undefined && "primaryAxisAlignItems" in node) {
    node.primaryAxisAlignItems = op.primaryAxisAlignItems;
  }
  if (op.counterAxisAlignItems !== undefined && "counterAxisAlignItems" in node) {
    node.counterAxisAlignItems = op.counterAxisAlignItems;
  }
  if (op.itemSpacing !== undefined && "itemSpacing" in node) node.itemSpacing = toNumber(op.itemSpacing, 0);
  if (op.counterAxisSpacing !== undefined && "counterAxisSpacing" in node) {
    node.counterAxisSpacing = toNumber(op.counterAxisSpacing, 0);
  }
  if (op.layoutSizingHorizontal !== undefined && "layoutSizingHorizontal" in node) {
    node.layoutSizingHorizontal = op.layoutSizingHorizontal;
  }
  if (op.layoutSizingVertical !== undefined && "layoutSizingVertical" in node) {
    node.layoutSizingVertical = op.layoutSizingVertical;
  }

  // Phase 3: Variable bindings (override direct values with token refs)
  if (op.variables && typeof op.variables === "object") {
    const fields = Object.keys(op.variables);
    for (let i = 0; i < fields.length; i++) {
      await bindVariableToNode(node, fields[i], op.variables[fields[i]]);
    }
  }

  // Phase 4: Text style (loads fonts, must happen after other props)
  if (op.textStyleId) {
    await applyTextStyle(node, op.textStyleId, styleCache);
  }

  // Phase 5: Effect style (drop shadows, inner shadows, blurs)
  if (op.effectStyleId) {
    await applyEffectStyle(node, op.effectStyleId, styleCache);
  }

  return { success: true, nodeId: op.nodeId, nodeName: node.name };
}

export async function apply(params) {
  const nodes = params.nodes;
  const commandId = params.commandId;

  if (!nodes || !Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("Missing or empty nodes array");
  }

  // Flatten nested structure into operation list
  const allOps = flattenNodes(nodes);
  const totalOps = allOps.length;

  if (commandId) {
    sendProgressUpdate(commandId, "apply", "started", 0, totalOps, 0, "Starting property application");
  }

  // Pre-load all unique text and effect styles
  const uniqueStyleIds = {};
  for (let i = 0; i < allOps.length; i++) {
    if (allOps[i].textStyleId) uniqueStyleIds[allOps[i].textStyleId] = true;
    if (allOps[i].effectStyleId) uniqueStyleIds[allOps[i].effectStyleId] = true;
  }
  const styleCache = {};
  const styleKeys = Object.keys(uniqueStyleIds);
  for (let i = 0; i < styleKeys.length; i++) {
    try {
      const style = await figma.getStyleByIdAsync(styleKeys[i]);
      if (style && style.type === "TEXT") {
        if (style.fontName) await figma.loadFontAsync(style.fontName);
        styleCache[styleKeys[i]] = style;
      } else if (style && style.type === "EFFECT") {
        styleCache[styleKeys[i]] = style;
      }
    } catch (_e) {
      // Style load failure will be caught per-node later
    }
  }

  // Process nodes in chunks
  const CHUNK_SIZE = 5;
  const totalChunks = Math.ceil(totalOps / CHUNK_SIZE);
  const results = [];
  let successCount = 0;
  let failureCount = 0;

  for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
    const start = chunkIdx * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalOps);
    const chunk = allOps.slice(start, end);

    const chunkPromises = chunk.map((op) =>
      processNode(op, styleCache).catch((e) => ({ success: false, nodeId: op.nodeId, error: e.message || String(e) })),
    );

    const chunkResults = await Promise.all(chunkPromises);
    for (let ri = 0; ri < chunkResults.length; ri++) {
      results.push(chunkResults[ri]);
      if (chunkResults[ri].success) successCount++;
      else failureCount++;
    }

    if (commandId) {
      const processed = Math.min(end, totalOps);
      const pct = Math.round((processed / totalOps) * 100);
      sendProgressUpdate(
        commandId,
        "apply",
        "in_progress",
        pct,
        totalOps,
        processed,
        "Applied " + processed + " of " + totalOps + " nodes",
      );
    }
  }

  if (commandId) {
    sendProgressUpdate(commandId, "apply", "completed", 100, totalOps, totalOps, "Property application completed");
  }

  return {
    success: failureCount === 0,
    totalNodes: totalOps,
    successCount: successCount,
    failureCount: failureCount,
    results: results,
  };
}
