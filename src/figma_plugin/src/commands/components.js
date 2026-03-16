// Component commands: create, combine, instances, swap, main component, instance overrides

export async function createComponent(params) {
  const { x = 0, y = 0, width = 100, height = 100, name = "Component", parentId } = params || {};

  const component = figma.createComponent();
  component.x = x;
  component.y = y;
  component.resize(width, height);
  component.name = name;

  if (parentId) {
    const parentNode = await figma.getNodeByIdAsync(parentId);
    if (!parentNode) throw new Error("Parent node not found: " + parentId);
    if (!("appendChild" in parentNode)) throw new Error("Parent node does not support children: " + parentId);
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

export async function combineAsVariants(params) {
  const { componentIds, parentId } = params || {};

  if (!componentIds || !Array.isArray(componentIds) || componentIds.length === 0) {
    throw new Error("Missing or empty componentIds array");
  }

  const components = [];
  for (let i = 0; i < componentIds.length; i++) {
    const node = await figma.getNodeByIdAsync(componentIds[i]);
    if (!node) throw new Error("Component not found: " + componentIds[i]);
    if (node.type !== "COMPONENT") throw new Error("Node is not a COMPONENT: " + componentIds[i]);
    components.push(node);
  }

  let parent = figma.currentPage;
  if (parentId) {
    const parentNode = await figma.getNodeByIdAsync(parentId);
    if (!parentNode) throw new Error("Parent node not found: " + parentId);
    parent = parentNode;
  }

  const componentSet = figma.combineAsVariants(components, parent);

  // Enable auto-layout on the COMPONENT_SET so variants don't pile up
  if (componentSet.layoutMode === "NONE") {
    componentSet.layoutMode = "HORIZONTAL";
    componentSet.layoutWrap = "WRAP";
    componentSet.itemSpacing = 20;
    componentSet.counterAxisSpacing = 20;
    componentSet.paddingTop = 40;
    componentSet.paddingRight = 40;
    componentSet.paddingBottom = 40;
    componentSet.paddingLeft = 40;
    componentSet.layoutSizingHorizontal = "HUG";
    componentSet.layoutSizingVertical = "HUG";
  }

  return {
    id: componentSet.id,
    name: componentSet.name,
    type: componentSet.type,
    childCount: componentSet.children.length,
    children: componentSet.children.map((child) => ({ id: child.id, name: child.name, type: child.type })),
  };
}

export async function createComponentInstance(params) {
  const { componentKey, componentId, x = 0, y = 0, parentId } = params || {};

  if (!componentKey && !componentId) {
    throw new Error("Missing componentKey or componentId parameter");
  }

  try {
    let component;
    if (componentId) {
      const node = await figma.getNodeByIdAsync(componentId);
      if (!node) throw new Error("Component node not found: " + componentId);
      if (node.type !== "COMPONENT")
        throw new Error("Node is not a COMPONENT: " + componentId + " (type: " + node.type + ")");
      component = node;
    } else {
      component = await figma.importComponentByKeyAsync(componentKey);
    }

    const instance = component.createInstance();
    instance.x = x;
    instance.y = y;

    if (parentId) {
      const parentNode = await figma.getNodeByIdAsync(parentId);
      if (!parentNode) throw new Error("Parent node not found: " + parentId);
      if (!("appendChild" in parentNode)) throw new Error("Parent node does not support children: " + parentId);
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

export async function importLibraryComponent(params) {
  const componentKey = params && params.componentKey;
  const parentNodeId = params && params.parentNodeId;
  const position = params && params.position;
  const nameOverride = params && params.name;

  if (!componentKey) throw new Error("Missing componentKey parameter");

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
        ", not COMPONENT. You likely used a component set key. Use get_component_variants to find individual variant keys, then import a specific variant.",
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

export async function swapComponentVariant(params) {
  const { instanceId, newVariantId } = params || {};

  if (!instanceId) throw new Error("Missing instanceId parameter");
  if (!newVariantId) throw new Error("Missing newVariantId parameter");

  const instance = await figma.getNodeByIdAsync(instanceId);
  if (!instance) throw new Error("Instance node not found: " + instanceId);
  if (instance.type !== "INSTANCE") throw new Error("Node is not an instance: " + instanceId);

  const newVariant = await figma.getNodeByIdAsync(newVariantId);
  if (!newVariant) throw new Error("Variant component not found: " + newVariantId);
  if (newVariant.type !== "COMPONENT") throw new Error("Target node is not a COMPONENT: " + newVariantId);

  instance.swapComponent(newVariant);

  return {
    success: true,
    instanceId: instance.id,
    instanceName: instance.name,
    newVariantId: newVariant.id,
    newVariantName: newVariant.name,
  };
}

export async function getMainComponent(params) {
  const nodeId = params.nodeId;
  if (!nodeId) throw new Error("Missing nodeId parameter");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);

  if (node.type !== "INSTANCE") {
    throw new Error("Node is not an instance (type: " + node.type + "). Only INSTANCE nodes have a main component.");
  }

  const mainComponent = await node.getMainComponentAsync();
  if (!mainComponent) throw new Error("Could not find main component for instance: " + nodeId);

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

export async function getComponentProperties(params) {
  const { nodeId } = params || {};
  if (!nodeId) throw new Error("Missing nodeId parameter");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
    throw new Error("Node must be a COMPONENT or COMPONENT_SET, got: " + node.type);
  }
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    componentPropertyDefinitions: node.componentPropertyDefinitions,
  };
}

export async function addComponentProperty(params) {
  const { nodeId, name, type, defaultValue, preferredValues } = params || {};
  if (!nodeId) throw new Error("Missing nodeId parameter");
  if (!name) throw new Error("Missing name parameter");
  if (!type) throw new Error("Missing type parameter");
  if (defaultValue === undefined || defaultValue === null) throw new Error("Missing defaultValue parameter");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
    throw new Error("Node must be a COMPONENT or COMPONENT_SET, got: " + node.type);
  }
  const options = {};
  if (preferredValues && Array.isArray(preferredValues)) {
    options.preferredValues = preferredValues;
  }
  const fullName = node.addComponentProperty(name, type, defaultValue, options);
  return {
    id: node.id,
    propertyName: fullName,
    componentPropertyDefinitions: node.componentPropertyDefinitions,
  };
}

export async function editComponentProperty(params) {
  const { nodeId, propertyName, newName, defaultValue, preferredValues } = params || {};
  if (!nodeId) throw new Error("Missing nodeId parameter");
  if (!propertyName) throw new Error("Missing propertyName parameter");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
    throw new Error("Node must be a COMPONENT or COMPONENT_SET, got: " + node.type);
  }
  const edits = {};
  if (newName !== undefined) edits.name = newName;
  if (defaultValue !== undefined) edits.defaultValue = defaultValue;
  if (preferredValues !== undefined) edits.preferredValues = preferredValues;
  node.editComponentProperty(propertyName, edits);
  return {
    id: node.id,
    componentPropertyDefinitions: node.componentPropertyDefinitions,
  };
}

export async function deleteComponentProperty(params) {
  const { nodeId, propertyName } = params || {};
  if (!nodeId) throw new Error("Missing nodeId parameter");
  if (!propertyName) throw new Error("Missing propertyName parameter");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
    throw new Error("Node must be a COMPONENT or COMPONENT_SET, got: " + node.type);
  }
  node.deleteComponentProperty(propertyName);
  return {
    id: node.id,
    componentPropertyDefinitions: node.componentPropertyDefinitions,
  };
}

export async function componentProperties(params) {
  const { nodeId, operations } = params || {};
  if (!nodeId) throw new Error("Missing nodeId parameter");
  if (!operations || !Array.isArray(operations) || operations.length === 0) {
    throw new Error("Missing or empty operations array");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
    throw new Error("Node must be a COMPONENT or COMPONENT_SET, got: " + node.type);
  }

  const results = [];
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    try {
      if (op.action === "add") {
        if (!op.name || !op.type || op.defaultValue === undefined) {
          throw new Error("add requires name, type, and defaultValue");
        }
        const options = {};
        if (op.preferredValues && Array.isArray(op.preferredValues)) {
          options.preferredValues = op.preferredValues;
        }
        const fullName = node.addComponentProperty(op.name, op.type, op.defaultValue, options);
        const addResult = { success: true, action: "add", propertyName: fullName };

        // Auto-bind to target node if targetNodeId is provided
        if (op.targetNodeId) {
          try {
            const targetNode = await figma.getNodeByIdAsync(op.targetNodeId);
            if (!targetNode) throw new Error("Target node not found: " + op.targetNodeId);
            // Auto-detect binding field from property type
            const fieldMap = { BOOLEAN: "visible", TEXT: "characters", INSTANCE_SWAP: "mainComponent" };
            const targetField = op.targetField || fieldMap[op.type];
            if (!targetField) throw new Error("Cannot auto-detect targetField for type: " + op.type);
            const refs = targetNode.componentPropertyReferences || {};
            refs[targetField] = fullName;
            targetNode.componentPropertyReferences = refs;
            addResult.boundTo = { nodeId: op.targetNodeId, field: targetField };
          } catch (bindErr) {
            addResult.bindError = bindErr.message || String(bindErr);
          }
        }

        results.push(addResult);
      } else if (op.action === "edit") {
        if (!op.propertyName) throw new Error("edit requires propertyName");
        const edits = {};
        if (op.newName !== undefined) edits.name = op.newName;
        if (op.defaultValue !== undefined) edits.defaultValue = op.defaultValue;
        if (op.preferredValues !== undefined) edits.preferredValues = op.preferredValues;
        node.editComponentProperty(op.propertyName, edits);
        results.push({ success: true, action: "edit", propertyName: op.propertyName });
      } else if (op.action === "delete") {
        if (!op.propertyName) throw new Error("delete requires propertyName");
        node.deleteComponentProperty(op.propertyName);
        results.push({ success: true, action: "delete", propertyName: op.propertyName });
      } else if (op.action === "bind") {
        if (!op.propertyName) throw new Error("bind requires propertyName (full name with #suffix)");
        if (!op.targetNodeId) throw new Error("bind requires targetNodeId");
        const targetNode = await figma.getNodeByIdAsync(op.targetNodeId);
        if (!targetNode) throw new Error("Target node not found: " + op.targetNodeId);
        // Detect field from property type in definitions, or use explicit targetField
        let targetField = op.targetField;
        if (!targetField) {
          const defs = node.componentPropertyDefinitions;
          const def = defs && defs[op.propertyName];
          if (!def) throw new Error("Property not found in definitions: " + op.propertyName);
          const fieldMap = { BOOLEAN: "visible", TEXT: "characters", INSTANCE_SWAP: "mainComponent" };
          targetField = fieldMap[def.type];
          if (!targetField) throw new Error("Cannot auto-detect targetField for type: " + def.type);
        }
        const refs = targetNode.componentPropertyReferences || {};
        refs[targetField] = op.propertyName;
        targetNode.componentPropertyReferences = refs;
        results.push({
          success: true,
          action: "bind",
          propertyName: op.propertyName,
          boundTo: { nodeId: op.targetNodeId, field: targetField },
        });
      } else {
        throw new Error("Unknown action: " + op.action + ". Use add, edit, or delete, or bind.");
      }
    } catch (e) {
      results.push({ success: false, action: op.action || "unknown", error: e.message || String(e) });
    }
  }

  return {
    id: node.id,
    name: node.name,
    results: results,
    componentPropertyDefinitions: node.componentPropertyDefinitions,
  };
}

export async function setExposedInstance(params) {
  const { nodeId, exposed } = params || {};
  if (!nodeId) throw new Error("Missing nodeId parameter");
  if (exposed === undefined) throw new Error("Missing exposed parameter");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (node.type !== "INSTANCE") {
    throw new Error("Node must be an INSTANCE, got: " + node.type);
  }
  node.isExposedInstance = exposed;
  return { id: node.id, name: node.name, isExposedInstance: node.isExposedInstance };
}

export async function getInstanceOverrides(instanceNode = null) {
  let sourceInstance = null;

  if (instanceNode) {
    if (instanceNode.type !== "INSTANCE") {
      figma.notify("Provided node is not a component instance");
      return { success: false, message: "Provided node is not a component instance" };
    }
    sourceInstance = instanceNode;
  } else {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.notify("Please select at least one instance");
      return { success: false, message: "No nodes selected" };
    }
    const instances = selection.filter((node) => node.type === "INSTANCE");
    if (instances.length === 0) {
      figma.notify("Please select at least one component instance");
      return { success: false, message: "No instances found in selection" };
    }
    sourceInstance = instances[0];
  }

  try {
    const overrides = sourceInstance.overrides || [];
    const mainComponent = await sourceInstance.getMainComponentAsync();
    if (!mainComponent) {
      figma.notify("Failed to get main component");
      return { success: false, message: "Failed to get main component" };
    }

    const returnData = {
      success: true,
      message: `Got component information from "${sourceInstance.name}" for overrides.length: ${overrides.length}`,
      sourceInstanceId: sourceInstance.id,
      mainComponentId: mainComponent.id,
      overridesCount: overrides.length,
    };

    figma.notify(`Got component information from "${sourceInstance.name}"`);
    return returnData;
  } catch (error) {
    figma.notify(`Error: ${error.message}`);
    return { success: false, message: `Error: ${error.message}` };
  }
}

export async function getValidTargetInstances(targetNodeIds) {
  const targetInstances = [];

  if (Array.isArray(targetNodeIds)) {
    if (targetNodeIds.length === 0) return { success: false, message: "No instances provided" };
    for (const targetNodeId of targetNodeIds) {
      const targetNode = await figma.getNodeByIdAsync(targetNodeId);
      if (targetNode && targetNode.type === "INSTANCE") {
        targetInstances.push(targetNode);
      }
    }
    if (targetInstances.length === 0) return { success: false, message: "No valid instances provided" };
  } else {
    return { success: false, message: "Invalid target node IDs provided" };
  }

  return { success: true, message: "Valid target instances provided", targetInstances };
}

export async function getSourceInstanceData(sourceInstanceId) {
  if (!sourceInstanceId) return { success: false, message: "Missing source instance ID" };

  const sourceInstance = await figma.getNodeByIdAsync(sourceInstanceId);
  if (!sourceInstance)
    return { success: false, message: "Source instance not found. The original instance may have been deleted." };
  if (sourceInstance.type !== "INSTANCE")
    return { success: false, message: "Source node is not a component instance." };

  const mainComponent = await sourceInstance.getMainComponentAsync();
  if (!mainComponent) return { success: false, message: "Failed to get main component from source instance." };

  return { success: true, sourceInstance, mainComponent, overrides: sourceInstance.overrides || [] };
}

export async function setInstanceOverrides(targetInstances, sourceResult) {
  try {
    const { sourceInstance, mainComponent, overrides } = sourceResult;

    const results = [];
    let totalAppliedCount = 0;

    for (const targetInstance of targetInstances) {
      try {
        try {
          targetInstance.swapComponent(mainComponent);
        } catch (error) {
          results.push({
            success: false,
            instanceId: targetInstance.id,
            instanceName: targetInstance.name,
            message: `Error: ${error.message}`,
          });
        }

        let appliedCount = 0;

        for (const override of overrides) {
          if (!override.id || !override.overriddenFields || override.overriddenFields.length === 0) continue;

          const overrideNodeId = override.id.replace(sourceInstance.id, targetInstance.id);
          const overrideNode = await figma.getNodeByIdAsync(overrideNodeId);
          if (!overrideNode) continue;

          const sourceNode = await figma.getNodeByIdAsync(override.id);
          if (!sourceNode) continue;

          let fieldApplied = false;
          for (const field of override.overriddenFields) {
            try {
              if (field === "componentProperties") {
                if (sourceNode.componentProperties && overrideNode.componentProperties) {
                  const properties = {};
                  for (const key in sourceNode.componentProperties) {
                    properties[key] = sourceNode.componentProperties[key].value;
                  }
                  overrideNode.setProperties(properties);
                  fieldApplied = true;
                }
              } else if (field === "characters" && overrideNode.type === "TEXT") {
                await figma.loadFontAsync(overrideNode.fontName);
                overrideNode.characters = sourceNode.characters;
                fieldApplied = true;
              } else if (field in overrideNode) {
                overrideNode[field] = sourceNode[field];
                fieldApplied = true;
              }
            } catch (fieldError) {
              console.error(`Error applying field ${field}:`, fieldError);
            }
          }

          if (fieldApplied) appliedCount++;
        }

        if (appliedCount > 0) {
          totalAppliedCount += appliedCount;
          results.push({
            success: true,
            instanceId: targetInstance.id,
            instanceName: targetInstance.name,
            appliedCount,
          });
        } else {
          results.push({
            success: false,
            instanceId: targetInstance.id,
            instanceName: targetInstance.name,
            message: "No overrides were applied",
          });
        }
      } catch (instanceError) {
        results.push({
          success: false,
          instanceId: targetInstance.id,
          instanceName: targetInstance.name,
          message: `Error: ${instanceError.message}`,
        });
      }
    }

    if (totalAppliedCount > 0) {
      const instanceCount = results.filter((r) => r.success).length;
      const message = `Applied ${totalAppliedCount} overrides to ${instanceCount} instances`;
      figma.notify(message);
      return { success: true, message, totalCount: totalAppliedCount, results };
    } else {
      const message = "No overrides applied to any instance";
      figma.notify(message);
      return { success: false, message, results };
    }
  } catch (error) {
    const message = `Error: ${error.message}`;
    figma.notify(message);
    return { success: false, message };
  }
}
