#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkTimeZone, loadConfig, type Config } from "./config.ts";
import { formatDuration } from "./duration.ts";
import { execScheduled, tick, type TickResult } from "./engine.ts";
import { notFound, userError } from "./errors.ts";
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
  type Detail,
  type EngineStatus,
  type RoutineInput,
  type Summary,
} from "./ops.ts";
import { resolvePaths, type Paths } from "./paths.ts";
import { buildSchedule, formatLocal, nextOccurrences } from "./schedule.ts";
import { actionSpec, actionText, COMMAND, emit, parseAction, usage, type Action, type Param } from "./spec.ts";
import type { RunRecord } from "./state.ts";
import { checkId, readTask, type ClosePolicy, type PermissionPolicy, type TaskError } from "./task.ts";

const VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string }).version;

let lazy: { paths: Paths; config: Config; ctx: Context } | undefined;
function env() {
  if (!lazy) {
    const paths = resolvePaths();
    const config = loadConfig(paths);
    lazy = { paths, config, ctx: { paths, config } };
  }
  return lazy;
}

// ---------------------------------------------------------------- text output

function local(iso: string | null | undefined, tz = env().config.tz): string {
  return iso ? formatLocal(Date.parse(iso), tz) : "-";
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  return rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ")).join("\n");
}

function runLine(record: RunRecord, tz?: string): string {
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

function listText(result: { routines: Summary[]; errors: TaskError[] }): string {
  const rows = [["ID", "DESCRIPTION", "STATE", "NEXT", "LAST RUN", "RECURRENCE", "META"]];
  for (const s of result.routines) {
    const state = s.running ? "running" : s.active ? "active" : "paused";
    const last = s.runningSince ? `started ${local(s.runningSince)}` : s.lastRun ? `${local(s.lastRun.started)} ${s.lastRun.status}` : "-";
    rows.push([s.id, s.description ?? "-", state, local(s.next), last, s.recurrence, s.meta ? JSON.stringify(s.meta) : "-"]);
  }
  const lines = result.routines.length ? [table(rows)] : ["no routine"];
  for (const e of result.errors) lines.push(`invalid ${e.id}: ${e.error}`);
  return lines.join("\n");
}

function detailText(d: Detail): string {
  const lines = [
    `id:        ${d.id}`,
    `about:     ${d.description ?? "-"}`,
    `file:      ${d.file}`,
    `state:     ${d.running ? "running" : d.active ? "active" : "paused"}`,
    `when:      ${d.recurrence}`,
    ...d.rrules.map((r) => `rrule:     ${r}`),
    `dtstart:   ${d.dtstart ?? "(default)"}`,
    `tz:        ${d.tz}`,
  ];
  if (d.run) lines.push(`run:       ${d.run}`);
  if (d.acp) {
    lines.push(`acp:       ${[d.acp.command, ...d.acp.args].join(" ")}`);
    if (d.acp.meta) lines.push(`acp meta:  ${JSON.stringify(d.acp.meta)}`);
    lines.push(`close:     ${d.acp.close}`, `perms:     ${d.acp.permissions}`);
  }
  for (const step of d.steps ?? []) {
    const what = step.run ? `run ${step.run}` : `acp ${[step.acp!.command, ...step.acp!.args].join(" ")} (close ${step.acp!.close}, permissions ${step.acp!.permissions})`;
    const extra = [step.timeoutMs ? `timeout ${formatDuration(step.timeoutMs)}` : "", step.cwd ? `cwd ${step.cwd}` : "", step.continueOnError ? "continue_on_error" : ""].filter(Boolean);
    lines.push(`step:      ${step.name}: ${what}${extra.length ? ` [${extra.join(", ")}]` : ""}`);
  }
  lines.push(`timeout:   ${d.timeout}`);
  if (d.cwd) lines.push(`cwd:       ${d.cwd}`);
  if (d.owner) lines.push(`owner:     ${d.owner}`);
  if (d.sphere) lines.push(`sphere:    ${d.sphere}`);
  if (d.onFailure) lines.push(`on fail:   ${d.onFailure}`);
  if (d.alertAfter) {
    const a = d.alertAfter;
    lines.push(`alert:     after ${[a.failures !== undefined ? `${a.failures} failures` : "", a.duration ?? ""].filter(Boolean).join(" or ")}`);
  }
  if (d.meta) lines.push(`meta:      ${JSON.stringify(d.meta)}`);
  lines.push(`upcoming:  ${d.upcoming.length ? d.upcoming.map((iso) => local(iso, d.tz)).join(", ") : "-"}`);
  lines.push(`last run:  ${d.lastRun ? runLine(d.lastRun, d.tz) : "-"}`);
  if (d.body) lines.push("", d.body.trimEnd());
  return lines.join("\n");
}

function tickText(result: TickResult): string {
  const stamp = formatLocal(Date.now(), env().config.tz);
  if (result.stopped) return `${stamp} stopped (routine start to resume)`;
  const lines = result.errors.map((e) => `${stamp} invalid ${e.id}: ${e.error}`);
  if (result.due.length) lines.push(`${stamp} due: ${result.due.join(", ")}`);
  for (const r of result.results) lines.push(r.record ? runLine(r.record) : `${r.id}: ${r.outcome}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- add and edit

const ID: Param = { name: "id", type: "string", positional: true, required: true, description: "Routine id: the path under the tasks directory without .md, e.g. office/perso-ingest." };

const FIELDS: Param[] = [
  { name: "description", type: "string", description: "What the routine does, in one sentence; empty removes it." },
  { name: "sphere", type: "string", description: "Sphere of the routine's journal events: perso or pro (default: the office of its owner); empty removes it." },
  { name: "rrule", type: "string[]", description: 'RRULE without DTSTART, e.g. "FREQ=DAILY;BYHOUR=7;BYMINUTE=0"; repeat for several rules.' },
  { name: "dtstart", type: "string", description: "Local start of the series, e.g. 2026-10-05T07:00." },
  { name: "tz", type: "string", description: "Time zone, e.g. Europe/Zurich (default from the config)." },
  { name: "run", type: "string", description: "Shell command; the body is passed on stdin." },
  { name: "acp-command", type: "string", description: "ACP server to start; the body is the prompt." },
  { name: "acp-arg", type: "string[]", description: "Argument of the ACP server (repeatable; --acp-arg=--flag for a dash)." },
  { name: "acp-meta", type: "string", description: "JSON object passed as _meta in session/new." },
  { name: "steps", type: "string", description: 'Ordered steps as a JSON list, e.g. [{"name":"measure","run":"…"}]; each step\'s text is the body section "## <name>".' },
  { name: "close", type: "string", enum: ["on-success", "always", "never", ""], description: "ACP session close: on-success (default), always, never." },
  { name: "permissions", type: "string", enum: ["reject", "allow", ""], description: "Answer to ACP permission requests: reject (default), allow." },
  { name: "cwd", type: "string", description: "Working directory (default home)." },
  { name: "timeout", type: "string", description: "Longest run: 30s, 10m, 1h30m; with steps, the budget of the whole run." },
  { name: "owner", type: "string", description: "Label of the program that manages the routine, e.g. office:perso/P-0014." },
  { name: "meta", type: "string", description: 'Free JSON object kept as is, e.g. {"states":["open","waiting"]}; empty removes it.' },
  { name: "on-failure", type: "string", description: "Alert command instead of the config's; none turns alerts off; empty removes it." },
  { name: "alert-after", type: "string", description: 'Alert after n failed runs in a row or dur failing, e.g. "3,30m"; empty removes it.' },
  { name: "body", type: "string", description: "Body of the routine: stdin of a command, prompt of an ACP routine, sections of steps." },
  { name: "body-file", type: "string", description: 'Read the body from a file ("-" for stdin).' },
];

function json(name: string, value: string, kind: "object" | "list"): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw userError(`--${name} expects a JSON ${kind}`);
  }
  const ok = kind === "list" ? Array.isArray(parsed) : typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  if (!ok) throw userError(`--${name} expects a JSON ${kind}`);
  return parsed;
}

// Builds the input from flags; ACP flags given to edit are merged into the routine's current acp.
function routineInput(a: Record<string, unknown>, current?: RoutineInput["acp"]): RoutineInput {
  const input: RoutineInput = {};
  const str = (key: string) => a[key] as string | undefined;
  if (Array.isArray(a.rrule)) input.rrule = a.rrule as string[];
  for (const key of ["description", "sphere", "dtstart", "tz", "cwd", "timeout", "owner"] as const) {
    const value = str(key);
    if (value !== undefined) input[key] = value === "" ? null : value;
  }
  const alertAfter = str("alert-after");
  if (alertAfter !== undefined) {
    if (alertAfter === "") input.alert_after = null;
    else {
      const m = /^(?:(\d+)(?: failures?)?)?\s*(?:(?:,|or)\s*)?([\dsmh]+)?$/.exec(alertAfter.trim());
      if (!m || (!m[1] && !m[2])) throw userError('--alert-after expects e.g. "3,30m", "5" or "1h"');
      input.alert_after = { ...(m[1] ? { failures: Number(m[1]) } : {}), ...(m[2] ? { duration: m[2] } : {}) };
    }
  }
  const onFailure = str("on-failure");
  if (onFailure !== undefined) input.on_failure = onFailure === "" ? null : onFailure;
  const close = str("close");
  if (close !== undefined) input.close = close === "" ? null : (close as ClosePolicy);
  const permissions = str("permissions");
  if (permissions !== undefined) input.permissions = permissions === "" ? null : (permissions as PermissionPolicy);
  const run = str("run");
  if (run !== undefined) input.run = run;
  const acpCommand = str("acp-command");
  const acpArgs = Array.isArray(a["acp-arg"]) ? (a["acp-arg"] as string[]) : undefined;
  const acpMeta = str("acp-meta");
  if (acpCommand !== undefined || acpArgs !== undefined || acpMeta !== undefined) {
    const command = acpCommand ?? current?.command;
    if (!command) throw userError("--acp-command is required for an ACP routine");
    const acp: NonNullable<RoutineInput["acp"]> = { command };
    const args = acpArgs ?? current?.args;
    if (args) acp.args = args;
    if (acpMeta !== undefined) {
      if (acpMeta !== "") acp.meta = json("acp-meta", acpMeta, "object") as Record<string, unknown>;
    } else if (current?.meta) acp.meta = current.meta;
    input.acp = acp;
  }
  const steps = str("steps");
  if (steps !== undefined) input.steps = json("steps", steps, "list") as Record<string, unknown>[];
  const meta = str("meta");
  if (meta !== undefined) input.meta = meta === "" ? null : (json("meta", meta, "object") as Record<string, unknown>);
  const body = str("body");
  const bodyFile = str("body-file");
  if (body !== undefined && bodyFile !== undefined) throw userError("give --body or --body-file, not both");
  if (bodyFile === "-") input.body = readFileSync(0, "utf8");
  else if (bodyFile !== undefined) input.body = readFileSync(bodyFile, "utf8");
  else if (body !== undefined) input.body = body;
  return input;
}

// ---------------------------------------------------------------- actions

const id = (a: Record<string, unknown>) => checkId(a.id as string);

const ACTIONS: Action[] = [
  {
    name: "ls",
    category: "routine",
    summary: "List routines with their state, next occurrence, last run and recurrence; invalid files come last.",
    params: [{ name: "owner", type: "string", description: "Keep the routines of this owner; a trailing * matches a prefix (office:perso/*)." }],
    examples: ["routine ls --format text", "routine ls --owner 'office:perso/*'"],
    run: (a) => ({ result: listRoutines(env().ctx, a.owner as string | undefined) }),
    text: listText,
  },
  {
    name: "show",
    category: "routine",
    summary: "Show one routine: fields, body, next occurrences, last run.",
    params: [ID, { name: "n", type: "integer", short: "n", default: 5, description: "Number of next occurrences." }],
    examples: ["routine show self-sync --format text"],
    run: (a) => {
      const n = a.n as number;
      if (n < 0) throw userError("-n expects an integer ≥ 0");
      return { result: showRoutine(env().ctx, id(a), n) };
    },
    text: detailText,
  },
  {
    name: "add",
    category: "routine",
    summary: "Create a routine: an rrule and one of --run, --acp-command or --steps. Only after the user agreed to it.",
    discussion: "A routine sends without review only to the user; for anyone else it writes a draft.",
    params: [ID, ...FIELDS, { name: "paused", type: "boolean", description: "Create the routine paused." }],
    examples: [
      'routine add backup --description "Back up the vault" --rrule "FREQ=DAILY;BYHOUR=2;BYMINUTE=0" --run "restic backup ~/vault"',
      'routine add brief --rrule "FREQ=DAILY;BYHOUR=7;BYMINUTE=0" --acp-command herdr-acp --acp-arg=--workspace --acp-arg routine --body-file prompt.md',
    ],
    run: async (a) => {
      const input = routineInput(a);
      if (!input.rrule || (input.run === undefined && input.acp === undefined && input.steps === undefined)) {
        throw userError(`add needs --rrule and one of --run, --acp-command or --steps. Usage: ${usage(ACTIONS[2]!)}`);
      }
      return { result: await addRoutine(env().ctx, id(a), input, a.paused === true) };
    },
    text: (s: Summary) => `added ${s.id} (${s.file})`,
  },
  {
    name: "edit",
    category: "routine",
    summary: "Change fields of a routine; an empty value removes an optional field; run, acp and steps replace one another. Only after the user agreed.",
    params: [ID, ...FIELDS],
    examples: ['routine edit self-sync --timeout 20m', 'routine edit brief --description ""'],
    run: async (a) => {
      const { paths, config, ctx } = env();
      const current = readTask(paths.tasks, id(a), config).acp;
      return { result: await editRoutine(ctx, id(a), routineInput(a, current)) };
    },
    text: (s: Summary) => `updated ${s.id}`,
  },
  {
    name: "pause",
    category: "routine",
    summary: "Pause a routine; `routine run` still works.",
    params: [ID],
    examples: ["routine pause self-sync"],
    run: async (a) => ({ result: await setActive(env().ctx, id(a), false) }),
    text: (s: Summary) => `paused ${s.id}`,
  },
  {
    name: "resume",
    category: "routine",
    summary: "Resume a paused routine; occurrences missed while paused are not caught up.",
    params: [ID],
    examples: ["routine resume self-sync"],
    run: async (a) => ({ result: await setActive(env().ctx, id(a), true) }),
    text: (s: Summary) => `resumed ${s.id}`,
  },
  {
    name: "rm",
    category: "routine",
    summary: "Delete a routine and its schedule state. Only after the user agreed.",
    params: [ID],
    examples: ["routine rm old-backup"],
    run: async (a) => ({ result: await removeRoutine(env().ctx, id(a)) }),
    text: (r: { id: string }) => `removed ${r.id}`,
  },
  {
    name: "run",
    category: "routine",
    summary: "Run a routine now, outside its schedule, and wait for the end; exit 1 when the run did not succeed.",
    params: [ID],
    examples: ["routine run self-sync --format text"],
    run: async (a) => {
      const record = await runRoutine(env().ctx, id(a));
      return { result: record, exitCode: record.status === "ok" ? 0 : 1 };
    },
    text: (r: RunRecord) => runLine(r),
  },
  {
    name: "log",
    category: "routine",
    summary: "Recent runs from the journal, oldest first, each with its status, steps and log file.",
    params: [
      { name: "id", type: "string", positional: true, description: "Keep the runs of this routine." },
      { name: "n", type: "integer", short: "n", default: 20, description: "Number of runs." },
    ],
    examples: ["routine log --format text", "routine log office/perso-ingest -n 5"],
    run: (a) => {
      const n = a.n as number;
      if (n < 1) throw userError("-n expects an integer ≥ 1");
      return { result: readRuns(env().ctx, a.id as string | undefined, n) };
    },
    text: (records: RunRecord[]) => (records.length ? records.map((r) => runLine(r)).join("\n") : "no run"),
  },
  {
    name: "check",
    category: "routine",
    summary: "Validate every routine file; exit 1 when one is invalid.",
    params: [],
    examples: ["routine check --format text"],
    run: () => {
      const result = checkRoutines(env().ctx);
      return { result, exitCode: result.errors.length ? 1 : 0 };
    },
    text: (r: { valid: string[]; errors: TaskError[]; warnings: { id: string; warning: string }[] }) =>
      [`${r.valid.length} valid routine(s)`, ...r.errors.map((e) => `invalid ${e.id}: ${e.error}`), ...r.warnings.map((w) => `warning ${w.id}: ${w.warning}`)].join("\n"),
  },
  {
    name: "describe",
    category: "routine",
    summary: "Describe a recurrence in plain English with its next occurrences, without saving anything.",
    params: [
      { name: "rrule", type: "string[]", required: true, description: "RRULE without DTSTART; repeat for several rules." },
      { name: "dtstart", type: "string", description: "Local start of the series, e.g. 2026-10-05T07:00." },
      { name: "tz", type: "string", description: "Time zone (default from the config)." },
      { name: "n", type: "integer", short: "n", default: 5, description: "Number of next occurrences." },
    ],
    examples: ['routine describe --rrule "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=30" --format text'],
    run: (a) => {
      const tz = checkTimeZone((a.tz as string | undefined) ?? env().config.tz);
      let schedule;
      try {
        schedule = buildSchedule(a.rrule as string[], a.dtstart as string | undefined, tz);
      } catch (error) {
        throw userError((error as Error).message);
      }
      const upcoming = nextOccurrences(schedule, Date.now(), a.n as number).map((ms) => new Date(ms).toISOString());
      return { result: { recurrence: schedule.text, upcoming } };
    },
    text: (r: { recurrence: string; upcoming: string[] }) => [r.recurrence, ...r.upcoming.map((iso) => `  ${local(iso)}`)].join("\n"),
  },
  {
    name: "tick",
    category: "engine",
    summary: "Start every routine that is due, each in a detached process; Routine.app calls it every minute.",
    params: [{ name: "foreground", type: "boolean", description: "Run due routines in this process and wait." }],
    examples: ["routine tick --format text"],
    run: async (a) => ({ result: await tick(env().paths, env().config, { foreground: a.foreground === true }) }),
    text: tickText,
  },
  {
    name: "status",
    category: "engine",
    summary: "Kill switch state, routines running now, routines due.",
    params: [],
    examples: ["routine status --format text"],
    run: () => ({ result: engineStatus(env().ctx) }),
    text: statusText,
  },
  {
    name: "stop",
    category: "engine",
    summary: "Turn on the kill switch: no routine runs until `routine start`; running ones finish.",
    params: [],
    examples: ["routine stop"],
    run: async () => ({ result: await setStopped(env().ctx, true) }),
    text: statusText,
  },
  {
    name: "start",
    category: "engine",
    summary: "Turn off the kill switch.",
    params: [],
    examples: ["routine start"],
    run: async () => ({ result: await setStopped(env().ctx, false) }),
    text: statusText,
  },
  {
    name: "exec",
    category: "engine",
    summary: "Run one routine if it is due (used by tick).",
    params: [ID],
    examples: [],
    hidden: true,
    streamed: true,
    run: async (a) => {
      const result = await execScheduled(env().paths, env().config, id(a));
      return { exitCode: result.record && result.record.status !== "ok" ? 1 : 0 };
    },
  },
  {
    name: "schema",
    category: "meta",
    summary: "Browse actions: the catalog, a category, or one action's full spec.",
    params: [
      { name: "category", type: "string", positional: true, description: "Category, or an action name." },
      { name: "action", type: "string", positional: true, description: "Action of the category." },
    ],
    examples: ["routine schema", "routine schema routine", "routine schema routine add --format json"],
    meta: true,
    run: (a) => ({ result: schema(a.category as string | undefined, a.action as string | undefined) }),
    text: schemaText,
  },
  {
    name: "skill",
    category: "meta",
    summary: "Print the embedded agent skill, or install it for an agent harness.",
    params: [
      { name: "verb", type: "string", positional: true, enum: ["show", "install"], default: "show", description: "show or install." },
      { name: "for", type: "string", enum: ["claude"], default: "claude", description: "Harness to install for." },
      { name: "dir", type: "string", description: "Install into this directory instead of ~/.claude/skills/routine/." },
    ],
    examples: ["routine skill show", "routine skill install --for claude"],
    meta: true,
    run: (a) => {
      const text = readFileSync(join(import.meta.dirname, "..", "skill", "SKILL.md"), "utf8");
      if (a.verb === "show") return { result: text };
      const dir = (a.dir as string | undefined) ?? join(homedir(), ".claude", "skills", "routine");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "SKILL.md");
      writeFileSync(file, text);
      return { result: { installed: file } };
    },
    text: (r: string | { installed: string }) => (typeof r === "string" ? r : `installed ${r.installed}`),
  },
  {
    name: "version",
    category: "meta",
    summary: "Print the routine version.",
    params: [],
    examples: ["routine version"],
    meta: true,
    run: () => ({ result: { version: VERSION } }),
    text: (r: { version: string }) => `routine ${r.version}`,
  },
  {
    name: "tui",
    category: "meta",
    summary: "Open the terminal interface; --select opens it on one routine, selected and visible.",
    params: [{ name: "select", type: "string", description: "Routine id to select at start, e.g. office/perso-ingest; an unknown id opens the list with a message." }],
    examples: ["routine tui", "routine tui --select office/perso-ingest"],
    meta: true,
    streamed: true,
    run: (a) => {
      const binary = join(import.meta.dirname, "..", "tui", "routine-tui");
      if (!existsSync(binary)) throw notFound(`${binary} not found: run npm run build:tui`);
      const args = typeof a.select === "string" ? ["--select", a.select] : [];
      const result = spawnSync(binary, args, {
        stdio: "inherit",
        env: { ...process.env, ROUTINE_CLI: JSON.stringify([process.execPath, process.argv[1]!]) },
      });
      if (result.error) throw result.error;
      return { exitCode: result.status ?? 1 };
    },
  },
  {
    name: "mcp",
    category: "meta",
    summary: "Serve the routine actions as MCP tools on stdio.",
    params: [],
    examples: ["claude mcp add --scope user routine -- routine mcp"],
    meta: true,
    streamed: true,
    run: async () => {
      const { serveMcp } = await import("./mcp.ts");
      await serveMcp(env().ctx);
      return {};
    },
  },
];

const VISIBLE = ACTIONS.filter((a) => !a.hidden);
const CATEGORIES = [...new Set(VISIBLE.map((a) => a.category))];

function schema(category?: string, action?: string): unknown {
  if (!category) return CATEGORIES.map((c) => ({ category: c, action_count: VISIBLE.filter((a) => a.category === c).length }));
  if (!CATEGORIES.includes(category)) {
    const named = VISIBLE.find((a) => a.name === category);
    if (named && !action) return actionSpec(named);
    throw notFound(`unknown category or action ${JSON.stringify(category)}; categories: ${CATEGORIES.join(", ")}`);
  }
  if (!action) return VISIBLE.filter((a) => a.category === category).map((a) => ({ name: a.name, command: `${COMMAND} ${a.name}`, summary: a.summary }));
  const found = VISIBLE.find((a) => a.category === category && a.name === action);
  if (!found) throw notFound(`unknown action ${JSON.stringify(action)} in ${category}; run \`routine schema ${category}\``);
  return actionSpec(found);
}

function schemaText(result: unknown): string {
  if (Array.isArray(result) && result.length && "category" in result[0]) {
    return (result as { category: string; action_count: number }[]).map((c) => `${c.category.padEnd(10)} ${c.action_count} actions`).join("\n");
  }
  if (Array.isArray(result)) {
    return (result as { command: string; summary: string }[]).map((a) => `${a.command.padEnd(18)} ${a.summary}`).join("\n");
  }
  const spec = result as { name: string };
  return actionText(VISIBLE.find((a) => a.name === spec.name)!);
}

function rootHelp(): string {
  const lines = [
    "routine — scheduled routines described by Markdown files with RRULE schedules",
    "",
    "Usage: routine <action> [arguments] [--format json|text]",
    "Run `routine schema` for the categories, `routine schema <category> <action>` for one action.",
    "",
  ];
  for (const c of CATEGORIES) lines.push(`  ${c.padEnd(10)} ${VISIBLE.filter((a) => a.category === c).map((a) => a.name).join(", ")}`);
  lines.push("", `Version ${VERSION}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- main

async function main(argv: string[]): Promise<number> {
  let format: string | undefined;
  let help = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--format" && i + 1 < argv.length) format = argv[++i];
    else if (arg.startsWith("--format=")) format = arg.slice("--format=".length);
    else if (arg === "--json") format = "json";
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--version") rest.push("version");
    else rest.push(arg);
  }
  if (format !== undefined && format !== "json" && format !== "text") {
    return emit(undefined, "json", undefined, userError(`--format takes json or text, got ${JSON.stringify(format)}. Example: routine ls --format text`));
  }
  const [name, ...args] = rest;
  if (!name || name === "help") {
    process.stdout.write(`${rootHelp()}\n`);
    return 0;
  }
  const action = ACTIONS.find((a) => a.name === name);
  if (!action) {
    return emit(undefined, format, undefined, userError(`unknown action ${JSON.stringify(name)}. Run \`routine schema\` to list them, for example \`routine ls\``));
  }
  if (help) {
    process.stdout.write(`${actionText(action)}\n`);
    return 0;
  }
  try {
    const parsed = parseAction(action, args);
    const outcome = await action.run(parsed);
    if (action.streamed) return outcome.exitCode ?? 0;
    return emit(action, format, outcome);
  } catch (error) {
    return emit(action, format, undefined, error);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.exitCode = emit(undefined, "text", undefined, error);
  },
);
