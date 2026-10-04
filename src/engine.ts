import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { runCommand } from "./execute.ts";
import type { Paths } from "./paths.ts";
import { dueOccurrence } from "./schedule.ts";
import { appendJournal, floorMs, readState, tryLock, writeState, type RunRecord, type TaskState } from "./state.ts";
import { loadTasks, readTask, type Task, type TaskError } from "./task.ts";

export type ExecOutcome = "ran" | "busy" | "not-due" | "inactive";

export interface ExecResult {
  id: string;
  outcome: ExecOutcome;
  record?: RunRecord;
}

// Brings the state in line with the routine: first sight and resumption open a fresh window.
export function syncState(task: Task, state: TaskState | undefined, nowMs: number): TaskState {
  const now = new Date(nowMs).toISOString();
  if (!state) return task.active ? { since: now } : { since: now, inactiveSeen: true };
  if (!task.active) return state.inactiveSeen ? state : { ...state, inactiveSeen: true };
  if (state.inactiveSeen) {
    const { inactiveSeen: _, ...rest } = state;
    return { ...rest, since: now };
  }
  return state;
}

function syncAndSave(paths: Paths, task: Task, nowMs: number): TaskState {
  const before = readState(paths, task.id);
  const after = syncState(task, before, nowMs);
  if (after !== before) writeState(paths, task.id, after);
  return after;
}

export function isDue(task: Task, state: TaskState, nowMs: number): number | null {
  if (!task.active) return null;
  return dueOccurrence(task.schedule, floorMs(state), nowMs);
}

// Runs one routine if it is due. The occurrence is recorded before the run: a run cut short is not repeated.
export async function execScheduled(paths: Paths, config: Config, id: string, nowMs = Date.now()): Promise<ExecResult> {
  const release = tryLock(paths, id);
  if (!release) return { id, outcome: "busy" };
  try {
    const task = readTask(paths.tasks, id, config);
    const state = syncAndSave(paths, task, nowMs);
    if (!task.active) return { id, outcome: "inactive" };
    const due = isDue(task, state, nowMs);
    if (due === null) return { id, outcome: "not-due" };
    const scheduled = new Date(due).toISOString();
    writeState(paths, id, { ...state, lastScheduled: scheduled });
    const record = await runCommand(task, config, paths, { scheduled });
    writeState(paths, id, { ...(readState(paths, id) ?? state), lastScheduled: scheduled, lastRun: record });
    appendJournal(paths, record);
    return { id, outcome: "ran", record };
  } finally {
    release();
  }
}

// Runs a routine now, outside its schedule, even when paused. The schedule is left untouched.
export async function runNow(paths: Paths, config: Config, id: string): Promise<ExecResult> {
  const task = readTask(paths.tasks, id, config);
  const release = tryLock(paths, id);
  if (!release) return { id, outcome: "busy" };
  try {
    const record = await runCommand(task, config, paths, { manual: true });
    const state = readState(paths, id) ?? syncState(task, undefined, Date.parse(record.started));
    writeState(paths, id, { ...state, lastRun: record });
    appendJournal(paths, record);
    return { id, outcome: "ran", record };
  } finally {
    release();
  }
}

export interface TickResult {
  stopped: boolean;
  due: string[];
  errors: TaskError[];
  results: ExecResult[];
}

export interface TickOptions {
  nowMs?: number;
  // Run due routines in this process and wait; otherwise each runs in a detached `routine exec`.
  foreground?: boolean;
  cliPath?: string;
}

export async function tick(paths: Paths, config: Config, options: TickOptions = {}): Promise<TickResult> {
  const nowMs = options.nowMs ?? Date.now();
  if (existsSync(paths.stopFile)) return { stopped: true, due: [], errors: [], results: [] };
  collectGarbage(paths, config, nowMs);
  const { tasks, errors } = loadTasks(paths.tasks, config);
  const due: string[] = [];
  for (const task of tasks) {
    const state = syncAndSave(paths, task, nowMs);
    if (isDue(task, state, nowMs) !== null) due.push(task.id);
  }
  if (options.foreground) {
    const results = await Promise.all(due.map((id) => execScheduled(paths, config, id, nowMs)));
    return { stopped: false, due, errors, results };
  }
  const cli = options.cliPath ?? process.argv[1]!;
  for (const id of due) {
    const child = spawn(process.execPath, [cli, "exec", id], { detached: true, stdio: "ignore", env: process.env });
    child.unref();
  }
  return { stopped: false, due, errors, results: [] };
}

function collectGarbage(paths: Paths, config: Config, nowMs: number): void {
  if (!existsSync(paths.runs)) return;
  const limit = nowMs - config.retentionDays * 86_400_000;
  for (const entry of readdirSync(paths.runs, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
    const file = join(entry.parentPath, entry.name);
    if (statSync(file).mtimeMs < limit) rmSync(file, { force: true });
  }
}
