> **Ce dépôt est archivé.** Depuis le 12.10.2026, le code vit dans le monorepo privé `aclemen1/jarvis`, sous `routine/`. Ce dépôt ne reçoit plus de changements.

# routine

Runs scheduled routines. A routine is a Markdown file: its frontmatter gives an iCalendar RRULE and a command, its body is passed to the command on stdin.

```markdown
---
description: Send me the morning briefing
rrule: FREQ=DAILY;BYHOUR=7;BYMINUTE=0
run: office brief --send
timeout: 10m
owner: office:perso/P-0014
---

Text passed on stdin.
```

## Files

| Path | Content |
|---|---|
| `~/.config/routine/tasks/**/*.md` | Routines. The id is the path without `.md` (`office/brief`). |
| `~/.config/routine/config.yaml` | Defaults (below). |
| `~/.local/state/routine/tasks/<id>.json` | Schedule state of each routine. |
| `~/.local/state/routine/runs/<id>/<time>.log` | Output of each run, kept `retention_days`. |
| `~/.local/state/routine/journal.jsonl` | One line per run. |
| `~/.local/state/routine/STOPPED` | Kill switch (`routine stop`). |

`ROUTINE_CONFIG_DIR` and `ROUTINE_STATE_DIR` override the two roots.

## Routine fields

| Field | Meaning | Default |
|---|---|---|
| `description` | What the routine does, in one sentence; written first in the file | none |
| `sphere` | Sphere of its journal events (`perso`, `pro`) | the office of an `office:<office>…` owner |
| `rrule` | RRULE value without `DTSTART`, or a list of them | required |
| `dtstart` | Local start of the series, e.g. `2026-10-05T07:00` | `2026-01-01T00:00` |
| `tz` | Time zone of `dtstart` and the rule | config `tz` |
| `run` | Shell command | `run` or `acp` |
| `acp` | ACP server to prompt: `command`, `args`, `meta` | `run` or `acp` |
| `close` | ACP session close: `on-success`, `always`, `never` | `on-success` |
| `permissions` | Answer to ACP permission requests: `reject`, `allow` | `reject` |
| `steps` | Ordered steps, instead of `run` or `acp` (below) | none |
| `cwd` | Working directory | home |
| `timeout` | `30s`, `10m`, `1h30m`; with `steps`, the budget of the whole run | config `timeout` |
| `owner` | Free label for the program that manages the routine | none |
| `actor` | Actor of its passages: `OFFICE_ACTOR` of every process it starts, `--by` of its run and alert events | `routine:<id>` |
| `on_failure` | Alert command, instead of the config's; `none` turns alerts off | config `on_failure` |
| `alert_after` | `{ failures, duration }`, instead of the config's | config `alert_after` |
| `meta` | Free mapping kept as is, returned by `ls` and `show`, ignored for scheduling | none |
| `active` | `false` pauses the routine | `true` |

A one-shot routine is `FREQ=DAILY;COUNT=1` with `dtstart` set to its time.

`ls`, `show`, the TUI and the JSON (`recurrence`) describe the rules in plain English, e.g. "every day at 6:03 AM; every day at 12:35 PM and 6:35 PM".

The command runs in `shell` (default `/bin/zsh -lc`, so the login profile is read) with `ROUTINE_ID`, `ROUTINE_SCHEDULED` (the occurrence, UTC), `ROUTINE_LOG` and `OFFICE_ACTOR` (below) in its environment.

## ACP routines

A routine with `acp` starts the ACP server, opens a session in `cwd` (`session/new`, with `meta` as `_meta`), sends the body as the prompt and waits for the end of the turn. The run is `ok` when the turn ends with `end_turn`. Past its timeout, the prompt gets `session/cancel`. Agent messages, tool calls and permission answers go to the run log. `routine` knows nothing of any particular server; server options go in `args` and `meta`.

```markdown
---
rrule: FREQ=DAILY;BYHOUR=7;BYMINUTE=0
acp:
  command: herdr-acp
  args: [--workspace, routine]
  meta: { herdr: { tabLabel: briefing } }
close: on-success
cwd: ~/offices/perso
timeout: 20m
---

Prepare today's briefing and send it to me.
```

## Steps

`steps` chains executors in one run, under one lock. Each step has a `name` and a `run` or an `acp` (with `close` and `permissions`), and may set `timeout`, `cwd` and `continue_on_error`.

```markdown
---
rrule: FREQ=DAILY;BYHOUR=21;BYMINUTE=45
timeout: 45m
steps:
  - name: coverage
    run: go test -cover ./...
    cwd: ~/code/aclemen1/office-cli
    timeout: 20m
  - name: improve
    acp: { command: herdr-acp, args: [--workspace, routine] }
    cwd: ~/code/aclemen1/office-cli
---

## improve

Here is today's coverage:

{{steps.coverage.output}}

Propose the three most useful tests to add.
```

- A step's stdin (command) or prompt (acp) is the body section `## <step name>`. Other headings stay inside their section; text before the first step heading is ignored.
- `{{run_dir}}` and `{{steps.<earlier step>.output}}` are replaced in that text. A command's output is its stdout and stderr; an acp step's output is the agent's text.
- Each run has its own directory, `$ROUTINE_RUN_DIR` (`runs/<id>/<time>.d/`), shared by its steps; each step's output is kept there as `<name>.out`. `ROUTINE_STEP` names the current step.
- Steps run in order. A failed step stops the run and the remaining steps are `skipped`, unless the step has `continue_on_error: true`.
- The routine `timeout` bounds the whole run; a step `timeout` bounds its step.
- The run log shows each step between `=== step <name> ===` lines; `routine log` and the journal give each step's status.

## Config

```yaml
tz: Europe/Zurich
timeout: 25m
shell: [/bin/zsh, -lc]
env: { }
retention_days: 14
on_failure: office tell desk --file /dev/stdin   # optional
alert_after: { failures: 3, duration: 30m }
journal: [logbook]                              # optional
history: { ls: [logbook, ls, --source, "routine:{id}", --limit, "{limit}", --format, json], limit: 10 }   # optional
# TUI keys i, @, u ({ref} is routine:<id>, {sphere} its sphere); optional
greffier: {text: [greffier, text, "-", --focus, "{ref}", --sphere, "{sphere}"]}
cabinet: {open: []}
undo:
  preview: [undo, last, --ref, "{ref}", --dry-run]
  last: [undo, last, --ref, "{ref}"]
```

`history.ls` lists a routine's last journal entries as a JSON envelope with `items` ({id}, {sphere}, {limit} are replaced): `show` returns them as `history` (with an entry's `undo` when it carries one) and prints them under "Journal", as does the TUI detail; an empty or failed read shows nothing. `greffier`, `cabinet` and `undo` are read by the TUI only; quote the `-` of a flow list (`"-"`), which YAML does not take bare.

`journal` names the command that records events. routine runs `<journal> add - --source routine:<id> --type <type> --sphere <sphere> --by <actor> --at <time> [--ref office:<dossier>]` with the text on stdin; a failed write never holds a run back. Types: `run` ("ok · 24s · scheduled 07:00", "failed exit 1 · 1m02s · manual · <first error line>"), `alert` (alert sent, ok again after failures), `state` (paused, resumed; the kill switch under `routine:engine`), `change` (created, edited, removed). `--by` is the passage actor for `run` and `alert`, the actor of the write for `state` and `change`; `unsigned` records a write without an actor (below). A routine with no sphere writes nothing; `routine check` warns about it.

`on_failure` runs once when a failing routine crosses `alert_after`: that many failed runs in a row, or that long failing, or at its first failure when its next run comes later than that (a daily routine alerts at once, one that runs every 5 minutes after 15 minutes). It runs again when the routine is `ok`, only if the alert went out; an alert that could not be sent is tried again on the next failed run. It gets the message on stdin (id, status, error, failed runs, description, log path, last lines of the log) and `ROUTINE_ID`, `OFFICE_ACTOR`, `ROUTINE_EVENT` (`failed` or `recovered`), `ROUTINE_STATUS`, `ROUTINE_LOG`, `ROUTINE_ERROR`. Its outcome is written at the end of the run log; it never changes the run's status.

## Provenance

Every passage (scheduled or `routine run`, command, ACP agent, each step, the `on_failure` alert) runs with `OFFICE_ACTOR=routine:<id>`, or the routine's `actor`; inherited `<TOOL>_BY` variables are dropped, so every tool it calls signs as the routine.

A write (`add`, `edit`, `pause`, `resume`, `rm`, `stop`, `start`) is signed by the first of:

1. `--by <actor>`;
2. `ROUTINE_BY`;
3. `OFFICE_ACTOR` (set by office in a dossier session, by routine in a passage);
4. on a terminal (stdin is a TTY), `human:AC@cli`.

A gesture of the TUI is always `human:AC@tui`, passed to the CLI as `ROUTINE_BY`, and to the commands of `i`, `@` and `u` as `OFFICE_ACTOR` (inherited `<TOOL>_BY` dropped): the environment it inherits is ignored.

An actor is `human:<who>@<surface>`, `agent:<id>` or `routine:<id>`; anything else is a `user_error`. Without an actor, until 2026-10-19 (Europe/Zurich) included, the write is signed `unknown:cli`, the JSON envelope carries `warnings` (a `warning:` line on stderr in text), and the journal gets an `unsigned` entry (the command and the tool). From 2026-10-20 it is refused: exit 2, `user_error`. The MCP server is an agent: it reads `ROUTINE_BY` or `OFFICE_ACTOR` from its environment, else follows the same rule, the warning as a second text item.

## Schedule rules

- `routine tick` runs every minute. Each due routine runs in its own detached `routine exec`, so a long run does not hold back the others.
- A routine is due when an occurrence falls after its last scheduled run. Missed occurrences (Mac asleep, routine still running) collapse into one run.
- A routine is not run for occurrences before it was first seen or last resumed.
- The occurrence is recorded before the run starts: a run cut short is not repeated.
- One run per routine at a time (lock in `~/.local/state/routine/locks/`).
- Past its timeout, the command's process group gets SIGTERM, then SIGKILL 10 s later.

## Commands

Every action prints a JSON envelope by default, `{"ok":true,"result":…}` or `{"ok":false,"error":{"code","kind","message"}}`; `--format text` prints for people (`schema`, `skill`, `version` print text unless `--format json`). `--json` is `--format json`.

```sh
routine ls [--owner <owner>[*]]
routine show <id> [-n <count>]
routine add <id> --rrule <RRULE> (--run <command> | --acp-command <cmd> [--acp-arg=<arg>…] [--acp-meta <json>] [--close --permissions] | --steps <json>)
              [--description --dtstart --tz --cwd --timeout --owner --actor --meta <json> --on-failure --alert-after --body | --body-file] [--paused] [--by <actor>]
routine edit <id> [same options]       # an empty value removes an optional field
routine pause <id> | resume <id> | rm <id>   # each write takes --by <actor>
routine run <id>                       # now, outside the schedule; exit 1 when the run fails
routine log [<id>] [-n <count>]
routine check                          # exit 1 when a file is invalid
routine describe --rrule <RRULE> [--dtstart --tz -n]   # the recurrence in plain English, next occurrences
routine tick [--foreground] | status | stop | start
routine schema [<category> [<action>]] # catalog, category, one action's spec
routine skill [show|install] | version | tui [--select <id>] | mcp
```

| Exit | Kind | When |
|---|---|---|
| 0 | | done |
| 1 | `error` | failed; or the run (`run`) or a file (`check`) did not succeed, with `ok: true` |
| 2 | `user_error` | bad argument, invalid routine, no actor after 2026-10-19 |
| 3 | `not_found` | no such routine |
| 4 | `conflict` | the routine already exists |
| 5 | `locked` | the routine is running |

## TUI

`routine tui` lists routines with their description, state (a spinner marks a running one), next occurrence, last run, recurrence in plain English and owner; `enter` opens a routine (rules, next occurrences, executor or steps, meta, body, recent runs with each step's status) and a run's log, followed live. `c` opens a form for a new routine (id, description, type command or agent, recurrence from presets or any RRULE, command or prompt, directory, timeout); `E` opens the same form filled in, or the file in `$EDITOR` for a routine with steps or several rules; office's routines are changed with `office routine`. The recurrence is checked and shown in plain English before saving. Every input goes through a tuikit modal. Keys follow the common TUI convention: `j`/`k` move, `gg`/`G` top/bottom, `enter`/`l` open, `esc`/`h` back, `J`/`K` scroll the detail, `/` filter, `t`/`T` sort/reverse (id, next, last run, state, owner), `r` reload, `R` run now, `space` pause or resume, `e`/`x` pause, `c` new, `E` edit, `L` last log, `o` the run's ACP session (herdr tab, from herdr-acp's pane records), `#` delete after typing the id, `X` kill switch, `?` keys, `q` quit. Common keys: `i` sends a line to the greffier (TextArea, then `greffier.text` with the text on stdin; its proposal and doubts come back in the footer), `@` opens the CABINET pane (`cabinet.open`), `u` undoes the last agent write on the routine (`undo.preview`, a confirmation showing the entry and its reverse, then `undo.last`; a reverse marked irreversible is never run from the TUI and points to `undo tui --select <id>`). The detail's Journal marks an entry carrying a reverse `↶ undoable` when `undo.last` is configured. A key whose command is missing or empty says so. The selected routine is written to the shared focus (`~/.local/state/office/focus.json`, `$OFFICE_FOCUS`) as `routine:<id>`. Kept during the transition: `p` pause, `S` reverse, `D` delete; resuming is `space`. It reads and changes everything through `routine … --json`, and keeps its sort, filter, legend and selection in `tui.json` in the user's config directory.

Built with Go and Bubble Tea: `npm run build:tui` (`tui/build.sh` stamps the short commit, shown in the header). When its binary is rebuilt, or on `SIGUSR1`, the TUI reloads itself by `exec`, keeping its view, routine, sort, filter and selection; during input, a confirmation or an open editor it shows "new version" and reloads once idle.

## MCP

`routine mcp` serves the same operations as tools: `routine_list`, `routine_show`, `routine_add`, `routine_edit`, `routine_pause`, `routine_resume`, `routine_remove`, `routine_run`, `routine_log`, `routine_check`, `routine_status`, `routine_stop`, `routine_start`.

```sh
claude mcp add --scope user routine -- node ~/code/aclemen1/routine-cli/dist/cli.js mcp
```

## Install

```sh
npm install && npm run build && npm run build:tui
app/scripts/build-app.sh --install     # add --notarize for a notarized build
```

`Routine.app` is a menu-bar app that runs `routine tick` every minute and on wake. Routines it starts inherit its TCC grants (Full Disk Access, Automation, Accessibility…), which its Access window checks and requests. Turn on "Ouvrir au démarrage" in its menu.

| Setting (`defaults write aero.clement.routine …`) | Default |
|---|---|
| `nodePath` | `/opt/homebrew/bin/node` |
| `cliPath` | `~/code/aclemen1/routine-cli/dist/cli.js` |
| `automationTargets` (array of bundle ids) | Finder, System Events, Mail, Notes, Messages |

Without the app, `contrib/aero.clement.routine.plist` runs the tick from launchd; routines then hold no TCC grant of their own.

## Development

```sh
npm test
npm run typecheck
```
