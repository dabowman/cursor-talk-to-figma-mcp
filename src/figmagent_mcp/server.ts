#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logger } from "./utils.js";
import { connectToFigma } from "./connection.js";
import { server } from "./instance.js";

// Re-export for backwards compatibility
export { server };

// Register all tools and prompts (side-effect imports)
import "./tools/document.js";
import "./tools/create.js";
import "./tools/modify.js";
import "./tools/text.js";
import "./tools/apply.js";
import "./tools/components.js";
import "./tools/export.js";
import "./tools/scan.js";
import "./tools/libraries.js";
import "./tools/comments.js";
import "./prompts/index.js";

// Start the server
async function main() {
  try {
    // Try to connect to Figma socket server
    connectToFigma();
  } catch (error) {
    logger.warn(`Could not connect to Figma initially: ${error instanceof Error ? error.message : String(error)}`);
    logger.warn("Will try to connect when the first command is sent");
  }

  // Start the MCP server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("FigmaMCP server running on stdio");
}

// Run the server
main().catch((error) => {
  logger.error(`Error starting FigmaMCP server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
