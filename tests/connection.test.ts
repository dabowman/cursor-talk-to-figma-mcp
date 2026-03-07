import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import type { Subprocess } from "bun";

/**
 * Tests for connection.ts logic by importing the module and exercising
 * connectToFigma, joinChannel, and sendCommandToFigma against a real
 * (minimal) WebSocket server.
 *
 * We use the actual relay server so the tests validate real behavior
 * including message routing and timeouts.
 */

const PORT = 3057;
const BUN = process.execPath;
let relayProcess: Subprocess;

beforeAll(async () => {
  relayProcess = Bun.spawn([BUN, "run", "src/socket.ts"], {
    env: { ...process.env, PORT: String(PORT) },
    stdout: "pipe",
    stderr: "pipe",
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
});

afterAll(() => {
  relayProcess.kill();
});

// We import the connection module dynamically so each describe block
// can get a fresh module state if needed. For now, single import is fine.
// Note: the module reads --server= from process.argv but defaults to localhost.

describe("discoverChannels", () => {
  test("returns empty object when no channels exist", async () => {
    const response = await fetch(`http://localhost:${PORT}/channels`);
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data).toEqual({});
  });

  test("returns channels with client counts after clients join", async () => {
    // Connect a client and join a channel
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    await new Promise((resolve) => {
      ws.onopen = resolve;
    });
    await new Promise((resolve) => {
      ws.onmessage = resolve;
    }); // welcome
    ws.send(JSON.stringify({ type: "join", channel: "discover-test-ch" }));
    await new Promise((resolve) => {
      ws.onmessage = resolve;
    }); // join confirm
    await new Promise((resolve) => {
      ws.onmessage = resolve;
    }); // join result

    const response = await fetch(`http://localhost:${PORT}/channels`);
    const data = await response.json();
    expect(data["discover-test-ch"]).toBeDefined();
    expect(data["discover-test-ch"].clientCount).toBeGreaterThanOrEqual(1);

    ws.close();
    // Wait for close to propagate
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  test("discoverChannels function works", async () => {
    // Connect a client to create a channel
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    await new Promise((resolve) => {
      ws.onopen = resolve;
    });
    await new Promise((resolve) => {
      ws.onmessage = resolve;
    }); // welcome
    ws.send(JSON.stringify({ type: "join", channel: "fn-discover-ch" }));
    await new Promise((resolve) => {
      ws.onmessage = resolve;
    }); // join confirm
    await new Promise((resolve) => {
      ws.onmessage = resolve;
    }); // join result

    const { discoverChannels } = await import("../src/talk_to_figma_mcp/connection.js");
    const channels = await discoverChannels(PORT);
    expect(channels["fn-discover-ch"]).toBeDefined();
    expect(channels["fn-discover-ch"].clientCount).toBeGreaterThanOrEqual(1);

    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});

describe("sendCommandToFigma", () => {
  test("rejects when not connected", async () => {
    // Fresh import — ws starts as null
    const { sendCommandToFigma } = await import("../src/talk_to_figma_mcp/connection.js");

    // Patch connectToFigma to not actually connect (avoid side-effect reconnect)
    // sendCommandToFigma calls connectToFigma() when ws is null, then rejects
    const result = sendCommandToFigma("get_document_info", {});
    await expect(result).rejects.toThrow("Not connected to Figma");
  });

  test("rejects non-join commands when no channel is joined", async () => {
    const { connectToFigma, sendCommandToFigma, pendingRequests } = await import(
      "../src/talk_to_figma_mcp/connection.js"
    );

    connectToFigma(PORT);
    // Wait for connection
    await new Promise((resolve) => setTimeout(resolve, 300));

    const result = sendCommandToFigma("get_document_info", {});
    await expect(result).rejects.toThrow("Must join a channel before sending commands");
    expect(pendingRequests.size).toBe(0);
  });

  test("join command succeeds and sets channel", async () => {
    const { connectToFigma, joinChannel } = await import("../src/talk_to_figma_mcp/connection.js");

    connectToFigma(PORT);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // joinChannel calls sendCommandToFigma("join", ...) internally
    // The relay responds with a system message containing result
    await joinChannel("test-conn-ch");
    // If we get here without throwing, join succeeded
  });

  test("sendCommandToFigma constructs correct message shape", async () => {
    // Connect a spy client to the same channel to observe the message
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    await new Promise((resolve) => {
      ws.onopen = resolve;
    });

    // Read welcome
    await new Promise((resolve) => {
      ws.onmessage = resolve;
    });

    // Join channel
    ws.send(JSON.stringify({ type: "join", channel: "shape-test-ch" }));
    await new Promise((resolve) => {
      ws.onmessage = resolve;
    }); // join confirm
    await new Promise((resolve) => {
      ws.onmessage = resolve;
    }); // join result

    // Now connect the MCP module to the same channel
    const { connectToFigma, joinChannel, sendCommandToFigma } = await import("../src/talk_to_figma_mcp/connection.js");
    connectToFigma(PORT);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await joinChannel("shape-test-ch");

    // Listen for the broadcast that the spy client receives
    const broadcastPromise = new Promise<any>((resolve) => {
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data as string);
        if (data.type === "broadcast" && data.message?.command === "create_rectangle") {
          resolve(data);
        }
      };
    });

    // Send a command (it will time out since no plugin responds, but the message shape is sent)
    const cmdPromise = sendCommandToFigma("create_rectangle", { x: 0, y: 0, width: 100, height: 50 }, 2000);

    const broadcast = await broadcastPromise;

    // Verify message shape
    expect(broadcast.type).toBe("broadcast");
    expect(broadcast.channel).toBe("shape-test-ch");
    expect(broadcast.message.command).toBe("create_rectangle");
    expect(broadcast.message.id).toBeDefined();
    expect(broadcast.message.params.x).toBe(0);
    expect(broadcast.message.params.width).toBe(100);
    expect(broadcast.message.params.commandId).toBe(broadcast.message.id);

    // Respond to the command so it doesn't hang
    ws.send(
      JSON.stringify({
        type: "message",
        channel: "shape-test-ch",
        id: broadcast.message.id,
        message: {
          id: broadcast.message.id,
          result: { id: "node-1", name: "Rectangle 1" },
        },
      }),
    );

    const result = await cmdPromise;
    expect((result as any).id).toBe("node-1");

    ws.close();
  });

  test("request times out and rejects after specified timeout", async () => {
    const { connectToFigma, joinChannel, sendCommandToFigma, pendingRequests } = await import(
      "../src/talk_to_figma_mcp/connection.js"
    );

    connectToFigma(PORT);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await joinChannel("timeout-test-ch");

    const start = Date.now();
    const result = sendCommandToFigma("get_selection", {}, 500); // 500ms timeout

    await expect(result).rejects.toThrow("Request to Figma timed out");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(2000);

    // Pending request should be cleaned up
    // (can't check exact key since UUID is internal, but size should be 0 for this request)
  });

  test("error response from plugin rejects the promise", async () => {
    const spy = new WebSocket(`ws://localhost:${PORT}`);
    await new Promise((resolve) => {
      spy.onopen = resolve;
    });
    await new Promise((resolve) => {
      spy.onmessage = resolve;
    }); // welcome
    spy.send(JSON.stringify({ type: "join", channel: "err-test-ch" }));
    await new Promise((resolve) => {
      spy.onmessage = resolve;
    }); // join confirm
    await new Promise((resolve) => {
      spy.onmessage = resolve;
    }); // join result

    const { connectToFigma, joinChannel, sendCommandToFigma } = await import("../src/talk_to_figma_mcp/connection.js");
    connectToFigma(PORT);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await joinChannel("err-test-ch");

    // Listen for broadcast and respond with error
    spy.onmessage = (event) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "broadcast" && data.message?.command) {
        spy.send(
          JSON.stringify({
            type: "message",
            channel: "err-test-ch",
            id: data.message.id,
            message: {
              id: data.message.id,
              error: "Node not found",
              result: {},
            },
          }),
        );
      }
    };

    const result = sendCommandToFigma("get_node_info", { nodeId: "bad-id" }, 5000);
    await expect(result).rejects.toThrow("Node not found");

    spy.close();
  });
});
