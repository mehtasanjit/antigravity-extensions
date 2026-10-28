// Queries behind the agy-local-telemetry page (browser and AGY 2.0 Hub plugin alike).
// Each answers from the local record, worked out on request:
//   overview      totals vs the previous period, by day, surface, model, repository
//   groups        repositories or Hub projects, with their usage
//   detail        one repository, Hub project or model: usage vs previous, by day, models or
//                 repositories, its sessions
//   conversations sessions (a top-level conversation with its subagents), filtered
//   conversation  one session: turn by turn, call by call, subagents, models

import { loadCalls } from "./views.mjs";

const DAY = 86_400_000;
const ALL_DAYS = 3650;
const sum = (rows, k) => rows.reduce((s, r) => s + r[k], 0);

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

// Usage of a set of calls (failed ones counted apart, no tokens).
function usage(rows) {
  const ok = rows.filter((r) => !r.failed);
  const input = sum(ok, "input");
  const cacheRead = sum(ok, "cacheRead");
  const total = sum(ok, "total");
  let first = null;
  let last = null;
  for (const r of rows) {
    if (first === null || r.ts < first) first = r.ts;
    if (last === null || r.ts > last) last = r.ts;
  }
  return {
    calls: ok.length,
    failed: rows.length - ok.length,
    compactions: ok.filter((r) => r.kind === "compaction").length,
    sessions: new Set(rows.map((r) => r.session)).size,
    input,
    cacheRead,
    output: sum(ok, "output"),
    thinking: sum(ok, "thinking"),
    total,
    cacheHit: input + cacheRead ? cacheRead / (input + cacheRead) : null,
    perCall: ok.length ? total / ok.length : null,
    maxContext: ok.reduce((m, r) => Math.max(m, r.input + r.cacheRead), 0),
    first,
    last,
  };
}

const distinctList = (rows, k) => [...new Set(rows.map((r) => r[k]).filter((v) => v !== null && v !== undefined))].sort();
const top = (rows, k) => {
  const counts = groupBy(rows, (r) => r[k]);
  return [...counts.entries()].sort((a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0])))[0]?.[0] ?? null;
};

// The period's calls and the same length of time just before it (for "vs previous"), narrowed by
// the page's filters: surface, repository (repo), Hub project (project; "-" = none) and model.
function matchesFilters(opts) {
  return (r) =>
    (!opts.surface || r.surface === opts.surface) &&
    (!opts.repo || r.repoGroup === opts.repo) &&
    (!opts.model || r.model === opts.model) &&
    (!opts.project || (opts.project === "-" ? !r.project : r.project === opts.project));
}

function period(store, opts = {}) {
  const days = Math.min(Number(opts.days) || 30, ALL_DAYS);
  const now = Date.now();
  const start = now - days * DAY;
  const all = loadCalls(store, { since: days >= ALL_DAYS ? 0 : start - days * DAY });
  const keep = matchesFilters(opts);
  return {
    days,
    rows: all.filter((r) => r.ts >= start && keep(r)),
    prev: days >= ALL_DAYS ? null : all.filter((r) => r.ts < start && keep(r)),
  };
}

// What the filter menus offer: everything in the period on the chosen surface, by tokens.
export function options(store, opts = {}) {
  const { rows } = period(store, { days: opts.days, surface: opts.surface });
  const rank = (keyFn, nameFn) =>
    [...groupBy(rows, keyFn)].map(([key, rs]) => ({ key, name: nameFn(rs, key), total: usage(rs).total })).sort((a, b) => b.total - a.total);
  return {
    repos: rank((r) => r.repoGroup, (rs) => rs[0].repo),
    models: rank((r) => r.model, (rs, k) => k),
    projects: rank((r) => r.project ?? "-", (rs, k) => (k === "-" ? "(no Hub project)" : `Hub project ${k.slice(0, 8)} · ${top(rs, "repo")}`)),
  };
}

function daily(rows) {
  return [...groupBy(rows, (r) => r.date)]
    .map(([date, rs]) => {
      const bySurface = {};
      for (const [s, x] of groupBy(rs, (r) => r.surface)) bySurface[s] = usage(x).total;
      const u = usage(rs);
      return { date, surfaces: bySurface, total: u.total, calls: u.calls, sessions: u.sessions };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

const byModel = (rows) =>
  [...groupBy(rows, (r) => r.model)].map(([model, rs]) => ({ model, surfaces: distinctList(rs, "surface"), ...usage(rs) })).sort((a, b) => b.total - a.total);
const byRepo = (rows) =>
  [...groupBy(rows, (r) => r.repoGroup)]
    .map(([key, rs]) => ({ key, name: rs[0].repo, surfaces: distinctList(rs, "surface"), branches: distinctList(rs, "branch"), ...usage(rs) }))
    .sort((a, b) => b.total - a.total);

function sessionRows(rows) {
  return [...groupBy(rows, (r) => r.session)].map(([session, rs]) => ({
    id: session,
    title: rs[0].title,
    surface: top(rs, "surface"),
    repository: top(rs, "repo"),
    repoKey: top(rs, "repoGroup"),
    branch: top(rs, "branch"),
    project: top(rs, "project"),
    turns: new Set(rs.filter((r) => r.turn).map((r) => `${r.conversation}:${r.turn}`)).size,
    subagents: new Set(rs.filter((r) => r.subagent).map((r) => r.conversation)).size,
    models: distinctList(rs, "model"),
    ...usage(rs),
  }));
}

export function overview(store, opts = {}) {
  const { days, rows, prev } = period(store, opts);
  return {
    days,
    totals: { repositories: new Set(rows.map((r) => r.repoGroup)).size, ...usage(rows) },
    previous: prev ? usage(prev) : null,
    surfaces: [...groupBy(rows, (r) => r.surface)].map(([surface, rs]) => ({ surface, ...usage(rs) })).sort((a, b) => b.total - a.total),
    models: byModel(rows),
    repositories: byRepo(rows).slice(0, 10),
    daily: daily(rows),
    lastCall: rows.reduce((m, r) => Math.max(m, r.ts), 0) || null,
  };
}

export function groups(store, opts = {}) {
  const by = opts.by === "project" ? "project" : "repo";
  const { rows, prev } = period(store, opts);
  const keyOf = by === "project" ? (r) => r.project ?? "" : (r) => r.repoGroup;
  const prevBy = prev ? groupBy(prev, keyOf) : new Map();
  return {
    by,
    rows: [...groupBy(rows, keyOf)]
      .map(([key, rs]) => ({
        key,
        name: by === "project" ? (key ? `Hub project ${key.slice(0, 8)}` : "(no Hub project)") : rs[0].repo,
        repository: by === "project" ? top(rs, "repo") : null,
        branches: distinctList(rs, "branch"),
        surfaces: distinctList(rs, "surface"),
        models: distinctList(rs, "model"),
        previousTotal: prev ? usage(prevBy.get(key) ?? []).total : null,
        ...usage(rs),
      }))
      .sort((a, b) => b.total - a.total),
  };
}

// One repository, Hub project or model.
export function detail(store, opts = {}) {
  const kind = ["repo", "project", "model"].includes(opts.kind) ? opts.kind : "repo";
  const key = opts.key ?? "";
  const match = { repo: (r) => r.repoGroup === key, project: (r) => (r.project ?? "") === key, model: (r) => r.model === key }[kind];
  const { days, rows: all, prev } = period(store, opts);
  const rows = all.filter(match);
  if (!rows.length) return { found: false, kind, key, days };
  const name = kind === "repo" ? rows[0].repo : kind === "project" ? (key ? `Hub project ${key.slice(0, 8)}` : "(no Hub project)") : key;
  return {
    found: true,
    kind,
    key,
    name,
    days,
    totals: usage(rows),
    previous: prev ? usage(prev.filter(match)) : null,
    surfaces: distinctList(rows, "surface"),
    branches: distinctList(rows, "branch"),
    repository: kind === "project" ? top(rows, "repo") : null,
    daily: daily(rows),
    models: kind === "model" ? [] : byModel(rows),
    repositories: kind === "repo" ? [] : byRepo(rows),
    sessions: sessionRows(rows).sort((a, b) => b.total - a.total).slice(0, 50),
  };
}

const SORTS = {
  recent: (a, b) => b.last - a.last,
  total: (a, b) => b.total - a.total,
  failed: (a, b) => b.failed - a.failed || b.last - a.last,
  compactions: (a, b) => b.compactions - a.compactions || b.total - a.total,
  coldcache: (a, b) => (a.cacheHit ?? 1) - (b.cacheHit ?? 1) || b.total - a.total,
};

export function conversations(store, opts = {}) {
  const { rows } = period(store, opts);
  let list = sessionRows(rows);
  if (opts.q) {
    const q = String(opts.q).toLowerCase();
    list = list.filter((s) => [s.id, s.title, s.repository, s.branch, ...s.models].some((v) => v && String(v).toLowerCase().includes(q)));
  }
  if (opts.sort === "failed") list = list.filter((s) => s.failed > 0);
  if (opts.sort === "compactions") list = list.filter((s) => s.compactions > 0);
  if (opts.sort === "coldcache") list = list.filter((s) => s.total >= 200_000 && s.cacheHit !== null && s.cacheHit < 0.5);
  return { sort: SORTS[opts.sort] ? opts.sort : "recent", rows: list.sort(SORTS[opts.sort] ?? SORTS.recent).slice(0, Number(opts.limit) || 500) };
}

// One session. `id` may be the session or any conversation in it (e.g. the Hub's active one).
export function conversation(store, { id } = {}) {
  if (!id) return { found: false };
  const all = loadCalls(store, { since: 0 });
  const owner = all.find((r) => r.conversation === id || r.session === id);
  if (!owner) return { found: false, id };
  const rows = all.filter((r) => r.session === owner.session);
  const [summary] = sessionRows(rows);
  const turnKey = (r) => `${r.subagent ? r.conversation : "main"}:${r.turn ?? "?"}`;
  const turns = [...groupBy(rows, turnKey)]
    .map(([k, rs]) => ({
      key: k,
      turn: rs[0].turn,
      subagent: rs[0].subagent ? rs[0].conversation : null,
      models: distinctList(rs, "model"),
      errors: distinctList(rs.filter((r) => r.failed), "error"),
      ...usage(rs),
    }))
    .sort((a, b) => a.first - b.first);
  const turnIndex = new Map(turns.map((t, i) => [t.key, i + 1]));
  const calls = rows
    .filter((r) => !r.subagent)
    .map((r) => ({
      ts: r.ts,
      turn: turnIndex.get(turnKey(r)) ?? null,
      model: r.model,
      kind: r.kind,
      failed: r.failed,
      error: r.error,
      context: r.input + r.cacheRead,
      cacheRead: r.cacheRead,
      output: r.output,
      thinking: r.thinking,
      total: r.total,
    }));
  const subagents = [...groupBy(rows.filter((r) => r.subagent), (r) => r.conversation)].map(([cid, rs]) => ({ id: cid, ...usage(rs) }));
  return { found: true, requested: id, session: summary, turns, calls, subagents, models: byModel(rows) };
}

export const routes = { overview, groups, detail, conversations, conversation, options };
export { DAY };
