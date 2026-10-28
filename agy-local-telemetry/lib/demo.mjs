// Made-up usage for a fictional team, for `agy-local-telemetry demo` and the README's pictures.
// Written straight into a separate record; nothing here reads or touches Antigravity's files.

import { openStore } from "./store.mjs";

const DAY = 86_400_000;

// Small deterministic random generator, so the demo looks the same every time.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const REPOS = [
  { key: "github.com/acme/web-shop", name: "acme/web-shop", branches: ["main", "checkout-redesign", "fix-cart-totals"], weight: 5 },
  { key: "github.com/acme/payments-api", name: "acme/payments-api", branches: ["main", "refund-flow"], weight: 3 },
  { key: "github.com/acme/mobile-app", name: "acme/mobile-app", branches: ["main", "dark-mode"], weight: 2 },
  { key: "github.com/acme/data-pipeline", name: "acme/data-pipeline", branches: ["main"], weight: 1.5 },
  { key: "/home/you/notes", name: "notes", branches: [null], weight: 0.6 },
];
const TITLES = {
  "acme/web-shop": ["Fix cart total rounding", "Add coupon field to checkout", "Speed up product page", "Write tests for search", "Explain the order state machine", "Migrate styles to CSS modules"],
  "acme/payments-api": ["Add refund endpoint", "Review retry logic", "Fix flaky webhook test", "Document the payments API"],
  "acme/mobile-app": ["Dark mode for settings screen", "Crash on login (Android)", "Upgrade navigation library"],
  "acme/data-pipeline": ["Nightly job runs out of memory", "Add a data quality check"],
  notes: ["Plan next sprint", "Summarise meeting notes"],
};
const SURFACES = [
  { surface: "hub", client: "antigravity_hub", folder: "antigravity", weight: 4 },
  { surface: "cli", client: "antigravity_cli", folder: "antigravity-cli", weight: 4 },
  { surface: "ide", client: "antigravity_ide", folder: "antigravity-ide", weight: 2 },
];
const MODELS = [
  { model: "gemini-3.8-flash", weight: 6 },
  { model: "gemini-4-argon", weight: 3 },
  { model: "claude-opus-5-5", weight: 1 },
];
const PROJECTS = { "acme/web-shop": "3f2a9c1e-shop", "acme/payments-api": "8b71d0aa-payments" };

function pick(rand, items) {
  const total = items.reduce((s, i) => s + (i.weight ?? 1), 0);
  let x = rand() * total;
  for (const i of items) if ((x -= i.weight ?? 1) <= 0) return i;
  return items[items.length - 1];
}

export function writeDemo(path, { days = 45, seed = 7 } = {}) {
  const rand = rng(seed);
  const store = openStore(path);
  store.exec("DELETE FROM calls; DELETE FROM conversations; DELETE FROM sources;");
  const putConv = store.prepare(`INSERT INTO conversations (conversation_id, surface, client_name, data_folder, session_id, parent_conversation_id,
    subagent_type, project_id, workspace_folders, git_root, git_remote, git_branch, repo_key, repo_name, scanned_at, title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const putCall = store.prepare(`INSERT INTO calls (call_key, conversation_id, session_id, kind, row_idx, response_id, turn_id, model, ts, ts_estimated,
    input, cache_read, output, thinking, failed, error, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const now = Date.now();
  let n = 0;
  store.exec("BEGIN");
  for (let d = days - 1; d >= 0; d--) {
    const day = new Date(now - d * DAY);
    const weekend = [0, 6].includes(day.getUTCDay());
    const sessionsToday = Math.floor(rand() * (weekend ? 2 : 6)) + (weekend ? 0 : 1);
    for (let s = 0; s < sessionsToday; s++) {
      const repo = pick(rand, REPOS);
      const surf = pick(rand, SURFACES);
      const mdl = pick(rand, MODELS);
      const outside = surf.surface === "hub" && rand() < 0.12;
      const id = `demo-${String(++n).padStart(4, "0")}-${Math.floor(rand() * 1e8).toString(16)}`;
      const titles = TITLES[repo.name];
      const branch = repo.branches[Math.floor(rand() * repo.branches.length)];
      const project = surf.surface === "hub" && !outside ? PROJECTS[repo.name] ?? null : outside ? "outside-of-project" : surf.surface === "cli" ? "default-cli-project" : null;
      putConv.run(id, surf.surface, surf.client, surf.folder, id, null, null, project,
        JSON.stringify(outside ? [] : [`file://${repo.key.startsWith("/") ? repo.key : "/home/you/work/" + repo.name.split("/")[1]}`]),
        outside ? null : repo.key.startsWith("/") ? null : "/home/you/work/" + repo.name.split("/")[1],
        outside || repo.key.startsWith("/") ? null : `git@github.com:${repo.name}.git`, outside ? null : branch,
        outside ? "(no workspace)" : repo.key, outside ? "(outside project)" : repo.name, now,
        outside ? "Brainstorm launch checklist" : titles[Math.floor(rand() * titles.length)]);
      // A session: a few turns, each a run of calls whose context grows; long ones get compacted.
      let t = day.getTime() - (day.getTime() % DAY) + (8 + rand() * 10) * 3_600_000;
      let context = 14_000 + rand() * 6_000;
      const turns = 1 + Math.floor(rand() * 6);
      let row = 0;
      for (let turn = 1; turn <= turns; turn++) {
        const callsInTurn = 1 + Math.floor(rand() * (mdl.model === "gemini-4-argon" ? 10 : 22));
        for (let c = 0; c < callsInTurn; c++) {
          t += 4_000 + rand() * 40_000;
          if (context > 110_000 && rand() < 0.5) {
            putCall.run(`c:${id}:${row}`, id, id, "compaction", row, null, `t${turn}`, mdl.model, t, Math.round(context * 0.9), 0, 2_500, 400, 0, null, now, now);
            context = 22_000 + rand() * 8_000;
            row++;
            continue;
          }
          const failed = rand() < 0.006;
          const fresh = Math.round(c === 0 ? context * (0.6 + rand() * 0.4) : 900 + rand() * 4_000);
          const cached = Math.max(0, Math.round(context - fresh));
          const out = failed ? 0 : Math.round(60 + rand() * 900);
          const think = failed ? 0 : Math.round(out * (mdl.model === "claude-opus-5-5" ? 0 : rand() * 0.6));
          putCall.run(failed ? `i:${id}:${row}:demo` : `r:${id}-${row}`, id, id, "call", row, failed ? null : `${id}-${row}`, `t${turn}`, mdl.model, t,
            failed ? 0 : fresh, failed ? 0 : cached, out, think, failed ? 1 : 0, failed ? "RESOURCE_EXHAUSTED (code 429)" : null, now, now);
          if (!failed) context += 1_500 + rand() * 5_000;
          row++;
        }
        t += 60_000 + rand() * 600_000;
        context += 2_000;
      }
    }
  }
  store.exec("COMMIT");
  return { conversations: n };
}
