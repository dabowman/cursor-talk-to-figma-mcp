export interface FigmaResponse {
  id: string;
  result?: any;
  error?: string;
}

export interface CommandProgressUpdate {
  type: "command_progress";
  commandId: string;
  commandType: string;
  status: "started" | "in_progress" | "completed" | "error";
  progress: number;
  totalItems: number;
  processedItems: number;
  currentChunk?: number;
  totalChunks?: number;
  chunkSize?: number;
  message: string;
  payload?: any;
  timestamp: number;
}

export interface getInstanceOverridesResult {
  success: boolean;
  message: string;
  sourceInstanceId: string;
  mainComponentId: string;
  overridesCount: number;
}

export interface setInstanceOverridesResult {
  success: boolean;
  message: string;
  totalCount?: number;
  results?: Array<{
    success: boolean;
    instanceId: string;
    instanceName: string;
    appliedCount?: number;
    message?: string;
  }>;
}

export type FigmaCommand =
  | "get_document_info"
  | "get_selection"
  | "get_node_tree"
  | "create"
  | "apply"
  | "move_node"
  | "resize_node"
  | "delete_node"
  | "delete_multiple_nodes"
  | "get_styles"
  | "get_local_variables"
  | "get_local_components"
  | "create_component"
  | "combine_as_variants"
  | "create_component_instance"
  | "get_instance_overrides"
  | "set_instance_overrides"
  | "swap_component_variant"
  | "export_node_as_image"
  | "join"
  | "rename_node"
  | "clone_node"
  | "set_text_content"
  | "scan_text_nodes"
  | "set_multiple_text_contents"
  | "get_annotations"
  | "set_annotation"
  | "set_multiple_annotations"
  | "scan_nodes_by_types"
  | "get_reactions"
  | "set_default_connector"
  | "create_connections"
  | "set_focus"
  | "set_selections"
  | "reorder_children"
  | "clone_and_modify"
  | "get_main_component"
  | "get_component_properties"
  | "add_component_property"
  | "edit_component_property"
  | "delete_component_property"
  | "set_exposed_instance"
  | "import_library_component"
  | "get_design_system"
  | "create_variables"
  | "update_variables"
  | "create_styles"
  | "update_styles"
  | "lint_design";
