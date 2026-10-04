# routine

Runs scheduled routines. A routine is a Markdown file: its frontmatter gives an iCalendar RRULE and a command, its body is passed to the command on stdin.

```markdown
---
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
| `rrule` | RRULE value without `DTSTART`, or a list of them | required |
| `dtstart` | Local start of the series, e.g. `2026-10-05T07:00` | `2026-01-01T00:00` |
| `tz` | Time zone of `dtstart` and the rule | config `tz` |
| `run` | Shell command | required |
| `cwd` | Working directory | home |
| `timeout` | `30s`, `10m`, `1h30m` | config `timeout` |
| `owner` | Free label for the program that manages the routine | none |
| `active` | `false` pauses the routine | `true` |

A one-shot routine is `FREQ=DAILY;COUNT=1` with `dtstart` set to its time.

The command runs in `shell` (default `/bin/zsh -lc`, so the login profile is read) with `ROUTINE_ID`, `ROUTINE_SCHEDULED` (the occurrence, UTC) and `ROUTINE_LOG` in its environment.

## Config

```yaml
tz: Europe/Zurich
timeout: 25m
shell: [/bin/zsh, -lc]
env: { }
retention_days: 14
```

## Schedule rules

- `routine tick` runs every minute. Each due routine runs in its own detached `routine exec`, so a long run does not hold back the others.
- A routine is due when an occurrence falls after its last scheduled run. Missed occurrences (Mac asleep, routine still running) collapse into one run.
- A routine is not run for occurrences before it was first seen or last resumed.
- The occurrence is recorded before the run starts: a run cut short is not repeated.
- One run per routine at a time (lock in `~/.local/state/routine/locks/`).
- Past its timeout, the command's process group gets SIGTERM, then SIGKILL 10 s later.

## Commands

```sh
routine add <id> --rrule <RRULE> --run <command> [--dtstart --tz --cwd --timeout --owner --body | --body-file] [--paused]
routine edit <id> [same options]       # an empty value removes an optional field
routine pause <id> | resume <id> | rm <id>
routine ls [--owner <owner>[*]]
routine show <id> [-n <count>]
routine run <id>                       # now, outside the schedule
routine log [<id>] [-n <count>]
routine check
routine tick [--foreground]
routine stop | start | status
```

Every command takes `--json`. Exit codes: 0 success, 1 failure, 2 usage error.

## Install

```sh
npm install && npm run build
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
