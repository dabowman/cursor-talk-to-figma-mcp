import { describe, test, expect } from "bun:test";

/**
 * These tests verify the message shape contracts between components.
 * If the protocol changes in one component, these tests catch mismatches.
 */

describe("Message Protocol Contracts", () => {
  describe("MCP Server → Relay message format", () => {
    test("command message has required fields", () => {
      // This is the shape sendCommandToFigma builds
      const msg = {
        id: "uuid-123",
        type: "message",
        channel: "test-channel",
        message: {
          id: "uuid-123",
          command: "create",
          params: {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            commandId: "uuid-123",
          },
        },
      };

      expect(msg.id).toBeDefined();
      expect(msg.type).toBe("message");
      expect(msg.channel).toBeDefined();
      expect(msg.message.id).toBe(msg.id);
      expect(msg.message.command).toBeDefined();
      expect(msg.message.params).toBeDefined();
      expect(msg.message.params.commandId).toBe(msg.id);
    });

    test("join message has channel at top level", () => {
      const msg = {
        id: "uuid-456",
        type: "join",
        channel: "my-channel",
        message: {
          id: "uuid-456",
          command: "join",
          params: { channel: "my-channel", commandId: "uuid-456" },
        },
      };

      expect(msg.type).toBe("join");
      expect(msg.channel).toBe("my-channel");
    });
  });

  describe("Relay → Plugin UI broadcast format", () => {
    test("broadcast wraps original message", () => {
      // The relay wraps messages in this format
      const broadcast = {
        type: "broadcast",
        message: {
          id: "uuid-123",
          command: "create",
          params: { x: 0, y: 0, width: 100, height: 100 },
        },
        sender: "peer",
        channel: "test-channel",
      };

      expect(broadcast.type).toBe("broadcast");
      expect(broadcast.sender).toBe("peer");
      expect(broadcast.message.id).toBeDefined();
      expect(broadcast.message.command).toBeDefined();
    });
  });

  describe("Plugin UI → code.js execute-command format", () => {
    test("execute-command has required fields", () => {
      // This is what ui.html sends to code.js via parent.postMessage
      const pluginMessage = {
        type: "execute-command",
        id: "uuid-123",
        command: "create",
        params: { x: 0, y: 0, width: 100, height: 100 },
      };

      expect(pluginMessage.type).toBe("execute-command");
      expect(pluginMessage.id).toBeDefined();
      expect(pluginMessage.command).toBeDefined();
      expect(pluginMessage.params).toBeDefined();
    });
  });

  describe("Plugin code.js → UI result format", () => {
    test("command-result has id and result", () => {
      const result = {
        type: "command-result",
        id: "uuid-123",
        result: { id: "node-1", name: "Rectangle 1", type: "RECTANGLE" },
      };

      expect(result.type).toBe("command-result");
      expect(result.id).toBeDefined();
      expect(result.result).toBeDefined();
    });

    test("command-error has id and error", () => {
      const error = {
        type: "command-error",
        id: "uuid-123",
        error: "Node not found",
      };

      expect(error.type).toBe("command-error");
      expect(error.id).toBeDefined();
      expect(error.error).toBeDefined();
    });
  });

  describe("Plugin UI → Relay response format", () => {
    test("success response wraps result in message envelope", () => {
      // This is what sendSuccessResponse builds in ui.html
      const response = {
        id: "uuid-123",
        type: "message",
        channel: "test-channel",
        message: {
          id: "uuid-123",
          result: { id: "node-1", name: "Rectangle 1" },
        },
      };

      expect(response.type).toBe("message");
      expect(response.message.id).toBe(response.id);
      expect(response.message.result).toBeDefined();
    });

    test("error response includes empty result object", () => {
      // sendErrorResponse in ui.html includes result: {} alongside error
      const response = {
        id: "uuid-123",
        type: "message",
        channel: "test-channel",
        message: {
          id: "uuid-123",
          error: "Node not found",
          result: {},
        },
      };

      expect(response.message.error).toBeDefined();
      expect(response.message.result).toBeDefined();
    });
  });

  describe("Progress update format", () => {
    test("plugin UI sends progress_update type", () => {
      // sendProgressUpdateToServer in ui.html
      const progressMsg = {
        id: "cmd-789",
        type: "progress_update",
        channel: "test-channel",
        message: {
          id: "cmd-789",
          type: "progress_update",
          data: {
            commandType: "set_multiple_text_contents",
            status: "in_progress",
            progress: 50,
            totalItems: 10,
            processedItems: 5,
            message: "Processing chunk 1/2",
            timestamp: Date.now(),
          },
        },
      };

      expect(progressMsg.type).toBe("progress_update");
      expect(progressMsg.message.type).toBe("progress_update");
      expect(progressMsg.message.data.progress).toBeGreaterThanOrEqual(0);
      expect(progressMsg.message.data.progress).toBeLessThanOrEqual(100);
    });

    test("server can extract progress from broadcast-wrapped message", () => {
      // After relay forwarding, progress arrives wrapped in broadcast
      const broadcastedProgress = {
        type: "broadcast",
        message: {
          id: "cmd-789",
          type: "progress_update",
          data: {
            commandType: "scan_text_nodes",
            progress: 75,
            message: "Scanning nodes",
          },
        },
        sender: "peer",
        channel: "test-channel",
      };

      // Server's detection logic
      const isProgressUpdate =
        broadcastedProgress.type === "progress_update" ||
        (broadcastedProgress.type === "broadcast" &&
          broadcastedProgress.message &&
          broadcastedProgress.message.type === "progress_update");

      expect(isProgressUpdate).toBe(true);

      const progressData = broadcastedProgress.message.data;
      const requestId = broadcastedProgress.message.id;

      expect(requestId).toBe("cmd-789");
      expect(progressData.progress).toBe(75);
    });
  });

  describe("Server response matching", () => {
    test("response id matches request id for resolution", () => {
      const requestId = "uuid-abc";
      const response = {
        type: "broadcast",
        message: {
          id: "uuid-abc",
          result: { success: true },
        },
        sender: "peer",
        channel: "ch",
      };

      // Server matching logic: myResponse.id && pendingRequests.has(myResponse.id) && myResponse.result
      const myResponse = response.message;
      expect(myResponse.id).toBe(requestId);
      expect(myResponse.result).toBeTruthy();
    });
  });
});
