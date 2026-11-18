import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { spawn as spawnProcess } from "node:child_process";
import { accessSync, constants as fsConstants, readFileSync, realpathSync, statSync } from "node:fs";
import { DEBUG, debug } from "./debug.js";
import { nonEmpty } from "../../lib/untyped.ts";

// Without a configured path the SDK runs the Claude Code binary it bundles, which
// matches the SDK version. A `claude` on PATH can be older and not know newer
// models, and Claude Code gives an unknown model a 200k window instead of its real one.
export function resolveClaudeExecutable(configured?: string): string | undefined {
	const trimmed = configured?.trim();
	return nonEmpty(trimmed);
}

export type ClaudeExecutableFileType = "elf" | "mach-o" | "pe" | "shebang-script" | "empty" | "unknown";

export interface ClaudeExecutablePreflightResult {
	path: string;
	realPath: string;
	cwd: string;
	realCwd: string;
	fileType: ClaudeExecutableFileType;
}

// A field of a Node.js system error; anything else has none.
function errorField(error: unknown, name: string): unknown {
	return typeof error === "object" && error !== null ? Reflect.get(error, name) : undefined;
}

function errnoValue(error: unknown): number | undefined {
	const value = errorField(error, "errno");
	return typeof value === "number" ? value : undefined;
}

function syscallValue(error: unknown): string | undefined {
	const value = errorField(error, "syscall");
	return typeof value === "string" ? value : undefined;
}

function pathValue(error: unknown): string | undefined {
	const value = errorField(error, "path");
	return typeof value === "string" ? value : undefined;
}

function codeValue(error: unknown, fallback: string): string {
	const value = errorField(error, "code");
	return typeof value === "string" ? value : fallback;
}

function isPreflightError(error: unknown): boolean {
	return error instanceof Error && error.name === "ClaudeExecutablePreflightError";
}

function displayValue(value: unknown): string {
	if (typeof value === "string") return value === "" ? "<none>" : value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	return value === undefined || value === null ? "<none>" : JSON.stringify(value);
}

function makeClaudePreflightError(
	summary: string,
	details: { code: string; errno?: number; syscall?: string; path: string; cwd: string; fileType?: ClaudeExecutableFileType; realPath?: string; cause?: unknown },
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
	const error = new Error(`${summary} (${detail})`, details.cause === undefined ? undefined : { cause: details.cause });
	error.name = "ClaudeExecutablePreflightError";
	return Object.assign(error, {
		code: details.code,
		...(details.errno !== undefined ? { errno: details.errno } : {}),
		...(details.syscall ? { syscall: details.syscall } : {}),
		path: details.path,
		cwd: details.cwd,
		...(details.fileType ? { fileType: details.fileType } : {}),
		...(details.realPath ? { realPath: details.realPath } : {}),
	});
}

export function classifyClaudeExecutableBytes(bytes: Uint8Array): ClaudeExecutableFileType {
	if (bytes.length === 0) return "empty";
	const header = Buffer.from(bytes);
	const text = header.toString("latin1");
	if (text.startsWith(SHEBANG)) return "shebang-script";
	if (text.startsWith(ELF_MAGIC)) return "elf";
	if (text.startsWith(PE_MAGIC)) return "pe";
	if (header.length >= MACH_O_MAGIC_BYTES && MACH_O_MAGICS.has(header.readUInt32BE(0))) return "mach-o";
	return "unknown";
}

// File signatures as latin1 text, where every byte is one character.
const SHEBANG = "#!";
const ELF_MAGIC = "\x7fELF";
const PE_MAGIC = "MZ";
// Mach-O thin (32- and 64-bit, both byte orders) and fat binaries, read as a big-endian word.
const MachOMagic = {
	Thin32: 0xfeedface,
	Thin64: 0xfeedfacf,
	Thin32Swapped: 0xcefaedfe,
	Thin64Swapped: 0xcffaedfe,
	Fat: 0xcafebabe,
	FatSwapped: 0xbebafeca,
} as const;
const MACH_O_MAGICS: ReadonlySet<number> = new Set(Object.values(MachOMagic));
const MACH_O_MAGIC_BYTES = 4;
// 16 bytes cover every signature above.
const HEADER_BYTES = 16;

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
		if (isPreflightError(error)) throw error;
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
		if (isPreflightError(error)) throw error;
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
		fileType = classifyClaudeExecutableBytes(readFileSync(realPath).subarray(0, HEADER_BYTES));
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

function environmentFlagEnabled(value: string | undefined): boolean {
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
	const wrapped = new Error(`Claude Code spawn failed: ${originalMessage} (${detail})`);
	wrapped.name = "ClaudeSpawnDiagnosticError";
	const errno = errnoValue(error);
	const syscall = syscallValue(error);
	// Do not set `cause` here: the listener copies these structured fields back
	// onto the original Error. A cause reference to that same object would become
	// `err.cause === err`, making JSON.stringify throw on a circular structure.
	// originalMessage plus code/errno/syscall/path/cwd preserve the useful data.
	return Object.assign(wrapped, {
		// The SDK special-cases code === ENOENT and replaces the message with its
		// generic "native binary not found" text. Preserve the original code in the
		// message/originalCode while using a bridge code so the SDK surfaces context.
		code: originalCode === "ENOENT" ? "CLAUDE_BRIDGE_SPAWN_FAILED" : originalCode,
		originalCode,
		originalMessage,
		...(errno !== undefined ? { errno } : {}),
		...(syscall ? { syscall } : {}),
		path: spawnPath,
		cwd,
	});
}

export function spawnClaudeCodeWithDiagnostics(options: SpawnOptions): SpawnedProcess {
	const pipeStderr = DEBUG || environmentFlagEnabled(options.env.DEBUG_CLAUDE_AGENT_SDK);
	const child = spawnProcess(options.command, options.args, {
		cwd: options.cwd,
		env: options.env,
		signal: options.signal,
		stdio: ["pipe", "pipe", pipeStderr ? "pipe" : "ignore"],
		windowsHide: true,
	});
	if (pipeStderr) {
		child.stderr?.on("data", (data: Buffer) => {
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
