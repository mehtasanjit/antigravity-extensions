// Calls from the local record, joined with their conversation's facts, and the text report.
// Everything is worked out when asked, never stored.
//
// Tokens: agy writes input (excluding cached), cache read, output (including thinking) and
// thinking. Total = input + cache read + output.

import { NO_PROJECT, NO_WORKSPACE } from "./store.mjs";

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const sum = (rows, k) => rows.reduce((s, r) => s + r[k], 0);

export function loadCalls(store, { days, since } = {}) {
  const convs = new Map(store.prepare("SELECT * FROM conversations").all().map((c) => [c.conversation_id, c]));
  // A subagent (or any conversation without a folder) takes its top-level conversation's workspace.
  const effective = (c) => {
    if (!c || c.repo_key !== NO_WORKSPACE) return c;
    const top = convs.get(c.session_id);
    return top && top.repo_key !== NO_WORKSPACE ? top : c;
  };
  const from = since ?? (days ? Date.now() - days * DAY : 0);
  return store
    .prepare("SELECT * FROM calls WHERE ts >= ? ORDER BY ts, row_idx")
    .all(from)
    .map((r) => {
      const c = convs.get(r.conversation_id) ?? {};
      const e = effective(c) ?? c;
      const top = convs.get(r.session_id ?? r.conversation_id) ?? c;
      const projectId = top.project_id ?? c.project_id;
      return {
        key: r.call_key,
        kind: r.kind,
        turn: r.turn_id,
        title: top.title ?? null,
        ts: r.ts,
        estimated: !!r.ts_estimated,
        date: iso(r.ts).slice(0, 10),
        surface: c.surface ?? "unknown",
        client: c.client_name ?? "unknown",
        model: r.model ?? "unspecified",
        conversation: r.conversation_id,
        session: r.session_id ?? r.conversation_id,
        subagent: !!c.parent_conversation_id,
        repoKey: e.repo_key ?? NO_WORKSPACE,
        repo: e.repo_name ?? NO_WORKSPACE,
        // Grouping key: the repository, or for conversations without one their label, so the Hub's
        // "(outside project)" and a CLI "(no workspace)" stay apart.
        repoGroup: (e.repo_key ?? NO_WORKSPACE) === NO_WORKSPACE ? (e.repo_name ?? NO_WORKSPACE) : e.repo_key,
        branch: e.git_branch ?? null,
        project: projectId && !NO_PROJECT.has(projectId) ? projectId : null,
        failed: !!r.failed,
        error: r.error,
        input: r.input,
        cacheRead: r.cache_read,
        output: r.output,
        thinking: r.thinking,
        total: r.input + r.cache_read + r.output,
      };
    });
}

function group(rows, keyFn, init, add) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    let a = m.get(k);
    if (!a) m.set(k, (a = init(r)));
    add(a, r);
  }
  return [...m.values()];
}

const distinct = (rows, k) => new Set(rows.map((r) => r[k]));
const sortedList = (rows, k) => [...distinct(rows, k)].sort().join(", ");

const BY = {
  repo: (r) => [r.repo, r.surface],
  surface: (r) => [r.surface],
  model: (r) => [r.model],
  day: (r) => [r.date],
  conversation: (r) => [r.session.slice(0, 8), r.surface, r.repo],
  project: (r) => [r.project ? r.project.slice(0, 8) : "(none)", r.surface, r.repo],
};
const HEAD = {
  repo: ["Repository", "Surface"], surface: ["Surface"], model: ["Model"], day: ["Day"],
  conversation: ["Session", "Surface", "Repository"], project: ["Hub project", "Surface", "Repository"],
};

export function report(store, { days = 30, by = "repo" } = {}) {
  if (!BY[by]) throw new Error(`--by must be one of: ${Object.keys(BY).join(", ")}`);
  const rows = loadCalls(store, { days });
  const answered = rows.filter((r) => !r.failed);
  const groups = group(
    rows,
    (r) => BY[by](r).join("\u0000"),
    (r) => ({ keys: BY[by](r), rows: [] }),
    (a, r) => a.rows.push(r),
  ).map((g) => {
    const ok = g.rows.filter((r) => !r.failed);
    return {
      keys: g.keys,
      sessions: distinct(g.rows, "session").size,
      calls: ok.length,
      failed: g.rows.length - ok.length,
      compactions: ok.filter((r) => r.kind === "compaction").length,
      input: sum(ok, "input"),
      cacheRead: sum(ok, "cacheRead"),
      output: sum(ok, "output"),
      thinking: sum(ok, "thinking"),
      total: sum(ok, "total"),
    };
  });
  groups.sort((a, b) => (by === "day" ? b.keys[0].localeCompare(a.keys[0]) : b.total - a.total));
  return {
    days,
    by,
    head: HEAD[by],
    totals: {
      sessions: distinct(rows, "session").size,
      calls: answered.length,
      failed: rows.length - answered.length,
      estimatedTimes: rows.filter((r) => r.estimated).length,
      surfaces: sortedList(rows, "surface"),
      input: sum(answered, "input"),
      cacheRead: sum(answered, "cacheRead"),
      output: sum(answered, "output"),
      thinking: sum(answered, "thinking"),
      total: sum(answered, "total"),
    },
    groups,
  };
}
