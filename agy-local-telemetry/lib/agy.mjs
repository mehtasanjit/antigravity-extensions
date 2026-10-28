// Reads Antigravity's on-device data folders (~/.gemini/antigravity*), which every surface
// writes in the same layout:
//   <data folder>/conversations/<conversation id>.db   one SQLite database per conversation
//   <data folder>/conversation_summaries.db            one row per conversation (project, folders)
// Seen on this machine: `antigravity` (AGY 2.0 / Hub) and `antigravity-cli` (agy CLI). The IDE
// extension starts agy itself; any other `antigravity*` folder holding `conversations/` is read too.
//
// Field paths used (undocumented; matched against agy's own printed totals):
//   gen_metadata row (one per model call):
//     1.4.2 input tokens, excluding cached · 1.4.5 cache read · 1.4.3 output, including thinking
//     1.4.9 thinking · 1.19 model · 1.4.11 response ID · 4 turn ID · 5 error text (failed call)
//   steps.metadata: 1 start · 8 end (timestamps) · 12 turn ID
//   CHECKPOINT step (type 23, a context compaction): its call's usage at 28.2 (.2 .5 .3 .9)
//   trajectory_metadata_blob 'main': 7 workspace folders (file:// URLs, sorted) ·
//     1 per folder {1 folder, 2 git root, 3 {1 owner/repo, 2 remote URL}, 4 branch} · 5 parent ·
//     6 top-level · 4.1 subagent type

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { messages, num, text, texts, timestampMs } from "./protobuf.mjs";

const CHECKPOINT_STEP = 23;
const MODEL_STEP = 15;
// Bump when reading changes, so the record re-reads every conversation once.
export const READER_VERSION = 2;

const KNOWN_SURFACES = {
  antigravity: { surface: "hub", client: "antigravity_hub", label: "AGY 2.0 (Hub)" },
  "antigravity-cli": { surface: "cli", client: "antigravity_cli", label: "agy CLI" },
};

export function surfaceFor(folderName) {
  if (KNOWN_SURFACES[folderName]) return KNOWN_SURFACES[folderName];
  if (/ide/i.test(folderName)) return { surface: "ide", client: "antigravity_ide", label: "IDE extension" };
  const s = folderName.replace(/^antigravity-?/, "") || "unknown";
  return { surface: s, client: `antigravity_${s.replace(/[^A-Za-z0-9]/g, "_")}`, label: folderName };
}

// Only Antigravity's own data folders are read: `antigravity` or `antigravity-<surface>` holding a
// `conversations/` folder. Nothing else under ~/.gemini is ever opened.
const ANTIGRAVITY_FOLDER = /^antigravity(-[a-z0-9]+)*$/;

export function discoverDataFolders(geminiDir = join(homedir(), ".gemini")) {
  if (!existsSync(geminiDir)) return [];
  return readdirSync(geminiDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && ANTIGRAVITY_FOLDER.test(d.name) && existsSync(join(geminiDir, d.name, "conversations")))
    .map((d) => ({ name: d.name, path: join(geminiDir, d.name), ...surfaceFor(d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Size and modification time of a database and its write-ahead log: unchanged means nothing new.
export function fingerprint(file) {
  const part = (f) => (existsSync(f) ? `${statSync(f).size}:${Math.floor(statSync(f).mtimeMs)}` : "-");
  return `${part(file)}|${part(`${file}-wal`)}`;
}

// agy keeps its databases open (WAL mode). Read a private copy of the database and its log, so
// nothing is ever written beside agy's files and every table is seen as of one moment.
function openSnapshot(file, tmp) {
  const dest = join(tmp, `${createHash("sha1").update(file).digest("hex").slice(0, 16)}.db`);
  copyFileSync(file, dest);
  if (existsSync(`${file}-wal`)) copyFileSync(`${file}-wal`, `${dest}-wal`);
  return new DatabaseSync(dest);
}

const bytes = (b) => (b ? new Uint8Array(b) : null);
const parseJsonList = (s) => {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

export function readSummaries(dataFolder, tmp) {
  const out = new Map();
  const file = join(dataFolder, "conversation_summaries.db");
  if (!existsSync(file)) return out;
  const db = openSnapshot(file, tmp);
  try {
    const rows = db
      .prepare("SELECT conversation_id, title, project_id, workspace_uris, parent_conversation_id, agent_name, last_modified_time FROM conversation_summaries")
      .all();
    for (const r of rows) {
      out.set(r.conversation_id, {
        title: r.title || null,
        projectId: r.project_id || null,
        workspaceUris: parseJsonList(r.workspace_uris),
        parentId: r.parent_conversation_id || null,
        agentName: r.agent_name || null,
        lastModifiedMs: Date.parse(r.last_modified_time) || null,
      });
    }
  } finally {
    db.close();
  }
  return out;
}

export function readConversation(file, tmp) {
  const db = openSnapshot(file, tmp);
  try {
    const meta = bytes(db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get()?.data);
    const conversation = {
      folders: texts(meta, "7"),
      git: messages(meta, "1").map((e) => ({
        folder: text(e, "1"),
        root: text(e, "2"),
        remote: text(e, "3.2"), // 3 is {1 "owner/repo", 2 remote URL}
        remoteName: text(e, "3.1"),
        branch: text(e, "4"),
      })),
      parentId: text(meta, "5"),
      topLevelId: text(meta, "6"),
      subagentType: text(meta, "4.1"),
    };

    // agy keeps no time on a call. A turn's model steps (type 15) carry start times, one step per
    // answered call in the same order (322 of 329 turns checked on 2026-10-28), so where the counts
    // agree each call takes its step's start; otherwise it takes its turn's latest step time.
    const turnTime = new Map();
    const modelSteps = new Map();
    const checkpoints = [];
    for (const s of db.prepare("SELECT idx, step_type, metadata FROM steps ORDER BY idx").iterate()) {
      const md = bytes(s.metadata);
      if (!md) continue;
      const turn = text(md, "12");
      const t = timestampMs(md, "8") ?? timestampMs(md, "1");
      if (turn && t !== null) turnTime.set(turn, Math.max(turnTime.get(turn) ?? 0, t));
      if (s.step_type === MODEL_STEP && turn) {
        if (!modelSteps.has(turn)) modelSteps.set(turn, []);
        modelSteps.get(turn).push(timestampMs(md, "1") ?? t);
      }
      if (s.step_type === CHECKPOINT_STEP) {
        const u = messages(md, "28.2")[0];
        if (u) checkpoints.push({ idx: s.idx, turn, ts: timestampMs(md, "1") ?? t, input: num(u, "2") ?? 0, cacheRead: num(u, "5") ?? 0, output: num(u, "3") ?? 0, thinking: num(u, "9") ?? 0 });
      }
    }

    const calls = [];
    for (const r of db.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx").iterate()) {
      const d = bytes(r.data);
      const input = num(d, "1.4.2");
      const output = num(d, "1.4.3");
      const error = text(d, "5");
      const answered = input !== null || output !== null;
      if (!answered && !error) continue; // still being written: read again next scan
      const rid = text(d, "1.4.11") ?? (num(d, "1.4.11") !== null ? String(num(d, "1.4.11")) : null);
      calls.push({
        kind: "call",
        idx: r.idx,
        turn: text(d, "4"),
        model: text(d, "1.19"),
        responseId: rid,
        failed: !answered,
        error: answered ? null : error,
        input: input ?? 0,
        cacheRead: num(d, "1.4.5") ?? 0,
        output: output ?? 0,
        thinking: num(d, "1.4.9") ?? 0,
        hash: createHash("sha1").update(d).digest("hex").slice(0, 12),
      });
    }

    // Failed rows and compactions name no model: take the nearest earlier call's (else later).
    let last = null;
    for (const c of calls) c.model ? (last = c.model) : (c.model = last);
    let next = null;
    for (let i = calls.length - 1; i >= 0; i--) calls[i].model ? (next = calls[i].model) : (calls[i].model = next);
    const turnModel = new Map(calls.filter((c) => c.turn && c.model).map((c) => [c.turn, c.model]));
    // Per-call start times where a turn's model steps line up one-to-one with its answered calls.
    for (const [turn, starts] of modelSteps) {
      const answered = calls.filter((c) => c.turn === turn && !c.failed);
      if (answered.length === starts.length) answered.forEach((c, i) => { if (starts[i] !== null) c.ts = starts[i]; });
    }
    for (const k of checkpoints) {
      calls.push({ kind: "compaction", ...k, model: turnModel.get(k.turn) ?? last ?? next, responseId: null, failed: false, error: null, hash: "" });
    }
    for (const c of calls) if (c.ts === undefined) c.ts = c.turn ? (turnTime.get(c.turn) ?? null) : null;
    return { ...conversation, calls };
  } finally {
    db.close();
  }
}
