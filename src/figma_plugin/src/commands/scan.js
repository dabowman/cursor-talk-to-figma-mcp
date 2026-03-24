// Scan commands: scanTextNodes, scanNodesByTypes, annotations

import { sendProgressUpdate, generateCommandId, delay } from "../helpers.js";

export async function scanTextNodes(params) {
  console.log(`Starting to scan text nodes from node ID: ${params.nodeId}`);
  const { nodeId, useChunking = true, chunkSize = 10, commandId = generateCommandId() } = params || {};

  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    console.error(`Node with ID ${nodeId} not found`);
    sendProgressUpdate(commandId, "scan_text_nodes", "error", 0, 0, 0, `Node with ID ${nodeId} not found`, {
      error: `Node not found: ${nodeId}`,
    });
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // If chunking is not enabled, use the original implementation
  if (!useChunking) {
    const textNodes = [];
    try {
      sendProgressUpdate(
        commandId,
        "scan_text_nodes",
        "started",
        0,
        1,
        0,
        `Starting scan of node "${node.name || nodeId}" without chunking`,
        null,
      );

      await findTextNodes(node, [], 0, textNodes);

      sendProgressUpdate(
        commandId,
        "scan_text_nodes",
        "completed",
        100,
        textNodes.length,
        textNodes.length,
        `Scan complete. Found ${textNodes.length} text nodes.`,
        { textNodes },
      );

      return {
        success: true,
        message: `Scanned ${textNodes.length} text nodes.`,
        count: textNodes.length,
        textNodes: textNodes,
        commandId,
      };
    } catch (error) {
      console.error("Error scanning text nodes:", error);
      sendProgressUpdate(
        commandId,
        "scan_text_nodes",
        "error",
        0,
        0,
        0,
        `Error scanning text nodes: ${error.message}`,
        { error: error.message },
      );
      throw new Error(`Error scanning text nodes: ${error.message}`);
    }
  }

  // Chunked implementation
  console.log(`Using chunked scanning with chunk size: ${chunkSize}`);

  const nodesToProcess = [];

  sendProgressUpdate(
    commandId,
    "scan_text_nodes",
    "started",
    0,
    0,
    0,
    `Starting chunked scan of node "${node.name || nodeId}"`,
    { chunkSize },
  );

  await collectNodesToProcess(node, [], 0, nodesToProcess);

  const totalNodes = nodesToProcess.length;
  console.log(`Found ${totalNodes} total nodes to process`);

  const totalChunks = Math.ceil(totalNodes / chunkSize);
  console.log(`Will process in ${totalChunks} chunks`);

  sendProgressUpdate(
    commandId,
    "scan_text_nodes",
    "in_progress",
    5,
    totalNodes,
    0,
    `Found ${totalNodes} nodes to scan. Will process in ${totalChunks} chunks.`,
    { totalNodes, totalChunks, chunkSize },
  );

  const allTextNodes = [];
  let processedNodes = 0;
  let chunksProcessed = 0;

  for (let i = 0; i < totalNodes; i += chunkSize) {
    const chunkEnd = Math.min(i + chunkSize, totalNodes);
    console.log(`Processing chunk ${chunksProcessed + 1}/${totalChunks} (nodes ${i} to ${chunkEnd - 1})`);

    sendProgressUpdate(
      commandId,
      "scan_text_nodes",
      "in_progress",
      Math.round(5 + (chunksProcessed / totalChunks) * 90),
      totalNodes,
      processedNodes,
      `Processing chunk ${chunksProcessed + 1}/${totalChunks}`,
      { currentChunk: chunksProcessed + 1, totalChunks, textNodesFound: allTextNodes.length },
    );

    const chunkNodes = nodesToProcess.slice(i, chunkEnd);
    const chunkTextNodes = [];

    for (const nodeInfo of chunkNodes) {
      if (nodeInfo.node.type === "TEXT") {
        try {
          const textNodeInfo = await processTextNode(nodeInfo.node, nodeInfo.parentPath, nodeInfo.depth);
          if (textNodeInfo) {
            chunkTextNodes.push(textNodeInfo);
          }
        } catch (error) {
          console.error(`Error processing text node: ${error.message}`);
        }
      }
      await delay(5);
    }

    allTextNodes.push(...chunkTextNodes);
    processedNodes += chunkNodes.length;
    chunksProcessed++;

    sendProgressUpdate(
      commandId,
      "scan_text_nodes",
      "in_progress",
      Math.round(5 + (chunksProcessed / totalChunks) * 90),
      totalNodes,
      processedNodes,
      `Processed chunk ${chunksProcessed}/${totalChunks}. Found ${allTextNodes.length} text nodes so far.`,
      {
        currentChunk: chunksProcessed,
        totalChunks,
        processedNodes,
        textNodesFound: allTextNodes.length,
        chunkResult: chunkTextNodes,
      },
    );

    if (i + chunkSize < totalNodes) {
      await delay(50);
    }
  }

  sendProgressUpdate(
    commandId,
    "scan_text_nodes",
    "completed",
    100,
    totalNodes,
    processedNodes,
    `Scan complete. Found ${allTextNodes.length} text nodes.`,
    { textNodes: allTextNodes, processedNodes, chunks: chunksProcessed },
  );

  return {
    success: true,
    message: `Chunked scan complete. Found ${allTextNodes.length} text nodes.`,
    totalNodes: allTextNodes.length,
    processedNodes: processedNodes,
    chunks: chunksProcessed,
    textNodes: allTextNodes,
    commandId,
  };
}

async function collectNodesToProcess(node, parentPath, depth, nodesToProcess) {
  if (node.visible === false) return;

  const nodePath = [...parentPath, node.name || `Unnamed ${node.type}`];

  nodesToProcess.push({
    node: node,
    parentPath: nodePath,
    depth: depth,
  });

  if ("children" in node) {
    for (const child of node.children) {
      await collectNodesToProcess(child, nodePath, depth + 1, nodesToProcess);
    }
  }
}

async function processTextNode(node, parentPath, depth) {
  if (node.type !== "TEXT") return null;

  try {
    let fontFamily = "";
    let fontStyle = "";

    if (node.fontName) {
      if (typeof node.fontName === "object") {
        if ("family" in node.fontName) fontFamily = node.fontName.family;
        if ("style" in node.fontName) fontStyle = node.fontName.style;
      }
    }

    let styleName = null;
    if (node.textStyleId && typeof node.textStyleId === "string") {
      try {
        const style = figma.getStyleById(node.textStyleId);
        if (style) {
          styleName = style.name;
        }
      } catch (_styleErr) {
        // style not found
      }
    }

    let fillsVariable = null;
    try {
      if (node.fills && node.fills.length > 0) {
        const firstFill = node.fills[0];
        if (firstFill && firstFill.boundVariables && firstFill.boundVariables.color) {
          const colorAlias = firstFill.boundVariables.color;
          if (colorAlias && colorAlias.id) {
            const variable = await figma.variables.getVariableByIdAsync(colorAlias.id);
            if (variable) {
              fillsVariable = variable.name;
            }
          }
        }
      }
    } catch (_varErr) {
      // variable lookup failed
    }

    const safeTextNode = {
      id: node.id,
      name: node.name || "Text",
      type: node.type,
      characters: node.characters,
      fontSize: typeof node.fontSize === "number" ? node.fontSize : 0,
      fontFamily: fontFamily,
      fontStyle: fontStyle,
      x: typeof node.x === "number" ? node.x : 0,
      y: typeof node.y === "number" ? node.y : 0,
      width: typeof node.width === "number" ? node.width : 0,
      height: typeof node.height === "number" ? node.height : 0,
      path: parentPath.join(" > "),
      depth: depth,
      style: styleName,
      fills_variable: fillsVariable,
    };

    return safeTextNode;
  } catch (nodeErr) {
    console.error("Error processing text node:", nodeErr);
    return null;
  }
}

async function findTextNodes(node, parentPath, depth, textNodes) {
  if (node.visible === false) return;

  const nodePath = [...parentPath, node.name || `Unnamed ${node.type}`];

  if (node.type === "TEXT") {
    try {
      let fontFamily = "";
      let fontStyle = "";

      if (node.fontName) {
        if (typeof node.fontName === "object") {
          if ("family" in node.fontName) fontFamily = node.fontName.family;
          if ("style" in node.fontName) fontStyle = node.fontName.style;
        }
      }

      const safeTextNode = {
        id: node.id,
        name: node.name || "Text",
        type: node.type,
        characters: node.characters,
        fontSize: typeof node.fontSize === "number" ? node.fontSize : 0,
        fontFamily: fontFamily,
        fontStyle: fontStyle,
        x: typeof node.x === "number" ? node.x : 0,
        y: typeof node.y === "number" ? node.y : 0,
        width: typeof node.width === "number" ? node.width : 0,
        height: typeof node.height === "number" ? node.height : 0,
        path: nodePath.join(" > "),
        depth: depth,
      };

      textNodes.push(safeTextNode);
    } catch (nodeErr) {
      console.error("Error processing text node:", nodeErr);
    }
  }

  if ("children" in node) {
    for (const child of node.children) {
      await findTextNodes(child, nodePath, depth + 1, textNodes);
    }
  }
}

export async function scanNodesByTypes(params) {
  console.log(`Starting to scan nodes by types from node ID: ${params.nodeId}`);
  const { nodeId, types = [] } = params || {};

  if (!types || types.length === 0) {
    throw new Error("No types specified to search for");
  }

  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  const matchingNodes = [];

  const commandId = generateCommandId();
  sendProgressUpdate(
    commandId,
    "scan_nodes_by_types",
    "started",
    0,
    1,
    0,
    `Starting scan of node "${node.name || nodeId}" for types: ${types.join(", ")}`,
    null,
  );

  await findNodesByTypes(node, types, matchingNodes);

  sendProgressUpdate(
    commandId,
    "scan_nodes_by_types",
    "completed",
    100,
    matchingNodes.length,
    matchingNodes.length,
    `Scan complete. Found ${matchingNodes.length} matching nodes.`,
    { matchingNodes },
  );

  return {
    success: true,
    message: `Found ${matchingNodes.length} matching nodes.`,
    count: matchingNodes.length,
    matchingNodes: matchingNodes,
    searchedTypes: types,
  };
}

async function findNodesByTypes(node, types, matchingNodes) {
  if (node.visible === false) return;

  if (types.includes(node.type)) {
    matchingNodes.push({
      id: node.id,
      name: node.name || `Unnamed ${node.type}`,
      type: node.type,
      bbox: {
        x: typeof node.x === "number" ? node.x : 0,
        y: typeof node.y === "number" ? node.y : 0,
        width: typeof node.width === "number" ? node.width : 0,
        height: typeof node.height === "number" ? node.height : 0,
      },
    });
  }

  if ("children" in node) {
    for (const child of node.children) {
      await findNodesByTypes(child, types, matchingNodes);
    }
  }
}

export async function getAnnotations(params) {
  try {
    const { nodeId, nodeIds, includeCategories = true } = params;

    // Only fetch categories when explicitly requested AND there are annotations to show
    let categoriesMap = {};
    let categoriesFetched = false;
    async function ensureCategories() {
      if (!categoriesFetched && includeCategories) {
        categoriesFetched = true;
        const categories = await figma.annotations.getAnnotationCategoriesAsync();
        categoriesMap = categories.reduce((map, category) => {
          map[category.id] = {
            id: category.id,
            label: category.label,
            color: category.color,
            isPreset: category.isPreset,
          };
          return map;
        }, {});
      }
    }

    // Helper: collect annotations from a node and its subtree
    async function collectAnnotations(node) {
      const mergedAnnotations = [];
      const collect = async (n) => {
        if ("annotations" in n && n.annotations && n.annotations.length > 0) {
          for (let idx = 0; idx < n.annotations.length; idx++) {
            const a = n.annotations[idx];
            mergedAnnotations.push({ nodeId: n.id, nodeName: n.name, annotation: { annotationIndex: idx, ...a } });
          }
        }
        if ("children" in n) {
          for (const child of n.children) {
            await collect(child);
          }
        }
      };
      await collect(node);
      return mergedAnnotations;
    }

    // Batch mode: multiple nodeIds
    if (nodeIds && nodeIds.length > 0) {
      const results = [];
      for (let i = 0; i < nodeIds.length; i++) {
        const nid = nodeIds[i];
        const node = await figma.getNodeByIdAsync(nid);
        if (!node) {
          results.push({ nodeId: nid, error: "Node not found" });
          continue;
        }
        if (!("annotations" in node)) {
          results.push({ nodeId: nid, name: node.name, annotations: [] });
          continue;
        }
        const annotations = await collectAnnotations(node);
        results.push({ nodeId: node.id, name: node.name, annotations: annotations });
      }

      // Only include categories if any annotations were found
      const hasAnyAnnotations = results.some((r) => r.annotations && r.annotations.length > 0);
      const result = { nodes: results };
      if (hasAnyAnnotations) {
        await ensureCategories();
        result.categories = Object.values(categoriesMap);
      }
      return result;
    }

    // Single node mode
    if (nodeId) {
      const node = await figma.getNodeByIdAsync(nodeId);
      if (!node) {
        throw new Error(`Node not found: ${nodeId}`);
      }

      if (!("annotations" in node)) {
        throw new Error(`Node type ${node.type} does not support annotations`);
      }

      const mergedAnnotations = await collectAnnotations(node);

      const result = {
        nodeId: node.id,
        name: node.name,
        annotations: mergedAnnotations,
      };

      // Only include categories when there are actual annotations
      if (mergedAnnotations.length > 0) {
        await ensureCategories();
        result.categories = Object.values(categoriesMap);
      }

      return result;
    }

    // No nodeId — scan entire current page
    const annotations = [];
    const processNode = async (node) => {
      if ("annotations" in node && node.annotations && node.annotations.length > 0) {
        const indexedAnnotations = node.annotations.map((a, idx) => ({ annotationIndex: idx, ...a }));
        annotations.push({
          nodeId: node.id,
          name: node.name,
          annotations: indexedAnnotations,
        });
      }
      if ("children" in node) {
        for (const child of node.children) {
          await processNode(child);
        }
      }
    };

    await processNode(figma.currentPage);

    const result = {
      annotatedNodes: annotations,
    };

    // Only include categories when there are actual annotations
    if (annotations.length > 0) {
      await ensureCategories();
      result.categories = Object.values(categoriesMap);
    }

    return result;
  } catch (error) {
    console.error("Error in getAnnotations:", error);
    throw error;
  }
}

export async function setAnnotation(params) {
  try {
    console.log("=== setAnnotation Debug Start ===");
    console.log("Input params:", JSON.stringify(params, null, 2));

    const { nodeId, annotationIndex, labelMarkdown, categoryId, properties } = params;

    if (!nodeId) {
      console.error("Validation failed: Missing nodeId");
      return { success: false, error: "Missing nodeId" };
    }

    if (!labelMarkdown) {
      console.error("Validation failed: Missing labelMarkdown");
      return { success: false, error: "Missing labelMarkdown" };
    }

    console.log("Attempting to get node:", nodeId);
    const node = await figma.getNodeByIdAsync(nodeId);
    console.log("Node lookup result:", {
      id: nodeId,
      found: !!node,
      type: node ? node.type : undefined,
      name: node ? node.name : undefined,
      hasAnnotations: node ? "annotations" in node : false,
    });

    if (!node) {
      console.error("Node lookup failed:", nodeId);
      return { success: false, error: `Node not found: ${nodeId}` };
    }

    if (!("annotations" in node)) {
      console.error("Node annotation support check failed:", {
        nodeType: node.type,
        nodeId: node.id,
      });
      return {
        success: false,
        error: `Node type ${node.type} does not support annotations`,
      };
    }

    const newAnnotation = {
      labelMarkdown,
    };

    if (categoryId) {
      console.log("Adding categoryId to annotation:", categoryId);
      newAnnotation.categoryId = categoryId;
    }

    if (properties && Array.isArray(properties) && properties.length > 0) {
      console.log("Adding properties to annotation:", JSON.stringify(properties, null, 2));
      newAnnotation.properties = properties;
    }

    console.log("Current node annotations:", node.annotations);
    console.log("Setting new annotation:", JSON.stringify(newAnnotation, null, 2));

    const existingAnnotations = node.annotations ? node.annotations.slice() : [];

    // If annotationIndex is provided, replace that specific annotation
    if (annotationIndex !== undefined && annotationIndex !== null) {
      if (annotationIndex >= 0 && annotationIndex < existingAnnotations.length) {
        existingAnnotations[annotationIndex] = newAnnotation;
        node.annotations = existingAnnotations;
        console.log(`Replaced annotation at index ${annotationIndex}`);
      } else {
        return {
          success: false,
          error: `annotationIndex ${annotationIndex} out of range (${existingAnnotations.length} existing annotations)`,
        };
      }
    } else if (existingAnnotations.length > 0) {
      // No annotationIndex provided but node already has annotations — replace the first one
      // This prevents the "node already has annotation" validation error
      existingAnnotations[0] = newAnnotation;
      node.annotations = existingAnnotations;
      console.log("Replaced existing first annotation (no annotationIndex specified)");
    } else {
      // No existing annotations — add new
      node.annotations = [newAnnotation];
      console.log("Added new annotation");
    }

    console.log("Updated node annotations:", node.annotations);
    console.log("=== setAnnotation Debug End ===");

    const indexedAnnotations = node.annotations
      ? node.annotations.map((a, idx) => ({ annotationIndex: idx, ...a }))
      : [];

    return {
      success: true,
      nodeId: node.id,
      name: node.name,
      annotations: indexedAnnotations,
    };
  } catch (error) {
    console.error("=== setAnnotation Error ===");
    console.error("Error details:", {
      message: error.message,
      stack: error.stack,
      params: JSON.stringify(params, null, 2),
    });
    return { success: false, error: error.message };
  }
}

export async function setMultipleAnnotations(params) {
  console.log("=== setMultipleAnnotations Debug Start ===");
  console.log("Input params:", JSON.stringify(params, null, 2));

  const { annotations } = params;

  if (!annotations || annotations.length === 0) {
    console.error("Validation failed: No annotations provided");
    return { success: false, error: "No annotations provided" };
  }

  console.log(`Processing ${annotations.length} annotations`);

  const results = [];
  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < annotations.length; i++) {
    const annotation = annotations[i];
    console.log(`\nProcessing annotation ${i + 1}/${annotations.length}:`, JSON.stringify(annotation, null, 2));

    try {
      console.log("Calling setAnnotation with params:", {
        nodeId: annotation.nodeId,
        annotationIndex: annotation.annotationIndex,
        labelMarkdown: annotation.labelMarkdown,
        categoryId: annotation.categoryId,
        properties: annotation.properties,
      });

      const result = await setAnnotation({
        nodeId: annotation.nodeId,
        annotationIndex: annotation.annotationIndex,
        labelMarkdown: annotation.labelMarkdown,
        categoryId: annotation.categoryId,
        properties: annotation.properties,
      });

      console.log("setAnnotation result:", JSON.stringify(result, null, 2));

      if (result.success) {
        successCount++;
        results.push({ success: true, nodeId: annotation.nodeId });
      } else {
        failureCount++;
        results.push({
          success: false,
          nodeId: annotation.nodeId,
          error: result.error,
        });
      }
    } catch (error) {
      failureCount++;
      results.push({
        success: false,
        nodeId: annotation.nodeId,
        error: error.message,
      });
      console.error(`Annotation ${i + 1} failed with error:`, error);
    }
  }

  const summary = {
    success: successCount > 0,
    annotationsApplied: successCount,
    annotationsFailed: failureCount,
    totalAnnotations: annotations.length,
    results: results,
  };

  console.log("\n=== setMultipleAnnotations Summary ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("=== setMultipleAnnotations Debug End ===");

  return summary;
}
