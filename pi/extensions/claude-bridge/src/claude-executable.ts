import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { spawn as spawnProcess } from "node:child_process";
import { accessSync, constants as fsConstants, readFileSync, realpathSync, statSync } from "node:fs";
import { DEBUG, debug } from "./debug.js";

// Without a configured path the SDK runs the Claude Code binary it bundles, which
// matches the SDK version. A `claude` on PATH can be older and not know newer
// models, and Claude Code gives an unknown model a 200k window instead of its real one.
export function resolveClaudeExecutable(configured?: string): string | undefined {
	const trimmed = configured?.trim();
	return trimmed ? trimmed : undefined;
}

export type ClaudeExecutableFileType = "elf" | "mach-o" | "pe" | "shebang-script" | "empty" | "unknown";

export interface ClaudeExecutablePreflightResult {
	path: string;
	realPath: string;
	cwd: string;
	realCwd: string;
	fileType: ClaudeExecutableFileType;
}

function errnoValue(error: unknown): string | number | undefined {
	return typeof (error as NodeJS.ErrnoException)?.errno === "number" ? (error as NodeJS.ErrnoException).errno : undefined;
}

function syscallValue(error: unknown): string | undefined {
	return typeof (error as NodeJS.ErrnoException)?.syscall === "string" ? (error as NodeJS.ErrnoException).syscall : undefined;
}

function pathValue(error: unknown): string | undefined {
	const value = (error as NodeJS.ErrnoException)?.path;
	return typeof value === "string" ? value : undefined;
}

function codeValue(error: unknown, fallback: string): string {
	const value = (error as NodeJS.ErrnoException)?.code;
	return typeof value === "string" ? value : fallback;
}

function displayValue(value: unknown): string {
	return value === undefined || value === null || value === "" ? "<none>" : String(value);
}

function makeClaudePreflightError(
	summary: string,
	details: { code: string; errno?: string | number; syscall?: string; path: string; cwd: string; fileType?: ClaudeExecutableFileType; realPath?: string; cause?: unknown },
): Error & NodeJS.ErrnoException & { cwd: string; fileType?: ClaudeExecutableFileType; realPath?: string } {
	const detail = [
		`code=${details.code}`,
		`errno=${displayValue(details.errno)}`,
		`syscall=${displayValue(details.syscall)}`,
		`path=${details.path}`,
		`cwd=${details.cwd}`,
		...(details.fileType ? [`fileType=${details.fileType}`] : []),
		...(details.realPath ? [`realPath=${details.realPath}`] : []),
	].join(" ");
	const error = new Error(`${summary} (${detail})`) as Error & NodeJS.ErrnoException & { cwd: string; fileType?: ClaudeExecutableFileType; realPath?: string };
	error.name = "ClaudeExecutablePreflightError";
	error.code = details.code;
	if (details.errno !== undefined) error.errno = typeof details.errno === "number" ? details.errno : Number(details.errno);
	if (details.syscall) error.syscall = details.syscall;
	error.path = details.path;
	error.cwd = details.cwd;
	if (details.fileType) error.fileType = details.fileType;
	if (details.realPath) error.realPath = details.realPath;
	if (details.cause !== undefined) (error as Error & { cause?: unknown }).cause = details.cause;
	return error;
}

export function classifyClaudeExecutableBytes(bytes: Uint8Array): ClaudeExecutableFileType {
	if (bytes.length === 0) return "empty";
	if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21) return "shebang-script";
	if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return "elf";
	if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return "pe";
	if (bytes.length >= 4) {
		const magic = bytes[0] * 0x1000000 + bytes[1] * 0x10000 + bytes[2] * 0x100 + bytes[3];
		if (
			magic === 0xfeedface ||
			magic === 0xfeedfacf ||
			magic === 0xcefaedfe ||
			magic === 0xcffaedfe ||
			magic === 0xcafebabe ||
			magic === 0xbebafeca
		) return "mach-o";
	}
	return "unknown";
}

export function preflightClaudeExecutable(path: string, cwd: string): ClaudeExecutablePreflightResult {
	let realCwd: string;
	try {
		const cwdStat = statSync(cwd);
		if (!cwdStat.isDirectory()) {
			throw makeClaudePreflightError("Claude Code spawn cwd preflight failed: cwd is not a directory.", {
				code: "ENOTDIR",
				syscall: "chdir",
				path: cwd,
				cwd,
			});
		}
		accessSync(cwd, fsConstants.X_OK);
		realCwd = realpathSync(cwd);
	} catch (error) {
		if ((error as Error).name === "ClaudeExecutablePreflightError") throw error;
		throw makeClaudePreflightError("Claude Code spawn cwd preflight failed: cwd is not reachable before spawning Claude Code.", {
			code: codeValue(error, "EACCES"),
			errno: errnoValue(error),
			syscall: syscallValue(error),
			path: pathValue(error) ?? cwd,
			cwd,
			cause: error,
		});
	}

	let realPath: string;
	try {
		const stat = statSync(path);
		if (!stat.isFile()) {
			throw makeClaudePreflightError("Claude Code executable preflight failed: resolved path is not a file.", {
				code: "EACCES",
				syscall: "exec",
				path,
				cwd,
			});
		}
		accessSync(path, fsConstants.X_OK);
		realPath = realpathSync(path);
	} catch (error) {
		if ((error as Error).name === "ClaudeExecutablePreflightError") throw error;
		throw makeClaudePreflightError("Claude Code executable preflight failed: cannot access resolved executable before spawning Claude Code.", {
			code: codeValue(error, "ENOENT"),
			errno: errnoValue(error),
			syscall: syscallValue(error),
			path: pathValue(error) ?? path,
			cwd,
			cause: error,
		});
	}

	let fileType: ClaudeExecutableFileType;
	try {
		fileType = classifyClaudeExecutableBytes(readFileSync(realPath).subarray(0, 16));
	} catch (error) {
		throw makeClaudePreflightError("Claude Code executable preflight failed: cannot read executable header before spawning Claude Code.", {
			code: codeValue(error, "EACCES"),
			errno: errnoValue(error),
			syscall: syscallValue(error),
			path: pathValue(error) ?? realPath,
			cwd,
			realPath,
			cause: error,
		});
	}

	if (!["elf", "mach-o", "pe", "shebang-script"].includes(fileType)) {
		throw makeClaudePreflightError("Claude Code executable preflight failed: executable header is not an ELF, Mach-O, PE, or shebang script.", {
			code: "ENOEXEC",
			syscall: "exec",
			path,
			cwd,
			fileType,
			realPath,
		});
	}

	return { path, realPath, cwd, realCwd, fileType };
}

function envFlagEnabled(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true";
}

export function wrapClaudeSpawnErrorForSdk(error: Error, options: SpawnOptions): Error & NodeJS.ErrnoException & { cwd: string; originalCode?: string; originalMessage?: string } {
	const originalCode = codeValue(error, "SPAWN_ERROR");
	const originalMessage = error.message;
	const spawnPath = pathValue(error) ?? options.command;
	const cwd = options.cwd ?? process.cwd();
	const detail = [
		`code=${originalCode}`,
		`errno=${displayValue(errnoValue(error))}`,
		`syscall=${displayValue(syscallValue(error))}`,
		`path=${spawnPath}`,
		`cwd=${cwd}`,
		`command=${options.command}`,
	].join(" ");
	const wrapped = new Error(`Claude Code spawn failed: ${originalMessage} (${detail})`) as Error & NodeJS.ErrnoException & { cwd: string; originalCode?: string; originalMessage?: string };
	wrapped.name = "ClaudeSpawnDiagnosticError";
	// The SDK special-cases code === ENOENT and replaces the message with its
	// generic "native binary not found" text. Preserve the original code in the
	// message/originalCode while using a bridge code so the SDK surfaces context.
	wrapped.code = originalCode === "ENOENT" ? "CLAUDE_BRIDGE_SPAWN_FAILED" : originalCode;
	wrapped.originalCode = originalCode;
	wrapped.originalMessage = originalMessage;
	const errno = errnoValue(error);
	if (errno !== undefined) wrapped.errno = typeof errno === "number" ? errno : Number(errno);
	const syscall = syscallValue(error);
	if (syscall) wrapped.syscall = syscall;
	wrapped.path = spawnPath;
	wrapped.cwd = cwd;
	// Do not set `cause` here: the listener copies these structured fields back
	// onto the original Error. A cause reference to that same object would become
	// `err.cause === err`, making JSON.stringify throw on a circular structure.
	// originalMessage plus code/errno/syscall/path/cwd preserve the useful data.
	return wrapped;
}

export function spawnClaudeCodeWithDiagnostics(options: SpawnOptions): SpawnedProcess {
	const pipeStderr = DEBUG || envFlagEnabled(options.env.DEBUG_CLAUDE_AGENT_SDK);
	const child = spawnProcess(options.command, options.args, {
		cwd: options.cwd,
		env: options.env,
		signal: options.signal,
		stdio: ["pipe", "pipe", pipeStderr ? "pipe" : "ignore"],
		windowsHide: true,
	});
	if (pipeStderr) {
		child.stderr?.on("data", (data) => {
			for (const line of data.toString().split(/\r?\n/)) {
				if (line) debug(`[cli-stderr spawn] ${line}`);
			}
		});
	}
	child.prependListener("error", (error) => {
		const originalStack = error.stack;
		const wrapped = wrapClaudeSpawnErrorForSdk(error, options);
		Object.assign(error, wrapped);
		error.name = wrapped.name;
		error.message = wrapped.message;
		// Keep V8's stack from the actual Node spawn failure, not the wrapper
		// construction site. Diagnostic fields above remain enumerable and
		// JSON-serializable; stack stays the spawn-time breadcrumb for operators.
		if (originalStack) error.stack = originalStack;
	});
	// Both are piped above, so Node always creates them.
	const { stdin, stdout } = child;
	if (!stdin || !stdout) throw new Error("claude-spawn-stdio=missing\nThe Claude Code process has no stdin or stdout pipe.");
	return {
		stdin,
		stdout,
		get killed() { return child.killed; },
		get exitCode() { return child.exitCode; },
		kill: child.kill.bind(child),
		on: child.on.bind(child),
		once: child.once.bind(child),
		off: child.off.bind(child),
	};
}
