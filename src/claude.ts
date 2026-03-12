import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export interface ClaudeCommand {
	command: string;
	displayPath: string;
	kind: "node-script" | "native-binary";
}

function detectClaudeKind(filePath: string): "node-script" | "native-binary" {
	if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) {
		return "node-script";
	}

	try {
		const fd = fs.openSync(filePath, "r");
		const buffer = Buffer.alloc(256);
		let bytesRead = 0;
		try {
			bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
		} finally {
			fs.closeSync(fd);
		}
		const header = buffer.subarray(0, bytesRead).toString("utf-8");
		if (header.startsWith("#!") && header.includes("node")) {
			return "node-script";
		}
	} catch {
		return "native-binary";
	}

	return "native-binary";
}

function resolvePath(filePath: string): string {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return filePath;
	}
}

function extractWrappedExecutable(filePath: string): string {
	const resolvedPath = resolvePath(filePath);

	if (!fs.existsSync(resolvedPath)) {
		return resolvedPath;
	}

	let content: string;
	try {
		content = fs.readFileSync(resolvedPath, "utf-8");
	} catch {
		return resolvedPath;
	}

	if (content.startsWith("#!/bin/bash") || content.startsWith("#!/bin/sh")) {
		const execMatch = content.match(/exec\s+"([^"]+)"/);
		if (execMatch && execMatch[1]) {
			return resolvePath(execMatch[1]);
		}
	}

	return resolvedPath;
}

function findClaudeFromPath(): string | null {
	const result = spawnSync("which", ["claude"], {
		encoding: "utf-8",
	});

	if (result.status !== 0) {
		return null;
	}

	const claudePath = result.stdout.trim();
	if (!claudePath) {
		return null;
	}

	const aliasMatch = claudePath.match(/:\s*aliased to\s+(.+)$/);
	return aliasMatch?.[1] ?? claudePath;
}

function getFallbackClaudePaths(): string[] {
	const home = os.homedir();
	return [
		path.join(home, ".claude", "local", "claude"),
		path.join(home, ".claude", "local", "node_modules", ".bin", "claude"),
		path.join(home, ".bun", "bin", "claude"),
		path.join(home, ".bun", "install", "global", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
	];
}

export function resolveClaudeCommand(customPath?: string): ClaudeCommand {
	if (customPath) {
		if (!fs.existsSync(customPath)) {
			throw new Error(`Claude binary not found at specified path: ${customPath}`);
		}

		const command = extractWrappedExecutable(customPath);
		return { command, displayPath: command, kind: detectClaudeKind(command) };
	}

	const pathClaude = findClaudeFromPath();
	if (pathClaude) {
		const command = extractWrappedExecutable(pathClaude);
		return { command, displayPath: command, kind: detectClaudeKind(command) };
	}

	for (const fallbackPath of getFallbackClaudePaths()) {
		if (fs.existsSync(fallbackPath)) {
			const command = extractWrappedExecutable(fallbackPath);
			return { command, displayPath: command, kind: detectClaudeKind(command) };
		}
	}

	throw new Error(`Claude CLI not found in PATH or common install locations`);
}

export function appendNodeOptions(...values: Array<string | undefined>): string {
	return [process.env.NODE_OPTIONS, ...values].filter(Boolean).join(" ").trim();
}