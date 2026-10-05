import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Paths } from "./paths.ts";

export type RunStatus = "ok" | "failed" | "timeout" | "error";

export interface StepRecord {
  name: string;
  status: RunStatus | "skipped";
  started: string;
  ended: string;
  exitCode?: number;
  error?: string;
  sessionId?: string;
  stopReason?: string;
}

export interface RunRecord {
  id: string;
  started: string;
  ended: string;
  status: RunStatus;
  exitCode: number | null;
  log: string;
  scheduled?: string;
  manual?: boolean;
  error?: string;
  sessionId?: string;
  stopReason?: string;
  steps?: StepRecord[];
}

export interface TaskState {
  // Occurrences at or before `since` never run: set when a routine is first seen or resumed.
  since: string;
  lastScheduled?: string;
  inactiveSeen?: boolean;
  lastRun?: RunRecord;
}

function stateFile(paths: Paths, id: string): string {
  return join(paths.taskState, `${id}.json`);
}

export function readState(paths: Paths, id: string): TaskState | undefined {
  const file = stateFile(paths, id);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as TaskState;
}

export function writeState(paths: Paths, id: string, state: TaskState): void {
  const file = stateFile(paths, id);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

export function removeState(paths: Paths, id: string): void {
  rmSync(stateFile(paths, id), { force: true });
}

// Floor below which occurrences are never run.
export function floorMs(state: TaskState): number {
  const since = Date.parse(state.since);
  return state.lastScheduled ? Math.max(since, Date.parse(state.lastScheduled)) : since;
}

const JOURNAL_MAX_BYTES = 5 * 1024 * 1024;

export function appendJournal(paths: Paths, record: RunRecord): void {
  mkdirSync(dirname(paths.journal), { recursive: true });
  if (existsSync(paths.journal) && statSync(paths.journal).size > JOURNAL_MAX_BYTES) {
    renameSync(paths.journal, `${paths.journal}.1`);
  }
  appendFileSync(paths.journal, `${JSON.stringify(record)}\n`);
}

export function readJournal(paths: Paths, filter: { id?: string; limit: number }): RunRecord[] {
  const files = [`${paths.journal}.1`, paths.journal].filter((f) => existsSync(f));
  const records: RunRecord[] = [];
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as RunRecord;
      if (!filter.id || record.id === filter.id) records.push(record);
    }
  }
  return records.slice(-filter.limit);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Returns a release function, or null when a live process holds the lock.
export function tryLock(paths: Paths, id: string): (() => void) | null {
  const file = join(paths.locks, `${id}.lock`);
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(file, "utf8"));
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}

export function lockHolder(paths: Paths, id: string): number | null {
  const file = join(paths.locks, `${id}.lock`);
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, "utf8"));
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
}
