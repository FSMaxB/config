import { randomUUID, createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDirectory, assertSafePath, loadConfiguration, writeProjectActivation } from "./config.ts";
import type { Project } from "./project.ts";
import type { DatabaseSync } from "node:sqlite";
import { readGeneration, manifestHash, type Manifest, type Published } from "./publication.ts";

export interface Claim {
  id: string;
  text: string;
  origin: "manual" | "inferred";
  sourceId: string | null;
}
export interface Job {
  id: string;
  sourceId: string;
  payload: string;
  epoch: number;
  owner: string;
}

export interface ConsolidationTask { owner: string; epoch: number; revision: number; claims: Claim[] }

export class Store {
  private constructor(private database: DatabaseSync, private agentDir: string, private project: Project) {}

  static async open(agentDir: string, project: Project): Promise<Store> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await Store.openOnce(agentDir,project); }
      catch (error) {
        if (!String(error).includes("SQLITE_BUSY") || attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve,25*(attempt+1)));
      }
    }
    throw new Error("Memory store unavailable");
  }

  private static async openOnce(agentDir: string, project: Project): Promise<Store> {
    const directory = join(agentDir, "memory", project.hash);
    ensurePrivateDirectory(directory);
    const path = join(directory, "memory.sqlite");
    assertSafePath(path);
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path, { timeout: 50 });
    try {
      chmodSync(path, 0o600);
      database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
      if (version !== 0 && version !== 1 && version !== 2) throw new Error("Unsupported memory database schema");
      if (version === 0) {
        database.exec(`
          CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), project_root TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0, worker_owner TEXT, worker_until INTEGER);
          CREATE TABLE claims (id TEXT PRIMARY KEY, text TEXT NOT NULL, origin TEXT NOT NULL, source_id TEXT, epoch INTEGER NOT NULL);
          CREATE TABLE claim_support (claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE, source_id TEXT NOT NULL, entry_id TEXT NOT NULL, PRIMARY KEY(claim_id,source_id,entry_id));
          CREATE TABLE sources (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, session_file TEXT NOT NULL, leaf_id TEXT NOT NULL, fingerprint TEXT NOT NULL, epoch INTEGER NOT NULL);
          CREATE TABLE source_entries (source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, entry_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(source_id,entry_id));
          CREATE TABLE jobs (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), payload TEXT NOT NULL, status TEXT NOT NULL, owner TEXT, lease_until INTEGER, retry_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL, reservation_day TEXT, reservation_inputs INTEGER);
          CREATE TABLE tombstones (id TEXT PRIMARY KEY, kind TEXT NOT NULL, fingerprint TEXT, created_at INTEGER NOT NULL);
          CREATE TABLE budget_days (day TEXT PRIMARY KEY, jobs INTEGER NOT NULL DEFAULT 0, inputs INTEGER NOT NULL DEFAULT 0, outputs INTEGER NOT NULL DEFAULT 0);
          CREATE INDEX jobs_pending ON jobs(status,retry_at);
          PRAGMA user_version=1;
        `);
      }
      if (version < 2) database.exec(`
        ALTER TABLE state ADD COLUMN active_generation_id TEXT;
        ALTER TABLE state ADD COLUMN published_revision INTEGER;
        ALTER TABLE state ADD COLUMN changed_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE state ADD COLUMN consolidation_attempts INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE state ADD COLUMN consolidation_retry_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE state ADD COLUMN consolidation_retry_revision INTEGER;
        ALTER TABLE state ADD COLUMN consolidation_failed_revision INTEGER;
        ALTER TABLE state ADD COLUMN consolidation_reservation_day TEXT;
        ALTER TABLE state ADD COLUMN consolidation_reservation_inputs INTEGER;
        ALTER TABLE sources ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE sources ADD COLUMN eligible INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE sources ADD COLUMN supersedes TEXT;
        UPDATE sources SET created_at=cast(strftime('%s','now') AS INTEGER)*1000 WHERE created_at=0;
        CREATE TABLE generations (id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, revision INTEGER NOT NULL, manifest_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE generation_inputs (generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE, claim_id TEXT NOT NULL, PRIMARY KEY(generation_id,claim_id));
        CREATE TABLE usage (source_id TEXT NOT NULL, session_id TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY(source_id,session_id,day));
        CREATE TABLE reader_leases (id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE, until INTEGER NOT NULL);
        CREATE TABLE inference_usage (owner TEXT PRIMARY KEY, kind TEXT NOT NULL, model_id TEXT NOT NULL, reported_input INTEGER, reported_output INTEGER, reserved_input INTEGER NOT NULL, reserved_output INTEGER NOT NULL, day TEXT NOT NULL);
        CREATE TRIGGER claim_added AFTER INSERT ON claims BEGIN UPDATE state SET revision=revision+1,changed_at=cast(strftime('%s','now') AS INTEGER)*1000 WHERE id=1; END;
        CREATE TRIGGER claim_deleted AFTER DELETE ON claims BEGIN UPDATE state SET revision=revision+1,changed_at=cast(strftime('%s','now') AS INTEGER)*1000 WHERE id=1; END;
        CREATE TRIGGER tombstone_added AFTER INSERT ON tombstones BEGIN UPDATE state SET revision=revision+1,changed_at=cast(strftime('%s','now') AS INTEGER)*1000 WHERE id=1; END;
        PRAGMA user_version=2;
      `);
      database.prepare("INSERT OR IGNORE INTO state(id,project_root) VALUES(1,?)").run(project.root);
      if (database.prepare("SELECT project_root FROM state WHERE id=1").get()?.project_root !== project.root) throw new Error("Memory project identity mismatch");
      database.exec("COMMIT");
      const store = new Store(database, agentDir, project);
      store.cleanupGenerations();
      return store;
    } catch (error) {
      if (database.isOpen) {
        try { database.exec("ROLLBACK"); } catch { /* No transaction was opened. */ }
        database.close();
      }
      throw error;
    }
  }

  snapshotToken(): string {
    const state = this.database.prepare("SELECT epoch,revision,active_generation_id FROM state WHERE id=1").get();
    return `${state?.epoch}:${state?.revision}:${state?.active_generation_id}`;
  }
  generationId(): string | undefined {
    const state = this.database.prepare("SELECT active_generation_id,published_revision,revision FROM state WHERE id=1").get();
    return state?.published_revision === state?.revision && typeof state?.active_generation_id === "string" ? state.active_generation_id : undefined;
  }
  published(): Published | undefined {
    this.database.exec("BEGIN IMMEDIATE");
    let lease: string | undefined;
    let state;
    let hash: string | undefined;
    try {
      state = this.database.prepare("SELECT active_generation_id,published_revision,revision,epoch FROM state WHERE id=1").get();
      if (state?.active_generation_id && state.published_revision === state.revision) {
        const row = this.database.prepare("SELECT manifest_hash FROM generations WHERE id=?").get(state.active_generation_id);
        if (!row) throw new Error("Missing memory generation");
        hash = String(row.manifest_hash);
        lease = randomUUID();
        this.database.prepare("INSERT INTO reader_leases(id,generation_id,until) VALUES(?,?,?)").run(lease,state.active_generation_id,Date.now()+300_000);
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    if (!lease || !state) return undefined;
    try {
      const published = readGeneration(this.agentDir,this.project,String(state.active_generation_id),Number(state.epoch),Number(state.revision),hash);
      const inputs = new Set(this.database.prepare("SELECT claim_id FROM generation_inputs WHERE generation_id=?").all(state.active_generation_id).map(row => String(row.claim_id)));
      if (published.manifest.artifacts.some(artifact => artifact.claimIds.some(id => !inputs.has(id)) || artifact.sourceIds.some(id => !this.database.prepare("SELECT 1 FROM sources WHERE id=?").get(id)))) throw new Error("Stale memory generation pointers");
      return published;
    } finally { this.database.prepare("DELETE FROM reader_leases WHERE id=?").run(lease); }
  }
  close(): void { this.database.close(); }
  epoch(): number { return Number(this.database.prepare("SELECT epoch FROM state WHERE id=1").get()?.epoch); }
  sourcePath(sourceId: string): string {
    const row = this.database.prepare("SELECT session_file FROM sources WHERE id=?").get(sourceId);
    return String(row?.session_file ?? "");
  }
  counts(): { pending: number; claims: number } {
    return {
      pending: Number(this.database.prepare("SELECT count(*) AS n FROM jobs WHERE status='pending'").get()?.n),
      claims: Number(this.database.prepare("SELECT count(*) AS n FROM claims").get()?.n),
    };
  }
  claims(): Claim[] {
    return this.database.prepare("SELECT id,text,origin,source_id AS sourceId FROM claims ORDER BY origin DESC,id").all() as unknown as Claim[];
  }
  remember(text: string): string {
    const id = `m-${randomUUID()}`;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("INSERT INTO claims(id,text,origin,source_id,epoch) VALUES(?,?,'manual',NULL,?)").run(id, text, this.epoch());
      this.database.exec("UPDATE state SET revision=revision+1 WHERE id=1");
      this.database.exec("COMMIT");
      return id;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  correct(id: string, text: string): string | undefined {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.suppressClaim(id)) { this.database.exec("COMMIT"); return undefined; }
      const replacement = `m-${randomUUID()}`;
      this.database.prepare("INSERT INTO claims(id,text,origin,source_id,epoch) VALUES(?,?,'manual',NULL,?)").run(replacement,text,this.epoch());
      this.database.exec("COMMIT");
      return replacement;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  forget(id: string): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const removed = this.suppressClaim(id);
      this.database.exec("COMMIT");
      return removed;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  forgetSource(id: string): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const source = this.database.prepare("SELECT fingerprint FROM sources WHERE id=?").get(id);
      if (!source) { this.database.exec("COMMIT"); return false; }
      this.database.prepare("INSERT OR IGNORE INTO tombstones(id,kind,fingerprint,created_at) VALUES(?,'source',?,?)").run(id, source.fingerprint, Date.now());
      this.database.prepare("INSERT OR IGNORE INTO tombstones(id,kind,fingerprint,created_at) SELECT s.session_id || ':' || e.entry_id,'entry',e.fingerprint,? FROM source_entries e JOIN sources s ON s.id=e.source_id WHERE e.source_id=?").run(Date.now(),id);
      this.database.prepare("DELETE FROM claims WHERE source_id=?").run(id);
      this.database.prepare("DELETE FROM jobs WHERE source_id=?").run(id);
      this.database.exec("UPDATE state SET revision=revision+1 WHERE id=1");
      this.database.exec("COMMIT");
      return true;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  reset(): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec("INSERT OR IGNORE INTO tombstones(id,kind,fingerprint,created_at) SELECT id,'source',fingerprint,strftime('%s','now')*1000 FROM sources; INSERT OR IGNORE INTO tombstones(id,kind,fingerprint,created_at) SELECT s.session_id || ':' || e.entry_id,'entry',e.fingerprint,strftime('%s','now')*1000 FROM source_entries e JOIN sources s ON s.id=e.source_id");
      this.database.exec("DELETE FROM claims; DELETE FROM jobs; DELETE FROM source_entries; DELETE FROM sources; UPDATE state SET epoch=epoch+1,revision=revision+1,worker_owner=NULL,worker_until=NULL WHERE id=1; COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  transition(enabled: boolean): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!enabled) this.database.exec("UPDATE state SET epoch=epoch+1,worker_owner=NULL,worker_until=NULL WHERE id=1; UPDATE jobs SET status='pending',owner=NULL,lease_until=NULL WHERE status='running'");
      writeProjectActivation(this.agentDir, this.project, enabled);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  enqueue(sessionId: string, sessionFile: string, leafId: string, payload: string, ancestorIds: Set<string> = new Set()): void {
    const entries = (JSON.parse(payload) as { entries: { id: string; role: string; text: string }[] }).entries;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const allowed = entries.filter(entry => {
        const fingerprint = createHash("sha256").update(`${entry.role}:${entry.text}`).digest("hex");
        return !this.database.prepare("SELECT 1 FROM tombstones WHERE id=? OR (kind='entry' AND fingerprint=?)").get(`${sessionId}:${entry.id}`,fingerprint);
      });
      if (allowed.length) {
        const filtered = JSON.stringify({ entries: allowed });
        const fingerprint = createHash("sha256").update(filtered).digest("hex");
        const id = createHash("sha256").update(`${sessionId}:${leafId}:${fingerprint}`).digest("hex");
        if (!this.database.prepare("SELECT 1 FROM tombstones WHERE id=? OR fingerprint=?").get(id, fingerprint)) {
          const ancestors = this.database.prepare("SELECT id,leaf_id FROM sources WHERE session_id=? ORDER BY created_at DESC,id DESC").all(sessionId);
          const supersedes = ancestors.find(source => ancestorIds.has(String(source.leaf_id)) && source.id !== id)?.id ?? null;
          this.database.prepare("INSERT OR IGNORE INTO sources(id,session_id,session_file,leaf_id,fingerprint,epoch,created_at,supersedes) VALUES(?,?,?,?,?,?,?,?)").run(id, sessionId, sessionFile, leafId, fingerprint, this.epoch(), Date.now(),supersedes);
          for (const source of ancestors) if (ancestorIds.has(String(source.leaf_id)) && source.id !== id) this.database.prepare("DELETE FROM jobs WHERE source_id=? AND status='pending'").run(source.id);
          for (const entry of allowed) this.database.prepare("INSERT OR IGNORE INTO source_entries(source_id,entry_id,fingerprint) VALUES(?,?,?)").run(id,entry.id,createHash("sha256").update(`${entry.role}:${entry.text}`).digest("hex"));
          this.database.prepare("INSERT OR IGNORE INTO jobs(id,source_id,payload,status,epoch,retry_at) VALUES(?, ?, ?, 'pending', ?, ?)").run(id, id, filtered, this.epoch(), Date.now() + 60_000);
        }
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  invalidatePending(sessionId: string, branchIds: Set<string>): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.database.prepare("SELECT j.id,s.leaf_id FROM jobs j JOIN sources s ON s.id=j.source_id WHERE s.session_id=? AND j.status='pending'").all(sessionId)) {
        if (!branchIds.has(String(row.leaf_id))) this.database.prepare("DELETE FROM jobs WHERE id=?").run(row.id);
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  claim(owner: string, limits: { maxJobsPerDay: number; maxInputEstimatedTokensPerDay: number; maxOutputTokensPerDay: number }): Job | undefined {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const locked = this.database.prepare("SELECT worker_owner,worker_until FROM state WHERE id=1").get();
      if (locked?.worker_owner && Number(locked.worker_until) > Date.now()) { this.database.exec("COMMIT"); return undefined; }
      const row = this.database.prepare("SELECT j.id,j.source_id AS sourceId,j.payload,j.epoch FROM jobs j JOIN state s ON s.id=1 WHERE j.epoch=s.epoch AND ((j.status='pending' AND j.retry_at<=?) OR (j.status='running' AND j.lease_until<?)) ORDER BY j.retry_at,j.id LIMIT 1").get(Date.now(), Date.now()) as unknown as Omit<Job,"owner"> | undefined;
      if (!row) { this.database.exec("COMMIT"); return undefined; }
      const day = new Date().toISOString().slice(0, 10);
      const tokens = Math.ceil(Buffer.byteLength(row.payload) / 3) + 4096;
      this.database.prepare("INSERT OR IGNORE INTO budget_days(day) VALUES(?)").run(day);
      const admitted = this.database.prepare("UPDATE budget_days SET jobs=jobs+1,inputs=inputs+?,outputs=outputs+4096 WHERE day=? AND jobs<? AND inputs+?<=? AND outputs+4096<=?").run(tokens, day, limits.maxJobsPerDay, tokens, limits.maxInputEstimatedTokensPerDay, limits.maxOutputTokensPerDay);
      if (!admitted.changes) { this.database.exec("COMMIT"); return undefined; }
      this.database.prepare("UPDATE jobs SET status='running',owner=?,lease_until=?,attempts=attempts+1,reservation_day=?,reservation_inputs=? WHERE id=?").run(owner, Date.now()+180_000, day, tokens, row.id);
      this.database.prepare("UPDATE state SET worker_owner=?,worker_until=? WHERE id=1").run(owner, Date.now()+180_000);
      this.database.exec("COMMIT");
      return { ...row, owner };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  recordUsage(owner: string, kind: "extraction" | "consolidation", modelId: string, usage: { input: number; output: number } | undefined): void {
    if (!usage || !Number.isSafeInteger(usage.input) || usage.input < 0 || !Number.isSafeInteger(usage.output) || usage.output < 0) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (this.database.prepare("SELECT 1 FROM inference_usage WHERE owner=?").get(owner)) { this.database.exec("COMMIT"); return; }
      const row = kind === "extraction" ? this.database.prepare("SELECT j.reservation_day AS day,j.reservation_inputs AS inputs FROM jobs j JOIN state s ON s.worker_owner=j.owner AND s.epoch=j.epoch WHERE j.owner=?").get(owner) : this.database.prepare("SELECT consolidation_reservation_day AS day,consolidation_reservation_inputs AS inputs FROM state WHERE id=1 AND worker_owner=?").get(owner);
      if (!row?.day || !Number.isInteger(row.inputs)) { this.database.exec("COMMIT"); return; }
      this.database.prepare("INSERT INTO inference_usage(owner,kind,model_id,reported_input,reported_output,reserved_input,reserved_output,day) VALUES(?,?,?,?,?,?,4096,?)").run(owner,kind,modelId,usage.input,usage.output,row.inputs,row.day);
      this.database.prepare("UPDATE budget_days SET inputs=inputs-?,outputs=outputs-? WHERE day=?").run(Math.max(0,Number(row.inputs)-Math.min(Number(row.inputs),usage.input)),Math.max(0,4096-Math.min(4096,usage.output)),row.day);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  heartbeat(job: Job): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const held = this.database.prepare("SELECT 1 FROM state WHERE id=1 AND worker_owner=? AND epoch=?").get(job.owner, job.epoch);
      if (!held) { this.database.exec("COMMIT"); return false; }
      const updated = this.database.prepare("UPDATE jobs SET lease_until=? WHERE id=? AND owner=? AND epoch=? AND status='running'").run(Date.now()+180_000,job.id,job.owner,job.epoch);
      this.database.prepare("UPDATE state SET worker_until=? WHERE id=1").run(Date.now()+180_000);
      this.database.exec("COMMIT");
      return updated.changes > 0;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  complete(job: Job, claims: { text: string; evidenceEntryIds: string[] }[]): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = loadConfiguration(this.agentDir, this.project).config.enabled && this.database.prepare("SELECT 1 FROM jobs j JOIN state s ON s.epoch=j.epoch AND s.worker_owner=j.owner JOIN sources source ON source.id=j.source_id AND source.eligible=1 WHERE j.id=? AND j.owner=? AND j.status='running' AND j.lease_until>?").get(job.id, job.owner, Date.now());
      if (!current) { this.database.exec("COMMIT"); return false; }
      this.database.prepare("DELETE FROM claims WHERE source_id=? OR source_id IN (WITH RECURSIVE lineage(id) AS (SELECT supersedes FROM sources WHERE id=? UNION ALL SELECT s.supersedes FROM sources s JOIN lineage l ON s.id=l.id WHERE s.supersedes IS NOT NULL) SELECT id FROM lineage WHERE id IS NOT NULL)").run(job.sourceId,job.sourceId);
      for (const claim of claims) {
        const id = `i-${createHash("sha256").update(`${job.sourceId}:${claim.text}:${claim.evidenceEntryIds.join(',')}`).digest("hex").slice(0,24)}`;
        const suppressed = claim.evidenceEntryIds.some(entryId => this.database.prepare("SELECT 1 FROM tombstones WHERE kind='entry' AND (id=(SELECT session_id FROM sources WHERE id=?) || ':' || ? OR fingerprint=(SELECT fingerprint FROM source_entries WHERE source_id=? AND entry_id=?))").get(job.sourceId,entryId,job.sourceId,entryId));
        if (!suppressed && !this.database.prepare("SELECT 1 FROM tombstones WHERE id=?").get(id)) {
          this.database.prepare("INSERT INTO claims(id,text,origin,source_id,epoch) VALUES(?,?,'inferred',?,?)").run(id,claim.text,job.sourceId,job.epoch);
          for (const entryId of claim.evidenceEntryIds) this.database.prepare("INSERT INTO claim_support(claim_id,source_id,entry_id) VALUES(?,?,?)").run(id,job.sourceId,entryId);
        }
      }
      this.database.prepare("UPDATE jobs SET status='done',payload='',owner=NULL,lease_until=NULL WHERE id=?").run(job.id);
      this.database.prepare("UPDATE state SET worker_owner=NULL,worker_until=NULL WHERE id=1 AND worker_owner=?").run(job.owner);
      this.database.exec("UPDATE state SET revision=revision+1 WHERE id=1; COMMIT");
      return true;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  reserveConsolidation(owner: string, limits: { maxJobsPerDay: number; maxInputEstimatedTokensPerDay: number; maxOutputTokensPerDay: number }, maxInputBytes = 64 * 1024): ConsolidationTask | undefined {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const state = this.database.prepare("SELECT epoch,revision,published_revision,changed_at,worker_owner,worker_until,consolidation_attempts,consolidation_retry_at,consolidation_retry_revision,consolidation_failed_revision FROM state WHERE id=1").get();
      if (!loadConfiguration(this.agentDir,this.project).config.enabled || state?.published_revision === state?.revision || Number(state?.changed_at) + 60_000 > Date.now() || state?.worker_owner && Number(state.worker_until) > Date.now()) { this.database.exec("COMMIT"); return undefined; }
      if (state?.consolidation_failed_revision === state?.revision || (state?.consolidation_retry_revision === state?.revision && Number(state?.consolidation_retry_at) > Date.now())) { this.database.exec("COMMIT"); return undefined; }
      const claims = this.database.prepare("SELECT c.id,c.text,c.origin,c.source_id AS sourceId FROM claims c LEFT JOIN sources s ON s.id=c.source_id LEFT JOIN (SELECT source_id, count(*) AS reads FROM usage GROUP BY source_id) u ON u.source_id=c.source_id ORDER BY CASE WHEN c.origin='manual' THEN 0 ELSE 1 END, coalesce(u.reads,0) DESC, coalesce(s.created_at,0) DESC,c.id LIMIT 256").all() as unknown as Claim[];
      if (!claims.length) {
        this.database.prepare("UPDATE state SET active_generation_id=NULL,published_revision=revision WHERE id=1").run();
        this.database.exec("COMMIT");
        return undefined;
      }
      const selectedSources = new Set<string>();
      let bytes = 2;
      const selected = claims.filter(claim => {
        if (claim.sourceId && !selectedSources.has(claim.sourceId) && selectedSources.size >= 64) return false;
        const addition = Buffer.byteLength(JSON.stringify(claim))+1;
        if (bytes+addition > Math.min(64*1024,maxInputBytes)) return false;
        bytes += addition;
        if (claim.sourceId) selectedSources.add(claim.sourceId);
        return true;
      });
      if (!selected.length) { this.database.exec("COMMIT"); return undefined; }
      const day = new Date().toISOString().slice(0,10);
      const inputs = Math.ceil(Buffer.byteLength(JSON.stringify(selected))/3) + 4096;
      this.database.prepare("INSERT OR IGNORE INTO budget_days(day) VALUES(?)").run(day);
      const admitted = this.database.prepare("UPDATE budget_days SET jobs=jobs+1,inputs=inputs+?,outputs=outputs+4096 WHERE day=? AND jobs<? AND inputs+?<=? AND outputs+4096<=?").run(inputs,day,limits.maxJobsPerDay,inputs,limits.maxInputEstimatedTokensPerDay,limits.maxOutputTokensPerDay);
      if (!admitted.changes) { this.database.exec("COMMIT"); return undefined; }
      this.database.prepare("UPDATE state SET worker_owner=?,worker_until=?,consolidation_reservation_day=?,consolidation_reservation_inputs=?,consolidation_attempts=CASE WHEN consolidation_retry_revision IS NOT NULL AND consolidation_retry_revision!=revision THEN 0 ELSE consolidation_attempts END,consolidation_retry_at=0,consolidation_retry_revision=NULL,consolidation_failed_revision=NULL WHERE id=1").run(owner,Date.now()+180_000,day,inputs);
      this.database.exec("COMMIT");
      return { owner, epoch: Number(state!.epoch), revision: Number(state!.revision), claims: selected };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  heartbeatConsolidation(task: ConsolidationTask): boolean {
    return this.database.prepare("UPDATE state SET worker_until=? WHERE id=1 AND worker_owner=? AND epoch=? AND revision=?").run(Date.now()+180_000,task.owner,task.epoch,task.revision).changes > 0;
  }
  publish(task: ConsolidationTask, manifest: Manifest): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const state = this.database.prepare("SELECT 1 FROM state WHERE id=1 AND worker_owner=? AND epoch=? AND revision=? AND worker_until>?").get(task.owner,task.epoch,task.revision,Date.now());
      if (!state || !loadConfiguration(this.agentDir,this.project).config.enabled || manifest.epoch !== task.epoch || manifest.revision !== task.revision) { this.database.exec("COMMIT"); return false; }
      const artifact = readGeneration(this.agentDir,this.project,manifest.id,task.epoch,task.revision);
      if (manifestHash(artifact.manifest) !== manifestHash(manifest)) throw new Error("Candidate manifest changed");
      const ids = new Set(task.claims.map(claim => claim.id));
      if (artifact.manifest.artifacts.some(item => item.claimIds.some(id => !ids.has(id)))) throw new Error("Generation references unselected claims");
      const current = this.database.prepare(`SELECT id FROM claims WHERE id IN (${task.claims.map(() => "?").join(",")})`).all(...task.claims.map(claim => claim.id));
      if (current.length !== task.claims.length) { this.database.exec("COMMIT"); return false; }
      this.database.prepare("INSERT INTO generations(id,epoch,revision,manifest_hash,created_at) VALUES(?,?,?,?,?)").run(manifest.id,task.epoch,task.revision,manifestHash(manifest),Date.now());
      for (const claim of task.claims) this.database.prepare("INSERT INTO generation_inputs(generation_id,claim_id) VALUES(?,?)").run(manifest.id,claim.id);
      this.database.prepare("UPDATE state SET active_generation_id=?,published_revision=?,worker_owner=NULL,worker_until=NULL,consolidation_attempts=0,consolidation_retry_at=0,consolidation_retry_revision=NULL,consolidation_failed_revision=NULL WHERE id=1").run(manifest.id,task.revision);
      this.database.exec("COMMIT");
      return true;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  releaseConsolidation(task: ConsolidationTask): void {
    this.database.prepare("UPDATE state SET worker_owner=NULL,worker_until=NULL WHERE id=1 AND worker_owner=? AND epoch=?").run(task.owner,task.epoch);
  }
  failConsolidation(task: ConsolidationTask): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const state = this.database.prepare("SELECT consolidation_attempts FROM state WHERE id=1 AND worker_owner=? AND epoch=? AND revision=?").get(task.owner,task.epoch,task.revision);
      if (state) {
        const attempts = Number(state.consolidation_attempts) + 1;
        this.database.prepare("UPDATE state SET worker_owner=NULL,worker_until=NULL,consolidation_attempts=?,consolidation_retry_at=?,consolidation_retry_revision=?,consolidation_failed_revision=? WHERE id=1").run(attempts,Date.now()+[60_000,300_000,1_800_000][Math.min(attempts-1,2)],task.revision,attempts >= 3 ? task.revision : null);
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  expireSources(now = Date.now()): number {
    const threshold = now - 30*24*60*60*1000;
    const day = new Date(threshold).toISOString().slice(0,10);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const sources = this.database.prepare("SELECT s.id FROM sources s WHERE s.eligible=1 AND s.created_at<? AND NOT EXISTS (SELECT 1 FROM usage u WHERE u.source_id=s.id AND u.day>=?)").all(threshold,day);
      for (const source of sources) {
        this.database.prepare("INSERT OR IGNORE INTO tombstones(id,kind,fingerprint,created_at) SELECT id,'source',fingerprint,? FROM sources WHERE id=?").run(now,source.id);
        this.database.prepare("INSERT OR IGNORE INTO tombstones(id,kind,fingerprint,created_at) SELECT s.session_id || ':' || e.entry_id,'entry',e.fingerprint,? FROM source_entries e JOIN sources s ON s.id=e.source_id WHERE s.id=?").run(now,source.id);
        this.database.prepare("DELETE FROM claims WHERE source_id=?").run(source.id);
        this.database.prepare("DELETE FROM jobs WHERE source_id=? AND status!='running'").run(source.id);
        this.database.prepare("UPDATE sources SET eligible=0 WHERE id=?").run(source.id);
      }
      this.database.exec("COMMIT");
      return sources.length;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  recordRetrieval(sessionId: string, sourceIds: string[]): void {
    const day = new Date().toISOString().slice(0,10);
    for (const id of sourceIds) this.database.prepare("INSERT OR IGNORE INTO usage(source_id,session_id,day) VALUES(?,?,?)").run(id,sessionId,day);
  }
  release(job: Job): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE jobs SET status='pending',owner=NULL,lease_until=NULL,retry_at=? WHERE id=? AND owner=? AND epoch=?").run(Date.now()+60_000,job.id,job.owner,job.epoch);
      this.database.prepare("UPDATE state SET worker_owner=NULL,worker_until=NULL WHERE id=1 AND worker_owner=?").run(job.owner);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  defer(job: Job): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const reservation = this.database.prepare("SELECT reservation_day,reservation_inputs FROM jobs WHERE id=? AND owner=? AND epoch=?").get(job.id,job.owner,job.epoch);
      if (reservation?.reservation_day) this.database.prepare("UPDATE budget_days SET jobs=jobs-1,inputs=inputs-?,outputs=outputs-4096 WHERE day=?").run(reservation.reservation_inputs,reservation.reservation_day);
      this.database.prepare("UPDATE jobs SET status='pending',owner=NULL,lease_until=NULL,retry_at=?,attempts=MAX(0,attempts-1),reservation_day=NULL,reservation_inputs=NULL WHERE id=? AND owner=? AND epoch=?").run(Date.now()+60_000,job.id,job.owner,job.epoch);
      this.database.prepare("UPDATE state SET worker_owner=NULL,worker_until=NULL WHERE id=1 AND worker_owner=?").run(job.owner);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  private suppressClaim(id: string): boolean {
    const support = this.database.prepare("SELECT s.session_id,e.entry_id,e.fingerprint FROM claim_support c JOIN source_entries e ON e.source_id=c.source_id AND e.entry_id=c.entry_id JOIN sources s ON s.id=c.source_id WHERE c.claim_id=?").all(id);
    for (const row of support) {
      this.database.prepare("INSERT OR IGNORE INTO tombstones(id,kind,fingerprint,created_at) VALUES(?,'entry',?,?)").run(`${row.session_id}:${row.entry_id}`,row.fingerprint,Date.now());
      this.database.prepare("DELETE FROM claims WHERE id IN (SELECT claim_id FROM claim_support WHERE source_id IN (SELECT source_id FROM source_entries WHERE fingerprint=?))").run(row.fingerprint);
    }
    const result = this.database.prepare("DELETE FROM claims WHERE id=?").run(id);
    if (result.changes || support.length) this.database.prepare("INSERT OR IGNORE INTO tombstones(id,kind,created_at) VALUES(?,'claim',?)").run(id,Date.now());
    return result.changes > 0 || support.length > 0;
  }
  fail(job: Job): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT attempts FROM jobs WHERE id=? AND owner=? AND epoch=?").get(job.id,job.owner,job.epoch);
      if (row) {
        const attempts = Number(row.attempts);
        this.database.prepare("UPDATE jobs SET status=?,payload=CASE WHEN ?>=3 THEN '' ELSE payload END,owner=NULL,lease_until=NULL,retry_at=? WHERE id=?").run(attempts>=3 ? "failed" : "pending", attempts, Date.now()+[60_000,300_000,1_800_000][Math.min(attempts-1,2)],job.id);
      }
      this.database.prepare("UPDATE state SET worker_owner=NULL,worker_until=NULL WHERE id=1 AND worker_owner=?").run(job.owner);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  cleanupGenerations(): void {
    const directory = join(this.agentDir,"memory",this.project.hash,"generations");
    if (!existsSync(directory)) return;
    if (!lstatSync(directory).isDirectory()) throw new Error("Unsafe memory generations directory");
    const stale: string[] = [];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM reader_leases WHERE until<?").run(Date.now());
      const state = this.database.prepare("SELECT active_generation_id,published_revision,revision,epoch FROM state WHERE id=1").get();
      const rows = this.database.prepare("SELECT id,epoch FROM generations ORDER BY created_at DESC,id DESC").all();
      const active = state && state.published_revision === state.revision ? state.active_generation_id : null;
      const previous = active ? rows.find(row => row.id !== active && row.epoch === state?.epoch)?.id : null;
      for (const row of rows) {
        if (row.id === active || row.id === previous || this.database.prepare("SELECT 1 FROM reader_leases WHERE generation_id=?").get(row.id)) continue;
        this.database.prepare("DELETE FROM generations WHERE id=?").run(row.id);
        stale.push(String(row.id));
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    for (const id of stale) this.removeGeneration(directory,id);
    for (const id of readdirSync(directory)) {
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(id)) throw new Error("Unsafe memory generation entry");
      const path = join(directory,id);
      if (!lstatSync(path).isDirectory()) throw new Error("Unsafe memory generation entry");
      if (!this.database.prepare("SELECT 1 FROM generations WHERE id=?").get(id) && Date.now()-statSync(path).mtimeMs > 3600_000) this.removeGeneration(directory,id);
    }
  }
  private removeGeneration(directory: string, id: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(id)) throw new Error("Unsafe generation ID");
    const path = join(directory,id);
    if (!existsSync(path)) return;
    if (!lstatSync(path).isDirectory()) throw new Error("Unsafe memory generation entry");
    rmSync(path,{ recursive:true,force:true });
  }
}
