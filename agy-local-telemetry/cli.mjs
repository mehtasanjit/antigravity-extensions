#!/usr/bin/env node
// agy-local-telemetry: on-device Antigravity telemetry (AGY 2.0 Hub, agy CLI, IDE extension).
// Reads the conversation databases Antigravity writes under ~/.gemini/antigravity*/, keeps its own
// record, and reports tokens by repository, Hub project, conversation, surface, model and day.
// Never calls a model, never sends anything off the machine, never writes beside Antigravity's
// files, and reads nothing else under ~/.gemini.

import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverDataFolders } from "./lib/agy.mjs";
import { defaultStorePath, openStore, scan } from "./lib/store.mjs";
import { writeDemo } from "./lib/demo.mjs";
import { report } from "./lib/views.mjs";
import { servePlain } from "./lib/web.mjs";

const HELP = `Usage: agy-local-telemetry <command> [options]

Commands:
  folders                 List the Antigravity data folders found on this device
  scan                    Read new and changed conversations into the local record
  report                  Tokens by repository and surface (scans first)
  serve [--port 8086]     The local web page: overview, repositories, Hub projects, models, conversations
  demo  [--port 8087]     The same page with made-up data, to try it out (your data isn't read)

Options:
  --days N                Report period in days (default 30)
  --by KEY                repo (default) | surface | model | day | conversation | project
  --json                  Machine-readable output
  --gemini-dir DIR        Where Antigravity keeps its data (default ~/.gemini)
  --store FILE            The local record (default ${defaultStorePath()})
  --no-scan               Report from the record as it is
  HOST=0.0.0.0            (serve) listen on all interfaces; there is no login

Install as an Antigravity plugin (adds the AGY 2.0 Hub side pane and a skill): see INSTALL.md.`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, days: 30, by: "repo", json: false, scan: true, port: 8086, store: defaultStorePath(), geminiDir: join(homedir(), ".gemini") };
  for (let i = 0; i < rest.length; i++) {
    let a = rest[i];
    let v;
    if (a.startsWith("--") && a.includes("=")) [a, v] = [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)];
    const val = () => v ?? rest[++i];
    if (a === "--days") opts.days = Number(val());
    else if (a === "--by") opts.by = val();
    else if (a === "--json") opts.json = true;
    else if (a === "--no-scan") opts.scan = false;
    else if (a === "--port") opts.port = Number(val());
    else if (a === "--store") opts.store = resolve(val());
    else if (a === "--gemini-dir") opts.geminiDir = resolve(val());
    else throw new Error(`Unknown option: ${a}`);
  }
  if (!Number.isFinite(opts.days) || opts.days <= 0) throw new Error("--days must be a positive number");
  return opts;
}

const fmt = (n) => Number(n).toLocaleString("en-US");
const compact = (n) => Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);

function table(head, rows) {
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const numeric = head.map((_, i) => rows.length > 0 && rows.every((r) => /^[\d,.\-—]+$/.test(String(r[i]))));
  const line = (cells) => cells.map((c, i) => (numeric[i] ? String(c).padStart(width[i]) : String(c).padEnd(width[i]))).join("  ");
  return [line(head), width.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

function runScan(store, opts, quiet = false) {
  const results = scan(store, { geminiDir: opts.geminiDir });
  if (!quiet) {
    if (!results.length) console.log(`No Antigravity data folders found under ${opts.geminiDir}.`);
    for (const r of results) {
      console.log(`${r.label.padEnd(16)} ${r.folder.padEnd(18)} ${fmt(r.conversations)} conversations: ${fmt(r.read)} read, ${fmt(r.unchanged)} unchanged · calls ${fmt(r.newCalls)} new, ${fmt(r.updatedCalls)} re-read`);
      for (const e of r.errors.slice(0, 5)) console.log(`  ! ${e}`);
      if (r.errors.length > 5) console.log(`  ! …and ${r.errors.length - 5} more`);
    }
  }
  return results;
}

function printReport(rep, storePath) {
  const t = rep.totals;
  console.log(`\nOn-device Antigravity telemetry, last ${rep.days} days  (record: ${storePath})`);
  console.log(`Surfaces: ${t.surfaces || "—"} · Sessions: ${fmt(t.sessions)} · Calls: ${fmt(t.calls)} answered, ${fmt(t.failed)} failed`);
  console.log(`Tokens: ${compact(t.total)} total = input ${compact(t.input)} + cache read ${compact(t.cacheRead)} + output ${compact(t.output)} (thinking ${compact(t.thinking)})`);
  if (t.estimatedTimes) console.log(`Note: ${fmt(t.estimatedTimes)} calls have no turn time and are dated by their conversation's last change.`);
  console.log("");
  const head = [...rep.head, "Sessions", "Calls", "Failed", "Compactions", "Input", "Cache read", "Output", "Thinking", "Total"];
  const rows = rep.groups.map((g) => [...g.keys, fmt(g.sessions), fmt(g.calls), fmt(g.failed), fmt(g.compactions), fmt(g.input), fmt(g.cacheRead), fmt(g.output), fmt(g.thinking), fmt(g.total)]);
  console.log(rows.length ? table(head, rows) : "Nothing recorded in this period.");
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n\n${HELP}`);
    process.exit(1);
  }
  if (!opts.command || ["help", "--help", "-h"].includes(opts.command)) return console.log(HELP);

  if (opts.command === "demo") {
    const path = join(tmpdir(), "agy-local-telemetry-demo", "record.sqlite");
    const { conversations } = writeDemo(path);
    const port = process.argv.includes("--port") ? opts.port : 8087;
    const host = process.env.HOST || "127.0.0.1";
    await servePlain(openStore(path), { port, host, demo: true, geminiDir: join(tmpdir(), "agy-local-telemetry-demo", "none") });
    console.log(`Demo with ${conversations} made-up conversations: http://${host === "0.0.0.0" ? "<this host>" : host}:${port}  (Ctrl-C stops it)`);
    return;
  }

  if (opts.command === "folders") {
    const folders = discoverDataFolders(opts.geminiDir);
    if (opts.json) return console.log(JSON.stringify(folders, null, 2));
    if (!folders.length) return console.log(`No Antigravity data folders found under ${opts.geminiDir}.`);
    return console.log(table(["Surface", "Folder", "Path"], folders.map((f) => [f.label, f.name, f.path])));
  }

  const store = openStore(opts.store);
  if (store.fallbackFrom) {
    console.error(`Note: can't write ${store.fallbackFrom.path} here (${store.fallbackFrom.reason}); using a temporary record rebuilt from Antigravity's files. Figures are the same.`);
  }
  if (opts.command === "scan") {
    const results = runScan(store, opts, opts.json);
    if (opts.json) console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (opts.command === "report") {
    if (opts.scan) runScan(store, opts, opts.json);
    const rep = report(store, { days: opts.days, by: opts.by });
    return opts.json ? console.log(JSON.stringify(rep, null, 2)) : printReport(rep, opts.store);
  }
  if (opts.command === "serve") {
    if (opts.scan) runScan(store, opts);
    const host = process.env.HOST || "127.0.0.1";
    await servePlain(store, { port: opts.port, host, geminiDir: opts.geminiDir });
    console.log(`On-device telemetry page: http://${host === "0.0.0.0" ? "<this host>" : host}:${opts.port}  (Ctrl-C stops it)`);
    if (host === "0.0.0.0") console.log("Listening on all interfaces, with no login.");
    return;
  }
  console.error(`Unknown command: ${opts.command}\n\n${HELP}`);
  process.exit(1);
}

main();
