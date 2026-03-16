import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";
import { logger } from "./utils.js";
import type { FigmaCommand, FigmaResponse, CommandProgressUpdate } from "./types.js";

// WebSocket connection and request tracking
let ws: WebSocket | null = null;
export const pendingRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
    lastActivity: number;
  }
>();

// Track which channel each client is in
let currentChannel: string | null = null;
// Port of the active relay connection (needed for channel discovery inside sendCommandToFigma)
let activePort: number = 3055;

// Add command line argument parsing
const args = process.argv.slice(2);
const serverArg = args.find((arg) => arg.startsWith("--server="));
const serverUrl = serverArg ? serverArg.split("=")[1] : "localhost";
const WS_URL = serverUrl === "localhost" ? `ws://${serverUrl}` : `wss://${serverUrl}`;

export function connectToFigma(port: number = 3055) {
  // If already connected, do nothing
  if (ws && ws.readyState === WebSocket.OPEN) {
    logger.info("Already connected to Figma");
    return;
  }

  activePort = port;
  const wsUrl = serverUrl === "localhost" ? `${WS_URL}:${port}` : WS_URL;
  logger.info(`Connecting to Figma socket server at ${wsUrl}...`);
  ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    logger.info("Connected to Figma socket server");
    // Reset channel on new connection
    currentChannel = null;
  });

  ws.on("message", (data: any) => {
    try {
      // Define a more specific type with an index signature to allow any property access
      interface ProgressMessage {
        message: FigmaResponse | any;
        type?: string;
        id?: string;
        [key: string]: any;
      }

      const json = JSON.parse(data) as ProgressMessage;

      // Handle progress updates (may arrive directly or wrapped in a broadcast by the relay)
      const isProgressUpdate =
        json.type === "progress_update" ||
        (json.type === "broadcast" && json.message && json.message.type === "progress_update");
      if (isProgressUpdate) {
        const progressData = json.message.data as CommandProgressUpdate;
        const requestId = json.message.id || json.id || "";

        if (requestId && pendingRequests.has(requestId)) {
          const request = pendingRequests.get(requestId)!;

          // Update last activity timestamp
          request.lastActivity = Date.now();

          // Reset the timeout to prevent timeouts during long-running operations
          clearTimeout(request.timeout);

          // Create a new timeout
          request.timeout = setTimeout(() => {
            if (pendingRequests.has(requestId)) {
              logger.error(`Request ${requestId} timed out after extended period of inactivity`);
              pendingRequests.delete(requestId);
              request.reject(new Error("Request to Figma timed out"));
            }
          }, 60000); // 60 second timeout for inactivity

          // Log progress
          logger.info(
            `Progress update for ${progressData.commandType}: ${progressData.progress}% - ${progressData.message}`,
          );

          // For completed updates, we could resolve the request early if desired
          if (progressData.status === "completed" && progressData.progress === 100) {
            // Instead, just log the completion, wait for final result from Figma
            logger.info(`Operation ${progressData.commandType} completed, waiting for final result`);
          }
        }
        return;
      }

      // Handle regular responses
      const myResponse = json.message;
      logger.debug(`Received message: ${JSON.stringify(myResponse)}`);
      logger.log("myResponse" + JSON.stringify(myResponse));

      // Handle response to a request
      if (myResponse.id && pendingRequests.has(myResponse.id) && myResponse.result) {
        const request = pendingRequests.get(myResponse.id)!;
        clearTimeout(request.timeout);

        if (myResponse.error) {
          logger.error(`Error from Figma: ${myResponse.error}`);
          request.reject(new Error(myResponse.error));
        } else {
          if (myResponse.result) {
            request.resolve(myResponse.result);
          }
        }

        pendingRequests.delete(myResponse.id);
      } else {
        // Handle broadcast messages or events
        logger.info(`Received broadcast message: ${JSON.stringify(myResponse)}`);
      }
    } catch (error) {
      logger.error(`Error parsing message: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ws.on("error", (error) => {
    logger.error(`Socket error: ${error}`);
  });

  ws.on("close", () => {
    logger.info("Disconnected from Figma socket server");
    ws = null;

    // Reject all pending requests
    for (const [id, request] of pendingRequests.entries()) {
      clearTimeout(request.timeout);
      request.reject(new Error("Connection closed"));
      pendingRequests.delete(id);
    }

    // Attempt to reconnect
    logger.info("Attempting to reconnect in 2 seconds...");
    setTimeout(() => connectToFigma(port), 2000);
  });
}

// Discover active channels from the relay's HTTP endpoint
export async function discoverChannels(port: number = 3055): Promise<Record<string, { clientCount: number }>> {
  const url = serverUrl === "localhost" ? `http://${serverUrl}:${port}/channels` : `https://${serverUrl}/channels`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to discover channels: ${response.statusText}`);
  }
  return response.json() as Promise<Record<string, { clientCount: number }>>;
}

// Function to join a channel
export async function joinChannel(channelName: string): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected to Figma");
  }

  try {
    await sendCommandToFigma("join", { channel: channelName });
    currentChannel = channelName;
    logger.info(`Joined channel: ${channelName}`);
  } catch (error) {
    logger.error(`Failed to join channel: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// Auto-discover and join the sole active channel, or throw a descriptive error.
async function autoJoinChannel(): Promise<void> {
  const channels = await discoverChannels(activePort);
  const names = Object.keys(channels);
  if (names.length === 1) {
    await joinChannel(names[0]);
    logger.info(`Auto-joined channel: ${names[0]}`);
  } else if (names.length > 1) {
    const listing = names.map((n) => `  • ${n}`).join("\n");
    throw new Error(`Multiple Figma files are open. Call join_channel with the file you want:\n${listing}`);
  } else {
    throw new Error("No active Figma channels found. Make sure the Figma plugin is open and connected.");
  }
}

// Function to send commands to Figma
export function sendCommandToFigma(
  command: FigmaCommand,
  params: unknown = {},
  timeoutMs: number = 30000,
): Promise<unknown> {
  // If not connected, kick off reconnect and fail fast
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectToFigma();
    return Promise.reject(new Error("Not connected to Figma. Attempting to connect..."));
  }

  // For non-join commands with no channel, attempt auto-join first then send
  const requiresChannel = command !== "join";
  const channelReady: Promise<void> = requiresChannel && !currentChannel ? autoJoinChannel() : Promise.resolve();

  return channelReady.then(
    () =>
      new Promise((resolve, reject) => {
        const id = uuidv4();
        const request = {
          id,
          type: command === "join" ? "join" : "message",
          ...(command === "join" ? { channel: (params as any).channel } : { channel: currentChannel }),
          message: {
            id,
            command,
            params: {
              ...(params as any),
              commandId: id,
            },
          },
        };

        const timeout = setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            logger.error(`Request ${id} to Figma timed out after ${timeoutMs / 1000} seconds`);
            // Invalidate the current channel so the next command
            // triggers auto-join and re-discovers available channels.
            if (currentChannel) {
              logger.info(`Invalidating stale channel "${currentChannel}" after timeout`);
              currentChannel = null;
            }
            reject(new Error("Request to Figma timed out"));
          }
        }, timeoutMs);

        pendingRequests.set(id, {
          resolve,
          reject,
          timeout,
          lastActivity: Date.now(),
        });

        logger.info(`Sending command to Figma: ${command}`);
        logger.debug(`Request details: ${JSON.stringify(request)}`);
        ws.send(JSON.stringify(request));
      }),
  );
}
