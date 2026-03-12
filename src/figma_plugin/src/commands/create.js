// Create command: builds one or more nodes from a recursive spec

import { toNumber, sendProgressUpdate } from "../helpers.js";

export async function create(params) {
  const parentId = params.parentId;
  const tree = params.tree;
  const commandId = params.commandId;

  if (!tree) throw new Error("Missing tree parameter");

  function countNodes(spec) {
    let count = 1;
    if (spec.children && Array.isArray(spec.children)) {
      for (let i = 0; i < spec.children.length; i++) {
        count += countNodes(spec.children[i]);
      }
    }
    return count;
  }

  const totalNodes = countNodes(tree);
  let createdCount = 0;

  if (commandId) {
    sendProgressUpdate(commandId, "create", "started", 0, totalNodes, 0, "Starting creation");
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

  async function buildNode(spec, parentNode) {
    const nodeType = spec.type || "FRAME";
    const fontFamily = spec.fontFamily || "Inter";
    const fontStyle = spec.fontStyle || "Regular";
    let node;

    if (nodeType === "TEXT") {
      node = figma.createText();
      try {
        await figma.loadFontAsync({ family: fontFamily, style: fontStyle });
      } catch (_e) {
        await figma.loadFontAsync({ family: "Inter", style: "Regular" });
      }
      if (spec.text !== undefined) {
        node.characters = String(spec.text);
      }
      if (spec.fontSize !== undefined) {
        node.fontSize = toNumber(spec.fontSize, 14);
      }
      if (spec.fontWeight !== undefined) {
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
        const w = toNumber(spec.fontWeight, 400);
        const styleName = weightMap[w] || "Regular";
        try {
          await figma.loadFontAsync({ family: fontFamily, style: styleName });
          node.fontName = { family: fontFamily, style: styleName };
        } catch (_e2) {
          // Keep default font if weight style not available
        }
      }
      if (spec.fontColor) {
        applyFillColor(node, spec.fontColor);
      }
    } else if (nodeType === "RECTANGLE") {
      node = figma.createRectangle();
    } else {
      node = figma.createFrame();
    }

    if (spec.name !== undefined) node.name = spec.name;
    if (spec.width !== undefined || spec.height !== undefined) {
      node.resize(toNumber(spec.width, 100), toNumber(spec.height, 100));
    }
    if (spec.x !== undefined) node.x = toNumber(spec.x, 0);
    if (spec.y !== undefined) node.y = toNumber(spec.y, 0);

    if (spec.cornerRadius !== undefined && "cornerRadius" in node) {
      node.cornerRadius = toNumber(spec.cornerRadius, 0);
    }

    if (spec.fillColor) {
      applyFillColor(node, spec.fillColor);
    }

    if (spec.strokeColor) {
      applyStrokeColor(node, spec.strokeColor);
    }
    if (spec.strokeWeight !== undefined && "strokeWeight" in node) {
      node.strokeWeight = toNumber(spec.strokeWeight, 1);
    }

    if (nodeType === "FRAME" && spec.layoutMode && spec.layoutMode !== "NONE") {
      node.layoutMode = spec.layoutMode;
      if (spec.layoutWrap) node.layoutWrap = spec.layoutWrap;
      if (spec.paddingTop !== undefined) node.paddingTop = toNumber(spec.paddingTop, 0);
      if (spec.paddingRight !== undefined) node.paddingRight = toNumber(spec.paddingRight, 0);
      if (spec.paddingBottom !== undefined) node.paddingBottom = toNumber(spec.paddingBottom, 0);
      if (spec.paddingLeft !== undefined) node.paddingLeft = toNumber(spec.paddingLeft, 0);
      if (spec.primaryAxisAlignItems) node.primaryAxisAlignItems = spec.primaryAxisAlignItems;
      if (spec.counterAxisAlignItems) node.counterAxisAlignItems = spec.counterAxisAlignItems;
      if (spec.itemSpacing !== undefined) node.itemSpacing = toNumber(spec.itemSpacing, 0);
    }

    if (parentNode) {
      parentNode.appendChild(node);
    } else if (parentId) {
      const targetParent = await figma.getNodeByIdAsync(parentId);
      if (!targetParent) throw new Error("Parent node not found: " + parentId);
      if (!("appendChild" in targetParent)) throw new Error("Parent node does not support children: " + parentId);
      targetParent.appendChild(node);
    } else {
      figma.currentPage.appendChild(node);
    }

    createdCount++;
    if (commandId && createdCount % 5 === 0) {
      const pct = Math.round((createdCount / totalNodes) * 100);
      sendProgressUpdate(
        commandId,
        "create",
        "in_progress",
        pct,
        totalNodes,
        createdCount,
        "Created " + createdCount + " of " + totalNodes + " nodes",
      );
    }

    const childResults = [];
    if (spec.children && Array.isArray(spec.children)) {
      for (let ci = 0; ci < spec.children.length; ci++) {
        const childResult = await buildNode(spec.children[ci], node);
        childResults.push(childResult);
      }
    }

    // Two-pass: set layout sizing AFTER children exist
    if (nodeType === "FRAME" && spec.layoutMode && spec.layoutMode !== "NONE") {
      if (spec.layoutSizingHorizontal) node.layoutSizingHorizontal = spec.layoutSizingHorizontal;
      if (spec.layoutSizingVertical) node.layoutSizingVertical = spec.layoutSizingVertical;
    }

    if (parentNode && "layoutMode" in parentNode && parentNode.layoutMode !== "NONE") {
      if (spec.layoutSizingHorizontal === "FILL") node.layoutSizingHorizontal = "FILL";
      if (spec.layoutSizingVertical === "FILL") node.layoutSizingVertical = "FILL";
    }

    const result = { id: node.id, name: node.name, type: node.type };
    if (childResults.length > 0) {
      result.children = childResults;
    }
    return result;
  }

  const treeResult = await buildNode(tree, null);

  if (commandId) {
    sendProgressUpdate(
      commandId,
      "create",
      "completed",
      100,
      totalNodes,
      createdCount,
      "Creation completed",
    );
  }

  return {
    success: true,
    totalNodesCreated: createdCount,
    tree: treeResult,
  };
}
