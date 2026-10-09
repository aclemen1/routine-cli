---
name: routine
description: Scheduled routines — a shell command, a prompt to an ACP agent, or ordered steps, run at the times of an iCalendar RRULE by Routine.app. Use when the user wants something done at fixed times or on a recurrence ("every morning at 7", "every 30 minutes", "each Monday"), asks what is scheduled, when a routine last ran or why it failed, or wants a routine paused, resumed, run now, changed or removed.
---

# routine

A routine is a Markdown file in `~/.config/routine/tasks/<id>.md`: frontmatter for the schedule and the executor, body for stdin or the prompt.
`Routine.app` (menu bar) runs `routine tick` every minute; routines inherit its macOS permissions.
`routine --help` lists every option.

## Which tool

| Routine | Change it with |
|---|---|
| id `office/*` (owner `office:…`) | `office routine add/edit/rm/run` (the dossier's states, history and moves depend on it) |
| any other | `routine` |

Before adding, check that the date is not already a reminder, a calendar event or a `due` entry.

## Read

```bash
routine ls                       # id, description, state, next, last run, recurrence
routine ls --owner 'office:perso/*'
routine show <id>                # fields, next occurrences, last run, body
routine log [<id>] [-n 20]       # runs: status, duration, steps, log file
routine status                   # kill switch, running, due
routine check                    # invalid files
routine tui                      # interactive view
```

Every command takes `--json`.

## Write

Only after the user agreed to the exact routine: schedule, executor, prompt or command, recipients.

```bash
routine add <id> --description "<one sentence>" --rrule "FREQ=DAILY;BYHOUR=7;BYMINUTE=0" --run '<shell>'
routine add <id> --description "…" --rrule "…" --acp-command herdr-acp --acp-arg=--workspace --acp-arg routine --cwd <dir> --body-file <prompt.md>
routine add <id> --description "…" --rrule "…" --steps '<json list>' --body-file <body.md>
routine edit <id> --timeout 20m            # empty value removes an optional field
routine pause <id> | resume <id> | rm <id>
routine run <id>                           # now, outside the schedule
```

- Every routine gets a `--description`.
- id: lowercase letters, digits, `.`, `_`, `-`; `/` separates segments.
- `run`, `acp` and `steps` replace one another.
- An argument that starts with `-` is written `--acp-arg=--flag`.

## Executors

| Field | Runs | Body |
|---|---|---|
| `run` | the command in `/bin/zsh -lc`, in `cwd` (default home) | stdin |
| `acp` | `command` + `args`, a new ACP session in `cwd`, `meta` passed as `_meta` | the prompt |
| `steps` | each step in order, under one lock | section `## <step name>` |

- `acp`: `ok` when the turn ends with `end_turn`. `close`: `on-success` (default), `always`, `never`. `permissions`: `reject` (default), `allow`.
- herdr-acp needs a `cwd` that Claude Code trusts, else `--acp-arg=--trust-folders`.
- `steps`: each step has `name`, `run` or `acp`, optional `timeout`, `cwd`, `continue_on_error`. A failed step skips the rest unless `continue_on_error: true`.
- In a step's text: `{{run_dir}}`, `{{steps.<earlier step>.output}}`. `$ROUTINE_RUN_DIR` is shared by the steps; each leaves `<name>.out` there.
- Environment: `ROUTINE_ID`, `ROUTINE_SCHEDULED`, `ROUTINE_LOG`, `ROUTINE_STEP`.

## Schedule

| Field | Value |
|---|---|
| `rrule` | RRULE without `DTSTART`, or a list (union of occurrences) |
| `dtstart` | local start, e.g. `2026-10-05T07:00` (default `2026-01-01T00:00`) |
| `tz` | default from the config (Europe/Zurich) |
| `timeout` | `30s`, `10m`, `1h30m`; with steps, the budget of the whole run |

| Need | RRULE |
|---|---|
| every 5 minutes | `FREQ=MINUTELY;INTERVAL=5` |
| every day at 7:00 | `FREQ=DAILY;BYHOUR=7;BYMINUTE=0` |
| weekdays at 8:30 | `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=30` |
| every hour 7:05–19:05, weekdays | `FREQ=HOURLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7,8,9,10,11,12,13,14,15,16,17,18,19;BYMINUTE=5` |
| last day of the month at 9:00 | `FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=9;BYMINUTE=0` |
| once | `FREQ=DAILY;COUNT=1` with `--dtstart` |

A missing `BYHOUR` or `BYMINUTE` takes the hour or minute of `dtstart` (default 00:00). Check with `routine show <id>`: `when` and `upcoming`.

- Missed occurrences (Mac asleep, run still going) collapse into one run.
- A new or resumed routine does not catch up occurrences before it was added or resumed.
- The occurrence is recorded before the run: a run cut short is not repeated.

## States

| State | Meaning |
|---|---|
| active | runs on schedule |
| paused | `active: false`; `routine run` still works |
| running | a run holds the lock; `ls` shows when it started |
| invalid | the file does not parse; `routine check` says why |

`routine stop` turns on the kill switch: nothing runs until `routine start`; running routines finish.

## Logs

| What | Where |
|---|---|
| one run's output | `~/.local/state/routine/runs/<id>/<time>.log`; `routine log <id>` gives the path |
| steps' outputs | `~/.local/state/routine/runs/<id>/<time>.d/` |
| every run | `~/.local/state/routine/journal.jsonl` |
| the ticks | `~/Library/Logs/routine.log` |

Statuses: `ok`, `failed` (exit ≠ 0, or the turn did not end with `end_turn`), `timeout`, `error` (could not start); a step may be `skipped`.

## TUI

`routine tui`: `enter`/`l` open, `esc`/`h` back, `q` quit, `t`/`T` sort, `/` filter, `R` run, `space` pause/resume, `E` edit, `L` last log, `o` the run's ACP session, `#` delete, `X` kill switch, `?` keys.

## Channels

| What a routine sends the user | Channel |
|---|---|
| a report, a briefing, a summary | e-mail to alain@clement.aero |
| what needs the user's attention now, an exchange with an agent | Telegram: `office tell` |
| an emergency | Pushover |

A failing routine alerts once on Telegram (config `on_failure`) after `alert_after`: 3 failed runs in a row or 30 min failing, or at its first failure when its next run comes later than that. Its recovery is told only if the alert was.

| Option | Effect for one routine |
|---|---|
| `--alert-after "5,1h"` | its own threshold |
| `--on-failure '<cmd>'` | its own command |
| `--on-failure none` | no alert |

## Guardrails

- A routine sends without review only to the user (Telegram, the user's own e-mail). For anyone else it writes a draft.
- `permissions: allow` lets an agent act without asking: only on the user's explicit request.
- Never edit `~/.config/routine/tasks/office/*` by hand.
