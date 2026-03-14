#!/usr/bin/env bun
/**
 * Extract Claude Code sessions to agent-friendly JSON.
 *
 * Usage:
 *   bun scripts/extract-sessions.ts [options]
 *
 * Options:
 *   --session <id>       Extract a single session by ID
 *   --latest [n]         Extract the n most recent sessions (default: 1)
 *   --all                Extract all sessions
 *   --out <dir>          Output directory (default: .claude/sessions-json)
 *   --include-agents     Include sub-agent sessions
 *   --list               List available sessions (no extraction)
 *   --compact            Omit tool results over 2000 chars (replace with summary)
 *   --no-thinking        Strip thinking blocks entirely
 *   --raw                Output raw JSONL messages (no transformation)
 */

import { readdir, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { parseArgs } from "node:util";

// Auto-detect the session directory based on CWD
function getSessionDir(): string {
	const home = process.env.HOME || "~";
	const projectsDir = join(home, ".claude/projects");
	// The directory name is the CWD with path separators replaced by dashes, leading dash
	const cwd = process.cwd();
	const encoded = cwd.replace(/\//g, "-");
	return join(projectsDir, encoded);
}
const SESSION_DIR = getSessionDir();
const DEFAULT_OUT = join(process.cwd(), ".claude/sessions-json");

// Pre-process argv: convert bare `--latest` to `--latest=1` so parseArgs accepts it
const rawArgv = process.argv.slice(2);
const processedArgv: string[] = [];
for (let i = 0; i < rawArgv.length; i++) {
	if (rawArgv[i] === "--latest") {
		// Check if next arg looks like a number (the optional count)
		const next = rawArgv[i + 1];
		if (next && /^\d+$/.test(next)) {
			processedArgv.push(`--latest=${next}`);
			i++; // skip next
		} else {
			processedArgv.push("--latest=1");
		}
	} else {
		processedArgv.push(rawArgv[i]!);
	}
}

const { values: args } = parseArgs({
	args: processedArgv,
	options: {
		session: { type: "string" },
		latest: { type: "string" },
		all: { type: "boolean", default: false },
		out: { type: "string" },
		"include-agents": { type: "boolean", default: false },
		list: { type: "boolean", default: false },
		compact: { type: "boolean", default: false },
		"no-thinking": { type: "boolean", default: false },
		raw: { type: "boolean", default: false },
	},
	strict: true,
});

interface SessionInfo {
	id: string;
	file: string;
	modified: Date;
	size: number;
	messageCount: number;
	firstUserMessage: string;
	hasSubAgents: boolean;
}

interface ExtractedMessage {
	role: "user" | "assistant" | "system";
	timestamp: string;
	content: ContentBlock[];
	model?: string;
	usage?: { input_tokens: number; output_tokens: number };
	uuid?: string;
	parentUuid?: string;
}

type ContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "tool_use"; id: string; name: string; input: unknown }
	| {
			type: "tool_result";
			tool_use_id: string;
			content: string;
			is_error?: boolean;
	  };

interface ExtractedSession {
	sessionId: string;
	extractedAt: string;
	metadata: {
		cwd: string;
		branch: string;
		version: string;
		messageCount: number;
		toolCallCount: number;
		uniqueTools: string[];
		duration: { start: string; end: string; minutes: number };
	};
	messages: ExtractedMessage[];
	subAgents?: Record<string, ExtractedSession>;
}

async function discoverSessions(): Promise<SessionInfo[]> {
	const entries = await readdir(SESSION_DIR);
	const jsonlFiles = entries.filter((e) => e.endsWith(".jsonl"));

	const sessions: SessionInfo[] = [];
	for (const file of jsonlFiles) {
		const filePath = join(SESSION_DIR, file);
		const id = file.replace(".jsonl", "");
		const fileStat = await stat(filePath);
		const raw = await readFile(filePath, "utf-8");
		const lines = raw.split("\n").filter(Boolean);

		let firstUserMsg = "";
		let msgCount = 0;
		for (const line of lines) {
			try {
				const d = JSON.parse(line);
				if (d.type === "user" || d.type === "assistant") msgCount++;
				if (d.type === "user" && !firstUserMsg) {
					const content = d.message?.content || [];
					for (const block of content) {
						if (
							block.type === "text" &&
							!block.text?.startsWith("<")
						) {
							firstUserMsg = block.text.slice(0, 120);
							break;
						}
					}
				}
			} catch {}
		}

		// Check for sub-agent directory
		const hasSubAgents = entries.includes(id);

		sessions.push({
			id,
			file: filePath,
			modified: fileStat.mtime,
			size: fileStat.size,
			messageCount: msgCount,
			firstUserMessage: firstUserMsg,
			hasSubAgents,
		});
	}

	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return sessions;
}

function parseJsonlToMessages(
	raw: string,
	options: { compact: boolean; noThinking: boolean; rawMode: boolean },
): { messages: ExtractedMessage[]; metadata: Record<string, unknown> } {
	const lines = raw.split("\n").filter(Boolean);
	const messages: ExtractedMessage[] = [];
	let cwd = "";
	let branch = "";
	let version = "";
	let firstTimestamp = "";
	let lastTimestamp = "";
	let toolCallCount = 0;
	const toolNames = new Set<string>();

	for (const line of lines) {
		let d: Record<string, unknown>;
		try {
			d = JSON.parse(line);
		} catch {
			continue;
		}

		const type = d.type as string;

		// Skip non-message types
		if (
			[
				"queue-operation",
				"file-history-snapshot",
				"progress",
				"last-prompt",
			].includes(type)
		)
			continue;

		// Extract metadata from first user message
		if (type === "user" && !cwd) {
			cwd = (d.cwd as string) || "";
			branch = (d.gitBranch as string) || "";
			version = (d.version as string) || "";
		}

		const timestamp = (d.timestamp as string) || "";
		if (!firstTimestamp && timestamp) firstTimestamp = timestamp;
		if (timestamp) lastTimestamp = timestamp;

		if (type === "system") {
			const msg = d.message as
				| { content: string | unknown[] }
				| undefined;
			if (msg) {
				const text =
					typeof msg.content === "string"
						? msg.content
						: JSON.stringify(msg.content);
				messages.push({
					role: "system",
					timestamp,
					content: [{ type: "text", text }],
				});
			}
			continue;
		}

		if (type !== "user" && type !== "assistant") continue;

		const msg = d.message as Record<string, unknown> | undefined;
		if (!msg) continue;

		const role = msg.role as "user" | "assistant";
		const rawContent = (msg.content as unknown[]) || [];
		const content: ContentBlock[] = [];

		for (const block of rawContent) {
			if (typeof block !== "object" || block === null) continue;
			const b = block as Record<string, unknown>;

			switch (b.type) {
				case "text":
					content.push({ type: "text", text: b.text as string });
					break;

				case "thinking":
					if (!options.noThinking) {
						content.push({
							type: "thinking",
							thinking: b.thinking as string,
						});
					}
					break;

				case "tool_use": {
					toolCallCount++;
					const toolName = b.name as string;
					toolNames.add(toolName);
					content.push({
						type: "tool_use",
						id: b.id as string,
						name: toolName,
						input: b.input,
					});
					break;
				}

				case "tool_result": {
					let resultContent: string;
					const rc = b.content;
					if (typeof rc === "string") {
						resultContent = rc;
					} else if (Array.isArray(rc)) {
						resultContent = rc
							.map((item: Record<string, unknown>) =>
								item.type === "text"
									? (item.text as string)
									: `[${item.type}]`,
							)
							.join("\n");
					} else {
						resultContent = JSON.stringify(rc);
					}

					if (
						options.compact &&
						resultContent.length > 2000
					) {
						resultContent = `[truncated: ${resultContent.length} chars] ${resultContent.slice(0, 500)}…`;
					}

					content.push({
						type: "tool_result",
						tool_use_id: b.tool_use_id as string,
						content: resultContent,
						...(b.is_error ? { is_error: true } : {}),
					});
					break;
				}
			}
		}

		if (content.length === 0) continue;

		const extracted: ExtractedMessage = {
			role,
			timestamp,
			content,
		};

		if (role === "assistant") {
			const model = msg.model as string | undefined;
			const usage = msg.usage as
				| { input_tokens: number; output_tokens: number }
				| undefined;
			if (model) extracted.model = model;
			if (usage)
				extracted.usage = {
					input_tokens: usage.input_tokens,
					output_tokens: usage.output_tokens,
				};
		}

		const uuid = d.uuid as string | undefined;
		const parentUuid = d.parentUuid as string | undefined;
		if (uuid) extracted.uuid = uuid;
		if (parentUuid) extracted.parentUuid = parentUuid;

		messages.push(extracted);
	}

	const start = firstTimestamp ? new Date(firstTimestamp) : new Date();
	const end = lastTimestamp ? new Date(lastTimestamp) : new Date();
	const minutes = Math.round((end.getTime() - start.getTime()) / 60000);

	return {
		messages,
		metadata: {
			cwd,
			branch,
			version,
			messageCount: messages.filter(
				(m) => m.role === "user" || m.role === "assistant",
			).length,
			toolCallCount,
			uniqueTools: [...toolNames].sort(),
			duration: {
				start: firstTimestamp,
				end: lastTimestamp,
				minutes,
			},
		},
	};
}

async function extractSession(
	sessionFile: string,
	sessionId: string,
	options: { compact: boolean; noThinking: boolean; rawMode: boolean },
	includeAgents: boolean,
): Promise<ExtractedSession> {
	const raw = await readFile(sessionFile, "utf-8");

	if (options.rawMode) {
		// Raw mode: just parse and return all JSONL lines as messages
		const lines = raw
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
		return {
			sessionId,
			extractedAt: new Date().toISOString(),
			metadata: {
				cwd: "",
				branch: "",
				version: "",
				messageCount: lines.length,
				toolCallCount: 0,
				uniqueTools: [],
				duration: { start: "", end: "", minutes: 0 },
			},
			messages: lines as unknown as ExtractedMessage[],
		};
	}

	const { messages, metadata } = parseJsonlToMessages(raw, options);

	const session: ExtractedSession = {
		sessionId,
		extractedAt: new Date().toISOString(),
		metadata: metadata as ExtractedSession["metadata"],
		messages,
	};

	// Sub-agents — check both <sessionId>/*.jsonl and <sessionId>/subagents/*.jsonl
	if (includeAgents) {
		const sessionDir = join(SESSION_DIR, sessionId);
		const agentJsonls: { id: string; path: string }[] = [];

		try {
			// Check for JSONL files directly in the session dir
			const dirEntries = await readdir(sessionDir);
			for (const f of dirEntries) {
				if (f.endsWith(".jsonl")) {
					agentJsonls.push({
						id: f.replace(".jsonl", ""),
						path: join(sessionDir, f),
					});
				}
			}
			// Check for subagents/ subdirectory
			const subagentsDir = join(sessionDir, "subagents");
			try {
				const subEntries = await readdir(subagentsDir);
				for (const f of subEntries) {
					if (f.endsWith(".jsonl")) {
						agentJsonls.push({
							id: f.replace(".jsonl", ""),
							path: join(subagentsDir, f),
						});
					}
				}
			} catch {
				// No subagents/ dir
			}
		} catch {
			// No session directory at all
		}

		if (agentJsonls.length > 0) {
			session.subAgents = {};
			for (const agent of agentJsonls) {
				const agentRaw = await readFile(agent.path, "utf-8");
				const agentParsed = parseJsonlToMessages(agentRaw, options);
				session.subAgents[agent.id] = {
					sessionId: agent.id,
					extractedAt: new Date().toISOString(),
					metadata:
						agentParsed.metadata as ExtractedSession["metadata"],
					messages: agentParsed.messages,
				};
			}
		}
	}

	return session;
}

async function main() {
	const options = {
		compact: args.compact || false,
		noThinking: args["no-thinking"] || false,
		rawMode: args.raw || false,
	};

	const sessions = await discoverSessions();

	// List mode
	if (args.list) {
		console.log(`Found ${sessions.length} sessions:\n`);
		for (const s of sessions) {
			const date = s.modified.toISOString().slice(0, 16).replace("T", " ");
			const size = (s.size / 1024).toFixed(0) + "KB";
			const agents = s.hasSubAgents ? " [+agents]" : "";
			console.log(
				`  ${s.id}  ${date}  ${size.padStart(7)}  ${s.messageCount} msgs${agents}`,
			);
			if (s.firstUserMessage) {
				console.log(`    "${s.firstUserMessage}"`);
			}
		}
		return;
	}

	// Determine which sessions to extract
	let toExtract: SessionInfo[];
	if (args.session) {
		const match = sessions.find((s) => s.id.startsWith(args.session!));
		if (!match) {
			console.error(`Session not found: ${args.session}`);
			process.exit(1);
		}
		toExtract = [match];
	} else if (args.all) {
		toExtract = sessions;
	} else {
		const n = Number.parseInt(args.latest || "1", 10);
		toExtract = sessions.slice(0, n);
	}

	const outDir = args.out || DEFAULT_OUT;
	await mkdir(outDir, { recursive: true });

	const includeAgents = args["include-agents"] || false;

	for (const s of toExtract) {
		const extracted = await extractSession(
			s.file,
			s.id,
			options,
			includeAgents,
		);
		const outFile = join(outDir, `${s.id}.json`);
		await writeFile(outFile, JSON.stringify(extracted, null, 2));
		const toolCount = extracted.metadata.toolCallCount;
		const msgCount = extracted.metadata.messageCount;
		const agents = extracted.subAgents
			? ` + ${Object.keys(extracted.subAgents).length} sub-agents`
			: "";
		console.log(
			`  ${s.id} → ${msgCount} messages, ${toolCount} tool calls${agents}`,
		);
	}

	console.log(`\nOutput: ${outDir}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
