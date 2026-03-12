import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { spawn, spawnSync, ChildProcess } from "child_process";
import { HTMLGenerator } from "./html-generator";
import { ClaudeCommand } from "./claude";

function buildLogPaths(logBaseName?: string): { logFile: string; htmlFile: string } {
	const logDir = ".claude-trace";
	if (!fs.existsSync(logDir)) {
		fs.mkdirSync(logDir, { recursive: true });
	}

	const fileBaseName =
		logBaseName || `log-${new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, -5)}`;

	return {
		logFile: path.join(logDir, `${fileBaseName}.jsonl`),
		htmlFile: path.join(logDir, `${fileBaseName}.html`),
	};
}

function getMitmAddonPath(): string {
	const addonPath = path.join(__dirname, "mitm-addon.py");
	if (!fs.existsSync(addonPath)) {
		throw new Error(`mitmproxy addon not found at: ${addonPath}`);
	}
	return addonPath;
}

function getMitmCertificatePath(): string {
	const certPath = path.join(os.homedir(), ".mitmproxy", "mitmproxy-ca-cert.pem");
	if (!fs.existsSync(certPath)) {
		throw new Error(`mitmproxy CA certificate not found at: ${certPath}`);
	}
	return certPath;
}

function ensureMitmdumpInstalled(): void {
	const result = spawnSync("mitmdump", ["--version"], { stdio: "ignore" });
	if (result.status !== 0) {
		throw new Error("mitmdump not found. Install mitmproxy first.");
	}
}

async function getAvailablePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Failed to allocate proxy port"));
				return;
			}
			const port = address.port;
			server.close(() => resolve(port));
		});
		server.on("error", reject);
	});
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const connected = await new Promise<boolean>((resolve) => {
			const socket = net.connect({ host: "127.0.0.1", port }, () => {
				socket.destroy();
				resolve(true);
			});
			socket.on("error", () => resolve(false));
		});
		if (connected) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for proxy on port ${port}`);
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
	return await new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("exit", (code) => resolve(code));
	});
}

export async function runClaudeWithProxy(
	claude: ClaudeCommand,
	claudeArgs: string[],
	includeAllRequests: boolean,
	openInBrowser: boolean,
	logBaseName?: string,
): Promise<void> {
	ensureMitmdumpInstalled();

	const { logFile, htmlFile } = buildLogPaths(logBaseName);
	const addonPath = getMitmAddonPath();
	const mitmCertPath = getMitmCertificatePath();
	const proxyPort = await getAvailablePort();
	const proxyUrl = `http://127.0.0.1:${proxyPort}`;

	console.log(`Using Claude binary: ${claude.displayPath}`);
	console.log("Detected native Claude binary, using proxy capture mode");
	console.log(`Using mitmproxy CA: ${mitmCertPath}`);
	console.log("Logs will be written to:");
	console.log(`  JSONL: ${path.resolve(logFile)}`);
	console.log(`  HTML:  ${path.resolve(htmlFile)}`);

	let mitmStderr = "";
	const mitm = spawn(
		"mitmdump",
		["-q", "--listen-host", "127.0.0.1", "--listen-port", String(proxyPort), "-s", addonPath],
		{
			env: {
				...process.env,
				CLAUDE_TRACE_OUTPUT_FILE: path.resolve(logFile),
				CLAUDE_TRACE_INCLUDE_ALL_REQUESTS: includeAllRequests ? "true" : "false",
			},
			stdio: ["ignore", "ignore", "pipe"],
		},
	);

	mitm.stderr?.on("data", (data) => {
		mitmStderr += data.toString();
	});

	try {
		await waitForPort(proxyPort, 10000);
	} catch (error) {
		mitm.kill("SIGTERM");
		throw error;
	}

	const child = spawn(claude.command, claudeArgs, {
		env: {
			...process.env,
			HTTPS_PROXY: proxyUrl,
			HTTP_PROXY: proxyUrl,
			ALL_PROXY: proxyUrl,
			NODE_EXTRA_CA_CERTS: mitmCertPath,
			SSL_CERT_FILE: mitmCertPath,
		},
		stdio: "inherit",
		cwd: process.cwd(),
	});

	child.on("error", (error: Error) => {
		console.error(`Error starting Claude: ${error.message}`);
		process.exit(1);
	});

	const handleSignal = (signal: string) => {
		console.log(`\nReceived ${signal}, shutting down...`);
		if (child.pid) {
			child.kill(signal as NodeJS.Signals);
		}
		if (mitm.pid) {
			mitm.kill(signal as NodeJS.Signals);
		}
	};

	process.on("SIGINT", () => handleSignal("SIGINT"));
	process.on("SIGTERM", () => handleSignal("SIGTERM"));

	const exitCode = await waitForExit(child);

	if (mitm.pid) {
		mitm.kill("SIGTERM");
	}
	await waitForExit(mitm).catch(() => null);

	if (exitCode !== 0 && mitmStderr.trim()) {
		console.error(mitmStderr.trim());
	}

	if (fs.existsSync(logFile) && fs.statSync(logFile).size > 0) {
		const htmlGenerator = new HTMLGenerator();
		await htmlGenerator.generateHTMLFromJSONL(logFile, htmlFile, includeAllRequests);
		if (openInBrowser) {
			spawn("open", [htmlFile], { detached: true, stdio: "ignore" }).unref();
		}
	}

	if (exitCode && exitCode !== 0) {
		process.exit(exitCode);
	}
}