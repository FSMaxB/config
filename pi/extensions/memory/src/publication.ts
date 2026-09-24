import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertSafePath, ensurePrivateDirectory } from "./config.ts";
import type { Project } from "./project.ts";
import type { Claim } from "./store.ts";
import type { Section } from "./consolidation.ts";
import { renderConsolidation } from "./consolidation.ts";

export interface Artifact { id: string; file: string; hash: string; bytes: number; claimIds: string[]; sourceIds: string[] }
export interface Manifest { version: 1; id: string; epoch: number; revision: number; artifacts: Artifact[] }
export interface Published { manifest: Manifest; contents: Map<string, string> }

export function stageGeneration(agentDir: string, project: Project, epoch: number, revision: number, claims: Claim[], sections: Section[]): Manifest {
  const id = randomUUID();
  const directory = generationDirectory(agentDir, project, id);
  ensurePrivateDirectory(join(directory, "sources"));
  const { summary, handbook } = renderConsolidation(sections);
  const artifacts: Artifact[] = [];
  const add = (artifactId: string, file: string, content: string, selected: Claim[]) => {
    const bytes = Buffer.byteLength(content);
    if (bytes > 32768) throw new Error("Artifact too large");
    const path = join(directory, file);
    writePrivateFile(path, content);
    artifacts.push({ id: artifactId, file, hash: createHash("sha256").update(content).digest("hex"), bytes, claimIds: selected.map(claim => claim.id), sourceIds: [...new Set(selected.flatMap(claim => claim.sourceId ? [claim.sourceId] : []))] });
  };
  add("summary", "memory_summary.md", summary, claims);
  add("handbook", "MEMORY.md", handbook, claims);
  const bySource = new Map<string, Claim[]>();
  for (const claim of claims) if (claim.sourceId) bySource.set(claim.sourceId, [...(bySource.get(claim.sourceId) ?? []), claim]);
  for (const [sourceId, selected] of bySource) {
    if (!/^[a-f0-9]{64}$/.test(sourceId)) throw new Error("Invalid source ID");
    add(`source:${sourceId}`, `sources/${sourceId}.md`, `# Source ${sourceId}\n\n${selected.map(claim => `- [${claim.id}] ${claim.text.replace(/[\r\n]+/g, " ")}`).join("\n")}\n`, selected);
  }
  const manifest: Manifest = { version: 1, id, epoch, revision, artifacts };
  const encoded = JSON.stringify(manifest) + "\n";
  if (artifacts.reduce((total, artifact) => total + artifact.bytes, Buffer.byteLength(encoded)) > 1024 * 1024) throw new Error("Generation too large");
  writePrivateFile(join(directory, "manifest.json"), encoded);
  const descriptor = openSync(directory, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  return manifest;
}

export function manifestHash(manifest: Manifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)+"\n").digest("hex");
}

export function readGeneration(agentDir: string, project: Project, id: string, epoch: number, revision: number, expectedHash?: string): Published {
  const directory = generationDirectory(agentDir, project, id);
  for (const path of [join(agentDir,"memory"),join(agentDir,"memory",project.hash),join(agentDir,"memory",project.hash,"generations"),directory,join(directory,"sources")]) {
    if (!existsSync(path) || !lstatSync(path).isDirectory()) throw new Error("Unsafe memory generation directory");
  }
  const manifestPath = join(directory, "manifest.json");
  const raw = readRegular(manifestPath, 256 * 1024);
  if (expectedHash && createHash("sha256").update(raw).digest("hex") !== expectedHash) throw new Error("Memory manifest hash mismatch");
  const manifest: unknown = JSON.parse(raw);
  if (!validManifest(manifest, id, epoch, revision)) throw new Error("Invalid memory manifest");
  const contents = new Map<string, string>();
  let total = Buffer.byteLength(raw);
  for (const artifact of manifest.artifacts) {
    const content = readRegular(join(directory, artifact.file), 32768);
    total += Buffer.byteLength(content);
    if (Buffer.byteLength(content) !== artifact.bytes || createHash("sha256").update(content).digest("hex") !== artifact.hash || contents.has(artifact.id)) throw new Error("Invalid memory artifact");
    contents.set(artifact.id, content);
  }
  if (total > 1024 * 1024) throw new Error("Memory generation exceeds limit");
  return { manifest, contents };
}

function generationDirectory(agentDir: string, project: Project, id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(id)) throw new Error("Invalid generation ID");
  return join(agentDir, "memory", project.hash, "generations", id);
}
function writePrivateFile(path: string, text: string): void {
  assertSafePath(path);
  const descriptor = openSync(path, "wx", 0o600);
  try { writeFileSync(descriptor, text); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}
function readRegular(path: string, limit: number): string {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).size > limit) throw new Error("Missing or invalid memory artifact");
  return readFileSync(path, "utf8");
}
function validManifest(value: unknown, id: string, epoch: number, revision: number): value is Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Manifest;
  return Object.keys(manifest).sort().join() === "artifacts,epoch,id,revision,version" && manifest.version === 1 && manifest.id === id && manifest.epoch === epoch && manifest.revision === revision && Array.isArray(manifest.artifacts) && manifest.artifacts.length <= 66 && manifest.artifacts.every(artifact => artifact && Object.keys(artifact).sort().join() === "bytes,claimIds,file,hash,id,sourceIds" && (artifact.id === "summary" && artifact.file === "memory_summary.md" || artifact.id === "handbook" && artifact.file === "MEMORY.md" || typeof artifact.id === "string" && /^source:[a-f0-9]{64}$/.test(artifact.id) && artifact.file === `sources/${artifact.id.slice(7)}.md`) && typeof artifact.hash === "string" && /^[a-f0-9]{64}$/.test(artifact.hash) && Number.isInteger(artifact.bytes) && artifact.bytes >= 0 && Array.isArray(artifact.claimIds) && artifact.claimIds.every(claimId => typeof claimId === "string" && /^[mi]-[a-f0-9-]+$/.test(claimId)) && Array.isArray(artifact.sourceIds) && artifact.sourceIds.every(sourceId => typeof sourceId === "string" && /^[a-f0-9]{64}$/.test(sourceId)));
}
