// This is the main code file for the Cursor MCP Figma plugin
// It handles Figma API commands

// Plugin state
const state = {
  serverPort: 3055, // Default port
};

// Helper function for progress updates
function sendProgressUpdate(
  commandId,
  commandType,
  status,
  progress,
  totalItems,
  processedItems,
  message,
  payload = null,
) {
  const update = {
    type: "command_progress",
    commandId,
    commandType,
    status,
    progress,
    totalItems,
    processedItems,
    message,
    timestamp: Date.now(),
  };

  // Add optional chunk information if present
  if (payload) {
    if (payload.currentChunk !== undefined && payload.totalChunks !== undefined) {
      update.currentChunk = payload.currentChunk;
      update.totalChunks = payload.totalChunks;
      update.chunkSize = payload.chunkSize;
    }
    update.payload = payload;
  }

  // Send to UI
  figma.ui.postMessage(update);
  console.log(`Progress update: ${status} - ${progress}% - ${message}`);

  return update;
}

// Helper: coerce value to number with fallback (handles string "4" → 4)
function toNumber(val, fallback) {
  if (val === undefined || val === null) return fallback;
  var n = typeof val === "number" ? val : parseFloat(val);
  return Number.isNaN(n) ? fallback : n;
}

// Performance: skip invisible instance children in all traversals
figma.skipInvisibleInstanceChildren = true;

// ─── Concurrency Control ────────────────────────────────────────────────────
// Enables safe parallel processing of multiple agent requests.
// - Reads run concurrently with no locking
// - Writes to different nodes run concurrently with per-node locks
// - Global operations (multi-node writes, tree mutations) serialize via a mutex
// - Max concurrent in-flight operations capped to stay within Figma's CPU budget

// Operation classification: which commands are read-only?
var READ_OPS = {
  "get_document_info": true,
  "get_selection": true,
  "get_node_info": true,
  "get_nodes_info": true,
  "read_my_design": true,
  "scan_text_nodes": true,
  "scan_nodes_by_types": true,
  "get_styles": true,
  "get_local_variables": true,
  "get_local_components": true,
  "get_library_variables": true,
  "get_library_components": true,
  "search_library_components": true,
  "get_annotations": true,
  "get_reactions": true,
  "get_component_variants": true,
  "get_instance_overrides": true,
  "get_main_component": true,
  "export_node_as_image": true,
  "set_selections": true,
  "set_focus": true
};

// Global operations that touch multiple nodes or tree structure — serialize globally
var GLOBAL_OPS = {
  "create_frame_tree": true,
  "delete_multiple_nodes": true,
  "combine_as_variants": true,
  "reorder_children": true,
  "create_connections": true,
  "set_multiple_properties": true,
  "batch_bind_variables": true,
  "batch_set_text_styles": true,
  "set_multiple_text_contents": true,
  "set_multiple_annotations": true,
  "set_instance_overrides": true
};
// Everything else is a per-node write operation (locked by params.nodeId)

// Node-level write locks: prevents two writes to the same node from interleaving
var nodeLocks = {};

function acquireNodeLock(nodeId) {
  if (!nodeId) {
    return Promise.resolve(() => {});
  }
  var entry = nodeLocks[nodeId];
  if (!entry) {
    entry = { queue: Promise.resolve() };
    nodeLocks[nodeId] = entry;
  }
  var release;
  var prev = entry.queue;
  entry.queue = new Promise((resolve) => {
    release = resolve;
  });
  return prev.then(() => release);
}

// Global mutex: serializes operations that touch multiple nodes or the tree structure
var globalLockQueue = Promise.resolve();

function acquireGlobalLock() {
  var release;
  var prev = globalLockQueue;
  globalLockQueue = new Promise((resolve) => {
    release = resolve;
  });
  return prev.then(() => release);
}

// Concurrency limiter: caps in-flight operations to avoid Figma CPU budget issues
var inFlightCount = 0;
var MAX_CONCURRENT = 6;
var waitQueue = [];

function waitForSlot() {
  if (inFlightCount < MAX_CONCURRENT) {
    inFlightCount++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waitQueue.push(resolve);
  });
}

function releaseSlot() {
  inFlightCount--;
  if (waitQueue.length > 0 && inFlightCount < MAX_CONCURRENT) {
    inFlightCount++;
    waitQueue.shift()();
  }
}

// Concurrency-safe request router
async function routeCommand(id, command, params) {
  await waitForSlot();
  try {
    var result;
    if (GLOBAL_OPS[command]) {
      // Global operations: acquire global mutex (serializes with all other global ops)
      var release = await acquireGlobalLock();
      try {
        result = await handleCommand(command, params);
      } finally {
        release();
      }
    } else if (!READ_OPS[command] && params && params.nodeId) {
      // Per-node write: acquire lock for this specific node
      var release = await acquireNodeLock(params.nodeId);
      try {
        result = await handleCommand(command, params);
      } finally {
        release();
      }
    } else {
      // Read operations or writes without a nodeId: run freely
      result = await handleCommand(command, params);
    }
    figma.ui.postMessage({
      type: "command-result",
      id: id,
      result: result,
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "command-error",
      id: id,
      error: error.message || "Error executing command",
    });
  } finally {
    releaseSlot();
  }
}

// ─── End Concurrency Control ────────────────────────────────────────────────

// Show UI
figma.showUI(__html__, { width: 320, height: 56 });

// Plugin commands from UI
figma.ui.onmessage = async (msg) => {
  switch (msg.type) {
    case "update-settings":
      updateSettings(msg);
      break;
    case "notify":
      figma.notify(msg.message);
      break;
    case "close-plugin":
      figma.closePlugin();
      break;
    case "execute-command":
      // Route through concurrency control (does NOT await — runs concurrently)
      routeCommand(msg.id, msg.command, msg.params);
      break;
  }
};

// Listen for plugin commands from menu
figma.on("run", ({ command }) => {
  figma.ui.postMessage({ type: "auto-connect" });
});

// Update plugin settings
function updateSettings(settings) {
  if (settings.serverPort) {
    state.serverPort = settings.serverPort;
  }

  figma.clientStorage.setAsync("settings", {
    serverPort: state.serverPort,
  });
}

// Handle commands from UI
async function handleCommand(command, params) {
  switch (command) {
    case "get_document_info":
      return await getDocumentInfo();
    case "get_selection":
      return await getSelection();
    case "get_node_info":
      if (!params || !params.nodeId) {
        throw new Error("Missing nodeId parameter");
      }
      return await getNodeInfo(params.nodeId);
    case "get_nodes_info":
      if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
        throw new Error("Missing or invalid nodeIds parameter");
      }
      return await getNodesInfo(params.nodeIds);
    case "read_my_design":
      return await readMyDesign();
    case "create_rectangle":
      return await createRectangle(params);
    case "create_frame":
      return await createFrame(params);
    case "create_text":
      return await createText(params);
    case "set_fill_color":
      return await setFillColor(params);
    case "set_stroke_color":
      return await setStrokeColor(params);
    case "move_node":
      return await moveNode(params);
    case "resize_node":
      return await resizeNode(params);
    case "delete_node":
      return await deleteNode(params);
    case "delete_multiple_nodes":
      return await deleteMultipleNodes(params);
    case "get_styles":
      return await getStyles();
    case "get_local_variables":
      return await getLocalVariables();
    case "get_local_components":
      return await getLocalComponents();
    // case "get_team_components":
    //   return await getTeamComponents();
    case "create_component":
      return await createComponent(params);
    case "combine_as_variants":
      return await combineAsVariants(params);
    case "create_component_instance":
      return await createComponentInstance(params);
    case "import_library_component":
      return await importLibraryComponent(params);
    case "export_node_as_image":
      return await exportNodeAsImage(params);
    case "set_corner_radius":
      return await setCornerRadius(params);
    case "set_text_content":
      return await setTextContent(params);
    case "rename_node":
      return await renameNode(params);
    case "clone_node":
      return await cloneNode(params);
    case "scan_text_nodes":
      return await scanTextNodes(params);
    case "set_multiple_text_contents":
      return await setMultipleTextContents(params);
    case "get_annotations":
      return await getAnnotations(params);
    case "set_annotation":
      return await setAnnotation(params);
    case "scan_nodes_by_types":
      return await scanNodesByTypes(params);
    case "set_multiple_annotations":
      return await setMultipleAnnotations(params);
    case "get_instance_overrides":
      // Check if instanceNode parameter is provided
      if (params && params.instanceNodeId) {
        // Get the instance node by ID
        const instanceNode = await figma.getNodeByIdAsync(params.instanceNodeId);
        if (!instanceNode) {
          throw new Error(`Instance node not found with ID: ${params.instanceNodeId}`);
        }
        return await getInstanceOverrides(instanceNode);
      }
      // Call without instance node if not provided
      return await getInstanceOverrides();

    case "set_instance_overrides":
      // Check if instanceNodeIds parameter is provided
      if (params && params.targetNodeIds) {
        // Validate that targetNodeIds is an array
        if (!Array.isArray(params.targetNodeIds)) {
          throw new Error("targetNodeIds must be an array");
        }

        // Get the instance nodes by IDs
        const targetNodes = await getValidTargetInstances(params.targetNodeIds);
        if (!targetNodes.success) {
          figma.notify(targetNodes.message);
          return { success: false, message: targetNodes.message };
        }

        if (params.sourceInstanceId) {
          // get source instance data
          let sourceInstanceData = null;
          sourceInstanceData = await getSourceInstanceData(params.sourceInstanceId);

          if (!sourceInstanceData.success) {
            figma.notify(sourceInstanceData.message);
            return { success: false, message: sourceInstanceData.message };
          }
          return await setInstanceOverrides(targetNodes.targetInstances, sourceInstanceData);
        } else {
          throw new Error("Missing sourceInstanceId parameter");
        }
      }
      throw new Error("Missing targetNodeIds parameter");
    case "swap_component_variant":
      return await swapComponentVariant(params);
    case "set_layout_mode":
      return await setLayoutMode(params);
    case "set_padding":
      return await setPadding(params);
    case "set_axis_align":
      return await setAxisAlign(params);
    case "set_layout_sizing":
      return await setLayoutSizing(params);
    case "set_item_spacing":
      return await setItemSpacing(params);
    case "get_reactions":
      if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
        throw new Error("Missing or invalid nodeIds parameter");
      }
      return await getReactions(params.nodeIds);
    case "set_default_connector":
      return await setDefaultConnector(params);
    case "create_connections":
      return await createConnections(params);
    case "set_focus":
      return await setFocus(params);
    case "set_selections":
      return await setSelections(params);
    case "reorder_children":
      return await reorderChildren(params);
    case "create_frame_tree":
      return await createFrameTree(params);
    case "set_multiple_properties":
      return await setMultipleProperties(params);
    case "clone_and_modify":
      return await cloneAndModify(params);
    case "get_main_component":
      return await getMainComponent(params);
    case "bind_variable":
      return await bindVariable(params);
    case "batch_bind_variables":
      return await batchBindVariables(params);
    case "set_text_style":
      return await setTextStyle(params);
    case "batch_set_text_styles":
      return await batchSetTextStyles(params);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// Command implementations

async function getDocumentInfo() {
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

async function getSelection() {
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

function rgbaToHex(color) {
  var r = Math.round(color.r * 255);
  var g = Math.round(color.g * 255);
  var b = Math.round(color.b * 255);
  var a = color.a !== undefined ? Math.round(color.a * 255) : 255;

  if (a === 255) {
    return (
      "#" +
      [r, g, b]
        .map((x) => {
          return x.toString(16).padStart(2, "0");
        })
        .join("")
    );
  }

  return (
    "#" +
    [r, g, b, a]
      .map((x) => {
        return x.toString(16).padStart(2, "0");
      })
      .join("")
  );
}

function filterFigmaNode(node) {
  if (node.type === "VECTOR") {
    return null;
  }

  var filtered = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  if (node.fills && node.fills.length > 0) {
    filtered.fills = node.fills.map((fill) => {
      var processedFill = Object.assign({}, fill);
      delete processedFill.boundVariables;
      delete processedFill.imageRef;

      if (processedFill.gradientStops) {
        processedFill.gradientStops = processedFill.gradientStops.map((stop) => {
          var processedStop = Object.assign({}, stop);
          if (processedStop.color) {
            processedStop.color = rgbaToHex(processedStop.color);
          }
          delete processedStop.boundVariables;
          return processedStop;
        });
      }

      if (processedFill.color) {
        processedFill.color = rgbaToHex(processedFill.color);
      }

      return processedFill;
    });
  }

  if (node.strokes && node.strokes.length > 0) {
    filtered.strokes = node.strokes.map((stroke) => {
      var processedStroke = Object.assign({}, stroke);
      delete processedStroke.boundVariables;
      if (processedStroke.color) {
        processedStroke.color = rgbaToHex(processedStroke.color);
      }
      return processedStroke;
    });
  }

  if (node.cornerRadius !== undefined) {
    filtered.cornerRadius = node.cornerRadius;
  }

  if (node.absoluteBoundingBox) {
    filtered.absoluteBoundingBox = node.absoluteBoundingBox;
  }

  if (node.characters) {
    filtered.characters = node.characters;
  }

  if (node.style) {
    filtered.style = {
      fontFamily: node.style.fontFamily,
      fontStyle: node.style.fontStyle,
      fontWeight: node.style.fontWeight,
      fontSize: node.style.fontSize,
      textAlignHorizontal: node.style.textAlignHorizontal,
      letterSpacing: node.style.letterSpacing,
      lineHeightPx: node.style.lineHeightPx,
    };
  }

  // Auto-layout properties (REST API format from exportAsync JSON_REST_V1)
  if (node.layoutMode && node.layoutMode !== "NONE") {
    filtered.layoutMode = node.layoutMode;
    filtered.primaryAxisSizingMode = node.primaryAxisSizingMode;
    filtered.counterAxisSizingMode = node.counterAxisSizingMode;
    if (node.primaryAxisAlignItems && node.primaryAxisAlignItems !== "MIN") {
      filtered.primaryAxisAlignItems = node.primaryAxisAlignItems;
    }
    if (node.counterAxisAlignItems && node.counterAxisAlignItems !== "MIN") {
      filtered.counterAxisAlignItems = node.counterAxisAlignItems;
    }
    if (node.itemSpacing > 0) {
      filtered.itemSpacing = node.itemSpacing;
    }
    if (node.counterAxisSpacing > 0) {
      filtered.counterAxisSpacing = node.counterAxisSpacing;
    }
    if (node.paddingLeft > 0) {
      filtered.paddingLeft = node.paddingLeft;
    }
    if (node.paddingRight > 0) {
      filtered.paddingRight = node.paddingRight;
    }
    if (node.paddingTop > 0) {
      filtered.paddingTop = node.paddingTop;
    }
    if (node.paddingBottom > 0) {
      filtered.paddingBottom = node.paddingBottom;
    }
    if (node.layoutWrap === "WRAP") {
      filtered.layoutWrap = node.layoutWrap;
    }
  }

  if (node.children) {
    filtered.children = node.children
      .map((child) => {
        return filterFigmaNode(child);
      })
      .filter((child) => {
        return child !== null;
      });
  }

  return filtered;
}

async function getNodeInfo(nodeId) {
  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  const response = await node.exportAsync({
    format: "JSON_REST_V1",
  });

  return filterFigmaNode(response.document);
}

async function getNodesInfo(nodeIds) {
  try {
    // Load all nodes in parallel
    const nodes = await Promise.all(nodeIds.map((id) => figma.getNodeByIdAsync(id)));

    // Filter out any null values (nodes that weren't found)
    const validNodes = nodes.filter((node) => node !== null);

    // Export all valid nodes in parallel
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

async function getReactions(nodeIds) {
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

    // Function to find nodes with reactions from the node and all its children
    async function findNodesWithReactions(node, processedNodes = new Set(), depth = 0, results = []) {
      // Skip already processed nodes (prevent circular references)
      if (processedNodes.has(node.id)) {
        return results;
      }

      processedNodes.add(node.id);

      // Check if the current node has reactions
      let filteredReactions = [];
      if (node.reactions && node.reactions.length > 0) {
        // Filter out reactions with navigation === 'CHANGE_TO'
        filteredReactions = node.reactions.filter((r) => {
          // Some reactions may have action or actions array
          if (r.action && r.action.navigation === "CHANGE_TO") return false;
          if (Array.isArray(r.actions)) {
            // If any action in actions array is CHANGE_TO, exclude
            return !r.actions.some((a) => a.navigation === "CHANGE_TO");
          }
          return true;
        });
      }
      const hasFilteredReactions = filteredReactions.length > 0;

      // If the node has filtered reactions, add it to results and apply highlight effect
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
        // Apply highlight effect (orange border)
        await highlightNodeWithAnimation(node);
      }

      // If node has children, recursively search them
      if (node.children) {
        for (const child of node.children) {
          await findNodesWithReactions(child, processedNodes, depth + 1, results);
        }
      }

      return results;
    }

    // Function to apply animated highlight effect to a node
    async function highlightNodeWithAnimation(node) {
      // Save original stroke properties
      const originalStrokeWeight = node.strokeWeight;
      const originalStrokes = node.strokes ? [...node.strokes] : [];

      try {
        // Apply orange border stroke
        node.strokeWeight = 4;
        node.strokes = [
          {
            type: "SOLID",
            color: { r: 1, g: 0.5, b: 0 }, // Orange color
            opacity: 0.8,
          },
        ];

        // Set timeout for animation effect (restore to original after 1.5 seconds)
        setTimeout(() => {
          try {
            // Restore original stroke properties
            node.strokeWeight = originalStrokeWeight;
            node.strokes = originalStrokes;
          } catch (restoreError) {
            console.error(`Error restoring node stroke: ${restoreError.message}`);
          }
        }, 1500);
      } catch (highlightError) {
        console.error(`Error highlighting node: ${highlightError.message}`);
        // Continue even if highlighting fails
      }
    }

    // Get node hierarchy path as a string
    function getNodePath(node) {
      const path = [];
      let current = node;

      while (current && current.parent) {
        path.unshift(current.name);
        current = current.parent;
      }

      return path.join(" > ");
    }

    // Array to store all results
    let allResults = [];
    let processedCount = 0;
    const totalCount = nodeIds.length;

    // Iterate through each node and its children to search for reactions
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

        // Search for reactions in the node and its children
        const processedNodes = new Set();
        const nodeResults = await findNodesWithReactions(node, processedNodes);

        // Add results
        allResults = allResults.concat(nodeResults);

        // Update progress
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

    // Completion update
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

async function readMyDesign() {
  try {
    // Load all selected nodes in parallel
    const nodes = await Promise.all(figma.currentPage.selection.map((node) => figma.getNodeByIdAsync(node.id)));

    // Filter out any null values (nodes that weren't found)
    const validNodes = nodes.filter((node) => node !== null);

    // Export all valid nodes in parallel
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

async function createRectangle(params) {
  const { x = 0, y = 0, width = 100, height = 100, name = "Rectangle", parentId } = params || {};

  const rect = figma.createRectangle();
  rect.x = x;
  rect.y = y;
  rect.resize(width, height);
  rect.name = name;

  // If parentId is provided, append to that node, otherwise append to current page
  if (parentId) {
    const parentNode = await figma.getNodeByIdAsync(parentId);
    if (!parentNode) {
      throw new Error(`Parent node not found with ID: ${parentId}`);
    }
    if (!("appendChild" in parentNode)) {
      throw new Error(`Parent node does not support children: ${parentId}`);
    }
    parentNode.appendChild(rect);
  } else {
    figma.currentPage.appendChild(rect);
  }

  return {
    id: rect.id,
    name: rect.name,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    fills: rect.fills,
    cornerRadius: rect.cornerRadius,
    parentId: rect.parent ? rect.parent.id : undefined,
  };
}

async function createFrame(params) {
  const {
    x = 0,
    y = 0,
    width = 100,
    height = 100,
    name = "Frame",
    parentId,
    fillColor,
    strokeColor,
    strokeWeight,
    layoutMode = "NONE",
    layoutWrap = "NO_WRAP",
    paddingTop = 10,
    paddingRight = 10,
    paddingBottom = 10,
    paddingLeft = 10,
    primaryAxisAlignItems = "MIN",
    counterAxisAlignItems = "MIN",
    layoutSizingHorizontal = "FIXED",
    layoutSizingVertical = "FIXED",
    itemSpacing = 0,
    cornerRadius,
  } = params || {};

  const frame = figma.createFrame();
  frame.x = x;
  frame.y = y;
  frame.resize(width, height);
  frame.name = name;

  // Set layout mode if provided
  if (layoutMode !== "NONE") {
    frame.layoutMode = layoutMode;
    frame.layoutWrap = layoutWrap;

    // Set padding values only when layoutMode is not NONE
    frame.paddingTop = paddingTop;
    frame.paddingRight = paddingRight;
    frame.paddingBottom = paddingBottom;
    frame.paddingLeft = paddingLeft;

    // Set axis alignment only when layoutMode is not NONE
    frame.primaryAxisAlignItems = primaryAxisAlignItems;
    frame.counterAxisAlignItems = counterAxisAlignItems;

    // Set layout sizing only when layoutMode is not NONE
    frame.layoutSizingHorizontal = layoutSizingHorizontal;
    frame.layoutSizingVertical = layoutSizingVertical;

    // Set item spacing only when layoutMode is not NONE
    frame.itemSpacing = itemSpacing;
  }

  // Set corner radius if provided
  if (cornerRadius !== undefined) {
    frame.cornerRadius = cornerRadius;
  }

  // Set fill color if provided
  if (fillColor) {
    const paintStyle = {
      type: "SOLID",
      color: {
        r: parseFloat(fillColor.r) || 0,
        g: parseFloat(fillColor.g) || 0,
        b: parseFloat(fillColor.b) || 0,
      },
      opacity: fillColor.a !== undefined ? parseFloat(fillColor.a) : 1,
    };
    frame.fills = [paintStyle];
  }

  // Set stroke color and weight if provided
  if (strokeColor) {
    const strokeStyle = {
      type: "SOLID",
      color: {
        r: parseFloat(strokeColor.r) || 0,
        g: parseFloat(strokeColor.g) || 0,
        b: parseFloat(strokeColor.b) || 0,
      },
      opacity: strokeColor.a !== undefined ? parseFloat(strokeColor.a) : 1,
    };
    frame.strokes = [strokeStyle];
  }

  // Set stroke weight if provided
  if (strokeWeight !== undefined) {
    frame.strokeWeight = strokeWeight;
  }

  // If parentId is provided, append to that node, otherwise append to current page
  if (parentId) {
    const parentNode = await figma.getNodeByIdAsync(parentId);
    if (!parentNode) {
      throw new Error(`Parent node not found with ID: ${parentId}`);
    }
    if (!("appendChild" in parentNode)) {
      throw new Error(`Parent node does not support children: ${parentId}`);
    }
    parentNode.appendChild(frame);
  } else {
    figma.currentPage.appendChild(frame);
  }

  return {
    id: frame.id,
    name: frame.name,
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    fills: frame.fills,
    strokes: frame.strokes,
    strokeWeight: frame.strokeWeight,
    cornerRadius: frame.cornerRadius,
    layoutMode: frame.layoutMode,
    layoutWrap: frame.layoutWrap,
    paddingTop: frame.paddingTop,
    paddingRight: frame.paddingRight,
    paddingBottom: frame.paddingBottom,
    paddingLeft: frame.paddingLeft,
    primaryAxisAlignItems: frame.primaryAxisAlignItems,
    counterAxisAlignItems: frame.counterAxisAlignItems,
    layoutSizingHorizontal: frame.layoutSizingHorizontal,
    layoutSizingVertical: frame.layoutSizingVertical,
    itemSpacing: frame.itemSpacing,
    parentId: frame.parent ? frame.parent.id : undefined,
  };
}

async function createText(params) {
  const {
    x = 0,
    y = 0,
    text = "Text",
    fontSize = 14,
    fontWeight = 400,
    fontColor = { r: 0, g: 0, b: 0, a: 1 }, // Default to black
    name = "",
    parentId,
  } = params || {};

  // Map common font weights to Figma font styles
  const getFontStyle = (weight) => {
    switch (weight) {
      case 100:
        return "Thin";
      case 200:
        return "Extra Light";
      case 300:
        return "Light";
      case 400:
        return "Regular";
      case 500:
        return "Medium";
      case 600:
        return "Semi Bold";
      case 700:
        return "Bold";
      case 800:
        return "Extra Bold";
      case 900:
        return "Black";
      default:
        return "Regular";
    }
  };

  const textNode = figma.createText();
  textNode.x = x;
  textNode.y = y;
  textNode.name = name || text;
  try {
    await figma.loadFontAsync({
      family: "Inter",
      style: getFontStyle(fontWeight),
    });
    textNode.fontName = { family: "Inter", style: getFontStyle(fontWeight) };
    textNode.fontSize = parseInt(fontSize, 10);
  } catch (error) {
    console.error("Error setting font size", error);
  }
  setCharacters(textNode, text);

  // Set text color
  const paintStyle = {
    type: "SOLID",
    color: {
      r: parseFloat(fontColor.r) || 0,
      g: parseFloat(fontColor.g) || 0,
      b: parseFloat(fontColor.b) || 0,
    },
    opacity: fontColor.a !== undefined ? parseFloat(fontColor.a) : 1,
  };
  textNode.fills = [paintStyle];

  // If parentId is provided, append to that node, otherwise append to current page
  if (parentId) {
    const parentNode = await figma.getNodeByIdAsync(parentId);
    if (!parentNode) {
      throw new Error(`Parent node not found with ID: ${parentId}`);
    }
    if (!("appendChild" in parentNode)) {
      throw new Error(`Parent node does not support children: ${parentId}`);
    }
    parentNode.appendChild(textNode);
  } else {
    figma.currentPage.appendChild(textNode);
  }

  return {
    id: textNode.id,
    name: textNode.name,
    x: textNode.x,
    y: textNode.y,
    width: textNode.width,
    height: textNode.height,
    characters: textNode.characters,
    fontSize: textNode.fontSize,
    fontWeight: fontWeight,
    fontColor: fontColor,
    fontName: textNode.fontName,
    fills: textNode.fills,
    parentId: textNode.parent ? textNode.parent.id : undefined,
  };
}

async function setFillColor(params) {
  console.log("setFillColor", params);
  const {
    nodeId,
    color: { r, g, b, a },
  } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("fills" in node)) {
    throw new Error(`Node does not support fills: ${nodeId}`);
  }

  // Create RGBA color
  const rgbColor = {
    r: parseFloat(r) || 0,
    g: parseFloat(g) || 0,
    b: parseFloat(b) || 0,
    a: a !== undefined ? parseFloat(a) : 1,
  };

  // Set fill
  const paintStyle = {
    type: "SOLID",
    color: {
      r: parseFloat(rgbColor.r),
      g: parseFloat(rgbColor.g),
      b: parseFloat(rgbColor.b),
    },
    opacity: parseFloat(rgbColor.a),
  };

  console.log("paintStyle", paintStyle);

  node.fills = [paintStyle];

  return {
    id: node.id,
    name: node.name,
    fills: [paintStyle],
  };
}

async function setStrokeColor(params) {
  const {
    nodeId,
    color: { r, g, b, a },
    weight = 1,
  } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("strokes" in node)) {
    throw new Error(`Node does not support strokes: ${nodeId}`);
  }

  // Create RGBA color
  const rgbColor = {
    r: r !== undefined ? r : 0,
    g: g !== undefined ? g : 0,
    b: b !== undefined ? b : 0,
    a: a !== undefined ? a : 1,
  };

  // Set stroke
  const paintStyle = {
    type: "SOLID",
    color: {
      r: rgbColor.r,
      g: rgbColor.g,
      b: rgbColor.b,
    },
    opacity: rgbColor.a,
  };

  node.strokes = [paintStyle];

  // Set stroke weight if available
  if ("strokeWeight" in node) {
    node.strokeWeight = weight;
  }

  return {
    id: node.id,
    name: node.name,
    strokes: node.strokes,
    strokeWeight: "strokeWeight" in node ? node.strokeWeight : undefined,
  };
}

async function moveNode(params) {
  const { nodeId, x, y } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  if (x === undefined || y === undefined) {
    throw new Error("Missing x or y parameters");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("x" in node) || !("y" in node)) {
    throw new Error(`Node does not support position: ${nodeId}`);
  }

  node.x = x;
  node.y = y;

  return {
    id: node.id,
    name: node.name,
    x: node.x,
    y: node.y,
  };
}

async function resizeNode(params) {
  const { nodeId, width, height } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  if (width === undefined || height === undefined) {
    throw new Error("Missing width or height parameters");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("resize" in node)) {
    throw new Error(`Node does not support resizing: ${nodeId}`);
  }

  node.resize(width, height);

  return {
    id: node.id,
    name: node.name,
    width: node.width,
    height: node.height,
  };
}

async function deleteNode(params) {
  const { nodeId } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  // Save node info before deleting
  const nodeInfo = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  node.remove();

  return nodeInfo;
}

async function getStyles() {
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

async function getLocalVariables() {
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

async function getLocalComponents() {
  await figma.loadAllPagesAsync();

  const components = figma.root.findAllWithCriteria({
    types: ["COMPONENT"],
  });

  return {
    count: components.length,
    components: components.map((component) => ({
      id: component.id,
      name: component.name,
      key: "key" in component ? component.key : null,
    })),
  };
}

// async function getTeamComponents() {
//   try {
//     const teamComponents =
//       await figma.teamLibrary.getAvailableComponentsAsync();

//     return {
//       count: teamComponents.length,
//       components: teamComponents.map((component) => ({
//         key: component.key,
//         name: component.name,
//         description: component.description,
//         libraryName: component.libraryName,
//       })),
//     };
//   } catch (error) {
//     throw new Error(`Error getting team components: ${error.message}`);
//   }
// }

async function createComponent(params) {
  const { x = 0, y = 0, width = 100, height = 100, name = "Component", parentId } = params || {};

  const component = figma.createComponent();
  component.x = x;
  component.y = y;
  component.resize(width, height);
  component.name = name;

  if (parentId) {
    const parentNode = await figma.getNodeByIdAsync(parentId);
    if (!parentNode) {
      throw new Error("Parent node not found: " + parentId);
    }
    if (!("appendChild" in parentNode)) {
      throw new Error("Parent node does not support children: " + parentId);
    }
    parentNode.appendChild(component);
  } else {
    figma.currentPage.appendChild(component);
  }

  return {
    id: component.id,
    name: component.name,
    type: component.type,
    x: component.x,
    y: component.y,
    width: component.width,
    height: component.height,
  };
}

async function combineAsVariants(params) {
  const { componentIds, parentId } = params || {};

  if (!componentIds || !Array.isArray(componentIds) || componentIds.length === 0) {
    throw new Error("Missing or empty componentIds array");
  }

  const components = [];
  for (let i = 0; i < componentIds.length; i++) {
    const node = await figma.getNodeByIdAsync(componentIds[i]);
    if (!node) {
      throw new Error("Component not found: " + componentIds[i]);
    }
    if (node.type !== "COMPONENT") {
      throw new Error("Node is not a COMPONENT: " + componentIds[i]);
    }
    components.push(node);
  }

  let parent = figma.currentPage;
  if (parentId) {
    const parentNode = await figma.getNodeByIdAsync(parentId);
    if (!parentNode) {
      throw new Error("Parent node not found: " + parentId);
    }
    parent = parentNode;
  }

  const componentSet = figma.combineAsVariants(components, parent);

  return {
    id: componentSet.id,
    name: componentSet.name,
    type: componentSet.type,
    childCount: componentSet.children.length,
    children: componentSet.children.map((child) => ({ id: child.id, name: child.name, type: child.type })),
  };
}

async function createComponentInstance(params) {
  const { componentKey, componentId, x = 0, y = 0, parentId } = params || {};

  if (!componentKey && !componentId) {
    throw new Error("Missing componentKey or componentId parameter");
  }

  try {
    let component;
    if (componentId) {
      const node = await figma.getNodeByIdAsync(componentId);
      if (!node) {
        throw new Error("Component node not found: " + componentId);
      }
      if (node.type !== "COMPONENT") {
        throw new Error("Node is not a COMPONENT: " + componentId + " (type: " + node.type + ")");
      }
      component = node;
    } else {
      component = await figma.importComponentByKeyAsync(componentKey);
    }

    const instance = component.createInstance();
    instance.x = x;
    instance.y = y;

    if (parentId) {
      const parentNode = await figma.getNodeByIdAsync(parentId);
      if (!parentNode) {
        throw new Error("Parent node not found: " + parentId);
      }
      if (!("appendChild" in parentNode)) {
        throw new Error("Parent node does not support children: " + parentId);
      }
      parentNode.appendChild(instance);
    }

    return {
      id: instance.id,
      name: instance.name,
      x: instance.x,
      y: instance.y,
      width: instance.width,
      height: instance.height,
      componentId: instance.componentId,
    };
  } catch (error) {
    throw new Error("Error creating component instance: " + error.message);
  }
}

async function importLibraryComponent(params) {
  const componentKey = params && params.componentKey;
  const parentNodeId = params && params.parentNodeId;
  const position = params && params.position;
  const nameOverride = params && params.name;

  if (!componentKey) {
    throw new Error("Missing componentKey parameter");
  }

  let imported;
  try {
    imported = await figma.importComponentByKeyAsync(componentKey);
  } catch (e) {
    throw new Error(
      "Failed to import component with key " +
        componentKey +
        ": " +
        (e && e.message ? e.message : String(e)) +
        ". This may be a component set key — use get_component_variants to find individual variant keys, then import those instead.",
    );
  }

  if (imported.type !== "COMPONENT") {
    throw new Error(
      "Imported node is type " +
        imported.type +
        ", not COMPONENT. " +
        "You likely used a component set key. Use get_component_variants to find individual variant keys, then import a specific variant.",
    );
  }

  const instance = imported.createInstance();

  if (position) {
    instance.x = position.x;
    instance.y = position.y;
  }

  if (parentNodeId) {
    const parent = await figma.getNodeByIdAsync(parentNodeId);
    if (parent && "appendChild" in parent) {
      parent.appendChild(instance);
    }
  }

  if (nameOverride) {
    instance.name = nameOverride;
  }

  figma.currentPage.selection = [instance];
  figma.viewport.scrollAndZoomIntoView([instance]);

  return {
    instanceId: instance.id,
    instanceName: instance.name,
    componentName: imported.name,
    width: instance.width,
    height: instance.height,
    variantProperties: instance.variantProperties || {},
  };
}

async function exportNodeAsImage(params) {
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

    // Proper way to convert Uint8Array to base64
    const base64 = customBase64Encode(bytes);
    // const imageData = `data:${mimeType};base64,${base64}`;

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
function customBase64Encode(bytes) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let base64 = "";

  const byteLength = bytes.byteLength;
  const byteRemainder = byteLength % 3;
  const mainLength = byteLength - byteRemainder;

  let a, b, c, d;
  let chunk;

  // Main loop deals with bytes in chunks of 3
  for (let i = 0; i < mainLength; i = i + 3) {
    // Combine the three bytes into a single integer
    chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];

    // Use bitmasks to extract 6-bit segments from the triplet
    a = (chunk & 16515072) >> 18; // 16515072 = (2^6 - 1) << 18
    b = (chunk & 258048) >> 12; // 258048 = (2^6 - 1) << 12
    c = (chunk & 4032) >> 6; // 4032 = (2^6 - 1) << 6
    d = chunk & 63; // 63 = 2^6 - 1

    // Convert the raw binary segments to the appropriate ASCII encoding
    base64 += chars[a] + chars[b] + chars[c] + chars[d];
  }

  // Deal with the remaining bytes and padding
  if (byteRemainder === 1) {
    chunk = bytes[mainLength];

    a = (chunk & 252) >> 2; // 252 = (2^6 - 1) << 2

    // Set the 4 least significant bits to zero
    b = (chunk & 3) << 4; // 3 = 2^2 - 1

    base64 += chars[a] + chars[b] + "==";
  } else if (byteRemainder === 2) {
    chunk = (bytes[mainLength] << 8) | bytes[mainLength + 1];

    a = (chunk & 64512) >> 10; // 64512 = (2^6 - 1) << 10
    b = (chunk & 1008) >> 4; // 1008 = (2^6 - 1) << 4

    // Set the 2 least significant bits to zero
    c = (chunk & 15) << 2; // 15 = 2^4 - 1

    base64 += chars[a] + chars[b] + chars[c] + "=";
  }

  return base64;
}

async function setCornerRadius(params) {
  const { nodeId, radius, corners } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  if (radius === undefined) {
    throw new Error("Missing radius parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  // Check if node supports corner radius
  if (!("cornerRadius" in node)) {
    throw new Error(`Node does not support corner radius: ${nodeId}`);
  }

  var numRadius = toNumber(radius, 0);

  // If corners array is provided, set individual corner radii
  if (corners && Array.isArray(corners) && corners.length === 4) {
    if ("topLeftRadius" in node) {
      // Node supports individual corner radii
      if (corners[0]) node.topLeftRadius = numRadius;
      if (corners[1]) node.topRightRadius = numRadius;
      if (corners[2]) node.bottomRightRadius = numRadius;
      if (corners[3]) node.bottomLeftRadius = numRadius;
    } else {
      // Node only supports uniform corner radius
      node.cornerRadius = numRadius;
    }
  } else {
    // Set uniform corner radius
    node.cornerRadius = numRadius;
  }

  return {
    id: node.id,
    name: node.name,
    cornerRadius: "cornerRadius" in node ? node.cornerRadius : undefined,
    topLeftRadius: "topLeftRadius" in node ? node.topLeftRadius : undefined,
    topRightRadius: "topRightRadius" in node ? node.topRightRadius : undefined,
    bottomRightRadius: "bottomRightRadius" in node ? node.bottomRightRadius : undefined,
    bottomLeftRadius: "bottomLeftRadius" in node ? node.bottomLeftRadius : undefined,
  };
}

async function renameNode(params) {
  const { nodeId, name } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }
  if (name === undefined) {
    throw new Error("Missing name parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error("Node not found: " + nodeId);
  }

  const oldName = node.name;
  node.name = name;

  return {
    id: node.id,
    oldName: oldName,
    newName: node.name,
    type: node.type,
  };
}

async function swapComponentVariant(params) {
  const { instanceId, newVariantId } = params || {};

  if (!instanceId) {
    throw new Error("Missing instanceId parameter");
  }
  if (!newVariantId) {
    throw new Error("Missing newVariantId parameter");
  }

  const instance = await figma.getNodeByIdAsync(instanceId);
  if (!instance) {
    throw new Error("Instance node not found: " + instanceId);
  }
  if (instance.type !== "INSTANCE") {
    throw new Error("Node is not an instance: " + instanceId);
  }

  const newVariant = await figma.getNodeByIdAsync(newVariantId);
  if (!newVariant) {
    throw new Error("Variant component not found: " + newVariantId);
  }
  if (newVariant.type !== "COMPONENT") {
    throw new Error("Target node is not a COMPONENT: " + newVariantId);
  }

  instance.swapComponent(newVariant);

  return {
    success: true,
    instanceId: instance.id,
    instanceName: instance.name,
    newVariantId: newVariant.id,
    newVariantName: newVariant.name,
  };
}

function findNodeByIdInTree(nodeId) {
  let found = null;
  function walk(node) {
    if (found) return;
    if (node.id === nodeId) {
      found = node;
      return;
    }
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        walk(node.children[i]);
      }
    }
  }
  walk(figma.currentPage);
  return found;
}

async function setTextContent(params) {
  const { nodeId, text } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  if (text === undefined) {
    throw new Error("Missing text parameter");
  }

  let node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    node = findNodeByIdInTree(nodeId);
  }
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (node.type !== "TEXT") {
    throw new Error(`Node is not a text node: ${nodeId}`);
  }

  try {
    await setCharacters(node, text);

    return {
      id: node.id,
      name: node.name,
      characters: node.characters,
      fontName: node.fontName,
    };
  } catch (error) {
    throw new Error(`Error setting text content: ${error.message}`);
  }
}

// Initialize settings on load
(async function initializePlugin() {
  try {
    const savedSettings = await figma.clientStorage.getAsync("settings");
    if (savedSettings) {
      if (savedSettings.serverPort) {
        state.serverPort = savedSettings.serverPort;
      }
    }

    // Send initial settings to UI
    figma.ui.postMessage({
      type: "init-settings",
      settings: {
        serverPort: state.serverPort,
      },
    });
  } catch (error) {
    console.error("Error loading settings:", error);
  }
})();

function uniqBy(arr, predicate) {
  const cb = typeof predicate === "function" ? predicate : (o) => o[predicate];
  return [
    ...arr
      .reduce((map, item) => {
        const key = item === null || item === undefined ? item : cb(item);

        map.has(key) || map.set(key, item);

        return map;
      }, new Map())
      .values(),
  ];
}
const setCharacters = async (node, characters, options) => {
  const fallbackFont = (options && options.fallbackFont) || {
    family: "Inter",
    style: "Regular",
  };
  try {
    if (node.fontName === figma.mixed) {
      if (options && options.smartStrategy === "prevail") {
        const fontHashTree = {};
        for (let i = 1; i < node.characters.length; i++) {
          const charFont = node.getRangeFontName(i - 1, i);
          const key = `${charFont.family}::${charFont.style}`;
          fontHashTree[key] = fontHashTree[key] ? fontHashTree[key] + 1 : 1;
        }
        const prevailedTreeItem = Object.entries(fontHashTree).sort((a, b) => b[1] - a[1])[0];
        const [family, style] = prevailedTreeItem[0].split("::");
        const prevailedFont = {
          family,
          style,
        };
        await figma.loadFontAsync(prevailedFont);
        node.fontName = prevailedFont;
      } else if (options && options.smartStrategy === "strict") {
        return setCharactersWithStrictMatchFont(node, characters, fallbackFont);
      } else if (options && options.smartStrategy === "experimental") {
        return setCharactersWithSmartMatchFont(node, characters, fallbackFont);
      } else {
        const firstCharFont = node.getRangeFontName(0, 1);
        await figma.loadFontAsync(firstCharFont);
        node.fontName = firstCharFont;
      }
    } else {
      await figma.loadFontAsync({
        family: node.fontName.family,
        style: node.fontName.style,
      });
    }
  } catch (err) {
    console.warn(
      `Failed to load "${node.fontName["family"]} ${node.fontName["style"]}" font and replaced with fallback "${fallbackFont.family} ${fallbackFont.style}"`,
      err,
    );
    await figma.loadFontAsync(fallbackFont);
    node.fontName = fallbackFont;
  }
  try {
    node.characters = characters;
    return true;
  } catch (err) {
    console.warn(`Failed to set characters. Skipped.`, err);
    return false;
  }
};

const setCharactersWithStrictMatchFont = async (node, characters, fallbackFont) => {
  const fontHashTree = {};
  for (let i = 1; i < node.characters.length; i++) {
    const startIdx = i - 1;
    const startCharFont = node.getRangeFontName(startIdx, i);
    const startCharFontVal = `${startCharFont.family}::${startCharFont.style}`;
    while (i < node.characters.length) {
      i++;
      const charFont = node.getRangeFontName(i - 1, i);
      if (startCharFontVal !== `${charFont.family}::${charFont.style}`) {
        break;
      }
    }
    fontHashTree[`${startIdx}_${i}`] = startCharFontVal;
  }
  await figma.loadFontAsync(fallbackFont);
  node.fontName = fallbackFont;
  node.characters = characters;
  console.log(fontHashTree);
  await Promise.all(
    Object.keys(fontHashTree).map(async (range) => {
      console.log(range, fontHashTree[range]);
      const [start, end] = range.split("_");
      const [family, style] = fontHashTree[range].split("::");
      const matchedFont = {
        family,
        style,
      };
      await figma.loadFontAsync(matchedFont);
      return node.setRangeFontName(Number(start), Number(end), matchedFont);
    }),
  );
  return true;
};

const getDelimiterPos = (str, delimiter, startIdx = 0, endIdx = str.length) => {
  const indices = [];
  let temp = startIdx;
  for (let i = startIdx; i < endIdx; i++) {
    if (str[i] === delimiter && i + startIdx !== endIdx && temp !== i + startIdx) {
      indices.push([temp, i + startIdx]);
      temp = i + startIdx + 1;
    }
  }
  temp !== endIdx && indices.push([temp, endIdx]);
  return indices.filter(Boolean);
};

const buildLinearOrder = (node) => {
  const fontTree = [];
  const newLinesPos = getDelimiterPos(node.characters, "\n");
  newLinesPos.forEach(([newLinesRangeStart, newLinesRangeEnd], n) => {
    const newLinesRangeFont = node.getRangeFontName(newLinesRangeStart, newLinesRangeEnd);
    if (newLinesRangeFont === figma.mixed) {
      const spacesPos = getDelimiterPos(node.characters, " ", newLinesRangeStart, newLinesRangeEnd);
      spacesPos.forEach(([spacesRangeStart, spacesRangeEnd], s) => {
        const spacesRangeFont = node.getRangeFontName(spacesRangeStart, spacesRangeEnd);
        if (spacesRangeFont === figma.mixed) {
          const spacesRangeFont = node.getRangeFontName(spacesRangeStart, spacesRangeStart[0]);
          fontTree.push({
            start: spacesRangeStart,
            delimiter: " ",
            family: spacesRangeFont.family,
            style: spacesRangeFont.style,
          });
        } else {
          fontTree.push({
            start: spacesRangeStart,
            delimiter: " ",
            family: spacesRangeFont.family,
            style: spacesRangeFont.style,
          });
        }
      });
    } else {
      fontTree.push({
        start: newLinesRangeStart,
        delimiter: "\n",
        family: newLinesRangeFont.family,
        style: newLinesRangeFont.style,
      });
    }
  });
  return fontTree
    .sort((a, b) => +a.start - +b.start)
    .map(({ family, style, delimiter }) => ({ family, style, delimiter }));
};

const setCharactersWithSmartMatchFont = async (node, characters, fallbackFont) => {
  const rangeTree = buildLinearOrder(node);
  const fontsToLoad = uniqBy(rangeTree, ({ family, style }) => `${family}::${style}`).map(({ family, style }) => ({
    family,
    style,
  }));

  await Promise.all([...fontsToLoad, fallbackFont].map(figma.loadFontAsync));

  node.fontName = fallbackFont;
  node.characters = characters;

  let prevPos = 0;
  rangeTree.forEach(({ family, style, delimiter }) => {
    if (prevPos < node.characters.length) {
      const delimeterPos = node.characters.indexOf(delimiter, prevPos);
      const endPos = delimeterPos > prevPos ? delimeterPos : node.characters.length;
      const matchedFont = {
        family,
        style,
      };
      node.setRangeFontName(prevPos, endPos, matchedFont);
      prevPos = endPos + 1;
    }
  });
  return true;
};

// Add the cloneNode function implementation
async function cloneNode(params) {
  const { nodeId, x, y } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  // Clone the node
  const clone = node.clone();

  // If x and y are provided, move the clone to that position
  if (x !== undefined && y !== undefined) {
    if (!("x" in clone) || !("y" in clone)) {
      throw new Error(`Cloned node does not support position: ${nodeId}`);
    }
    clone.x = x;
    clone.y = y;
  }

  // Add the clone to the same parent as the original node
  if (node.parent) {
    node.parent.appendChild(clone);
  } else {
    figma.currentPage.appendChild(clone);
  }

  return {
    id: clone.id,
    name: clone.name,
    x: "x" in clone ? clone.x : undefined,
    y: "y" in clone ? clone.y : undefined,
    width: "width" in clone ? clone.width : undefined,
    height: "height" in clone ? clone.height : undefined,
  };
}

async function scanTextNodes(params) {
  console.log(`Starting to scan text nodes from node ID: ${params.nodeId}`);
  const { nodeId, useChunking = true, chunkSize = 10, commandId = generateCommandId() } = params || {};

  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    console.error(`Node with ID ${nodeId} not found`);
    // Send error progress update
    sendProgressUpdate(commandId, "scan_text_nodes", "error", 0, 0, 0, `Node with ID ${nodeId} not found`, {
      error: `Node not found: ${nodeId}`,
    });
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // If chunking is not enabled, use the original implementation
  if (!useChunking) {
    const textNodes = [];
    try {
      // Send started progress update
      sendProgressUpdate(
        commandId,
        "scan_text_nodes",
        "started",
        0,
        1, // Not known yet how many nodes there are
        0,
        `Starting scan of node "${node.name || nodeId}" without chunking`,
        null,
      );

      await findTextNodes(node, [], 0, textNodes);

      // Send completed progress update
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

      // Send error progress update
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

  // First, collect all nodes to process (without processing them yet)
  const nodesToProcess = [];

  // Send started progress update
  sendProgressUpdate(
    commandId,
    "scan_text_nodes",
    "started",
    0,
    0, // Not known yet how many nodes there are
    0,
    `Starting chunked scan of node "${node.name || nodeId}"`,
    { chunkSize },
  );

  await collectNodesToProcess(node, [], 0, nodesToProcess);

  const totalNodes = nodesToProcess.length;
  console.log(`Found ${totalNodes} total nodes to process`);

  // Calculate number of chunks needed
  const totalChunks = Math.ceil(totalNodes / chunkSize);
  console.log(`Will process in ${totalChunks} chunks`);

  // Send update after node collection
  sendProgressUpdate(
    commandId,
    "scan_text_nodes",
    "in_progress",
    5, // 5% progress for collection phase
    totalNodes,
    0,
    `Found ${totalNodes} nodes to scan. Will process in ${totalChunks} chunks.`,
    {
      totalNodes,
      totalChunks,
      chunkSize,
    },
  );

  // Process nodes in chunks
  const allTextNodes = [];
  let processedNodes = 0;
  let chunksProcessed = 0;

  for (let i = 0; i < totalNodes; i += chunkSize) {
    const chunkEnd = Math.min(i + chunkSize, totalNodes);
    console.log(`Processing chunk ${chunksProcessed + 1}/${totalChunks} (nodes ${i} to ${chunkEnd - 1})`);

    // Send update before processing chunk
    sendProgressUpdate(
      commandId,
      "scan_text_nodes",
      "in_progress",
      Math.round(5 + (chunksProcessed / totalChunks) * 90), // 5-95% for processing
      totalNodes,
      processedNodes,
      `Processing chunk ${chunksProcessed + 1}/${totalChunks}`,
      {
        currentChunk: chunksProcessed + 1,
        totalChunks,
        textNodesFound: allTextNodes.length,
      },
    );

    const chunkNodes = nodesToProcess.slice(i, chunkEnd);
    const chunkTextNodes = [];

    // Process each node in this chunk
    for (const nodeInfo of chunkNodes) {
      if (nodeInfo.node.type === "TEXT") {
        try {
          const textNodeInfo = await processTextNode(nodeInfo.node, nodeInfo.parentPath, nodeInfo.depth);
          if (textNodeInfo) {
            chunkTextNodes.push(textNodeInfo);
          }
        } catch (error) {
          console.error(`Error processing text node: ${error.message}`);
          // Continue with other nodes
        }
      }

      // Brief delay to allow UI updates and prevent freezing
      await delay(5);
    }

    // Add results from this chunk
    allTextNodes.push(...chunkTextNodes);
    processedNodes += chunkNodes.length;
    chunksProcessed++;

    // Send update after processing chunk
    sendProgressUpdate(
      commandId,
      "scan_text_nodes",
      "in_progress",
      Math.round(5 + (chunksProcessed / totalChunks) * 90), // 5-95% for processing
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

    // Small delay between chunks to prevent UI freezing
    if (i + chunkSize < totalNodes) {
      await delay(50);
    }
  }

  // Send completed progress update
  sendProgressUpdate(
    commandId,
    "scan_text_nodes",
    "completed",
    100,
    totalNodes,
    processedNodes,
    `Scan complete. Found ${allTextNodes.length} text nodes.`,
    {
      textNodes: allTextNodes,
      processedNodes,
      chunks: chunksProcessed,
    },
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

// Helper function to collect all nodes that need to be processed
async function collectNodesToProcess(node, parentPath = [], depth = 0, nodesToProcess = []) {
  // Skip invisible nodes
  if (node.visible === false) return;

  // Get the path to this node
  const nodePath = [...parentPath, node.name || `Unnamed ${node.type}`];

  // Add this node to the processing list
  nodesToProcess.push({
    node: node,
    parentPath: nodePath,
    depth: depth,
  });

  // Recursively add children
  if ("children" in node) {
    for (const child of node.children) {
      await collectNodesToProcess(child, nodePath, depth + 1, nodesToProcess);
    }
  }
}

// Process a single text node
async function processTextNode(node, parentPath, depth) {
  if (node.type !== "TEXT") return null;

  try {
    // Safely extract font information
    let fontFamily = "";
    let fontStyle = "";

    if (node.fontName) {
      if (typeof node.fontName === "object") {
        if ("family" in node.fontName) fontFamily = node.fontName.family;
        if ("style" in node.fontName) fontStyle = node.fontName.style;
      }
    }

    // Get applied text style name if present
    let styleName = null;
    if (node.textStyleId && typeof node.textStyleId === "string") {
      try {
        const style = figma.getStyleById(node.textStyleId);
        if (style) {
          styleName = style.name;
        }
      } catch (styleErr) {
        // style not found
      }
    }

    // Get fill color variable binding if present (stored on the paint object)
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
    } catch (varErr) {
      // variable lookup failed
    }

    // Create a safe representation of the text node
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

// A delay function that returns a promise
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Keep the original findTextNodes for backward compatibility
async function findTextNodes(node, parentPath = [], depth = 0, textNodes = []) {
  // Skip invisible nodes
  if (node.visible === false) return;

  // Get the path to this node including its name
  const nodePath = [...parentPath, node.name || `Unnamed ${node.type}`];

  if (node.type === "TEXT") {
    try {
      // Safely extract font information to avoid Symbol serialization issues
      let fontFamily = "";
      let fontStyle = "";

      if (node.fontName) {
        if (typeof node.fontName === "object") {
          if ("family" in node.fontName) fontFamily = node.fontName.family;
          if ("style" in node.fontName) fontStyle = node.fontName.style;
        }
      }

      // Create a safe representation of the text node with only serializable properties
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
      // Skip this node but continue with others
    }
  }

  // Recursively process children of container nodes
  if ("children" in node) {
    for (const child of node.children) {
      await findTextNodes(child, nodePath, depth + 1, textNodes);
    }
  }
}

// Replace text in a specific node
async function setMultipleTextContents(params) {
  const { nodeId, text } = params || {};
  const commandId = params.commandId || generateCommandId();

  if (!nodeId || !text || !Array.isArray(text)) {
    const errorMsg = "Missing required parameters: nodeId and text array";

    // Send error progress update
    sendProgressUpdate(commandId, "set_multiple_text_contents", "error", 0, 0, 0, errorMsg, { error: errorMsg });

    throw new Error(errorMsg);
  }

  console.log(`Starting text replacement for node: ${nodeId} with ${text.length} text replacements`);

  // Send started progress update
  sendProgressUpdate(
    commandId,
    "set_multiple_text_contents",
    "started",
    0,
    text.length,
    0,
    `Starting text replacement for ${text.length} nodes`,
    { totalReplacements: text.length },
  );

  // Define the results array and counters
  const results = [];
  let successCount = 0;
  let failureCount = 0;

  // Split text replacements into chunks of 5
  const CHUNK_SIZE = 5;
  const chunks = [];

  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
  }

  console.log(`Split ${text.length} replacements into ${chunks.length} chunks`);

  // Send chunking info update
  sendProgressUpdate(
    commandId,
    "set_multiple_text_contents",
    "in_progress",
    5, // 5% progress for planning phase
    text.length,
    0,
    `Preparing to replace text in ${text.length} nodes using ${chunks.length} chunks`,
    {
      totalReplacements: text.length,
      chunks: chunks.length,
      chunkSize: CHUNK_SIZE,
    },
  );

  // Process each chunk sequentially
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    console.log(`Processing chunk ${chunkIndex + 1}/${chunks.length} with ${chunk.length} replacements`);

    // Send chunk processing start update
    sendProgressUpdate(
      commandId,
      "set_multiple_text_contents",
      "in_progress",
      Math.round(5 + (chunkIndex / chunks.length) * 90), // 5-95% for processing
      text.length,
      successCount + failureCount,
      `Processing text replacements chunk ${chunkIndex + 1}/${chunks.length}`,
      {
        currentChunk: chunkIndex + 1,
        totalChunks: chunks.length,
        successCount,
        failureCount,
      },
    );

    // Process replacements within a chunk in parallel
    const chunkPromises = chunk.map(async (replacement) => {
      if (!replacement.nodeId || replacement.text === undefined) {
        console.error(`Missing nodeId or text for replacement`);
        return {
          success: false,
          nodeId: replacement.nodeId || "unknown",
          error: "Missing nodeId or text in replacement entry",
        };
      }

      try {
        console.log(`Attempting to replace text in node: ${replacement.nodeId}`);

        // Get the text node to update (just to check it exists and get original text)
        const textNode = await figma.getNodeByIdAsync(replacement.nodeId);

        if (!textNode) {
          console.error(`Text node not found: ${replacement.nodeId}`);
          return {
            success: false,
            nodeId: replacement.nodeId,
            error: `Node not found: ${replacement.nodeId}`,
          };
        }

        if (textNode.type !== "TEXT") {
          console.error(`Node is not a text node: ${replacement.nodeId} (type: ${textNode.type})`);
          return {
            success: false,
            nodeId: replacement.nodeId,
            error: `Node is not a text node: ${replacement.nodeId} (type: ${textNode.type})`,
          };
        }

        // Save original text for the result
        const originalText = textNode.characters;
        console.log(`Original text: "${originalText}"`);
        console.log(`Will translate to: "${replacement.text}"`);

        // Highlight the node before changing text
        let originalFills;
        try {
          // Save original fills for restoration later
          originalFills = JSON.parse(JSON.stringify(textNode.fills));
          // Apply highlight color (orange with 30% opacity)
          textNode.fills = [
            {
              type: "SOLID",
              color: { r: 1, g: 0.5, b: 0 },
              opacity: 0.3,
            },
          ];
        } catch (highlightErr) {
          console.error(`Error highlighting text node: ${highlightErr.message}`);
          // Continue anyway, highlighting is just visual feedback
        }

        // Use the existing setTextContent function to handle font loading and text setting
        await setTextContent({
          nodeId: replacement.nodeId,
          text: replacement.text,
        });

        // Keep highlight for a moment after text change, then restore original fills
        if (originalFills) {
          try {
            // Use delay function for consistent timing
            await delay(500);
            textNode.fills = originalFills;
          } catch (restoreErr) {
            console.error(`Error restoring fills: ${restoreErr.message}`);
          }
        }

        console.log(`Successfully replaced text in node: ${replacement.nodeId}`);
        return {
          success: true,
          nodeId: replacement.nodeId,
          originalText: originalText,
          translatedText: replacement.text,
        };
      } catch (error) {
        console.error(`Error replacing text in node ${replacement.nodeId}: ${error.message}`);
        return {
          success: false,
          nodeId: replacement.nodeId,
          error: `Error applying replacement: ${error.message}`,
        };
      }
    });

    // Wait for all replacements in this chunk to complete
    const chunkResults = await Promise.all(chunkPromises);

    // Process results for this chunk
    chunkResults.forEach((result) => {
      if (result.success) {
        successCount++;
      } else {
        failureCount++;
      }
      results.push(result);
    });

    // Send chunk processing complete update with partial results
    sendProgressUpdate(
      commandId,
      "set_multiple_text_contents",
      "in_progress",
      Math.round(5 + ((chunkIndex + 1) / chunks.length) * 90), // 5-95% for processing
      text.length,
      successCount + failureCount,
      `Completed chunk ${chunkIndex + 1}/${chunks.length}. ${successCount} successful, ${failureCount} failed so far.`,
      {
        currentChunk: chunkIndex + 1,
        totalChunks: chunks.length,
        successCount,
        failureCount,
        chunkResults: chunkResults,
      },
    );

    // Add a small delay between chunks to avoid overloading Figma
    if (chunkIndex < chunks.length - 1) {
      console.log("Pausing between chunks to avoid overloading Figma...");
      await delay(1000); // 1 second delay between chunks
    }
  }

  console.log(`Replacement complete: ${successCount} successful, ${failureCount} failed`);

  // Send completed progress update
  sendProgressUpdate(
    commandId,
    "set_multiple_text_contents",
    "completed",
    100,
    text.length,
    successCount + failureCount,
    `Text replacement complete: ${successCount} successful, ${failureCount} failed`,
    {
      totalReplacements: text.length,
      replacementsApplied: successCount,
      replacementsFailed: failureCount,
      completedInChunks: chunks.length,
      results: results,
    },
  );

  return {
    success: successCount > 0,
    nodeId: nodeId,
    replacementsApplied: successCount,
    replacementsFailed: failureCount,
    totalReplacements: text.length,
    results: results,
    completedInChunks: chunks.length,
    commandId,
  };
}

// Function to generate simple UUIDs for command IDs
function generateCommandId() {
  return "cmd_" + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

async function getAnnotations(params) {
  try {
    const { nodeId, includeCategories = true } = params;

    // Get categories first if needed
    let categoriesMap = {};
    if (includeCategories) {
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

    if (nodeId) {
      // Get annotations for a specific node
      const node = await figma.getNodeByIdAsync(nodeId);
      if (!node) {
        throw new Error(`Node not found: ${nodeId}`);
      }

      if (!("annotations" in node)) {
        throw new Error(`Node type ${node.type} does not support annotations`);
      }

      // Collect annotations from this node and all its descendants
      const mergedAnnotations = [];
      const collect = async (n) => {
        if ("annotations" in n && n.annotations && n.annotations.length > 0) {
          for (const a of n.annotations) {
            mergedAnnotations.push({ nodeId: n.id, annotation: a });
          }
        }
        if ("children" in n) {
          for (const child of n.children) {
            await collect(child);
          }
        }
      };
      await collect(node);

      const result = {
        nodeId: node.id,
        name: node.name,
        annotations: mergedAnnotations,
      };

      if (includeCategories) {
        result.categories = Object.values(categoriesMap);
      }

      return result;
    } else {
      // Get all annotations in the current page
      const annotations = [];
      const processNode = async (node) => {
        if ("annotations" in node && node.annotations && node.annotations.length > 0) {
          annotations.push({
            nodeId: node.id,
            name: node.name,
            annotations: node.annotations,
          });
        }
        if ("children" in node) {
          for (const child of node.children) {
            await processNode(child);
          }
        }
      };

      // Start from current page
      await processNode(figma.currentPage);

      const result = {
        annotatedNodes: annotations,
      };

      if (includeCategories) {
        result.categories = Object.values(categoriesMap);
      }

      return result;
    }
  } catch (error) {
    console.error("Error in getAnnotations:", error);
    throw error;
  }
}

async function setAnnotation(params) {
  try {
    console.log("=== setAnnotation Debug Start ===");
    console.log("Input params:", JSON.stringify(params, null, 2));

    const { nodeId, labelMarkdown, categoryId, properties } = params;

    // Validate required parameters
    if (!nodeId) {
      console.error("Validation failed: Missing nodeId");
      return { success: false, error: "Missing nodeId" };
    }

    if (!labelMarkdown) {
      console.error("Validation failed: Missing labelMarkdown");
      return { success: false, error: "Missing labelMarkdown" };
    }

    console.log("Attempting to get node:", nodeId);
    // Get and validate node
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

    // Validate node supports annotations
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

    // Create the annotation object
    const newAnnotation = {
      labelMarkdown,
    };

    // Validate and add categoryId if provided
    if (categoryId) {
      console.log("Adding categoryId to annotation:", categoryId);
      newAnnotation.categoryId = categoryId;
    }

    // Validate and add properties if provided
    if (properties && Array.isArray(properties) && properties.length > 0) {
      console.log("Adding properties to annotation:", JSON.stringify(properties, null, 2));
      newAnnotation.properties = properties;
    }

    // Log current annotations before update
    console.log("Current node annotations:", node.annotations);

    // Append annotation (preserve existing)
    console.log("Setting new annotation:", JSON.stringify(newAnnotation, null, 2));
    node.annotations = (node.annotations ? node.annotations.slice() : []).concat([newAnnotation]);

    // Verify the update
    console.log("Updated node annotations:", node.annotations);
    console.log("=== setAnnotation Debug End ===");

    return {
      success: true,
      nodeId: node.id,
      name: node.name,
      annotations: node.annotations,
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

/**
 * Scan for nodes with specific types within a node
 * @param {Object} params - Parameters object
 * @param {string} params.nodeId - ID of the node to scan within
 * @param {Array<string>} params.types - Array of node types to find (e.g. ['COMPONENT', 'FRAME'])
 * @returns {Object} - Object containing found nodes
 */
async function scanNodesByTypes(params) {
  console.log(`Starting to scan nodes by types from node ID: ${params.nodeId}`);
  const { nodeId, types = [] } = params || {};

  if (!types || types.length === 0) {
    throw new Error("No types specified to search for");
  }

  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Simple implementation without chunking
  const matchingNodes = [];

  // Send a single progress update to notify start
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

  // Recursively find nodes with specified types
  await findNodesByTypes(node, types, matchingNodes);

  // Send completion update
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

/**
 * Helper function to recursively find nodes with specific types
 * @param {SceneNode} node - The root node to start searching from
 * @param {Array<string>} types - Array of node types to find
 * @param {Array} matchingNodes - Array to store found nodes
 */
async function findNodesByTypes(node, types, matchingNodes = []) {
  // Skip invisible nodes
  if (node.visible === false) return;

  // Check if this node is one of the specified types
  if (types.includes(node.type)) {
    // Create a minimal representation with just ID, type and bbox
    matchingNodes.push({
      id: node.id,
      name: node.name || `Unnamed ${node.type}`,
      type: node.type,
      // Basic bounding box info
      bbox: {
        x: typeof node.x === "number" ? node.x : 0,
        y: typeof node.y === "number" ? node.y : 0,
        width: typeof node.width === "number" ? node.width : 0,
        height: typeof node.height === "number" ? node.height : 0,
      },
    });
  }

  // Recursively process children of container nodes
  if ("children" in node) {
    for (const child of node.children) {
      await findNodesByTypes(child, types, matchingNodes);
    }
  }
}

// Set multiple annotations with async progress updates
async function setMultipleAnnotations(params) {
  console.log("=== setMultipleAnnotations Debug Start ===");
  console.log("Input params:", JSON.stringify(params, null, 2));

  const { nodeId, annotations } = params;

  if (!annotations || annotations.length === 0) {
    console.error("Validation failed: No annotations provided");
    return { success: false, error: "No annotations provided" };
  }

  console.log(`Processing ${annotations.length} annotations for node ${nodeId}`);

  const results = [];
  let successCount = 0;
  let failureCount = 0;

  // Process annotations sequentially
  for (let i = 0; i < annotations.length; i++) {
    const annotation = annotations[i];
    console.log(`\nProcessing annotation ${i + 1}/${annotations.length}:`, JSON.stringify(annotation, null, 2));

    try {
      console.log("Calling setAnnotation with params:", {
        nodeId: annotation.nodeId,
        labelMarkdown: annotation.labelMarkdown,
        categoryId: annotation.categoryId,
        properties: annotation.properties,
      });

      const result = await setAnnotation({
        nodeId: annotation.nodeId,
        labelMarkdown: annotation.labelMarkdown,
        categoryId: annotation.categoryId,
        properties: annotation.properties,
      });

      console.log("setAnnotation result:", JSON.stringify(result, null, 2));

      if (result.success) {
        successCount++;
        results.push({ success: true, nodeId: annotation.nodeId });
        console.log(`✓ Annotation ${i + 1} applied successfully`);
      } else {
        failureCount++;
        results.push({
          success: false,
          nodeId: annotation.nodeId,
          error: result.error,
        });
        console.error(`✗ Annotation ${i + 1} failed:`, result.error);
      }
    } catch (error) {
      failureCount++;
      const errorResult = {
        success: false,
        nodeId: annotation.nodeId,
        error: error.message,
      };
      results.push(errorResult);
      console.error(`✗ Annotation ${i + 1} failed with error:`, error);
      console.error("Error details:", {
        message: error.message,
        stack: error.stack,
      });
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

async function deleteMultipleNodes(params) {
  const { nodeIds } = params || {};
  const commandId = generateCommandId();

  if (!nodeIds || !Array.isArray(nodeIds) || nodeIds.length === 0) {
    const errorMsg = "Missing or invalid nodeIds parameter";
    sendProgressUpdate(commandId, "delete_multiple_nodes", "error", 0, 0, 0, errorMsg, { error: errorMsg });
    throw new Error(errorMsg);
  }

  console.log(`Starting deletion of ${nodeIds.length} nodes`);

  // Send started progress update
  sendProgressUpdate(
    commandId,
    "delete_multiple_nodes",
    "started",
    0,
    nodeIds.length,
    0,
    `Starting deletion of ${nodeIds.length} nodes`,
    { totalNodes: nodeIds.length },
  );

  const results = [];
  let successCount = 0;
  let failureCount = 0;

  // Process nodes in chunks of 5 to avoid overwhelming Figma
  const CHUNK_SIZE = 5;
  const chunks = [];

  for (let i = 0; i < nodeIds.length; i += CHUNK_SIZE) {
    chunks.push(nodeIds.slice(i, i + CHUNK_SIZE));
  }

  console.log(`Split ${nodeIds.length} deletions into ${chunks.length} chunks`);

  // Send chunking info update
  sendProgressUpdate(
    commandId,
    "delete_multiple_nodes",
    "in_progress",
    5,
    nodeIds.length,
    0,
    `Preparing to delete ${nodeIds.length} nodes using ${chunks.length} chunks`,
    {
      totalNodes: nodeIds.length,
      chunks: chunks.length,
      chunkSize: CHUNK_SIZE,
    },
  );

  // Process each chunk sequentially
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    console.log(`Processing chunk ${chunkIndex + 1}/${chunks.length} with ${chunk.length} nodes`);

    // Send chunk processing start update
    sendProgressUpdate(
      commandId,
      "delete_multiple_nodes",
      "in_progress",
      Math.round(5 + (chunkIndex / chunks.length) * 90),
      nodeIds.length,
      successCount + failureCount,
      `Processing deletion chunk ${chunkIndex + 1}/${chunks.length}`,
      {
        currentChunk: chunkIndex + 1,
        totalChunks: chunks.length,
        successCount,
        failureCount,
      },
    );

    // Process deletions within a chunk in parallel
    const chunkPromises = chunk.map(async (nodeId) => {
      try {
        const node = await figma.getNodeByIdAsync(nodeId);

        if (!node) {
          console.error(`Node not found: ${nodeId}`);
          return {
            success: false,
            nodeId: nodeId,
            error: `Node not found: ${nodeId}`,
          };
        }

        // Save node info before deleting
        const nodeInfo = {
          id: node.id,
          name: node.name,
          type: node.type,
        };

        // Delete the node
        node.remove();

        console.log(`Successfully deleted node: ${nodeId}`);
        return {
          success: true,
          nodeId: nodeId,
          nodeInfo: nodeInfo,
        };
      } catch (error) {
        console.error(`Error deleting node ${nodeId}: ${error.message}`);
        return {
          success: false,
          nodeId: nodeId,
          error: error.message,
        };
      }
    });

    // Wait for all deletions in this chunk to complete
    const chunkResults = await Promise.all(chunkPromises);

    // Process results for this chunk
    chunkResults.forEach((result) => {
      if (result.success) {
        successCount++;
      } else {
        failureCount++;
      }
      results.push(result);
    });

    // Send chunk processing complete update
    sendProgressUpdate(
      commandId,
      "delete_multiple_nodes",
      "in_progress",
      Math.round(5 + ((chunkIndex + 1) / chunks.length) * 90),
      nodeIds.length,
      successCount + failureCount,
      `Completed chunk ${chunkIndex + 1}/${chunks.length}. ${successCount} successful, ${failureCount} failed so far.`,
      {
        currentChunk: chunkIndex + 1,
        totalChunks: chunks.length,
        successCount,
        failureCount,
        chunkResults: chunkResults,
      },
    );

    // Add a small delay between chunks
    if (chunkIndex < chunks.length - 1) {
      console.log("Pausing between chunks...");
      await delay(1000);
    }
  }

  console.log(`Deletion complete: ${successCount} successful, ${failureCount} failed`);

  // Send completed progress update
  sendProgressUpdate(
    commandId,
    "delete_multiple_nodes",
    "completed",
    100,
    nodeIds.length,
    successCount + failureCount,
    `Node deletion complete: ${successCount} successful, ${failureCount} failed`,
    {
      totalNodes: nodeIds.length,
      nodesDeleted: successCount,
      nodesFailed: failureCount,
      completedInChunks: chunks.length,
      results: results,
    },
  );

  return {
    success: successCount > 0,
    nodesDeleted: successCount,
    nodesFailed: failureCount,
    totalNodes: nodeIds.length,
    results: results,
    completedInChunks: chunks.length,
    commandId,
  };
}

// Implementation for getInstanceOverrides function
async function getInstanceOverrides(instanceNode = null) {
  console.log("=== getInstanceOverrides called ===");

  let sourceInstance = null;

  // Check if an instance node was passed directly
  if (instanceNode) {
    console.log("Using provided instance node");

    // Validate that the provided node is an instance
    if (instanceNode.type !== "INSTANCE") {
      console.error("Provided node is not an instance");
      figma.notify("Provided node is not a component instance");
      return { success: false, message: "Provided node is not a component instance" };
    }

    sourceInstance = instanceNode;
  } else {
    // No node provided, use selection
    console.log("No node provided, using current selection");

    // Get the current selection
    const selection = figma.currentPage.selection;

    // Check if there's anything selected
    if (selection.length === 0) {
      console.log("No nodes selected");
      figma.notify("Please select at least one instance");
      return { success: false, message: "No nodes selected" };
    }

    // Filter for instances in the selection
    const instances = selection.filter((node) => node.type === "INSTANCE");

    if (instances.length === 0) {
      console.log("No instances found in selection");
      figma.notify("Please select at least one component instance");
      return { success: false, message: "No instances found in selection" };
    }

    // Take the first instance from the selection
    sourceInstance = instances[0];
  }

  try {
    console.log(`Getting instance information:`);
    console.log(sourceInstance);

    // Get component overrides and main component
    const overrides = sourceInstance.overrides || [];
    console.log(`  Raw Overrides:`, overrides);

    // Get main component
    const mainComponent = await sourceInstance.getMainComponentAsync();
    if (!mainComponent) {
      console.error("Failed to get main component");
      figma.notify("Failed to get main component");
      return { success: false, message: "Failed to get main component" };
    }

    // return data to MCP server
    const returnData = {
      success: true,
      message: `Got component information from "${sourceInstance.name}" for overrides.length: ${overrides.length}`,
      sourceInstanceId: sourceInstance.id,
      mainComponentId: mainComponent.id,
      overridesCount: overrides.length,
    };

    console.log("Data to return to MCP server:", returnData);
    figma.notify(`Got component information from "${sourceInstance.name}"`);

    return returnData;
  } catch (error) {
    console.error("Error in getInstanceOverrides:", error);
    figma.notify(`Error: ${error.message}`);
    return {
      success: false,
      message: `Error: ${error.message}`,
    };
  }
}

/**
 * Helper function to validate and get target instances
 * @param {string[]} targetNodeIds - Array of instance node IDs
 * @returns {instanceNode[]} targetInstances - Array of target instances
 */
async function getValidTargetInstances(targetNodeIds) {
  const targetInstances = [];

  // Handle array of instances or single instance
  if (Array.isArray(targetNodeIds)) {
    if (targetNodeIds.length === 0) {
      return { success: false, message: "No instances provided" };
    }
    for (const targetNodeId of targetNodeIds) {
      const targetNode = await figma.getNodeByIdAsync(targetNodeId);
      if (targetNode && targetNode.type === "INSTANCE") {
        targetInstances.push(targetNode);
      }
    }
    if (targetInstances.length === 0) {
      return { success: false, message: "No valid instances provided" };
    }
  } else {
    return { success: false, message: "Invalid target node IDs provided" };
  }

  return { success: true, message: "Valid target instances provided", targetInstances };
}

/**
 * Helper function to validate and get saved override data
 * @param {string} sourceInstanceId - Source instance ID
 * @returns {Promise<Object>} - Validation result with source instance data or error
 */
async function getSourceInstanceData(sourceInstanceId) {
  if (!sourceInstanceId) {
    return { success: false, message: "Missing source instance ID" };
  }

  // Get source instance by ID
  const sourceInstance = await figma.getNodeByIdAsync(sourceInstanceId);
  if (!sourceInstance) {
    return {
      success: false,
      message: "Source instance not found. The original instance may have been deleted.",
    };
  }

  // Verify it's an instance
  if (sourceInstance.type !== "INSTANCE") {
    return {
      success: false,
      message: "Source node is not a component instance.",
    };
  }

  // Get main component
  const mainComponent = await sourceInstance.getMainComponentAsync();
  if (!mainComponent) {
    return {
      success: false,
      message: "Failed to get main component from source instance.",
    };
  }

  return {
    success: true,
    sourceInstance,
    mainComponent,
    overrides: sourceInstance.overrides || [],
  };
}

/**
 * Sets saved overrides to the selected component instance(s)
 * @param {InstanceNode[] | null} targetInstances - Array of instance nodes to set overrides to
 * @param {Object} sourceResult - Source instance data from getSourceInstanceData
 * @returns {Promise<Object>} - Result of the set operation
 */
async function setInstanceOverrides(targetInstances, sourceResult) {
  try {
    const { sourceInstance, mainComponent, overrides } = sourceResult;

    console.log(`Processing ${targetInstances.length} instances with ${overrides.length} overrides`);
    console.log(`Source instance: ${sourceInstance.id}, Main component: ${mainComponent.id}`);
    console.log(`Overrides:`, overrides);

    // Process all instances
    const results = [];
    let totalAppliedCount = 0;

    for (const targetInstance of targetInstances) {
      try {
        // // Skip if trying to apply to the source instance itself
        // if (targetInstance.id === sourceInstance.id) {
        //   console.log(`Skipping source instance itself: ${targetInstance.id}`);
        //   results.push({
        //     success: false,
        //     instanceId: targetInstance.id,
        //     instanceName: targetInstance.name,
        //     message: "This is the source instance itself, skipping"
        //   });
        //   continue;
        // }

        // Swap component
        try {
          targetInstance.swapComponent(mainComponent);
          console.log(`Swapped component for instance "${targetInstance.name}"`);
        } catch (error) {
          console.error(`Error swapping component for instance "${targetInstance.name}":`, error);
          results.push({
            success: false,
            instanceId: targetInstance.id,
            instanceName: targetInstance.name,
            message: `Error: ${error.message}`,
          });
        }

        // Prepare overrides by replacing node IDs
        let appliedCount = 0;

        // Apply each override
        for (const override of overrides) {
          // Skip if no ID or overriddenFields
          if (!override.id || !override.overriddenFields || override.overriddenFields.length === 0) {
            continue;
          }

          // Replace source instance ID with target instance ID in the node path
          const overrideNodeId = override.id.replace(sourceInstance.id, targetInstance.id);
          const overrideNode = await figma.getNodeByIdAsync(overrideNodeId);

          if (!overrideNode) {
            console.log(`Override node not found: ${overrideNodeId}`);
            continue;
          }

          // Get source node to copy properties from
          const sourceNode = await figma.getNodeByIdAsync(override.id);
          if (!sourceNode) {
            console.log(`Source node not found: ${override.id}`);
            continue;
          }

          // Apply each overridden field
          let fieldApplied = false;
          for (const field of override.overriddenFields) {
            try {
              if (field === "componentProperties") {
                // Apply component properties
                if (sourceNode.componentProperties && overrideNode.componentProperties) {
                  const properties = {};
                  for (const key in sourceNode.componentProperties) {
                    // if INSTANCE_SWAP use id, otherwise use value
                    if (sourceNode.componentProperties[key].type === "INSTANCE_SWAP") {
                      properties[key] = sourceNode.componentProperties[key].value;
                    } else {
                      properties[key] = sourceNode.componentProperties[key].value;
                    }
                  }
                  overrideNode.setProperties(properties);
                  fieldApplied = true;
                }
              } else if (field === "characters" && overrideNode.type === "TEXT") {
                // For text nodes, need to load fonts first
                await figma.loadFontAsync(overrideNode.fontName);
                overrideNode.characters = sourceNode.characters;
                fieldApplied = true;
              } else if (field in overrideNode) {
                // Direct property assignment
                overrideNode[field] = sourceNode[field];
                fieldApplied = true;
              }
            } catch (fieldError) {
              console.error(`Error applying field ${field}:`, fieldError);
            }
          }

          if (fieldApplied) {
            appliedCount++;
          }
        }

        if (appliedCount > 0) {
          totalAppliedCount += appliedCount;
          results.push({
            success: true,
            instanceId: targetInstance.id,
            instanceName: targetInstance.name,
            appliedCount,
          });
          console.log(`Applied ${appliedCount} overrides to "${targetInstance.name}"`);
        } else {
          results.push({
            success: false,
            instanceId: targetInstance.id,
            instanceName: targetInstance.name,
            message: "No overrides were applied",
          });
        }
      } catch (instanceError) {
        console.error(`Error processing instance "${targetInstance.name}":`, instanceError);
        results.push({
          success: false,
          instanceId: targetInstance.id,
          instanceName: targetInstance.name,
          message: `Error: ${instanceError.message}`,
        });
      }
    }

    // Return results
    if (totalAppliedCount > 0) {
      const instanceCount = results.filter((r) => r.success).length;
      const message = `Applied ${totalAppliedCount} overrides to ${instanceCount} instances`;
      figma.notify(message);
      return {
        success: true,
        message,
        totalCount: totalAppliedCount,
        results,
      };
    } else {
      const message = "No overrides applied to any instance";
      figma.notify(message);
      return { success: false, message, results };
    }
  } catch (error) {
    console.error("Error in setInstanceOverrides:", error);
    const message = `Error: ${error.message}`;
    figma.notify(message);
    return { success: false, message };
  }
}

async function setLayoutMode(params) {
  const { nodeId, layoutMode = "NONE", layoutWrap = "NO_WRAP" } = params || {};

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports layoutMode
  if (node.type !== "FRAME" && node.type !== "COMPONENT" && node.type !== "COMPONENT_SET" && node.type !== "INSTANCE") {
    throw new Error(`Node type ${node.type} does not support layoutMode`);
  }

  // Set layout mode
  node.layoutMode = layoutMode;

  // Set layoutWrap if applicable
  if (layoutMode !== "NONE") {
    node.layoutWrap = layoutWrap;
  }

  return {
    id: node.id,
    name: node.name,
    layoutMode: node.layoutMode,
    layoutWrap: node.layoutWrap,
  };
}

async function setPadding(params) {
  const { nodeId, paddingTop, paddingRight, paddingBottom, paddingLeft } = params || {};

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports padding
  if (node.type !== "FRAME" && node.type !== "COMPONENT" && node.type !== "COMPONENT_SET" && node.type !== "INSTANCE") {
    throw new Error(`Node type ${node.type} does not support padding`);
  }

  // Check if the node has auto-layout enabled
  if (node.layoutMode === "NONE") {
    throw new Error("Padding can only be set on auto-layout frames (layoutMode must not be NONE)");
  }

  // Set padding values if provided (with type coercion)
  if (paddingTop !== undefined) node.paddingTop = toNumber(paddingTop, 0);
  if (paddingRight !== undefined) node.paddingRight = toNumber(paddingRight, 0);
  if (paddingBottom !== undefined) node.paddingBottom = toNumber(paddingBottom, 0);
  if (paddingLeft !== undefined) node.paddingLeft = toNumber(paddingLeft, 0);

  return {
    id: node.id,
    name: node.name,
    paddingTop: node.paddingTop,
    paddingRight: node.paddingRight,
    paddingBottom: node.paddingBottom,
    paddingLeft: node.paddingLeft,
  };
}

async function setAxisAlign(params) {
  const { nodeId, primaryAxisAlignItems, counterAxisAlignItems } = params || {};

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports axis alignment
  if (node.type !== "FRAME" && node.type !== "COMPONENT" && node.type !== "COMPONENT_SET" && node.type !== "INSTANCE") {
    throw new Error(`Node type ${node.type} does not support axis alignment`);
  }

  // Check if the node has auto-layout enabled
  if (node.layoutMode === "NONE") {
    throw new Error("Axis alignment can only be set on auto-layout frames (layoutMode must not be NONE)");
  }

  // Validate and set primaryAxisAlignItems if provided
  if (primaryAxisAlignItems !== undefined) {
    if (!["MIN", "MAX", "CENTER", "SPACE_BETWEEN"].includes(primaryAxisAlignItems)) {
      throw new Error("Invalid primaryAxisAlignItems value. Must be one of: MIN, MAX, CENTER, SPACE_BETWEEN");
    }
    node.primaryAxisAlignItems = primaryAxisAlignItems;
  }

  // Validate and set counterAxisAlignItems if provided
  if (counterAxisAlignItems !== undefined) {
    if (!["MIN", "MAX", "CENTER", "BASELINE"].includes(counterAxisAlignItems)) {
      throw new Error("Invalid counterAxisAlignItems value. Must be one of: MIN, MAX, CENTER, BASELINE");
    }
    // BASELINE is only valid for horizontal layout
    if (counterAxisAlignItems === "BASELINE" && node.layoutMode !== "HORIZONTAL") {
      throw new Error("BASELINE alignment is only valid for horizontal auto-layout frames");
    }
    node.counterAxisAlignItems = counterAxisAlignItems;
  }

  return {
    id: node.id,
    name: node.name,
    primaryAxisAlignItems: node.primaryAxisAlignItems,
    counterAxisAlignItems: node.counterAxisAlignItems,
    layoutMode: node.layoutMode,
  };
}

async function setLayoutSizing(params) {
  const { nodeId, layoutSizingHorizontal, layoutSizingVertical } = params || {};

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports layout sizing
  if (node.type !== "FRAME" && node.type !== "COMPONENT" && node.type !== "COMPONENT_SET" && node.type !== "INSTANCE") {
    throw new Error(`Node type ${node.type} does not support layout sizing`);
  }

  // Validate and set layoutSizingHorizontal if provided
  if (layoutSizingHorizontal !== undefined) {
    if (!["FIXED", "HUG", "FILL"].includes(layoutSizingHorizontal)) {
      throw new Error("Invalid layoutSizingHorizontal value. Must be one of: FIXED, HUG, FILL");
    }
    // HUG is only valid on auto-layout frames and text nodes
    if (layoutSizingHorizontal === "HUG" && !["FRAME", "TEXT"].includes(node.type)) {
      throw new Error("HUG sizing is only valid on auto-layout frames and text nodes");
    }
    // FILL is only valid on auto-layout children
    if (layoutSizingHorizontal === "FILL" && (!node.parent || node.parent.layoutMode === "NONE")) {
      throw new Error("FILL sizing is only valid on auto-layout children");
    }
    node.layoutSizingHorizontal = layoutSizingHorizontal;
  }

  // Validate and set layoutSizingVertical if provided
  if (layoutSizingVertical !== undefined) {
    if (!["FIXED", "HUG", "FILL"].includes(layoutSizingVertical)) {
      throw new Error("Invalid layoutSizingVertical value. Must be one of: FIXED, HUG, FILL");
    }
    // HUG is only valid on auto-layout frames and text nodes
    if (layoutSizingVertical === "HUG" && !["FRAME", "TEXT"].includes(node.type)) {
      throw new Error("HUG sizing is only valid on auto-layout frames and text nodes");
    }
    // FILL is only valid on auto-layout children
    if (layoutSizingVertical === "FILL" && (!node.parent || node.parent.layoutMode === "NONE")) {
      throw new Error("FILL sizing is only valid on auto-layout children");
    }
    node.layoutSizingVertical = layoutSizingVertical;
  }

  return {
    id: node.id,
    name: node.name,
    layoutSizingHorizontal: node.layoutSizingHorizontal,
    layoutSizingVertical: node.layoutSizingVertical,
    layoutMode: node.layoutMode,
  };
}

async function setItemSpacing(params) {
  const { nodeId, itemSpacing, counterAxisSpacing } = params || {};

  // Validate that at least one spacing parameter is provided
  if (itemSpacing === undefined && counterAxisSpacing === undefined) {
    throw new Error("At least one of itemSpacing or counterAxisSpacing must be provided");
  }

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports item spacing
  if (node.type !== "FRAME" && node.type !== "COMPONENT" && node.type !== "COMPONENT_SET" && node.type !== "INSTANCE") {
    throw new Error(`Node type ${node.type} does not support item spacing`);
  }

  // Check if the node has auto-layout enabled
  if (node.layoutMode === "NONE") {
    throw new Error("Item spacing can only be set on auto-layout frames (layoutMode must not be NONE)");
  }

  // Set item spacing if provided (with type coercion)
  if (itemSpacing !== undefined) {
    const numItemSpacing = toNumber(itemSpacing, undefined);
    if (numItemSpacing === undefined) {
      throw new Error("Item spacing must be a number");
    }
    node.itemSpacing = numItemSpacing;
  }

  // Set counter axis spacing if provided (with type coercion)
  if (counterAxisSpacing !== undefined) {
    const numCounterAxisSpacing = toNumber(counterAxisSpacing, undefined);
    if (numCounterAxisSpacing === undefined) {
      throw new Error("Counter axis spacing must be a number");
    }
    // counterAxisSpacing only applies when layoutWrap is WRAP
    if (node.layoutWrap !== "WRAP") {
      throw new Error("Counter axis spacing can only be set on frames with layoutWrap set to WRAP");
    }
    node.counterAxisSpacing = numCounterAxisSpacing;
  }

  return {
    id: node.id,
    name: node.name,
    itemSpacing: node.itemSpacing || undefined,
    counterAxisSpacing: node.counterAxisSpacing || undefined,
    layoutMode: node.layoutMode,
    layoutWrap: node.layoutWrap,
  };
}

async function setDefaultConnector(params) {
  const { connectorId } = params || {};

  // If connectorId is provided, search and set by that ID (do not check existing storage)
  if (connectorId) {
    // Get node by specified ID
    const node = await figma.getNodeByIdAsync(connectorId);
    if (!node) {
      throw new Error(`Connector node not found with ID: ${connectorId}`);
    }

    // Check node type
    if (node.type !== "CONNECTOR") {
      throw new Error(`Node is not a connector: ${connectorId}`);
    }

    // Set the found connector as the default connector
    await figma.clientStorage.setAsync("defaultConnectorId", connectorId);

    return {
      success: true,
      message: `Default connector set to: ${connectorId}`,
      connectorId: connectorId,
    };
  }
  // If connectorId is not provided, check existing storage
  else {
    // Check if there is an existing default connector in client storage
    try {
      const existingConnectorId = await figma.clientStorage.getAsync("defaultConnectorId");

      // If there is an existing connector ID, check if the node is still valid
      if (existingConnectorId) {
        try {
          const existingConnector = await figma.getNodeByIdAsync(existingConnectorId);

          // If the stored connector still exists and is of type CONNECTOR
          if (existingConnector && existingConnector.type === "CONNECTOR") {
            return {
              success: true,
              message: `Default connector is already set to: ${existingConnectorId}`,
              connectorId: existingConnectorId,
              exists: true,
            };
          }
          // The stored connector is no longer valid - find a new connector
          else {
            console.log(`Stored connector ID ${existingConnectorId} is no longer valid, finding a new connector...`);
          }
        } catch (error) {
          console.log(`Error finding stored connector: ${error.message}. Will try to set a new one.`);
        }
      }
    } catch (error) {
      console.log(`Error checking for existing connector: ${error.message}`);
    }

    // If there is no stored default connector or it is invalid, find one in the current page
    try {
      // Find CONNECTOR type nodes in the current page
      const currentPageConnectors = figma.currentPage.findAllWithCriteria({ types: ["CONNECTOR"] });

      if (currentPageConnectors && currentPageConnectors.length > 0) {
        // Use the first connector found
        const foundConnector = currentPageConnectors[0];
        const autoFoundId = foundConnector.id;

        // Set the found connector as the default connector
        await figma.clientStorage.setAsync("defaultConnectorId", autoFoundId);

        return {
          success: true,
          message: `Automatically found and set default connector to: ${autoFoundId}`,
          connectorId: autoFoundId,
          autoSelected: true,
        };
      } else {
        // If no connector is found in the current page, show a guide message
        throw new Error(
          "No connector found in the current page. Please create a connector in Figma first or specify a connector ID.",
        );
      }
    } catch (error) {
      // Error occurred while running findAllWithCriteria
      throw new Error(`Failed to find a connector: ${error.message}`);
    }
  }
}

async function createCursorNode(targetNodeId) {
  const svgString = `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M16 8V35.2419L22 28.4315L27 39.7823C27 39.7823 28.3526 40.2722 29 39.7823C29.6474 39.2924 30.2913 38.3057 30 37.5121C28.6247 33.7654 25 26.1613 25 26.1613H32L16 8Z" fill="#202125" />
  </svg>`;
  try {
    const targetNode = await figma.getNodeByIdAsync(targetNodeId);
    if (!targetNode) throw new Error("Target node not found");

    // The targetNodeId has semicolons since it is a nested node.
    // So we need to get the parent node ID from the target node ID and check if we can appendChild to it or not.
    const parentNodeId = targetNodeId.includes(";") ? targetNodeId.split(";")[0] : targetNodeId;
    if (!parentNodeId) throw new Error("Could not determine parent node ID");

    // Find the parent node to append cursor node as child
    let parentNode = await figma.getNodeByIdAsync(parentNodeId);
    if (!parentNode) throw new Error("Parent node not found");

    // If the parent node is not eligible to appendChild, set the parentNode to the parent of the parentNode
    if (parentNode.type === "INSTANCE" || parentNode.type === "COMPONENT" || parentNode.type === "COMPONENT_SET") {
      parentNode = parentNode.parent;
      if (!parentNode) throw new Error("Parent node not found");
    }

    // Create the cursor node
    const importedNode = await figma.createNodeFromSvg(svgString);
    if (!importedNode || !importedNode.id) {
      throw new Error("Failed to create imported cursor node");
    }
    importedNode.name = "TTF_Connector / Mouse Cursor";
    importedNode.resize(48, 48);

    const cursorNode = importedNode.findOne((node) => node.type === "VECTOR");
    if (cursorNode) {
      cursorNode.fills = [
        {
          type: "SOLID",
          color: { r: 0, g: 0, b: 0 },
          opacity: 1,
        },
      ];
      cursorNode.strokes = [
        {
          type: "SOLID",
          color: { r: 1, g: 1, b: 1 },
          opacity: 1,
        },
      ];
      cursorNode.strokeWeight = 2;
      cursorNode.strokeAlign = "OUTSIDE";
      cursorNode.effects = [
        {
          type: "DROP_SHADOW",
          color: { r: 0, g: 0, b: 0, a: 0.3 },
          offset: { x: 1, y: 1 },
          radius: 2,
          spread: 0,
          visible: true,
          blendMode: "NORMAL",
        },
      ];
    }

    // Append the cursor node to the parent node
    parentNode.appendChild(importedNode);

    // if the parentNode has auto-layout enabled, set the layoutPositioning to ABSOLUTE
    if ("layoutMode" in parentNode && parentNode.layoutMode !== "NONE") {
      importedNode.layoutPositioning = "ABSOLUTE";
    }

    // Adjust the importedNode's position to the targetNode's position
    if (targetNode.absoluteBoundingBox && parentNode.absoluteBoundingBox) {
      // if the targetNode has absoluteBoundingBox, set the importedNode's absoluteBoundingBox to the targetNode's absoluteBoundingBox
      console.log("targetNode.absoluteBoundingBox", targetNode.absoluteBoundingBox);
      console.log("parentNode.absoluteBoundingBox", parentNode.absoluteBoundingBox);
      importedNode.x =
        targetNode.absoluteBoundingBox.x -
        parentNode.absoluteBoundingBox.x +
        targetNode.absoluteBoundingBox.width / 2 -
        48 / 2;
      importedNode.y =
        targetNode.absoluteBoundingBox.y -
        parentNode.absoluteBoundingBox.y +
        targetNode.absoluteBoundingBox.height / 2 -
        48 / 2;
    } else if ("x" in targetNode && "y" in targetNode && "width" in targetNode && "height" in targetNode) {
      // if the targetNode has x, y, width, height, calculate center based on relative position
      console.log("targetNode.x/y/width/height", targetNode.x, targetNode.y, targetNode.width, targetNode.height);
      importedNode.x = targetNode.x + targetNode.width / 2 - 48 / 2;
      importedNode.y = targetNode.y + targetNode.height / 2 - 48 / 2;
    } else {
      // Fallback: Place at top-left of target if possible, otherwise at (0,0) relative to parent
      if ("x" in targetNode && "y" in targetNode) {
        console.log("Fallback to targetNode x/y");
        importedNode.x = targetNode.x;
        importedNode.y = targetNode.y;
      } else {
        console.log("Fallback to (0,0)");
        importedNode.x = 0;
        importedNode.y = 0;
      }
    }

    // get the importedNode ID and the importedNode
    console.log("importedNode", importedNode);

    return { id: importedNode.id, node: importedNode };
  } catch (error) {
    console.error("Error creating cursor from SVG:", error);
    return { id: null, node: null, error: error.message };
  }
}

async function createConnections(params) {
  if (!params || !params.connections || !Array.isArray(params.connections)) {
    throw new Error("Missing or invalid connections parameter");
  }

  const { connections } = params;

  // Command ID for progress tracking
  const commandId = generateCommandId();
  sendProgressUpdate(
    commandId,
    "create_connections",
    "started",
    0,
    connections.length,
    0,
    `Starting to create ${connections.length} connections`,
  );

  // Get default connector ID from client storage
  const defaultConnectorId = await figma.clientStorage.getAsync("defaultConnectorId");
  if (!defaultConnectorId) {
    throw new Error(
      'No default connector set. Please try one of the following options to create connections:\n1. Create a connector in FigJam and copy/paste it to your current page, then run the "set_default_connector" command.\n2. Select an existing connector on the current page, then run the "set_default_connector" command.',
    );
  }

  // Get the default connector
  const defaultConnector = await figma.getNodeByIdAsync(defaultConnectorId);
  if (!defaultConnector) {
    throw new Error(`Default connector not found with ID: ${defaultConnectorId}`);
  }
  if (defaultConnector.type !== "CONNECTOR") {
    throw new Error(`Node is not a connector: ${defaultConnectorId}`);
  }

  // Results array for connection creation
  const results = [];
  let processedCount = 0;
  const totalCount = connections.length;

  // Preload fonts (used for text if provided)

  for (let i = 0; i < connections.length; i++) {
    try {
      const { startNodeId: originalStartId, endNodeId: originalEndId, text } = connections[i];
      let startId = originalStartId;
      let endId = originalEndId;

      // Check and potentially replace start node ID
      if (startId.includes(";")) {
        console.log(`Nested start node detected: ${startId}. Creating cursor node.`);
        const cursorResult = await createCursorNode(startId);
        if (!cursorResult || !cursorResult.id) {
          throw new Error(`Failed to create cursor node for nested start node: ${startId}`);
        }
        startId = cursorResult.id;
      }

      const startNode = await figma.getNodeByIdAsync(startId);
      if (!startNode) throw new Error(`Start node not found with ID: ${startId}`);

      // Check and potentially replace end node ID
      if (endId.includes(";")) {
        console.log(`Nested end node detected: ${endId}. Creating cursor node.`);
        const cursorResult = await createCursorNode(endId);
        if (!cursorResult || !cursorResult.id) {
          throw new Error(`Failed to create cursor node for nested end node: ${endId}`);
        }
        endId = cursorResult.id;
      }
      const endNode = await figma.getNodeByIdAsync(endId);
      if (!endNode) throw new Error(`End node not found with ID: ${endId}`);

      // Clone the default connector
      const clonedConnector = defaultConnector.clone();

      // Update connector name using potentially replaced node names
      clonedConnector.name = `TTF_Connector/${startNode.id}/${endNode.id}`;

      // Set start and end points using potentially replaced IDs
      clonedConnector.connectorStart = {
        endpointNodeId: startId,
        magnet: "AUTO",
      };

      clonedConnector.connectorEnd = {
        endpointNodeId: endId,
        magnet: "AUTO",
      };

      // Add text (if provided)
      if (text) {
        try {
          // Try to load the necessary fonts
          try {
            // First check if default connector has font and use the same
            if (defaultConnector.text && defaultConnector.text.fontName) {
              const fontName = defaultConnector.text.fontName;
              await figma.loadFontAsync(fontName);
              clonedConnector.text.fontName = fontName;
            } else {
              // Try default Inter font
              await figma.loadFontAsync({ family: "Inter", style: "Regular" });
            }
          } catch (fontError) {
            // If first font load fails, try another font style
            try {
              await figma.loadFontAsync({ family: "Inter", style: "Medium" });
            } catch (_mediumFontError) {
              // If second font fails, try system font
              try {
                await figma.loadFontAsync({ family: "System", style: "Regular" });
              } catch (_systemFontError) {
                // If all font loading attempts fail, throw error
                throw new Error(`Failed to load any font: ${fontError.message}`);
              }
            }
          }

          // Set the text
          clonedConnector.text.characters = text;
        } catch (textError) {
          console.error("Error setting text:", textError);
          // Continue with connection even if text setting fails
          results.push({
            id: clonedConnector.id,
            startNodeId: startId,
            endNodeId: endId,
            text: "",
            textError: textError.message,
          });

          // Continue to next connection
          continue;
        }
      }

      // Add to results (using the *original* IDs for reference if needed)
      results.push({
        id: clonedConnector.id,
        originalStartNodeId: originalStartId,
        originalEndNodeId: originalEndId,
        usedStartNodeId: startId, // ID actually used for connection
        usedEndNodeId: endId, // ID actually used for connection
        text: text || "",
      });

      // Update progress
      processedCount++;
      sendProgressUpdate(
        commandId,
        "create_connections",
        "in_progress",
        processedCount / totalCount,
        totalCount,
        processedCount,
        `Created connection ${processedCount}/${totalCount}`,
      );
    } catch (error) {
      console.error("Error creating connection", error);
      // Continue processing remaining connections even if an error occurs
      processedCount++;
      sendProgressUpdate(
        commandId,
        "create_connections",
        "in_progress",
        processedCount / totalCount,
        totalCount,
        processedCount,
        `Error creating connection: ${error.message}`,
      );

      results.push({
        error: error.message,
        connectionInfo: connections[i],
      });
    }
  }

  // Completion update
  sendProgressUpdate(
    commandId,
    "create_connections",
    "completed",
    1,
    totalCount,
    totalCount,
    `Completed creating ${results.length} connections`,
  );

  return {
    success: true,
    count: results.length,
    connections: results,
  };
}

// Set focus on a specific node
async function setFocus(params) {
  if (!params || !params.nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) {
    throw new Error(`Node with ID ${params.nodeId} not found`);
  }

  // Set selection to the node
  figma.currentPage.selection = [node];

  // Scroll and zoom to show the node in viewport
  figma.viewport.scrollAndZoomIntoView([node]);

  return {
    success: true,
    name: node.name,
    id: node.id,
    message: `Focused on node "${node.name}"`,
  };
}

// Set selection to multiple nodes
async function setSelections(params) {
  if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
    throw new Error("Missing or invalid nodeIds parameter");
  }

  if (params.nodeIds.length === 0) {
    throw new Error("nodeIds array cannot be empty");
  }

  // Get all valid nodes
  const nodes = [];
  const notFoundIds = [];

  for (const nodeId of params.nodeIds) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (node) {
      nodes.push(node);
    } else {
      notFoundIds.push(nodeId);
    }
  }

  if (nodes.length === 0) {
    throw new Error(`No valid nodes found for the provided IDs: ${params.nodeIds.join(", ")}`);
  }

  // Set selection to the nodes
  figma.currentPage.selection = nodes;

  // Scroll and zoom to show all nodes in viewport
  figma.viewport.scrollAndZoomIntoView(nodes);

  const selectedNodes = nodes.map((node) => ({
    name: node.name,
    id: node.id,
  }));

  return {
    success: true,
    count: nodes.length,
    selectedNodes: selectedNodes,
    notFoundIds: notFoundIds,
    message: `Selected ${nodes.length} nodes${notFoundIds.length > 0 ? ` (${notFoundIds.length} not found)` : ""}`,
  };
}

// ============================================================
// Composite / batch tools (Phase 2-4)
// ============================================================

async function reorderChildren(params) {
  const parentId = params.parentId;
  const childIds = params.childIds;

  if (!parentId) throw new Error("Missing parentId parameter");
  if (!childIds || !Array.isArray(childIds) || childIds.length === 0) {
    throw new Error("Missing or invalid childIds parameter");
  }

  const parent = await figma.getNodeByIdAsync(parentId);
  if (!parent) throw new Error("Parent node not found: " + parentId);
  if (!("children" in parent)) throw new Error("Node does not support children: " + parentId);

  // Build lookup of current children
  const childMap = {};
  for (let i = 0; i < parent.children.length; i++) {
    childMap[parent.children[i].id] = parent.children[i];
  }

  // Insert specified children in order using insertChild
  let moved = 0;
  for (let idx = 0; idx < childIds.length; idx++) {
    const child = childMap[childIds[idx]];
    if (child) {
      parent.insertChild(idx, child);
      moved++;
    }
  }

  return {
    parentId: parent.id,
    parentName: parent.name,
    newOrder: parent.children.map((c) => ({ id: c.id, name: c.name })),
    movedCount: moved,
  };
}

async function createFrameTree(params) {
  const parentId = params.parentId;
  const tree = params.tree;
  const commandId = params.commandId;

  if (!tree) throw new Error("Missing tree parameter");

  // Count total nodes for progress tracking
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
    sendProgressUpdate(commandId, "create_frame_tree", "started", 0, totalNodes, 0, "Starting tree creation");
  }

  // Helper to apply fill color to a node
  function applyFillColor(node, colorSpec) {
    node.fills = [
      {
        type: "SOLID",
        color: { r: parseFloat(colorSpec.r) || 0, g: parseFloat(colorSpec.g) || 0, b: parseFloat(colorSpec.b) || 0 },
        opacity: colorSpec.a !== undefined ? parseFloat(colorSpec.a) : 1,
      },
    ];
  }

  // Helper to apply stroke color to a node
  function applyStrokeColor(node, colorSpec) {
    node.strokes = [
      {
        type: "SOLID",
        color: { r: parseFloat(colorSpec.r) || 0, g: parseFloat(colorSpec.g) || 0, b: parseFloat(colorSpec.b) || 0 },
        opacity: colorSpec.a !== undefined ? parseFloat(colorSpec.a) : 1,
      },
    ];
  }

  // Recursive builder
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
      // FRAME (default)
      node = figma.createFrame();
    }

    // Common properties
    if (spec.name !== undefined) node.name = spec.name;
    if (spec.width !== undefined || spec.height !== undefined) {
      node.resize(toNumber(spec.width, 100), toNumber(spec.height, 100));
    }
    if (spec.x !== undefined) node.x = toNumber(spec.x, 0);
    if (spec.y !== undefined) node.y = toNumber(spec.y, 0);

    // Corner radius (frames and rectangles)
    if (spec.cornerRadius !== undefined && "cornerRadius" in node) {
      node.cornerRadius = toNumber(spec.cornerRadius, 0);
    }

    // Fill color
    if (spec.fillColor) {
      applyFillColor(node, spec.fillColor);
    }

    // Stroke
    if (spec.strokeColor) {
      applyStrokeColor(node, spec.strokeColor);
    }
    if (spec.strokeWeight !== undefined && "strokeWeight" in node) {
      node.strokeWeight = toNumber(spec.strokeWeight, 1);
    }

    // Auto-layout properties (FRAME only)
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

    // Append to parent
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

    // Track progress
    createdCount++;
    if (commandId && createdCount % 5 === 0) {
      const pct = Math.round((createdCount / totalNodes) * 100);
      sendProgressUpdate(
        commandId,
        "create_frame_tree",
        "in_progress",
        pct,
        totalNodes,
        createdCount,
        "Created " + createdCount + " of " + totalNodes + " nodes",
      );
    }

    // Build children recursively
    const childResults = [];
    if (spec.children && Array.isArray(spec.children)) {
      for (let ci = 0; ci < spec.children.length; ci++) {
        const childResult = await buildNode(spec.children[ci], node);
        childResults.push(childResult);
      }
    }

    // Two-pass: set layout sizing AFTER children are created (FILL requires parent auto-layout)
    if (nodeType === "FRAME" && spec.layoutMode && spec.layoutMode !== "NONE") {
      if (spec.layoutSizingHorizontal) node.layoutSizingHorizontal = spec.layoutSizingHorizontal;
      if (spec.layoutSizingVertical) node.layoutSizingVertical = spec.layoutSizingVertical;
    }

    // Set FILL sizing on this node if it's a child of an auto-layout parent
    if (parentNode && "layoutMode" in parentNode && parentNode.layoutMode !== "NONE") {
      if (spec.layoutSizingHorizontal === "FILL") node.layoutSizingHorizontal = "FILL";
      if (spec.layoutSizingVertical === "FILL") node.layoutSizingVertical = "FILL";
    }

    const result = {
      id: node.id,
      name: node.name,
      type: node.type,
    };
    if (childResults.length > 0) {
      result.children = childResults;
    }
    return result;
  }

  const treeResult = await buildNode(tree, null);

  if (commandId) {
    sendProgressUpdate(
      commandId,
      "create_frame_tree",
      "completed",
      100,
      totalNodes,
      createdCount,
      "Tree creation completed",
    );
  }

  return {
    success: true,
    totalNodesCreated: createdCount,
    tree: treeResult,
  };
}

async function setMultipleProperties(params) {
  const operations = params.operations;
  const commandId = params.commandId;

  if (!operations || !Array.isArray(operations) || operations.length === 0) {
    throw new Error("Missing or empty operations array");
  }

  const totalOps = operations.length;
  let successCount = 0;
  let failureCount = 0;
  const results = [];

  if (commandId) {
    sendProgressUpdate(commandId, "set_multiple_properties", "started", 0, totalOps, 0, "Starting property updates");
  }

  // Process in chunks of 5
  const CHUNK_SIZE = 5;
  const totalChunks = Math.ceil(totalOps / CHUNK_SIZE);

  for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
    const start = chunkIdx * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalOps);
    const chunk = operations.slice(start, end);

    const chunkPromises = chunk.map((op) =>
      (async (op) => {
        try {
          const node = await figma.getNodeByIdAsync(op.nodeId);
          if (!node) throw new Error("Node not found: " + op.nodeId);

          // Fill color
          if (op.fillColor && "fills" in node) {
            const fc = op.fillColor;
            node.fills = [
              {
                type: "SOLID",
                color: { r: parseFloat(fc.r) || 0, g: parseFloat(fc.g) || 0, b: parseFloat(fc.b) || 0 },
                opacity: fc.a !== undefined ? parseFloat(fc.a) : 1,
              },
            ];
          }

          // Stroke color
          if (op.strokeColor && "strokes" in node) {
            const sc = op.strokeColor;
            node.strokes = [
              {
                type: "SOLID",
                color: { r: parseFloat(sc.r) || 0, g: parseFloat(sc.g) || 0, b: parseFloat(sc.b) || 0 },
                opacity: sc.a !== undefined ? parseFloat(sc.a) : 1,
              },
            ];
          }

          // Stroke weight
          if (op.strokeWeight !== undefined && "strokeWeight" in node) {
            node.strokeWeight = toNumber(op.strokeWeight, 1);
          }

          // Corner radius
          if (op.cornerRadius !== undefined && "cornerRadius" in node) {
            node.cornerRadius = toNumber(op.cornerRadius, 0);
          }

          // Layout sizing
          if (op.layoutSizingHorizontal !== undefined && "layoutSizingHorizontal" in node) {
            node.layoutSizingHorizontal = op.layoutSizingHorizontal;
          }
          if (op.layoutSizingVertical !== undefined && "layoutSizingVertical" in node) {
            node.layoutSizingVertical = op.layoutSizingVertical;
          }

          // Padding
          if (op.paddingTop !== undefined && "paddingTop" in node) node.paddingTop = toNumber(op.paddingTop, 0);
          if (op.paddingRight !== undefined && "paddingRight" in node) node.paddingRight = toNumber(op.paddingRight, 0);
          if (op.paddingBottom !== undefined && "paddingBottom" in node)
            node.paddingBottom = toNumber(op.paddingBottom, 0);
          if (op.paddingLeft !== undefined && "paddingLeft" in node) node.paddingLeft = toNumber(op.paddingLeft, 0);

          // Item spacing
          if (op.itemSpacing !== undefined && "itemSpacing" in node) {
            node.itemSpacing = toNumber(op.itemSpacing, 0);
          }

          return { success: true, nodeId: op.nodeId };
        } catch (e) {
          return { success: false, nodeId: op.nodeId, error: e.message || String(e) };
        }
      })(op),
    );

    const chunkResults = await Promise.all(chunkPromises);
    for (let ri = 0; ri < chunkResults.length; ri++) {
      results.push(chunkResults[ri]);
      if (chunkResults[ri].success) {
        successCount++;
      } else {
        failureCount++;
      }
    }

    if (commandId) {
      const processed = Math.min(end, totalOps);
      const pct = Math.round((processed / totalOps) * 100);
      sendProgressUpdate(
        commandId,
        "set_multiple_properties",
        "in_progress",
        pct,
        totalOps,
        processed,
        "Processed " + processed + " of " + totalOps,
        {
          currentChunk: chunkIdx + 1,
          totalChunks: totalChunks,
          chunkSize: CHUNK_SIZE,
        },
      );
    }
  }

  if (commandId) {
    sendProgressUpdate(
      commandId,
      "set_multiple_properties",
      "completed",
      100,
      totalOps,
      totalOps,
      "All property updates completed",
    );
  }

  return {
    success: failureCount === 0,
    totalOperations: totalOps,
    successCount: successCount,
    failureCount: failureCount,
    results: results,
  };
}

async function cloneAndModify(params) {
  const nodeId = params.nodeId;
  const targetParentId = params.parentId;
  const newName = params.name;

  if (!nodeId) throw new Error("Missing nodeId parameter");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);

  const clone = node.clone();

  // Reparent: clone() auto-appends to currentPage, so move to correct parent
  if (targetParentId) {
    const targetParent = await figma.getNodeByIdAsync(targetParentId);
    if (!targetParent) throw new Error("Target parent not found: " + targetParentId);
    if (!("appendChild" in targetParent)) throw new Error("Target parent does not support children: " + targetParentId);
    targetParent.appendChild(clone);
  } else if (node.parent && node.parent.id !== figma.currentPage.id) {
    // Default: place clone in same parent as original
    node.parent.appendChild(clone);
  }

  // Apply modifications
  if (newName !== undefined) clone.name = newName;
  if (params.x !== undefined) clone.x = toNumber(params.x, 0);
  if (params.y !== undefined) clone.y = toNumber(params.y, 0);

  if (params.fillColor && "fills" in clone) {
    const fc = params.fillColor;
    clone.fills = [
      {
        type: "SOLID",
        color: { r: parseFloat(fc.r) || 0, g: parseFloat(fc.g) || 0, b: parseFloat(fc.b) || 0 },
        opacity: fc.a !== undefined ? parseFloat(fc.a) : 1,
      },
    ];
  }

  if (params.cornerRadius !== undefined && "cornerRadius" in clone) {
    clone.cornerRadius = toNumber(params.cornerRadius, 0);
  }

  return {
    id: clone.id,
    name: clone.name,
    type: clone.type,
    x: clone.x,
    y: clone.y,
    width: clone.width,
    height: clone.height,
    parentId: clone.parent ? clone.parent.id : undefined,
  };
}

async function getMainComponent(params) {
  const nodeId = params.nodeId;
  if (!nodeId) throw new Error("Missing nodeId parameter");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);

  if (node.type !== "INSTANCE") {
    throw new Error("Node is not an instance (type: " + node.type + "). Only INSTANCE nodes have a main component.");
  }

  const mainComponent = await node.getMainComponentAsync();
  if (!mainComponent) {
    throw new Error("Could not find main component for instance: " + nodeId);
  }

  return {
    id: mainComponent.id,
    name: mainComponent.name,
    type: mainComponent.type,
    description: mainComponent.description || "",
    key: mainComponent.key,
    parent: mainComponent.parent
      ? { id: mainComponent.parent.id, name: mainComponent.parent.name, type: mainComponent.parent.type }
      : undefined,
  };
}

async function bindVariable(params) {
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

  // Map user-friendly field names to Figma's VariableBindableNodeField values
  var fieldMap = {
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

  var figmaField = fieldMap[field];
  if (!figmaField) {
    throw new Error("Unsupported field: " + field + ". Supported fields: " + Object.keys(fieldMap).join(", "));
  }

  // For fill/stroke bindings, we need to bind to the first paint's color
  if (figmaField === "fills" || figmaField === "strokes") {
    // Ensure node supports this property
    if (!(figmaField in node)) {
      throw new Error("Node does not support " + figmaField + ": " + nodeId);
    }
    // For color variables, we need to set a solid fill/stroke first if empty,
    // then bind the variable to it
    let paints = JSON.parse(JSON.stringify(node[figmaField]));
    if (!paints || paints.length === 0) {
      paints = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }];
      node[figmaField] = paints;
    }
    // Use the fill/stroke-specific binding via setBoundVariable
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

async function batchBindVariables(params) {
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

  var fieldMap = {
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

  var CHUNK_SIZE = 10;
  var totalChunks = Math.ceil(totalOps / CHUNK_SIZE);
  var chunkIdx, start, end, chunk, chunkPromises, chunkResults, ri, processed, pct;

  for (chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
    start = chunkIdx * CHUNK_SIZE;
    end = Math.min(start + CHUNK_SIZE, totalOps);
    chunk = bindings.slice(start, end);

    chunkPromises = chunk.map(function (binding) {
      return (async function (b) {
        try {
          const node = await figma.getNodeByIdAsync(b.nodeId);
          if (!node) throw new Error("Node not found: " + b.nodeId);

          const variable = await figma.variables.getVariableByIdAsync(b.variableId);
          if (!variable) throw new Error("Variable not found: " + b.variableId);

          const figmaField = fieldMap[b.field];
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
      })(binding);
    });

    chunkResults = await Promise.all(chunkPromises);
    for (ri = 0; ri < chunkResults.length; ri++) {
      results.push(chunkResults[ri]);
      if (chunkResults[ri].success) successCount++;
      else failureCount++;
    }

    if (commandId) {
      processed = Math.min(end, totalOps);
      pct = Math.round((processed / totalOps) * 100);
      sendProgressUpdate(commandId, "batch_bind_variables", "in_progress", pct, totalOps, processed,
        "Processed " + processed + " of " + totalOps,
        { currentChunk: chunkIdx + 1, totalChunks: totalChunks, chunkSize: CHUNK_SIZE });
    }
  }

  if (commandId) {
    sendProgressUpdate(commandId, "batch_bind_variables", "completed", 100, totalOps, totalOps, "All bindings completed");
  }

  return {
    success: failureCount === 0,
    totalBindings: totalOps,
    successCount: successCount,
    failureCount: failureCount,
    results: results,
  };
}

async function setTextStyle(params) {
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

  // Load fonts before applying style
  var style = await figma.getStyleByIdAsync(styleId);
  if (!style) throw new Error("Style not found: " + styleId);
  if (style.type !== "TEXT") throw new Error("Style is not a text style (type: " + style.type + ")");

  // Load the font from the style
  var fontName = style.fontName;
  if (fontName) {
    await figma.loadFontAsync(fontName);
  }

  // Also load current fonts to avoid errors
  if (node.fontName !== figma.mixed) {
    await figma.loadFontAsync(node.fontName);
  } else {
    // Mixed fonts — load all segments
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

async function batchSetTextStyles(params) {
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
    sendProgressUpdate(commandId, "batch_set_text_styles", "started", 0, totalOps, 0, "Starting text style assignments");
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

    chunkPromises = chunk.map(function (assignment) {
      return (async function (a) {
        try {
          const node = await figma.getNodeByIdAsync(a.nodeId);
          if (!node) throw new Error("Node not found: " + a.nodeId);
          if (node.type !== "TEXT") throw new Error("Not a TEXT node: " + a.nodeId + " (type: " + node.type + ")");

          const cachedStyle = styleCache[a.styleId];
          if (!cachedStyle) throw new Error("Style not found or not a text style: " + a.styleId);

          // Load current node fonts
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
      })(assignment);
    });

    chunkResults = await Promise.all(chunkPromises);
    for (ri = 0; ri < chunkResults.length; ri++) {
      results.push(chunkResults[ri]);
      if (chunkResults[ri].success) successCount++;
      else failureCount++;
    }

    if (commandId) {
      processed = Math.min(end, totalOps);
      pct = Math.round((processed / totalOps) * 100);
      sendProgressUpdate(commandId, "batch_set_text_styles", "in_progress", pct, totalOps, processed,
        "Processed " + processed + " of " + totalOps,
        { currentChunk: chunkIdx + 1, totalChunks: totalChunks, chunkSize: CHUNK_SIZE });
    }
  }

  if (commandId) {
    sendProgressUpdate(commandId, "batch_set_text_styles", "completed", 100, totalOps, totalOps, "All style assignments completed");
  }

  return {
    success: failureCount === 0,
    totalAssignments: totalOps,
    successCount: successCount,
    failureCount: failureCount,
    results: results,
  };
}
