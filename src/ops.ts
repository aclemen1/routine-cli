import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.ts";
import { formatDuration } from "./duration.ts";
import { isDue, runNow } from "./engine.ts";
import type { Paths } from "./paths.ts";
import { nextOccurrences } from "./schedule.ts";
import { lockHolder, lockSince, readJournal, readState, removeState, writeState, type RunRecord } from "./state.ts";
import {
  checkId,
  loadTasks,
  parseTask,
  readTask,
  taskFile,
  writeTaskFile,
  type AcpSpec,
  type ClosePolicy,
  type FieldValues,
  type PermissionPolicy,
  type Step,
  type Task,
  type TaskError,
} from "./task.ts";

// Operations shared by the CLI and the MCP server.

export interface Context {
  paths: Paths;
  config: Config;
}

export interface RoutineInput {
  rrule?: string[];
  dtstart?: string | null;
  tz?: string | null;
  run?: string;
  acp?: { command: string; args?: string[]; meta?: Record<string, unknown> };
  // As in the routine file: name, run or acp, close, permissions, timeout, cwd, continue_on_error.
  steps?: Record<string, unknown>[];
  close?: ClosePolicy | null;
  permissions?: PermissionPolicy | null;
  meta?: Record<string, unknown> | null;
  cwd?: string | null;
  timeout?: string | null;
  owner?: string | null;
  body?: string;
}

export interface Summary {
  id: string;
  file: string;
  owner?: string;
  active: boolean;
  running: boolean;
  runningSince?: string;
  rrules: string[];
  recurrence: string;
  dtstart?: string;
  tz: string;
  timeout: string;
  cwd?: string;
  run?: string;
  acp?: AcpSpec;
  steps?: Step[];
  meta?: Record<string, unknown>;
  next: string | null;
  lastScheduled?: string;
  lastRun?: RunRecord;
}

export interface Detail extends Summary {
  upcoming: string[];
  body: string;
}

export interface EngineStatus {
  stopped: boolean;
  routines: number;
  active: number;
  running: string[];
  due: string[];
  invalid: number;
}

const OPTIONAL = ["dtstart", "tz", "cwd", "timeout", "owner", "close", "permissions"] as const;

// An empty string or null removes an optional field. Setting run drops acp and the reverse.
function toFieldValues(input: RoutineInput): FieldValues {
  const values: FieldValues = {};
  if (input.rrule !== undefined) {
    if (input.rrule.length === 0 || input.rrule.some((r) => r.trim() === "")) throw new Error("rrule cannot be empty");
    values.rrule = input.rrule.length === 1 ? input.rrule[0]! : input.rrule;
  }
  for (const key of OPTIONAL) {
    const value = input[key];
    if (value !== undefined) values[key] = value === null || value === "" ? null : value;
  }
  if (input.meta !== undefined) values.meta = input.meta === null || Object.keys(input.meta).length === 0 ? null : input.meta;
  const executors = [input.run, input.acp, input.steps].filter((v) => v !== undefined).length;
  if (executors > 1) throw new Error("give one of run, acp or steps");
  if (input.run !== undefined) {
    if (!input.run.trim()) throw new Error("run cannot be empty");
    values.run = input.run;
    values.acp = null;
    values.steps = null;
    if (input.close === undefined) values.close = null;
    if (input.permissions === undefined) values.permissions = null;
  }
  if (input.acp !== undefined) {
    const acp: Record<string, unknown> = { command: input.acp.command };
    if (input.acp.args?.length) acp.args = input.acp.args;
    if (input.acp.meta !== undefined) acp.meta = input.acp.meta;
    values.acp = acp;
    values.run = null;
    values.steps = null;
  }
  if (input.steps !== undefined) {
    values.steps = input.steps;
    values.run = null;
    values.acp = null;
    values.close = null;
    values.permissions = null;
  }
  return values;
}

// Writes the file, then parses it back; a file that does not parse is rolled back.
function writeValidated(ctx: Context, file: string, id: string, values: FieldValues, body: string | undefined): Task {
  const previous = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  writeTaskFile(file, values, body);
  try {
    return parseTask(id, file, readFileSync(file, "utf8"), ctx.config);
  } catch (error) {
    if (previous === undefined) rmSync(file, { force: true });
    else writeFileSync(file, previous);
    throw new Error(`${id}: ${(error as Error).message}`);
  }
}

export function summarize(ctx: Context, task: Task, nowMs = Date.now()): Summary {
  const state = readState(ctx.paths, task.id);
  const [next] = task.active ? nextOccurrences(task.schedule, nowMs, 1) : [];
  const summary: Summary = {
    id: task.id,
    file: task.file,
    active: task.active,
    running: lockHolder(ctx.paths, task.id) !== null,
    rrules: task.rrules,
    recurrence: task.schedule.text,
    tz: task.tz,
    timeout: formatDuration(task.timeoutMs),
    next: next === undefined ? null : new Date(next).toISOString(),
  };
  const since = summary.running ? lockSince(ctx.paths, task.id) : null;
  if (since) summary.runningSince = since;
  if (task.owner) summary.owner = task.owner;
  if (task.dtstart) summary.dtstart = task.dtstart;
  if (task.cwd) summary.cwd = task.cwd;
  if (task.run) summary.run = task.run;
  if (task.acp) summary.acp = task.acp;
  if (task.steps) summary.steps = task.steps;
  if (task.meta) summary.meta = task.meta;
  if (state?.lastScheduled) summary.lastScheduled = state.lastScheduled;
  if (state?.lastRun) summary.lastRun = state.lastRun;
  return summary;
}

export function addRoutine(ctx: Context, id: string, input: RoutineInput, paused = false): Summary {
  const file = taskFile(ctx.paths.tasks, id);
  if (existsSync(file)) throw new Error(`routine ${JSON.stringify(id)} already exists`);
  if (!input.rrule?.length) throw new Error("a new routine needs rrule");
  if (input.run === undefined && input.acp === undefined && input.steps === undefined) throw new Error("a new routine needs run, acp or steps");
  const task = writeValidated(ctx, file, id, { ...toFieldValues(input), active: !paused }, input.body);
  const since = new Date().toISOString();
  writeState(ctx.paths, id, paused ? { since, inactiveSeen: true } : { since });
  return summarize(ctx, task);
}

export function editRoutine(ctx: Context, id: string, input: RoutineInput): Summary {
  const file = readTask(ctx.paths.tasks, id, ctx.config).file;
  return summarize(ctx, writeValidated(ctx, file, id, toFieldValues(input), input.body));
}

export function setActive(ctx: Context, id: string, active: boolean): Summary {
  const file = readTask(ctx.paths.tasks, id, ctx.config).file;
  const task = writeValidated(ctx, file, id, { active }, undefined);
  const now = new Date().toISOString();
  const state = readState(ctx.paths, id) ?? { since: now };
  if (active) {
    const { inactiveSeen: _, ...rest } = state;
    writeState(ctx.paths, id, { ...rest, since: now });
  } else writeState(ctx.paths, id, { ...state, inactiveSeen: true });
  return summarize(ctx, task);
}

export function removeRoutine(ctx: Context, id: string): { id: string; removed: true } {
  const file = taskFile(ctx.paths.tasks, id);
  if (!existsSync(file)) throw new Error(`no routine ${JSON.stringify(id)}`);
  rmSync(file);
  removeState(ctx.paths, id);
  return { id, removed: true };
}

function ownerMatches(owner: string | undefined, pattern: string): boolean {
  if (owner === undefined) return false;
  return pattern.endsWith("*") ? owner.startsWith(pattern.slice(0, -1)) : owner === pattern;
}

// A trailing * in owner matches a prefix. Invalid files are listed only without an owner filter.
export function listRoutines(ctx: Context, owner?: string): { routines: Summary[]; errors: TaskError[] } {
  const { tasks, errors } = loadTasks(ctx.paths.tasks, ctx.config);
  const selected = owner === undefined ? tasks : tasks.filter((t) => ownerMatches(t.owner, owner));
  const now = Date.now();
  return { routines: selected.map((t) => summarize(ctx, t, now)), errors: owner === undefined ? errors : [] };
}

export function showRoutine(ctx: Context, id: string, count = 5): Detail {
  const task = readTask(ctx.paths.tasks, checkId(id), ctx.config);
  const now = Date.now();
  const upcoming = task.active ? nextOccurrences(task.schedule, now, count).map((ms) => new Date(ms).toISOString()) : [];
  return { ...summarize(ctx, task, now), upcoming, body: task.body };
}

export async function runRoutine(ctx: Context, id: string): Promise<RunRecord> {
  const result = await runNow(ctx.paths, ctx.config, checkId(id));
  if (result.outcome === "busy" || !result.record) throw new Error(`${id} is already running`);
  return result.record;
}

export function readRuns(ctx: Context, id: string | undefined, limit = 20): RunRecord[] {
  return readJournal(ctx.paths, id ? { id: checkId(id), limit } : { limit });
}

export function checkRoutines(ctx: Context): { valid: string[]; errors: TaskError[] } {
  const { tasks, errors } = loadTasks(ctx.paths.tasks, ctx.config);
  return { valid: tasks.map((t) => t.id), errors };
}

export function setStopped(ctx: Context, stopped: boolean): EngineStatus {
  if (stopped) {
    mkdirSync(dirname(ctx.paths.stopFile), { recursive: true });
    writeFileSync(ctx.paths.stopFile, `${new Date().toISOString()}\n`);
  } else rmSync(ctx.paths.stopFile, { force: true });
  return engineStatus(ctx);
}

export function engineStatus(ctx: Context): EngineStatus {
  const now = Date.now();
  const { tasks, errors } = loadTasks(ctx.paths.tasks, ctx.config);
  return {
    stopped: existsSync(ctx.paths.stopFile),
    routines: tasks.length,
    active: tasks.filter((t) => t.active).length,
    running: tasks.filter((t) => lockHolder(ctx.paths, t.id) !== null).map((t) => t.id),
    due: tasks
      .filter((t) => {
        const state = readState(ctx.paths, t.id);
        return state !== undefined && isDue(t, state, now) !== null;
      })
      .map((t) => t.id),
    invalid: errors.length,
  };
}
