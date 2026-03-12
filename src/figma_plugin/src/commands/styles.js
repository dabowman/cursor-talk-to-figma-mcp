// Styles commands: getStyles, getLocalVariables, getLocalComponents,
// bindVariable, batchBindVariables, setTextStyle, batchSetTextStyles

import { sendProgressUpdate } from "../helpers.js";

export async function getStyles() {
  const styles = {
    colors: await figma.getLocalPaintStylesAsync(),
    texts: await figma.getLocalTextStylesAsync(),
    effects: await figma.getLocalEffectStylesAsync(),
    grids: await figma.getLocalGridStylesAsync(),
  };

  return {
    colors: styles.colors.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
      paint: style.paints[0],
    })),
    texts: styles.texts.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
      fontSize: style.fontSize,
      fontName: style.fontName,
    })),
    effects: styles.effects.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
    })),
    grids: styles.grids.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
    })),
  };
}

export async function getLocalVariables() {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const result = [];

  for (let i = 0; i < collections.length; i++) {
    const collection = collections[i];
    const variables = [];

    for (let j = 0; j < collection.variableIds.length; j++) {
      const variable = await figma.variables.getVariableByIdAsync(collection.variableIds[j]);
      if (!variable) continue;

      const values = {};
      for (let m = 0; m < collection.modes.length; m++) {
        const mode = collection.modes[m];
        const value = variable.valuesByMode[mode.modeId];
        if (value && typeof value === "object" && "type" in value && value.type === "VARIABLE_ALIAS") {
          values[mode.name] = { alias: value.id };
        } else {
          values[mode.name] = value;
        }
      }

      variables.push({
        id: variable.id,
        name: variable.name,
        resolvedType: variable.resolvedType,
        values: values,
      });
    }

    result.push({
      id: collection.id,
      name: collection.name,
      modes: collection.modes.map((mode) => ({ id: mode.modeId, name: mode.name })),
      variableCount: variables.length,
      variables: variables,
    });
  }

  return result;
}

export async function getLocalComponents() {
  await figma.loadAllPagesAsync();

  const componentSets = figma.root.findAllWithCriteria({
    types: ["COMPONENT_SET"],
  });

  const standaloneComponents = figma.root
    .findAllWithCriteria({
      types: ["COMPONENT"],
    })
    .filter((c) => !c.parent || c.parent.type !== "COMPONENT_SET");

  const results = [];

  for (let i = 0; i < componentSets.length; i++) {
    const set = componentSets[i];
    const axesMap = {};
    const variants = [];
    for (let j = 0; j < set.children.length; j++) {
      const child = set.children[j];
      if (child.type !== "COMPONENT") continue;
      variants.push({
        id: child.id,
        name: child.name,
        key: "key" in child ? child.key : null,
      });
      const pairs = child.name.split(",");
      for (let k = 0; k < pairs.length; k++) {
        const pair = pairs[k].trim();
        const eqIdx = pair.indexOf("=");
        if (eqIdx === -1) continue;
        const propName = pair.substring(0, eqIdx).trim();
        const propVal = pair.substring(eqIdx + 1).trim();
        if (!axesMap[propName]) axesMap[propName] = [];
        if (axesMap[propName].indexOf(propVal) === -1) axesMap[propName].push(propVal);
      }
    }
    results.push({
      id: set.id,
      name: set.name,
      key: "key" in set ? set.key : null,
      type: "COMPONENT_SET",
      variantCount: variants.length,
      variantAxes: axesMap,
      defaultVariant: set.defaultVariant && set.defaultVariant.name ? set.defaultVariant.name : null,
      variants: variants,
    });
  }

  for (let i = 0; i < standaloneComponents.length; i++) {
    const comp = standaloneComponents[i];
    results.push({
      id: comp.id,
      name: comp.name,
      key: "key" in comp ? comp.key : null,
      type: "COMPONENT",
    });
  }

  return {
    count: results.length,
    components: results,
  };
}

export var FIELD_MAP = {
  fills: "fills",
  fill: "fills",
  strokes: "strokes",
  stroke: "strokes",
  opacity: "opacity",
  cornerRadius: "topLeftRadius",
  topLeftRadius: "topLeftRadius",
  topRightRadius: "topRightRadius",
  bottomLeftRadius: "bottomLeftRadius",
  bottomRightRadius: "bottomRightRadius",
  paddingTop: "paddingTop",
  paddingRight: "paddingRight",
  paddingBottom: "paddingBottom",
  paddingLeft: "paddingLeft",
  itemSpacing: "itemSpacing",
  counterAxisSpacing: "counterAxisSpacing",
  width: "width",
  height: "height",
  minWidth: "minWidth",
  maxWidth: "maxWidth",
  minHeight: "minHeight",
  maxHeight: "maxHeight",
  visible: "visible",
  characters: "characters",
};

export async function bindVariable(params) {
  var _a = params || {},
    nodeId = _a.nodeId,
    field = _a.field,
    variableId = _a.variableId;

  if (!nodeId) throw new Error("Missing nodeId parameter");
  if (!field) throw new Error("Missing field parameter");
  if (!variableId) throw new Error("Missing variableId parameter");

  var node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);

  var variable = await figma.variables.getVariableByIdAsync(variableId);
  if (!variable) throw new Error("Variable not found: " + variableId);

  var figmaField = FIELD_MAP[field];
  if (!figmaField) {
    throw new Error("Unsupported field: " + field + ". Supported fields: " + Object.keys(FIELD_MAP).join(", "));
  }

  if (figmaField === "fills" || figmaField === "strokes") {
    if (!(figmaField in node)) {
      throw new Error("Node does not support " + figmaField + ": " + nodeId);
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

  return {
    success: true,
    nodeId: node.id,
    nodeName: node.name,
    field: field,
    figmaField: figmaField,
    variableId: variable.id,
    variableName: variable.name,
  };
}

export async function batchBindVariables(params) {
  var bindings = (params || {}).bindings;
  var commandId = (params || {}).commandId;

  if (!bindings || !Array.isArray(bindings) || bindings.length === 0) {
    throw new Error("Missing or empty bindings array");
  }

  var totalOps = bindings.length;
  var successCount = 0;
  var failureCount = 0;
  var results = [];

  if (commandId) {
    sendProgressUpdate(commandId, "batch_bind_variables", "started", 0, totalOps, 0, "Starting variable bindings");
  }

  var CHUNK_SIZE = 10;
  var totalChunks = Math.ceil(totalOps / CHUNK_SIZE);
  var chunkIdx, start, end, chunk, chunkPromises, chunkResults, ri, processed, pct;

  for (chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
    start = chunkIdx * CHUNK_SIZE;
    end = Math.min(start + CHUNK_SIZE, totalOps);
    chunk = bindings.slice(start, end);

    chunkPromises = chunk.map((binding) =>
      (async (b) => {
        try {
          const node = await figma.getNodeByIdAsync(b.nodeId);
          if (!node) throw new Error("Node not found: " + b.nodeId);

          const variable = await figma.variables.getVariableByIdAsync(b.variableId);
          if (!variable) throw new Error("Variable not found: " + b.variableId);

          const figmaField = FIELD_MAP[b.field];
          if (!figmaField) throw new Error("Unsupported field: " + b.field);

          if (figmaField === "fills" || figmaField === "strokes") {
            if (!(figmaField in node)) {
              throw new Error("Node does not support " + figmaField + ": " + b.nodeId);
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

          return { success: true, nodeId: b.nodeId, field: b.field, variableId: b.variableId };
        } catch (e) {
          return { success: false, nodeId: b.nodeId, field: b.field, error: e.message || String(e) };
        }
      })(binding),
    );

    chunkResults = await Promise.all(chunkPromises);
    for (ri = 0; ri < chunkResults.length; ri++) {
      results.push(chunkResults[ri]);
      if (chunkResults[ri].success) successCount++;
      else failureCount++;
    }

    if (commandId) {
      processed = Math.min(end, totalOps);
      pct = Math.round((processed / totalOps) * 100);
      sendProgressUpdate(
        commandId,
        "batch_bind_variables",
        "in_progress",
        pct,
        totalOps,
        processed,
        "Processed " + processed + " of " + totalOps,
        { currentChunk: chunkIdx + 1, totalChunks: totalChunks, chunkSize: CHUNK_SIZE },
      );
    }
  }

  if (commandId) {
    sendProgressUpdate(
      commandId,
      "batch_bind_variables",
      "completed",
      100,
      totalOps,
      totalOps,
      "All bindings completed",
    );
  }

  return {
    success: failureCount === 0,
    totalBindings: totalOps,
    successCount: successCount,
    failureCount: failureCount,
    results: results,
  };
}

export async function setTextStyle(params) {
  var _a = params || {},
    nodeId = _a.nodeId,
    styleId = _a.styleId;

  if (!nodeId) throw new Error("Missing nodeId parameter");
  if (!styleId) throw new Error("Missing styleId parameter");

  var node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);

  if (node.type !== "TEXT") {
    throw new Error("Node is not a TEXT node (type: " + node.type + ")");
  }

  var style = await figma.getStyleByIdAsync(styleId);
  if (!style) throw new Error("Style not found: " + styleId);
  if (style.type !== "TEXT") throw new Error("Style is not a text style (type: " + style.type + ")");

  var fontName = style.fontName;
  if (fontName) {
    await figma.loadFontAsync(fontName);
  }

  if (node.fontName !== figma.mixed) {
    await figma.loadFontAsync(node.fontName);
  } else {
    const len = node.characters.length;
    const fontsToLoad = {};
    for (let i = 0; i < len; i++) {
      const f = node.getRangeFontName(i, i + 1);
      const key = f.family + ":" + f.style;
      if (!fontsToLoad[key]) {
        fontsToLoad[key] = f;
      }
    }
    const fontEntries = Object.keys(fontsToLoad);
    for (let j = 0; j < fontEntries.length; j++) {
      await figma.loadFontAsync(fontsToLoad[fontEntries[j]]);
    }
  }

  await node.setTextStyleIdAsync(styleId);

  return {
    success: true,
    nodeId: node.id,
    nodeName: node.name,
    styleId: styleId,
    styleName: style.name,
  };
}

export async function batchSetTextStyles(params) {
  var assignments = (params || {}).assignments;
  var commandId = (params || {}).commandId;

  if (!assignments || !Array.isArray(assignments) || assignments.length === 0) {
    throw new Error("Missing or empty assignments array");
  }

  var totalOps = assignments.length;
  var successCount = 0;
  var failureCount = 0;
  var results = [];
  var si, sk, style;

  if (commandId) {
    sendProgressUpdate(
      commandId,
      "batch_set_text_styles",
      "started",
      0,
      totalOps,
      0,
      "Starting text style assignments",
    );
  }

  // Phase 1: Pre-load all unique styles and their fonts
  var uniqueStyleIds = {};
  for (si = 0; si < assignments.length; si++) {
    uniqueStyleIds[assignments[si].styleId] = true;
  }
  var styleCache = {};
  var styleKeys = Object.keys(uniqueStyleIds);
  for (sk = 0; sk < styleKeys.length; sk++) {
    try {
      style = await figma.getStyleByIdAsync(styleKeys[sk]);
      if (style && style.type === "TEXT") {
        if (style.fontName) {
          await figma.loadFontAsync(style.fontName);
        }
        styleCache[styleKeys[sk]] = style;
      }
    } catch (_e) {
      // Style load failure will be caught per-item later
    }
  }

  // Phase 2: Process in chunks
  var CHUNK_SIZE = 5;
  var totalChunks = Math.ceil(totalOps / CHUNK_SIZE);
  var chunkIdx, start, end, chunk, chunkPromises, chunkResults, ri, processed, pct;

  for (chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
    start = chunkIdx * CHUNK_SIZE;
    end = Math.min(start + CHUNK_SIZE, totalOps);
    chunk = assignments.slice(start, end);

    chunkPromises = chunk.map((assignment) =>
      (async (a) => {
        try {
          const node = await figma.getNodeByIdAsync(a.nodeId);
          if (!node) throw new Error("Node not found: " + a.nodeId);
          if (node.type !== "TEXT") throw new Error("Not a TEXT node: " + a.nodeId + " (type: " + node.type + ")");

          const cachedStyle = styleCache[a.styleId];
          if (!cachedStyle) throw new Error("Style not found or not a text style: " + a.styleId);

          if (node.fontName !== figma.mixed) {
            await figma.loadFontAsync(node.fontName);
          } else {
            const len = node.characters.length;
            const fontsToLoad = {};
            for (let i = 0; i < len; i++) {
              const f = node.getRangeFontName(i, i + 1);
              const key = f.family + ":" + f.style;
              if (!fontsToLoad[key]) {
                fontsToLoad[key] = f;
              }
            }
            const fontEntries = Object.keys(fontsToLoad);
            for (let j = 0; j < fontEntries.length; j++) {
              await figma.loadFontAsync(fontsToLoad[fontEntries[j]]);
            }
          }

          await node.setTextStyleIdAsync(a.styleId);
          return { success: true, nodeId: a.nodeId, styleId: a.styleId, styleName: cachedStyle.name };
        } catch (e) {
          return { success: false, nodeId: a.nodeId, styleId: a.styleId, error: e.message || String(e) };
        }
      })(assignment),
    );

    chunkResults = await Promise.all(chunkPromises);
    for (ri = 0; ri < chunkResults.length; ri++) {
      results.push(chunkResults[ri]);
      if (chunkResults[ri].success) successCount++;
      else failureCount++;
    }

    if (commandId) {
      processed = Math.min(end, totalOps);
      pct = Math.round((processed / totalOps) * 100);
      sendProgressUpdate(
        commandId,
        "batch_set_text_styles",
        "in_progress",
        pct,
        totalOps,
        processed,
        "Processed " + processed + " of " + totalOps,
        { currentChunk: chunkIdx + 1, totalChunks: totalChunks, chunkSize: CHUNK_SIZE },
      );
    }
  }

  if (commandId) {
    sendProgressUpdate(
      commandId,
      "batch_set_text_styles",
      "completed",
      100,
      totalOps,
      totalOps,
      "All style assignments completed",
    );
  }

  return {
    success: failureCount === 0,
    totalAssignments: totalOps,
    successCount: successCount,
    failureCount: failureCount,
    results: results,
  };
}
