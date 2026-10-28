# Installing agy-local-telemetry (instructions for agents)

You're installing a plugin for Google Antigravity. It reports token usage from Antigravity's own files on this device, as a command, a local web page, an AGY 2.0 Hub side pane and a skill. It reads only local files, calls no model and sends nothing anywhere.

Before you start, tell the user in one sentence what you're about to install. Then do these steps in order. Stop and report if a step fails.

## 1. Check Node

```bash
node --version
```

You need **v22.5.0 or newer** (for its built-in SQLite). If Node is older or missing, stop. Tell the user, and suggest they install a current Node (for example via their package manager or nvm). Don't install or upgrade Node yourself unless they ask.

## 2. Get the repository

If you don't already have a clone, clone it into a folder the user chooses (default: `~/work/`):

```bash
git clone <repository URL>
```

The plugin is the `agy-local-telemetry/` folder inside the clone. Call its absolute path `<plugin>` from here on.

## 3. Check the plugin

```bash
agy plugin validate <plugin>
```

It must end with `✔ Validation passed`.

## 4. Install it

```bash
agy plugin install <plugin>
agy plugin list
```

`agy-local-telemetry` must appear in the list, enabled. If it's disabled, run `agy plugin enable agy-local-telemetry`.

## 5. Confirm it reads this device

```bash
<plugin>/bin/agy-local-telemetry folders
<plugin>/bin/agy-local-telemetry report --days 7
```

`folders` lists the Antigravity data folders found (e.g. AGY 2.0 / Hub, agy CLI). The report shows the last 7 days. "Nothing recorded in this period" is fine on a new machine.

## 6. Tell the user

Summarise in a few lines:
- It's installed as the Antigravity plugin `agy-local-telemetry`.
- **In the AGY 2.0 Hub:** restart the Hub if it was open, then open **Usage** from a conversation's plugin (+) menu.
- **In agy:** they can ask things like "how many tokens did I use this week?" or "which repositories used the most tokens?". The plugin's skill answers from the report. New agy sessions pick up the skill; already-open sessions may need a restart.
- **In a browser:** `<plugin>/bin/agy-local-telemetry serve`, then open http://localhost:8086.
- Their usage record is kept in `~/.local/share/agy-local-telemetry/`.

Don't start the web server or change any Antigravity settings unless the user asks.
