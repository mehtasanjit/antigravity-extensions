// The local record: our own SQLite file, so calls survive even when agy deletes or rewinds rows.
// Every scan re-reads only databases that changed, and saves each call once:
//   r:<response ID>                 an answered call (a /fork copy repeats the ID, so it's kept once)
//   i:<conversation>:<row>:<hash>   a failed call, or one without a response ID (a reused row number
//                                   after a rewind has different bytes, so both calls are kept)
//   c:<conversation>:<step>         a compaction
// Rows that disappear from agy's database stay here: they were made, and billed.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { READER_VERSION, discoverDataFolders, fingerprint, readConversation, readSummaries } from "./agy.mjs";

// One record per device, shared by the command line and the Hub plugin.
// AGY_LOCAL_TELEMETRY_STORE moves it. A record from before the rename is moved here once.
export function defaultStorePath() {
  const override = process.env.AGY_LOCAL_TELEMETRY_STORE || process.env.LOCAL_TELEMETRY_STORE;
  if (override) return override;
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const path = join(base, "agy-local-telemetry", "record.sqlite");
  const old = join(base, "antigravity-local-telemetry", "local_telemetry.sqlite");
  if (!existsSync(path) && existsSync(old)) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(old + suffix)) renameSync(old + suffix, path + suffix);
      if (readdirSync(dirname(old)).length === 0) rmSync(dirname(old), { recursive: true });
    } catch {
      return old; // can't move it (e.g. read-only): keep using it where it is
    }
  }
  return path;
}

export const NO_WORKSPACE = "(no workspace)";
const OUTSIDE_PROJECT = "outside-of-project";
const NO_PROJECT = new Set([OUTSIDE_PROJECT, "default-cli-project"]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY, surface TEXT, client_name TEXT, data_folder TEXT,
  session_id TEXT, parent_conversation_id TEXT, subagent_type TEXT,
  project_id TEXT, workspace_folders TEXT, git_root TEXT, git_remote TEXT, git_branch TEXT,
  repo_key TEXT, repo_name TEXT, scanned_at INTEGER);
CREATE TABLE IF NOT EXISTS calls (
  call_key TEXT PRIMARY KEY, conversation_id TEXT, session_id TEXT, kind TEXT,
  row_idx INTEGER, response_id TEXT, turn_id TEXT, model TEXT, ts INTEGER, ts_estimated INTEGER,
  input INTEGER, cache_read INTEGER, output INTEGER, thinking INTEGER,
  failed INTEGER, error TEXT, first_seen_at INTEGER, last_seen_at INTEGER);
CREATE INDEX IF NOT EXISTS calls_ts ON calls(ts);
CREATE TABLE IF NOT EXISTS sources (path TEXT PRIMARY KEY, fingerprint TEXT, scanned_at INTEGER);
`;

// Opens the record. Where its folder can't be written (an agent's sandbox, a read-only home), a
// temporary record is used instead: it's rebuilt from Antigravity's files on the spot, so reports
// are the same, only nothing is kept between runs. `store.fallbackFrom` says when that happened.
export function openStore(path) {
  try {
    return openAt(path);
  } catch (error) {
    const temp = join(tmpdir(), `agy-local-telemetry-${process.getuid?.() ?? "user"}`, "record.sqlite");
    if (temp === path) throw error;
    const store = openAt(temp);
    store.fallbackFrom = { path, reason: error.code || error.message };
    return store;
  }
}

function openAt(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // The CLI and the Hub plugin can use the record at the same time.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  // Columns added after the first version.
  const have = new Set(db.prepare("PRAGMA table_info(conversations)").all().map((c) => c.name));
  if (!have.has("title")) db.exec("ALTER TABLE conversations ADD COLUMN title TEXT");
  // A newer reader reads every conversation again once (calls merge by key; nothing is lost).
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  // A file that exists but can't be written opens read-only: a real write finds that out now, not mid-scan.
  db.prepare("INSERT INTO meta (key, value) VALUES ('opened_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(new Date().toISOString());
  const version = db.prepare("SELECT value FROM meta WHERE key = 'reader_version'").get()?.value;
  if (version !== String(READER_VERSION)) {
    db.exec("DELETE FROM sources");
    db.prepare("INSERT INTO meta (key, value) VALUES ('reader_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(READER_VERSION));
  }
  return db;
}

const fileUrlPath = (u) => (u ? decodeURIComponent(String(u).replace(/^file:\/\//, "")) : null);
const normaliseRemote = (r) =>
  r
    .trim()
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");

// Repository → folder → nothing. With several folders, one with a git remote is preferred.
function repositoryOf(conv, summary) {
  const g = conv.git.find((e) => e.remote) ?? conv.git.find((e) => e.root);
  const folders = conv.folders.length ? conv.folders : (summary?.workspaceUris ?? []);
  if (g?.remote) {
    const key = normaliseRemote(g.remote);
    return { key, name: g.remoteName || key.split("/").slice(-2).join("/"), root: fileUrlPath(g.root), remote: g.remote, branch: g.branch };
  }
  if (g?.root) {
    const root = fileUrlPath(g.root);
    return { key: root, name: basename(root), root, remote: null, branch: g.branch };
  }
  if (folders[0]) {
    const f = fileUrlPath(folders[0]);
    return { key: f, name: basename(f), root: null, remote: null, branch: null };
  }
  const outside = summary?.projectId === OUTSIDE_PROJECT;
  return { key: NO_WORKSPACE, name: outside ? "(outside project)" : NO_WORKSPACE, root: null, remote: null, branch: null };
}

export function scan(store, { geminiDir } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "agy-local-telemetry-"));
  const now = Date.now();
  const results = [];
  const getSource = store.prepare("SELECT fingerprint FROM sources WHERE path = ?");
  const putSource = store.prepare(
    "INSERT INTO sources (path, fingerprint, scanned_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET fingerprint = excluded.fingerprint, scanned_at = excluded.scanned_at",
  );
  const putConversation = store.prepare(`
    INSERT INTO conversations (conversation_id, surface, client_name, data_folder, session_id, parent_conversation_id,
      subagent_type, project_id, workspace_folders, git_root, git_remote, git_branch, repo_key, repo_name, scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET surface = excluded.surface, client_name = excluded.client_name,
      data_folder = excluded.data_folder, session_id = excluded.session_id, parent_conversation_id = excluded.parent_conversation_id,
      subagent_type = excluded.subagent_type, project_id = excluded.project_id, workspace_folders = excluded.workspace_folders,
      git_root = excluded.git_root, git_remote = excluded.git_remote, git_branch = excluded.git_branch,
      repo_key = excluded.repo_key, repo_name = excluded.repo_name, scanned_at = excluded.scanned_at`);
  const hasCall = store.prepare("SELECT 1 FROM calls WHERE call_key = ?");
  const putCall = store.prepare(`
    INSERT INTO calls (call_key, conversation_id, session_id, kind, row_idx, response_id, turn_id, model, ts, ts_estimated,
      input, cache_read, output, thinking, failed, error, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(call_key) DO UPDATE SET model = COALESCE(excluded.model, calls.model), turn_id = COALESCE(excluded.turn_id, calls.turn_id),
      ts = CASE WHEN excluded.ts_estimated = 0 OR calls.ts IS NULL THEN excluded.ts ELSE calls.ts END,
      ts_estimated = CASE WHEN excluded.ts_estimated = 0 OR calls.ts IS NULL THEN excluded.ts_estimated ELSE calls.ts_estimated END,
      input = excluded.input, cache_read = excluded.cache_read, output = excluded.output, thinking = excluded.thinking,
      failed = excluded.failed, error = excluded.error, last_seen_at = excluded.last_seen_at`);
  const setSummary = store.prepare("UPDATE conversations SET project_id = COALESCE(?, project_id), title = COALESCE(?, title) WHERE conversation_id = ?");

  try {
    for (const folder of discoverDataFolders(geminiDir)) {
      const r = { folder: folder.name, surface: folder.surface, label: folder.label, conversations: 0, read: 0, unchanged: 0, errors: [], newCalls: 0, updatedCalls: 0 };
      let summaries = new Map();
      try {
        summaries = readSummaries(folder.path, tmp);
      } catch (e) {
        r.errors.push(`conversation_summaries.db: ${e.message}`);
      }
      const dir = join(folder.path, "conversations");
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".db"))) {
        r.conversations++;
        const file = join(dir, name);
        const id = name.slice(0, -3);
        const summary = summaries.get(id);
        const print = fingerprint(file);
        if (getSource.get(file)?.fingerprint === print) {
          r.unchanged++;
          if (summary) setSummary.run(summary.projectId, summary.title, id);
          continue;
        }
        let conv;
        try {
          conv = readConversation(file, tmp);
        } catch (e) {
          r.errors.push(`${id}: ${e.message}`);
          continue;
        }
        const repo = repositoryOf(conv, summary);
        const sessionId = conv.topLevelId || conv.parentId || summary?.parentId || id;
        const fallbackTs = summary?.lastModifiedMs ?? Math.floor(statSync(file).mtimeMs);
        store.exec("BEGIN");
        try {
          putConversation.run(
            id, folder.surface, folder.client, folder.name, sessionId, conv.parentId || summary?.parentId || null,
            conv.subagentType || summary?.agentName || null, summary?.projectId ?? null,
            JSON.stringify(conv.folders.length ? conv.folders : (summary?.workspaceUris ?? [])),
            repo.root, repo.remote, repo.branch, repo.key, repo.name, now,
          );
          setSummary.run(summary?.projectId ?? null, summary?.title ?? null, id);
          for (const c of conv.calls) {
            const key =
              c.kind === "compaction" ? `c:${id}:${c.idx}` : !c.failed && c.responseId ? `r:${c.responseId}` : `i:${id}:${c.idx}:${c.hash}`;
            const isNew = !hasCall.get(key);
            putCall.run(
              key, id, sessionId, c.kind, c.idx, c.responseId, c.turn ?? null, c.model ?? null,
              c.ts ?? fallbackTs, c.ts == null ? 1 : 0,
              c.input, c.cacheRead, c.output, c.thinking, c.failed ? 1 : 0, c.error, now, now,
            );
            isNew ? r.newCalls++ : r.updatedCalls++;
          }
          putSource.run(file, print, now);
          store.exec("COMMIT");
          r.read++;
        } catch (e) {
          store.exec("ROLLBACK");
          r.errors.push(`${id}: ${e.message}`);
        }
      }
      results.push(r);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return results;
}

export { NO_PROJECT };
