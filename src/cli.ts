#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { loadConfig, type Config } from "./config.ts";
import { formatDuration } from "./duration.ts";
import { execScheduled, runNow, tick, isDue } from "./engine.ts";
import { resolvePaths, type Paths } from "./paths.ts";
import { formatLocal, nextOccurrences } from "./schedule.ts";
import { lockHolder, readJournal, readState, removeState, writeState, type RunRecord } from "./state.ts";
import { checkId, loadTasks, parseTask, readTask, taskFile, writeTaskFile, type FieldValues, type Task } from "./task.ts";

const USAGE = `routine — run scheduled routines described by Markdown files

Usage:
  routine add <id> --rrule <RRULE> --run <command> [options]
  routine edit <id> [options]            change fields; an empty value removes an optional one
  routine pause <id> | resume <id>
  routine rm <id>
  routine ls [--owner <owner>[*]]        a trailing * matches a prefix
  routine show <id> [-n <count>]
  routine run <id>                       run now, outside the schedule
  routine log [<id>] [-n <count>]
  routine check                          validate every routine file
  routine tick [--foreground]            run what is due (called every minute)
  routine stop | start | status          global kill switch

Options for add and edit:
  --rrule <RRULE>        e.g. "FREQ=DAILY;BYHOUR=7;BYMINUTE=0"; repeat for several rules
  --dtstart <date-time>  local start of the series, e.g. 2026-10-05T07:00
  --tz <zone>            time zone, e.g. Europe/Zurich
  --run <command>        shell command
  --owner <owner>        e.g. office:perso/P-0014
  --timeout <duration>   e.g. 30s, 10m, 1h
  --cwd <dir>            working directory (default: home)
  --body <text>          text passed to the command on stdin
  --body-file <file>     same, from a file ("-" for stdin)
  --paused               create the routine paused (add only)

Common options:
  --json                 machine-readable output
  -h, --help
`;

class UsageError extends Error {}

const FIELD_OPTIONS = {
  rrule: { type: "string", multiple: true },
  dtstart: { type: "string" },
  tz: { type: "string" },
  run: { type: "string" },
  owner: { type: "string" },
  timeout: { type: "string" },
  cwd: { type: "string" },
  body: { type: "string" },
  "body-file": { type: "string" },
} as const satisfies ParseArgsConfig["options"];

function parse<O extends NonNullable<ParseArgsConfig["options"]>>(args: string[], options: O) {
  try {
    return parseArgs({ args, options: { ...options, json: { type: "boolean" }, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

function oneId(positionals: string[]): string {
  if (positionals.length !== 1) throw new UsageError("expected exactly one routine id");
  return checkId(positionals[0]!);
}

function print(json: boolean | undefined, data: unknown, text: () => string): void {
  if (json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else {
    const out = text();
    if (out) process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  }
}

function readBody(values: { body?: string; "body-file"?: string }): string | undefined {
  if (values.body !== undefined && values["body-file"] !== undefined) throw new UsageError("give --body or --body-file, not both");
  if (values["body-file"] === "-") return readFileSync(0, "utf8");
  if (values["body-file"] !== undefined) return readFileSync(values["body-file"], "utf8");
  return values.body;
}

function fieldValues(values: Record<string, string | string[] | boolean | undefined>, creating: boolean): FieldValues {
  const result: FieldValues = {};
  const rrules = values.rrule;
  if (Array.isArray(rrules)) {
    if (rrules.some((r) => r.trim() === "")) throw new UsageError("--rrule cannot be empty");
    result.rrule = rrules.length === 1 ? rrules[0]! : rrules;
  }
  for (const key of ["dtstart", "tz", "run", "owner", "timeout", "cwd"] as const) {
    const value = values[key];
    if (typeof value !== "string") continue;
    if (value === "") {
      if (key === "run") throw new UsageError(`--${key} cannot be empty`);
      if (!creating) result[key] = null;
    } else result[key] = value;
  }
  return result;
}

// Writes the file, then parses it back; a file that does not parse is rolled back.
function writeValidated(file: string, id: string, values: FieldValues, body: string | undefined, config: Config): Task {
  const previous = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  writeTaskFile(file, values, body);
  try {
    return parseTask(id, file, readFileSync(file, "utf8"), config);
  } catch (error) {
    if (previous === undefined) rmSync(file, { force: true });
    else writeFileSync(file, previous);
    throw new Error(`${id}: ${(error as Error).message}`);
  }
}

interface Summary {
  id: string;
  file: string;
  owner?: string;
  active: boolean;
  running: boolean;
  rrules: string[];
  dtstart?: string;
  tz: string;
  timeout: string;
  cwd?: string;
  run: string;
  next: string | null;
  lastScheduled?: string;
  lastRun?: RunRecord;
}

function summarize(paths: Paths, task: Task, nowMs: number): Summary {
  const state = readState(paths, task.id);
  const [next] = task.active ? nextOccurrences(task.schedule, nowMs, 1) : [];
  const summary: Summary = {
    id: task.id,
    file: task.file,
    active: task.active,
    running: lockHolder(paths, task.id) !== null,
    rrules: task.rrules,
    tz: task.tz,
    timeout: formatDuration(task.timeoutMs),
    run: task.run,
    next: next === undefined ? null : new Date(next).toISOString(),
  };
  if (task.owner) summary.owner = task.owner;
  if (task.dtstart) summary.dtstart = task.dtstart;
  if (task.cwd) summary.cwd = task.cwd;
  if (state?.lastScheduled) summary.lastScheduled = state.lastScheduled;
  if (state?.lastRun) summary.lastRun = state.lastRun;
  return summary;
}

function local(iso: string | null | undefined, tz: string): string {
  return iso ? formatLocal(Date.parse(iso), tz) : "-";
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  return rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ")).join("\n");
}

function ownerMatches(owner: string | undefined, pattern: string): boolean {
  if (owner === undefined) return false;
  return pattern.endsWith("*") ? owner.startsWith(pattern.slice(0, -1)) : owner === pattern;
}

function runLine(record: RunRecord, tz: string): string {
  const duration = formatDuration(Date.parse(record.ended) - Date.parse(record.started));
  const kind = record.manual ? "manual" : `scheduled ${local(record.scheduled, tz)}`;
  const code = record.exitCode === null ? "" : ` exit ${record.exitCode}`;
  return `${local(record.started, tz)}  ${record.id}  ${record.status}${code}  ${duration}  ${kind}${record.error ? `  (${record.error})` : ""}\n  ${record.log}`;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  const paths = resolvePaths();
  const config = loadConfig(paths);
  const now = Date.now();

  switch (command) {
    case "add": {
      const { values, positionals } = parse(args, { ...FIELD_OPTIONS, paused: { type: "boolean" } });
      const id = oneId(positionals);
      const file = taskFile(paths.tasks, id);
      if (existsSync(file)) throw new Error(`routine ${JSON.stringify(id)} already exists`);
      if (!values.rrule || !values.run) throw new UsageError("add needs --rrule and --run");
      const fields = { ...fieldValues(values, true), active: !values.paused };
      const task = writeValidated(file, id, fields, readBody(values), config);
      writeState(paths, id, values.paused ? { since: new Date(now).toISOString(), inactiveSeen: true } : { since: new Date(now).toISOString() });
      print(values.json, summarize(paths, task, now), () => `added ${id} (${task.file})`);
      return 0;
    }
    case "edit": {
      const { values, positionals } = parse(args, FIELD_OPTIONS);
      const id = oneId(positionals);
      const file = readTask(paths.tasks, id, config).file;
      const task = writeValidated(file, id, fieldValues(values, false), readBody(values), config);
      print(values.json, summarize(paths, task, now), () => `updated ${id}`);
      return 0;
    }
    case "pause":
    case "resume": {
      const { values, positionals } = parse(args, {});
      const id = oneId(positionals);
      const active = command === "resume";
      const file = readTask(paths.tasks, id, config).file;
      const task = writeValidated(file, id, { active }, undefined, config);
      const state = readState(paths, id) ?? { since: new Date(now).toISOString() };
      if (active) {
        const { inactiveSeen: _, ...rest } = state;
        writeState(paths, id, { ...rest, since: new Date(now).toISOString() });
      } else writeState(paths, id, { ...state, inactiveSeen: true });
      print(values.json, summarize(paths, task, now), () => `${active ? "resumed" : "paused"} ${id}`);
      return 0;
    }
    case "rm": {
      const { values, positionals } = parse(args, {});
      const id = oneId(positionals);
      const file = taskFile(paths.tasks, id);
      if (!existsSync(file)) throw new Error(`no routine ${JSON.stringify(id)}`);
      rmSync(file);
      removeState(paths, id);
      print(values.json, { id, removed: true }, () => `removed ${id}`);
      return 0;
    }
    case "ls": {
      const { values, positionals } = parse(args, { owner: { type: "string" } });
      if (positionals.length) throw new UsageError("ls takes no positional argument");
      const { tasks, errors } = loadTasks(paths.tasks, config);
      const selected = values.owner === undefined ? tasks : tasks.filter((t) => ownerMatches(t.owner, values.owner!));
      const summaries = selected.map((task) => summarize(paths, task, now));
      const shownErrors = values.owner === undefined ? errors : [];
      print(values.json, { routines: summaries, errors: shownErrors }, () => {
        const rows = [["ID", "STATE", "NEXT", "LAST RUN", "RRULE"]];
        for (const s of summaries) {
          const state = s.running ? "running" : s.active ? "active" : "paused";
          const last = s.lastRun ? `${local(s.lastRun.started, config.tz)} ${s.lastRun.status}` : "-";
          rows.push([s.id, state, local(s.next, config.tz), last, s.rrules.join(" | ")]);
        }
        const lines = summaries.length ? [table(rows)] : ["no routine"];
        for (const e of shownErrors) lines.push(`invalid ${e.id}: ${e.error}`);
        return lines.join("\n");
      });
      return 0;
    }
    case "show": {
      const { values, positionals } = parse(args, { n: { type: "string", short: "n" } });
      const id = oneId(positionals);
      const task = readTask(paths.tasks, id, config);
      const count = values.n === undefined ? 5 : Number(values.n);
      if (!Number.isInteger(count) || count < 0) throw new UsageError("-n expects a non-negative integer");
      const summary = summarize(paths, task, now);
      const upcoming = task.active ? nextOccurrences(task.schedule, now, count).map((ms) => new Date(ms).toISOString()) : [];
      print(values.json, { ...summary, upcoming, body: task.body }, () => {
        const lines = [
          `id:        ${summary.id}`,
          `file:      ${summary.file}`,
          `state:     ${summary.running ? "running" : summary.active ? "active" : "paused"}`,
          ...summary.rrules.map((r) => `rrule:     ${r}`),
          `dtstart:   ${summary.dtstart ?? "(default)"}`,
          `tz:        ${summary.tz}`,
          `run:       ${summary.run}`,
          `timeout:   ${summary.timeout}`,
        ];
        if (summary.cwd) lines.push(`cwd:       ${summary.cwd}`);
        if (summary.owner) lines.push(`owner:     ${summary.owner}`);
        lines.push(`upcoming:  ${upcoming.length ? upcoming.map((iso) => local(iso, task.tz)).join(", ") : "-"}`);
        lines.push(`last run:  ${summary.lastRun ? runLine(summary.lastRun, task.tz) : "-"}`);
        if (task.body) lines.push("", task.body.trimEnd());
        return lines.join("\n");
      });
      return 0;
    }
    case "run": {
      const { values, positionals } = parse(args, {});
      const id = oneId(positionals);
      const result = await runNow(paths, config, id);
      if (result.outcome === "busy") throw new Error(`${id} is already running`);
      print(values.json, result.record, () => runLine(result.record!, config.tz));
      return result.record!.status === "ok" ? 0 : 1;
    }
    case "log": {
      const { values, positionals } = parse(args, { n: { type: "string", short: "n" } });
      if (positionals.length > 1) throw new UsageError("log takes at most one routine id");
      const limit = values.n === undefined ? 20 : Number(values.n);
      if (!Number.isInteger(limit) || limit < 1) throw new UsageError("-n expects a positive integer");
      const filter = positionals[0] ? { id: checkId(positionals[0]), limit } : { limit };
      const records = readJournal(paths, filter);
      print(values.json, records, () => (records.length ? records.map((r) => runLine(r, config.tz)).join("\n") : "no run"));
      return 0;
    }
    case "check": {
      const { values, positionals } = parse(args, {});
      if (positionals.length) throw new UsageError("check takes no positional argument");
      const { tasks, errors } = loadTasks(paths.tasks, config);
      print(values.json, { valid: tasks.map((t) => t.id), errors }, () =>
        [`${tasks.length} valid routine(s)`, ...errors.map((e) => `invalid ${e.id}: ${e.error}`)].join("\n"),
      );
      return errors.length ? 1 : 0;
    }
    case "tick": {
      const { values, positionals } = parse(args, { foreground: { type: "boolean" } });
      if (positionals.length) throw new UsageError("tick takes no positional argument");
      const result = await tick(paths, config, { foreground: values.foreground ?? false });
      const stampNow = formatLocal(now, config.tz);
      print(values.json, result, () => {
        if (result.stopped) return `${stampNow} stopped (routine start to resume)`;
        const lines = result.errors.map((e) => `${stampNow} invalid ${e.id}: ${e.error}`);
        if (result.due.length) lines.push(`${stampNow} due: ${result.due.join(", ")}`);
        for (const r of result.results) lines.push(r.record ? runLine(r.record, config.tz) : `${r.id}: ${r.outcome}`);
        return lines.join("\n");
      });
      return 0;
    }
    case "exec": {
      const { positionals } = parse(args, {});
      const result = await execScheduled(paths, config, oneId(positionals));
      return result.record && result.record.status !== "ok" ? 1 : 0;
    }
    case "stop":
    case "start":
    case "status": {
      const { values, positionals } = parse(args, {});
      if (positionals.length) throw new UsageError(`${command} takes no positional argument`);
      if (command === "stop") {
        mkdirSync(dirname(paths.stopFile), { recursive: true });
        writeFileSync(paths.stopFile, `${new Date(now).toISOString()}\n`);
      } else if (command === "start") rmSync(paths.stopFile, { force: true });
      const stopped = existsSync(paths.stopFile);
      const { tasks, errors } = loadTasks(paths.tasks, config);
      const running = tasks.filter((t) => lockHolder(paths, t.id) !== null).map((t) => t.id);
      const due = tasks.filter((t) => {
        const state = readState(paths, t.id);
        return state !== undefined && isDue(t, state, now) !== null;
      }).map((t) => t.id);
      const data = { stopped, routines: tasks.length, active: tasks.filter((t) => t.active).length, running, due, invalid: errors.length };
      print(values.json, data, () =>
        [
          stopped ? "stopped: no routine runs until `routine start`" : "running: routines run on schedule",
          `${data.routines} routine(s), ${data.active} active, ${data.invalid} invalid`,
          `running now: ${running.length ? running.join(", ") : "-"}`,
          `due: ${due.length ? due.join(", ") : "-"}`,
        ].join("\n"),
      );
      return 0;
    }
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`routine: ${(error as Error).message}\n`);
    if (error instanceof UsageError) process.stderr.write("Try `routine --help`.\n");
    process.exitCode = error instanceof UsageError ? 2 : 1;
  },
);
