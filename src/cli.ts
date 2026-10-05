#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { loadConfig } from "./config.ts";
import { formatDuration } from "./duration.ts";
import { execScheduled, tick } from "./engine.ts";
import {
  addRoutine,
  checkRoutines,
  editRoutine,
  engineStatus,
  listRoutines,
  readRuns,
  removeRoutine,
  runRoutine,
  setActive,
  setStopped,
  showRoutine,
  type Context,
  type EngineStatus,
  type RoutineInput,
} from "./ops.ts";
import { resolvePaths } from "./paths.ts";
import { formatLocal } from "./schedule.ts";
import type { RunRecord } from "./state.ts";
import { checkId, readTask, type ClosePolicy, type PermissionPolicy } from "./task.ts";

const USAGE = `routine — run scheduled routines described by Markdown files

Usage:
  routine add <id> --rrule <RRULE> (--run <command> | --acp-command <cmd> | --steps <json>) [options]
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
  routine tui                            terminal interface
  routine mcp                            serve these operations over MCP (stdio)

Options for add and edit:
  --rrule <RRULE>        e.g. "FREQ=DAILY;BYHOUR=7;BYMINUTE=0"; repeat for several rules
  --dtstart <date-time>  local start of the series, e.g. 2026-10-05T07:00
  --tz <zone>            time zone, e.g. Europe/Zurich
  --run <command>        shell command; the body is passed on stdin
  --acp-command <cmd>    ACP server to start; the body is the prompt
  --acp-arg <arg>        argument of the ACP server (repeatable; --acp-arg=--flag for a dash)
  --acp-meta <json>      _meta object passed in session/new
  --steps <json>         ordered steps, e.g. '[{"name":"measure","run":"…"},{"name":"analyse","acp":{"command":"…"}}]';
                         each step's text is the body section "## <name>"
  --close <policy>       ACP session close: on-success (default), always, never
  --permissions <p>      answer to ACP permission requests: reject (default), allow
  --owner <owner>        e.g. office:perso/P-0014
  --meta <json>          free object kept as is, e.g. '{"states":["open","waiting"]}'
  --timeout <duration>   e.g. 30s, 10m, 1h
  --cwd <dir>            working directory (default: home)
  --body <text>          body of the routine
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
  "acp-command": { type: "string" },
  "acp-arg": { type: "string", multiple: true },
  "acp-meta": { type: "string" },
  meta: { type: "string" },
  steps: { type: "string" },
  close: { type: "string" },
  permissions: { type: "string" },
  owner: { type: "string" },
  timeout: { type: "string" },
  cwd: { type: "string" },
  body: { type: "string" },
  "body-file": { type: "string" },
} as const satisfies ParseArgsConfig["options"];

type FieldFlags = Partial<Record<keyof typeof FIELD_OPTIONS, string | string[] | boolean>>;

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

function noPositional(command: string, positionals: string[]): void {
  if (positionals.length) throw new UsageError(`${command} takes no positional argument`);
}

function print(json: boolean | undefined, data: unknown, text: () => string): void {
  if (json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else {
    const out = text();
    if (out) process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  }
}

function count(value: string | undefined, fallback: number, min: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`-n expects an integer ≥ ${min}`);
  return n;
}

// Builds the input from flags; ACP flags given to edit are merged into the routine's current acp.
function routineInput(flags: FieldFlags, current?: RoutineInput["acp"]): RoutineInput {
  const input: RoutineInput = {};
  const str = (key: keyof typeof FIELD_OPTIONS) => (typeof flags[key] === "string" ? (flags[key] as string) : undefined);
  if (Array.isArray(flags.rrule)) input.rrule = flags.rrule;
  for (const key of ["dtstart", "tz", "cwd", "timeout", "owner"] as const) {
    const value = str(key);
    if (value !== undefined) input[key] = value === "" ? null : value;
  }
  const close = str("close");
  if (close !== undefined) input.close = close === "" ? null : (close as ClosePolicy);
  const permissions = str("permissions");
  if (permissions !== undefined) input.permissions = permissions === "" ? null : (permissions as PermissionPolicy);
  const run = str("run");
  if (run !== undefined) input.run = run;
  const acpCommand = str("acp-command");
  const acpArgs = Array.isArray(flags["acp-arg"]) ? flags["acp-arg"] : undefined;
  const acpMeta = str("acp-meta");
  if (acpCommand !== undefined || acpArgs !== undefined || acpMeta !== undefined) {
    const command = acpCommand ?? current?.command;
    if (!command) throw new UsageError("--acp-command is required for an ACP routine");
    const acp: NonNullable<RoutineInput["acp"]> = { command };
    const args = acpArgs ?? current?.args;
    if (args) acp.args = args;
    if (acpMeta !== undefined) {
      if (acpMeta !== "") {
        try {
          acp.meta = JSON.parse(acpMeta) as Record<string, unknown>;
        } catch {
          throw new UsageError("--acp-meta expects a JSON object");
        }
      }
    } else if (current?.meta) acp.meta = current.meta;
    input.acp = acp;
  }
  const steps = str("steps");
  if (steps !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(steps);
    } catch {
      throw new UsageError("--steps expects a JSON list");
    }
    if (!Array.isArray(parsed)) throw new UsageError("--steps expects a JSON list");
    input.steps = parsed as Record<string, unknown>[];
  }
  const meta = str("meta");
  if (meta !== undefined) {
    if (meta === "") input.meta = null;
    else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(meta);
      } catch {
        throw new UsageError("--meta expects a JSON object");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new UsageError("--meta expects a JSON object");
      input.meta = parsed as Record<string, unknown>;
    }
  }
  const body = str("body");
  const bodyFile = str("body-file");
  if (body !== undefined && bodyFile !== undefined) throw new UsageError("give --body or --body-file, not both");
  if (bodyFile === "-") input.body = readFileSync(0, "utf8");
  else if (bodyFile !== undefined) input.body = readFileSync(bodyFile, "utf8");
  else if (body !== undefined) input.body = body;
  return input;
}

function local(iso: string | null | undefined, tz: string): string {
  return iso ? formatLocal(Date.parse(iso), tz) : "-";
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  return rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ")).join("\n");
}

function runLine(record: RunRecord, tz: string): string {
  const duration = formatDuration(Date.parse(record.ended) - Date.parse(record.started));
  const kind = record.manual ? "manual" : `scheduled ${local(record.scheduled, tz)}`;
  const code = record.exitCode === null ? "" : ` exit ${record.exitCode}`;
  const stop = record.stopReason ? ` (${record.stopReason})` : "";
  const steps = record.steps ? `\n  steps: ${record.steps.map((s) => `${s.name} ${s.status}`).join(", ")}` : "";
  return `${local(record.started, tz)}  ${record.id}  ${record.status}${code}${stop}  ${duration}  ${kind}${record.error ? `  (${record.error})` : ""}${steps}\n  ${record.log}`;
}

function statusText(status: EngineStatus): string {
  return [
    status.stopped ? "stopped: no routine runs until `routine start`" : "running: routines run on schedule",
    `${status.routines} routine(s), ${status.active} active, ${status.invalid} invalid`,
    `running now: ${status.running.length ? status.running.join(", ") : "-"}`,
    `due: ${status.due.length ? status.due.join(", ") : "-"}`,
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  const paths = resolvePaths();
  const config = loadConfig(paths);
  const ctx: Context = { paths, config };
  const tz = config.tz;

  switch (command) {
    case "add": {
      const { values, positionals } = parse(args, { ...FIELD_OPTIONS, paused: { type: "boolean" } });
      const id = oneId(positionals);
      const input = routineInput(values);
      if (!input.rrule || (input.run === undefined && input.acp === undefined && input.steps === undefined)) {
        throw new UsageError("add needs --rrule and one of --run, --acp-command or --steps");
      }
      const summary = addRoutine(ctx, id, input, values.paused ?? false);
      print(values.json, summary, () => `added ${id} (${summary.file})`);
      return 0;
    }
    case "edit": {
      const { values, positionals } = parse(args, FIELD_OPTIONS);
      const id = oneId(positionals);
      const current = readTask(paths.tasks, id, config).acp;
      const summary = editRoutine(ctx, id, routineInput(values, current));
      print(values.json, summary, () => `updated ${id}`);
      return 0;
    }
    case "pause":
    case "resume": {
      const { values, positionals } = parse(args, {});
      const id = oneId(positionals);
      const summary = setActive(ctx, id, command === "resume");
      print(values.json, summary, () => `${command === "resume" ? "resumed" : "paused"} ${id}`);
      return 0;
    }
    case "rm": {
      const { values, positionals } = parse(args, {});
      const id = oneId(positionals);
      print(values.json, removeRoutine(ctx, id), () => `removed ${id}`);
      return 0;
    }
    case "ls": {
      const { values, positionals } = parse(args, { owner: { type: "string" } });
      noPositional("ls", positionals);
      const result = listRoutines(ctx, values.owner);
      print(values.json, result, () => {
        const rows = [["ID", "STATE", "NEXT", "LAST RUN", "META", "RRULE"]];
        for (const s of result.routines) {
          const state = s.running ? "running" : s.active ? "active" : "paused";
          const last = s.lastRun ? `${local(s.lastRun.started, tz)} ${s.lastRun.status}` : "-";
          rows.push([s.id, state, local(s.next, tz), last, s.meta ? JSON.stringify(s.meta) : "-", s.rrules.join(" | ")]);
        }
        const lines = result.routines.length ? [table(rows)] : ["no routine"];
        for (const e of result.errors) lines.push(`invalid ${e.id}: ${e.error}`);
        return lines.join("\n");
      });
      return 0;
    }
    case "show": {
      const { values, positionals } = parse(args, { n: { type: "string", short: "n" } });
      const detail = showRoutine(ctx, oneId(positionals), count(values.n, 5, 0));
      print(values.json, detail, () => {
        const lines = [
          `id:        ${detail.id}`,
          `file:      ${detail.file}`,
          `state:     ${detail.running ? "running" : detail.active ? "active" : "paused"}`,
          ...detail.rrules.map((r) => `rrule:     ${r}`),
          `dtstart:   ${detail.dtstart ?? "(default)"}`,
          `tz:        ${detail.tz}`,
        ];
        if (detail.run) lines.push(`run:       ${detail.run}`);
        if (detail.acp) {
          lines.push(`acp:       ${[detail.acp.command, ...detail.acp.args].join(" ")}`);
          if (detail.acp.meta) lines.push(`acp meta:  ${JSON.stringify(detail.acp.meta)}`);
          lines.push(`close:     ${detail.acp.close}`, `perms:     ${detail.acp.permissions}`);
        }
        for (const step of detail.steps ?? []) {
          const what = step.run ? `run ${step.run}` : `acp ${[step.acp!.command, ...step.acp!.args].join(" ")} (close ${step.acp!.close}, permissions ${step.acp!.permissions})`;
          const extra = [step.timeoutMs ? `timeout ${formatDuration(step.timeoutMs)}` : "", step.cwd ? `cwd ${step.cwd}` : "", step.continueOnError ? "continue_on_error" : ""].filter(Boolean);
          lines.push(`step:      ${step.name}: ${what}${extra.length ? ` [${extra.join(", ")}]` : ""}`);
        }
        lines.push(`timeout:   ${detail.timeout}`);
        if (detail.cwd) lines.push(`cwd:       ${detail.cwd}`);
        if (detail.owner) lines.push(`owner:     ${detail.owner}`);
        if (detail.meta) lines.push(`meta:      ${JSON.stringify(detail.meta)}`);
        lines.push(`upcoming:  ${detail.upcoming.length ? detail.upcoming.map((iso) => local(iso, detail.tz)).join(", ") : "-"}`);
        lines.push(`last run:  ${detail.lastRun ? runLine(detail.lastRun, detail.tz) : "-"}`);
        if (detail.body) lines.push("", detail.body.trimEnd());
        return lines.join("\n");
      });
      return 0;
    }
    case "run": {
      const { values, positionals } = parse(args, {});
      const record = await runRoutine(ctx, oneId(positionals));
      print(values.json, record, () => runLine(record, tz));
      return record.status === "ok" ? 0 : 1;
    }
    case "log": {
      const { values, positionals } = parse(args, { n: { type: "string", short: "n" } });
      if (positionals.length > 1) throw new UsageError("log takes at most one routine id");
      const records = readRuns(ctx, positionals[0], count(values.n, 20, 1));
      print(values.json, records, () => (records.length ? records.map((r) => runLine(r, tz)).join("\n") : "no run"));
      return 0;
    }
    case "check": {
      const { values, positionals } = parse(args, {});
      noPositional("check", positionals);
      const result = checkRoutines(ctx);
      print(values.json, result, () =>
        [`${result.valid.length} valid routine(s)`, ...result.errors.map((e) => `invalid ${e.id}: ${e.error}`)].join("\n"),
      );
      return result.errors.length ? 1 : 0;
    }
    case "tick": {
      const { values, positionals } = parse(args, { foreground: { type: "boolean" } });
      noPositional("tick", positionals);
      const result = await tick(paths, config, { foreground: values.foreground ?? false });
      const stampNow = formatLocal(Date.now(), tz);
      print(values.json, result, () => {
        if (result.stopped) return `${stampNow} stopped (routine start to resume)`;
        const lines = result.errors.map((e) => `${stampNow} invalid ${e.id}: ${e.error}`);
        if (result.due.length) lines.push(`${stampNow} due: ${result.due.join(", ")}`);
        for (const r of result.results) lines.push(r.record ? runLine(r.record, tz) : `${r.id}: ${r.outcome}`);
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
      noPositional(command, positionals);
      const status = command === "status" ? engineStatus(ctx) : setStopped(ctx, command === "stop");
      print(values.json, status, () => statusText(status));
      return 0;
    }
    case "tui": {
      const { positionals } = parse(args, {});
      noPositional("tui", positionals);
      const binary = join(import.meta.dirname, "..", "tui", "routine-tui");
      if (!existsSync(binary)) throw new Error(`${binary} not found: run npm run build:tui`);
      const result = spawnSync(binary, [], {
        stdio: "inherit",
        env: { ...process.env, ROUTINE_CLI: JSON.stringify([process.execPath, process.argv[1]!]) },
      });
      if (result.error) throw result.error;
      return result.status ?? 1;
    }
    case "mcp": {
      const { positionals } = parse(args, {});
      noPositional("mcp", positionals);
      const { serveMcp } = await import("./mcp.ts");
      await serveMcp(ctx);
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
