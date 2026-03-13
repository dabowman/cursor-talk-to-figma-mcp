import { z } from "zod";
import { server } from "../instance.js";
import { sendCommandToFigma } from "../connection.js";
import { joinChannel, discoverChannels } from "../connection.js";
import { guardOutput, extractJsonSummary } from "../utils.js";

// Node Type Scanning Tool
server.tool(
  "scan_nodes_by_types",
  "Scan for child nodes with specific types. Prefer find() for most searches — it supports more criteria and groups results by ancestor.",
  {
    nodeId: z.string().describe("ID of the node to scan"),
    types: z
      .array(z.string())
      .min(1)
      .describe("Array of node types to find in the child nodes (e.g. ['COMPONENT', 'FRAME'])"),
  },
  async ({ nodeId, types }: any) => {
    try {
      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting node type scanning for types: ${types.join(", ")}...`,
      };

      // Use the plugin's scan_nodes_by_types function
      const result = await sendCommandToFigma("scan_nodes_by_types", {
        nodeId,
        types,
      });

      // Format the response
      if (result && typeof result === "object" && "matchingNodes" in result) {
        const typedResult = result as {
          success: boolean;
          count: number;
          matchingNodes: Array<{
            id: string;
            name: string;
            type: string;
            bbox: {
              x: number;
              y: number;
              width: number;
              height: number;
            };
          }>;
          searchedTypes: Array<string>;
        };

        const summaryText = `Scan completed: Found ${typedResult.count} nodes matching types: ${typedResult.searchedTypes.join(", ")}`;
        const nodesJson = JSON.stringify(typedResult.matchingNodes, null, 2);
        const guarded = guardOutput(nodesJson, {
          metaExtractor: extractJsonSummary,
          toolName: "scan_nodes_by_types",
          narrowingHints: [
            "  • Use find() instead — it supports more criteria and groups results",
            "  • Search a specific subtree instead of a large parent",
          ],
        });

        return {
          content: [
            initialStatus,
            {
              type: "text" as const,
              text: summaryText,
            },
            {
              type: "text" as const,
              text: guarded.text,
            },
          ],
        };
      }

      // If the result is in an unexpected format, return it as is
      return {
        content: [
          initialStatus,
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error scanning nodes by types: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Get Reactions Tool
server.tool(
  "get_reactions",
  "Get Figma Prototyping Reactions from multiple nodes. CRITICAL: The output MUST be processed using the 'reaction_to_connector_strategy' prompt IMMEDIATELY to generate parameters for connector lines via the 'create_connections' tool.",
  {
    nodeIds: z.array(z.string()).min(1).describe("Array of node IDs to get reactions from"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("get_reactions", { nodeIds });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
          {
            type: "text",
            text: "IMPORTANT: You MUST now use the reaction data above and follow the `reaction_to_connector_strategy` prompt to prepare the parameters for the `create_connections` tool call. This is a required next step.",
          },
        ],
        followUp: {
          type: "prompt",
          prompt: "reaction_to_connector_strategy",
        },
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting reactions: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Default Connector Tool
server.tool(
  "set_default_connector",
  "Set a copied connector node as the default connector",
  {
    connectorId: z.string().optional().describe("The ID of the connector node to set as default"),
  },
  async ({ connectorId }: any) => {
    try {
      const result = await sendCommandToFigma("set_default_connector", {
        connectorId,
      });

      return {
        content: [
          {
            type: "text",
            text: `Default connector set: ${JSON.stringify(result)}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting default connector: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Connect Nodes Tool
server.tool(
  "create_connections",
  "Create connections between nodes using the default connector style",
  {
    connections: z
      .array(
        z.object({
          startNodeId: z.string().describe("ID of the starting node"),
          endNodeId: z.string().describe("ID of the ending node"),
          text: z.string().optional().describe("Optional text to display on the connector"),
        }),
      )
      .min(1)
      .describe("Array of node connections to create"),
  },
  async ({ connections }: any) => {
    try {
      if (!connections || connections.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No connections provided",
            },
          ],
        };
      }

      const result = await sendCommandToFigma("create_connections", {
        connections,
      });

      return {
        content: [
          {
            type: "text",
            text: `Created ${connections.length} connections: ${JSON.stringify(result)}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating connections: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Focus Tool
server.tool(
  "set_focus",
  "Set focus on a specific node in Figma by selecting it and scrolling viewport to it",
  {
    nodeId: z.string().describe("The ID of the node to focus on"),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("set_focus", { nodeId });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Focused on node "${typedResult.name}" (ID: ${typedResult.id})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting focus: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Selections Tool
server.tool(
  "set_selections",
  "Set selection to multiple nodes in Figma and scroll viewport to show them",
  {
    nodeIds: z.array(z.string()).min(1).describe("Array of node IDs to select"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("set_selections", { nodeIds });
      const typedResult = result as { selectedNodes: Array<{ name: string; id: string }>; count: number };
      return {
        content: [
          {
            type: "text",
            text: `Selected ${typedResult.count} nodes: ${typedResult.selectedNodes.map((node) => `"${node.name}" (${node.id})`).join(", ")}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting selections: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Join Channel Tool
server.tool(
  "join_channel",
  "Join a channel to communicate with Figma. If no channel name is provided, auto-discovers active channels from the relay and joins if exactly one is found. You usually don't need to call this — the server auto-joins on first command. Call this explicitly when: (1) commands are timing out (connection may have dropped — re-joining reconnects), (2) you need to switch between multiple open Figma files.",
  {
    channel: z.string().describe("The name of the channel to join").default(""),
  },
  async ({ channel }: any) => {
    try {
      if (!channel) {
        // Auto-discover: query relay for active channels
        try {
          const channels = await discoverChannels();
          const channelNames = Object.keys(channels);

          if (channelNames.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No active channels found. Make sure the Figma plugin is running and connected to the relay.",
                },
              ],
            };
          }

          if (channelNames.length === 1) {
            // Exactly one channel — auto-join it
            channel = channelNames[0];
          } else {
            // Multiple channels — ask user to pick
            const listing = channelNames
              .map((name) => `  - ${name} (${channels[name].clientCount} client(s))`)
              .join("\n");
            return {
              content: [
                {
                  type: "text",
                  text: `Multiple active channels found. Please specify which one to join:\n${listing}`,
                },
              ],
            };
          }
        } catch (_discoveryError) {
          return {
            content: [
              {
                type: "text",
                text: `Could not auto-discover channels (is the relay running?). Please provide a channel name manually.`,
              },
            ],
          };
        }
      }

      await joinChannel(channel);
      return {
        content: [
          {
            type: "text",
            text: `Successfully joined channel: ${channel}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error joining channel: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);
