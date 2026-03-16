import { z } from "zod";
import { server } from "../instance.js";
import { sendCommandToFigma } from "../connection.js";

// Rename Node Tool
server.tool(
  "rename_node",
  "Rename any node in Figma. Essential for setting variant names (e.g. 'Layout=Activity') on components inside a COMPONENT_SET.",
  {
    nodeId: z.string().describe("The ID of the node to rename"),
    name: z.string().describe("The new name for the node"),
  },
  async ({ nodeId, name }: any) => {
    try {
      const result = await sendCommandToFigma("rename_node", { nodeId, name });
      const typedResult = result as { id: string; oldName: string; newName: string; type: string };
      return {
        content: [
          {
            type: "text",
            text: `Renamed ${typedResult.type} "${typedResult.oldName}" → "${typedResult.newName}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error renaming node: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Move Node Tool
server.tool(
  "move_node",
  "Move a node to a new x/y position in Figma. NOTE: This only changes coordinates, NOT parent hierarchy. To reparent a node, use clone_and_modify(nodeId, parentId=newParent) + delete_node(originalId).",
  {
    nodeId: z.string().describe("The ID of the node to move"),
    x: z.number().describe("New X position"),
    y: z.number().describe("New Y position"),
  },
  async ({ nodeId, x, y }: any) => {
    try {
      const result = await sendCommandToFigma("move_node", { nodeId, x, y });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Moved node "${typedResult.name}" to position (${x}, ${y})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error moving node: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Clone Node Tool
server.tool(
  "clone_node",
  "Clone an existing node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to clone"),
    x: z.number().optional().describe("New X position for the clone"),
    y: z.number().optional().describe("New Y position for the clone"),
  },
  async ({ nodeId, x, y }: any) => {
    try {
      const result = await sendCommandToFigma("clone_node", { nodeId, x, y });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Cloned node "${typedResult.name}" with new ID: ${typedResult.id}${x !== undefined && y !== undefined ? ` at position (${x}, ${y})` : ""}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error cloning node: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Resize Node Tool
server.tool(
  "resize_node",
  "Resize a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to resize"),
    width: z.number().positive().describe("New width"),
    height: z.number().positive().describe("New height"),
  },
  async ({ nodeId, width, height }: any) => {
    try {
      const result = await sendCommandToFigma("resize_node", {
        nodeId,
        width,
        height,
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Resized node "${typedResult.name}" to width ${width} and height ${height}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error resizing node: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Delete Node Tool
server.tool(
  "delete_node",
  "Delete a node from Figma. Do NOT delete TEXT nodes to change font properties — use apply with fontFamily/fontWeight/fontSize instead.",
  {
    nodeId: z.string().describe("The ID of the node to delete"),
  },
  async ({ nodeId }: any) => {
    try {
      await sendCommandToFigma("delete_node", { nodeId });
      return {
        content: [
          {
            type: "text",
            text: `Deleted node with ID: ${nodeId}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting node: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Delete Multiple Nodes Tool
server.tool(
  "delete_multiple_nodes",
  "Delete multiple nodes from Figma at once",
  {
    nodeIds: z.array(z.string()).min(1).describe("Array of node IDs to delete"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("delete_multiple_nodes", { nodeIds });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting multiple nodes: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Reorder Children Tool
server.tool(
  "reorder_children",
  "Reorder children within a parent frame. Provide the ordered array of child IDs — children will be reordered to match this sequence.",
  {
    parentId: z.string().describe("The ID of the parent frame"),
    childIds: z
      .array(z.string())
      .min(1)
      .describe(
        "Ordered array of child node IDs. First ID becomes the first child (bottom-most layer). Children not listed keep their relative position at the end.",
      ),
  },
  async ({ parentId, childIds }: any) => {
    try {
      const result = await sendCommandToFigma("reorder_children", { parentId, childIds });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error reordering children: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Clone and Modify Tool
server.tool(
  "clone_and_modify",
  "Clone an existing node and optionally modify the clone's properties in one call. Clone is placed in the same parent as original by default. Also used to reparent nodes (no reparent tool exists): clone_and_modify(nodeId, parentId=newParent) + delete_node(originalId). Clones preserve all instance overrides.",
  {
    nodeId: z.string().describe("Node ID to clone"),
    parentId: z.string().optional().describe("Parent ID for the clone (default: same parent as original)"),
    name: z.string().optional().describe("New name for the clone"),
    x: z.number().optional().describe("X position for the clone"),
    y: z.number().optional().describe("Y position for the clone"),
    fillColor: z
      .object({
        r: z.number().min(0).max(1),
        g: z.number().min(0).max(1),
        b: z.number().min(0).max(1),
        a: z.number().min(0).max(1).optional(),
      })
      .optional()
      .describe("Fill color in RGBA format (0-1)"),
    cornerRadius: z.number().min(0).optional().describe("Corner radius"),
  },
  async ({ nodeId, parentId, name, x, y, fillColor, cornerRadius }: any) => {
    try {
      const result = await sendCommandToFigma("clone_and_modify", {
        nodeId,
        parentId,
        name,
        x,
        y,
        fillColor,
        cornerRadius,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error cloning and modifying: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);
