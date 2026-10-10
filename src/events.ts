import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Config } from "./config.ts";
import { formatDuration } from "./duration.ts";
import { formatLocal } from "./schedule.ts";
import type { RunRecord } from "./state.ts";
import type { Task } from "./task.ts";

// Events go to the journal command of the config (logbook), `<cmd> add - --source routine:<id> …`,
// the text on stdin. A write that fails or hangs never holds a run back.

const WRITE_TIMEOUT_MS = 10_000;

export type EventType = "run" | "alert" | "state" | "change";

export const ENGINE_SOURCE = "engine";
// The engine is the user's own tooling: its events belong to the personal sphere.
export const ENGINE_SPHERE = "perso";

// The sphere of a routine: its own field, else the office of its owner (office:perso/P-0045).
export function sphereOf(task: { sphere?: string; owner?: string }): string | undefined {
  if (task.sphere) return task.sphere;
  return /^office:([a-z]+)(\/|$)/.exec(task.owner ?? "")?.[1];
}

// The dossier a routine belongs to, as a ref: office:perso/P-0045 → office:P-0045.
export function refOf(owner: string | undefined): string | undefined {
  const id = /^office:[a-z]+\/(.+)$/.exec(owner ?? "")?.[1];
  return id ? `office:${id}` : undefined;
}

export interface Event {
  id: string;
  type: EventType;
  sphere: string;
  text: string;
  at?: string;
  ref?: string;
}

export async function writeEvent(config: Config, event: Event): Promise<boolean> {
  const command = config.journal;
  if (!command?.length) return false;
  const [bin, ...base] = command;
  const args = [...base, "add", "-", "--source", `routine:${event.id}`, "--type", event.type, "--sphere", event.sphere, "--by", "routine", "--at", event.at ?? new Date().toISOString()];
  if (event.ref) args.push("--ref", event.ref);
  return new Promise<boolean>((resolve) => {
    let child;
    try {
      child = spawn(bin!, args, { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, ...config.env } });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), WRITE_TIMEOUT_MS);
    child.stdin?.on("error", () => {});
    child.stdin?.end(event.text);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

// An event about a routine: skipped when the routine has no sphere.
export async function routineEvent(config: Config, task: { id: string; sphere?: string; owner?: string }, type: EventType, text: string, at?: string): Promise<boolean> {
  const sphere = sphereOf(task);
  if (!sphere) return false;
  const event: Event = { id: task.id, type, sphere, text };
  if (at) event.at = at;
  const ref = refOf(task.owner);
  if (ref) event.ref = ref;
  return writeEvent(config, event);
}

export function runText(record: RunRecord, tz: string, firstErrorLine?: string): string {
  const duration = formatDuration(Date.parse(record.ended) - Date.parse(record.started));
  const parts: string[] = [record.status];
  if (record.exitCode !== null && record.status !== "ok") parts[0] += ` exit ${record.exitCode}`;
  if (record.stopReason && record.stopReason !== "end_turn") parts.push(record.stopReason);
  parts.push(duration, record.manual || !record.scheduled ? "manual" : `scheduled ${formatLocal(Date.parse(record.scheduled), tz)}`);
  if (record.steps) parts.push(`steps: ${record.steps.map((s) => `${s.name} ${s.status}`).join(", ")}`);
  const error = record.error ?? firstErrorLine;
  if (record.status !== "ok" && error) parts.push(error);
  return parts.join(" · ");
}

export function runEvent(config: Config, task: Task, record: RunRecord, firstErrorLine?: string): Promise<boolean> {
  return routineEvent(config, task, "run", runText(record, task.tz, firstErrorLine), record.ended);
}

// The first line of a failed run's log that reads like an error, else its last line.
export function firstErrorLine(log: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(log, "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("[notify]") && !l.startsWith("==="));
  const line = lines.find((l) => /error|fail|denied|not found|no such|refus/i.test(l)) ?? lines.at(-1);
  return line ? line.slice(0, 200) : undefined;
}
