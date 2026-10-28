---
name: agy-local-telemetry
description: Shows what Antigravity work on this device used, from Antigravity's own local files - tokens, model calls, cache hit and sessions for AGY 2.0 (Hub), agy CLI and IDE conversations, by repository, Hub project, model, day or conversation. Use when the user asks about their Antigravity / agy usage, tokens, which models or repositories they used, what a conversation used, or wants to open, update or uninstall the usage dashboard (agy-local-telemetry). Reads only local files and never sends anything off the machine. Don't use for organisation-wide usage across users (that comes from Cloud Logging, not this device).
---

# agy-local-telemetry

Antigravity writes a database for every conversation under `~/.gemini/antigravity*/`. This plugin reads those files, keeps its own record (`~/.local/share/agy-local-telemetry/record.sqlite`) and reports on it. It never calls a model, never writes to Antigravity's files, and reads nothing else under `~/.gemini`.

## Where the command is

The plugin root is the folder **two levels above this SKILL.md** (this file is `<root>/skills/agy-local-telemetry/SKILL.md`). The command is:

```bash
<root>/bin/agy-local-telemetry
```

It needs Node 22.5 or newer (`node --version`). Every command reads new conversations first; that takes a second or two. If it prints "can't write … using a temporary record", that's expected inside a sandbox: the figures are the same. Use the output; don't ask for extra permissions to rerun it.

## Answering usage questions

Use `report --json` and answer from it. Don't guess numbers.

```bash
<root>/bin/agy-local-telemetry report --json                      # last 30 days, by repository and surface
<root>/bin/agy-local-telemetry report --days 7 --by model --json  # --by: repo | surface | model | day | conversation | project
```

The JSON has `totals` (sessions, calls, failed, input, cacheRead, output, thinking, total) and `groups` (one entry per row, with `keys` naming it).

- **Tokens:** total = input + cache read + output. Thinking is part of output. Quote totals in compact form (e.g. 67.4M), and say which period they cover.
- **Cache hit** = cacheRead ÷ (input + cacheRead).
- **Surfaces:** `hub` = AGY 2.0, `cli` = agy CLI, `ide` = IDE extension.
- **"This conversation":** in agy, the current conversation's ID is in `$ANTIGRAVITY_CONVERSATION_ID`. Run `report --by conversation --days 3650 --json` and find the row whose first key is the first 8 characters of that ID. For turn-by-turn detail, point the user to the page instead.
- **There is no cost in money.** These are token counts from Antigravity's own files. If the user asks about cost, say that, and that billing depends on their plan.
- **Not counted:** conversation-title and `/btw` calls (Antigravity doesn't write them locally), and conversations deleted before the first scan.

## Opening the page

```bash
<root>/bin/agy-local-telemetry serve --port 8086    # http://localhost:8086 ; keeps running until stopped
```

Run it in the background and give the user the URL. It listens on this machine only. Only start it with `HOST=0.0.0.0` if the user asks for access from another machine, and tell them it has no login. In the AGY 2.0 Hub, the same page is in a conversation's plugin (+) menu under **Usage**.

## Updating and uninstalling

- **Update:** in the folder the repository was cloned to, run `git pull`, then `agy plugin install <clone>/agy-local-telemetry` again.
- **Uninstall:** `agy plugin uninstall agy-local-telemetry`. The record stays in `~/.local/share/agy-local-telemetry/`. Only delete it if the user asks.

## Don't

- Don't edit or delete anything under `~/.gemini/`.
- Don't read conversation contents to answer usage questions; the report has everything needed.
- Don't send the record or report output anywhere unless the user asks.
