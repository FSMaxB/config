import { randomUUID, createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDirectory, assertSafePath, loadConfiguration, writeProjectActivation } from "./config.ts";
import type { Project } from "./project.ts";
import type { DatabaseSync } from "node:sqlite";

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

export class Store {
  private constructor(private database: DatabaseSync, private agentDir: string, private project: Project) {}

  static async open(agentDir: string, project: Project): Promise<Store> {
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
      if (version !== 0 && version !== 1) throw new Error("Unsupported memory database schema");
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
      database.prepare("INSERT OR IGNORE INTO state(id,project_root) VALUES(1,?)").run(project.root);
      if (database.prepare("SELECT project_root FROM state WHERE id=1").get()?.project_root !== project.root) throw new Error("Memory project identity mismatch");
      database.exec("COMMIT");
      return new Store(database, agentDir, project);
    } catch (error) {
      if (database.isOpen) {
        try { database.exec("ROLLBACK"); } catch { /* No transaction was opened. */ }
        database.close();
      }
      throw error;
    }
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
    const old = this.database.prepare("SELECT id FROM claims WHERE id=?").get(id);
    if (!old) return undefined;
    this.forget(id);
    return this.remember(text);
  }
  forget(id: string): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const support = this.database.prepare("SELECT s.session_id, e.entry_id, e.fingerprint FROM claim_support c JOIN source_entries e ON e.source_id=c.source_id AND e.entry_id=c.entry_id JOIN sources s ON s.id=c.source_id WHERE c.claim_id=?").all(id);
      for (const row of support) {
        this.database.prepare("INSERT OR IGNORE INTO tombstones(id,kind,fingerprint,created_at) VALUES(?,'entry',?,?)").run(`${row.session_id}:${row.entry_id}`,row.fingerprint,Date.now());
        this.database.prepare("DELETE FROM claims WHERE id IN (SELECT claim_id FROM claim_support WHERE source_id IN (SELECT source_id FROM source_entries WHERE fingerprint=?))").run(row.fingerprint);
      }
      const result = this.database.prepare("DELETE FROM claims WHERE id=?").run(id);
      if (result.changes || support.length) {
        this.database.prepare("INSERT OR IGNORE INTO tombstones(id,kind,created_at) VALUES(?,'claim',?)").run(id, Date.now());
        this.database.exec("UPDATE state SET revision=revision+1 WHERE id=1");
      }
      this.database.exec("COMMIT");
      return result.changes > 0 || support.length > 0;
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
  enqueue(sessionId: string, sessionFile: string, leafId: string, payload: string): void {
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
          this.database.prepare("INSERT OR IGNORE INTO sources(id,session_id,session_file,leaf_id,fingerprint,epoch) VALUES(?,?,?,?,?,?)").run(id, sessionId, sessionFile, leafId, fingerprint, this.epoch());
          for (const entry of allowed) this.database.prepare("INSERT OR IGNORE INTO source_entries(source_id,entry_id,fingerprint) VALUES(?,?,?)").run(id,entry.id,createHash("sha256").update(`${entry.role}:${entry.text}`).digest("hex"));
          this.database.prepare("INSERT OR IGNORE INTO jobs(id,source_id,payload,status,epoch,retry_at) VALUES(?, ?, ?, 'pending', ?, ?)").run(id, id, filtered, this.epoch(), Date.now() + 60_000);
        }
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
      const current = loadConfiguration(this.agentDir, this.project).config.enabled && this.database.prepare("SELECT 1 FROM jobs j JOIN state s ON s.epoch=j.epoch AND s.worker_owner=j.owner WHERE j.id=? AND j.owner=? AND j.status='running' AND j.lease_until>?").get(job.id, job.owner, Date.now());
      if (!current) { this.database.exec("COMMIT"); return false; }
      this.database.prepare("DELETE FROM claims WHERE source_id=?").run(job.sourceId);
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
}
