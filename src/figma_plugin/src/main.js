// Main entry point for the Figma plugin
// Bundles into code.js via `bun build`

import { state, sanitizeSymbols } from "./helpers.js";

// Command imports — document
import {
  getDocumentInfo,
  getSelection,
  getNodeInfo,
  getNodesInfo,
  readMyDesign,
  getReactions,
  exportNodeAsImage,
  getNodeTree,
} from "./commands/document.js";

// Command imports — create
import { create } from "./commands/create.js";

// Command imports — apply
import { apply } from "./commands/apply.js";

// Command imports — modify
import {
  moveNode,
  resizeNode,
  renameNode,
  deleteNode,
  deleteMultipleNodes,
  reorderChildren,
  cloneNode,
  cloneAndModify,
} from "./commands/modify.js";

// Command imports — text
import { setTextContent, setMultipleTextContents } from "./commands/text.js";

// Command imports — components
import {
  createComponent,
  combineAsVariants,
  createComponentInstance,
  importLibraryComponent,
  swapComponentVariant,
  getMainComponent,
  getInstanceOverrides,
  getValidTargetInstances,
  getSourceInstanceData,
  setInstanceOverrides,
  getComponentProperties,
  addComponentProperty,
  editComponentProperty,
  deleteComponentProperty,
  setExposedInstance,
  componentProperties,
} from "./commands/components.js";

// Command imports — scan & annotations
import {
  scanTextNodes,
  scanNodesByTypes,
  getAnnotations,
  setAnnotation,
  setMultipleAnnotations,
} from "./commands/scan.js";

// Command imports — find (unified search)
import { find } from "./commands/find.js";

// Command imports — styles & variables
import {
  getStyles,
  getLocalVariables,
  getLocalComponents,
  getDesignSystem,
  createVariables,
  updateVariables,
  createStyles,
  updateStyles,
} from "./commands/styles.js";

// Command imports — lint
import { lintDesign } from "./commands/lint.js";

// Command imports — connections & navigation
import { setDefaultConnector, createConnections, setFocus, setSelections } from "./commands/connections.js";

// ─── Performance ─────────────────────────────────────────────────────────────
figma.skipInvisibleInstanceChildren = true;

// ─── Concurrency Control ─────────────────────────────────────────────────────

var READ_OPS = {
  get_document_info: true,
  get_selection: true,
  get_node_info: true,
  get_nodes_info: true,
  get_node_tree: true,
  read_my_design: true,
  scan_text_nodes: true,
  scan_nodes_by_types: true,
  get_styles: true,
  get_local_variables: true,
  get_local_components: true,
  get_library_variables: true,
  get_library_components: true,
  search_library_components: true,
  get_annotations: true,
  get_reactions: true,
  get_component_variants: true,
  get_instance_overrides: true,
  get_main_component: true,
  get_component_properties: true,
  export_node_as_image: true,
  set_selections: true,
  set_focus: true,
  get_design_system: true,
  lint_design: true,
  find: true,
};

var GLOBAL_OPS = {
  create: true,
  apply: true,
  delete_multiple_nodes: true,
  combine_as_variants: true,
  reorder_children: true,
  create_connections: true,
  set_multiple_text_contents: true,
  set_multiple_annotations: true,
  set_instance_overrides: true,
  create_variables: true,
  update_variables: true,
  create_styles: true,
  update_styles: true,
  component_properties: true,
};

// Node-level write locks
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

// Global mutex
var globalLockQueue = Promise.resolve();

function acquireGlobalLock() {
  var release;
  var prev = globalLockQueue;
  globalLockQueue = new Promise((resolve) => {
    release = resolve;
  });
  return prev.then(() => release);
}

// Concurrency limiter
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
  let result;
  let release;
  try {
    if (command === "lint_design" && params && params.autoFix) {
      // lint_design is read-only by default, but autoFix mutates nodes
      release = await acquireGlobalLock();
      try {
        result = await handleCommand(command, params);
      } finally {
        release();
      }
    } else if (GLOBAL_OPS[command]) {
      release = await acquireGlobalLock();
      try {
        result = await handleCommand(command, params);
      } finally {
        release();
      }
    } else if (!READ_OPS[command] && params && params.nodeId) {
      release = await acquireNodeLock(params.nodeId);
      try {
        result = await handleCommand(command, params);
      } finally {
        release();
      }
    } else {
      result = await handleCommand(command, params);
    }
    figma.ui.postMessage({
      type: "command-result",
      id: id,
      result: sanitizeSymbols(result),
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

// ─── Command Dispatcher ──────────────────────────────────────────────────────

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
    case "get_node_tree":
      if (!params || !params.nodeId) {
        throw new Error("Missing nodeId parameter");
      }
      return await getNodeTree(params);
    case "read_my_design":
      return await readMyDesign();
    case "create":
      return await create(params);
    case "apply":
      return await apply(params);
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
    case "get_design_system":
      return await getDesignSystem();
    case "create_variables":
      return await createVariables(params);
    case "update_variables":
      return await updateVariables(params);
    case "create_styles":
      return await createStyles(params);
    case "update_styles":
      return await updateStyles(params);
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
    case "find":
      return await find(params);
    case "set_multiple_annotations":
      return await setMultipleAnnotations(params);
    case "get_instance_overrides":
      if (params && params.instanceNodeId) {
        const instanceNode = await figma.getNodeByIdAsync(params.instanceNodeId);
        if (!instanceNode) {
          throw new Error(`Instance node not found with ID: ${params.instanceNodeId}`);
        }
        return await getInstanceOverrides(instanceNode);
      }
      return await getInstanceOverrides();

    case "set_instance_overrides":
      if (params && params.targetNodeIds) {
        if (!Array.isArray(params.targetNodeIds)) {
          throw new Error("targetNodeIds must be an array");
        }

        const targetNodes = await getValidTargetInstances(params.targetNodeIds);
        if (!targetNodes.success) {
          figma.notify(targetNodes.message);
          return { success: false, message: targetNodes.message };
        }

        if (params.sourceInstanceId) {
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
    case "clone_and_modify":
      return await cloneAndModify(params);
    case "get_main_component":
      return await getMainComponent(params);
    case "get_component_properties":
      return await getComponentProperties(params);
    case "add_component_property":
      return await addComponentProperty(params);
    case "edit_component_property":
      return await editComponentProperty(params);
    case "delete_component_property":
      return await deleteComponentProperty(params);
    case "set_exposed_instance":
      return await setExposedInstance(params);
    case "component_properties":
      return await componentProperties(params);
    case "lint_design":
      return await lintDesign(params);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// ─── Plugin UI & Message Handling ────────────────────────────────────────────

figma.showUI(__html__, { width: 320, height: 56 });

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
      routeCommand(msg.id, msg.command, msg.params);
      break;
    case "get-file-name":
      figma.ui.postMessage({ type: "file-name", name: figma.root.name });
      break;
  }
};

figma.on("run", ({ command }) => {
  figma.ui.postMessage({ type: "auto-connect" });
});

function updateSettings(settings) {
  if (settings.serverPort) {
    state.serverPort = settings.serverPort;
  }

  figma.clientStorage.setAsync("settings", {
    serverPort: state.serverPort,
  });
}
