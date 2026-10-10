import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Config } from "./config.ts";
import type { RunRecord } from "./state.ts";
import type { Task } from "./task.ts";
import { routineEvent } from "./events.ts";

const NOTIFY_TIMEOUT_MS = 60_000;
const TAIL_LINES = 12;

export type NotifyEvent = "failed" | "recovered";

export interface AlertThreshold {
  failures: number;
  durationMs: number;
}

// Kept in the routine's state between runs.
export interface AlertState {
  failStreak?: number;
  failingSince?: string;
  alerted?: boolean;
}

// A failing routine alerts once its streak reaches the threshold, once it has failed for the
// threshold's duration, or at once when its next run would come after that duration.
export function shouldAlert(threshold: AlertThreshold, streak: number, sinceMs: number, nowMs: number, nextMs: number | null): boolean {
  const deadline = sinceMs + threshold.durationMs;
  return streak >= threshold.failures || nowMs >= deadline || nextMs === null || nextMs > deadline;
}

export function threshold(task: Task, config: Config): AlertThreshold {
  return { ...config.alertAfter, ...task.alertAfter };
}

// Updates the alert state after a run and sends what it calls for. The recovery is told only
// when the failure was; an alert that could not be sent is tried again on the next failed run.
export async function handleAlert(task: Task, config: Config, before: AlertState, record: RunRecord, nowMs: number, nextMs: number | null): Promise<AlertState> {
  if (record.status === "ok") {
    if (before.alerted) await notify(task, config, record, "recovered", before);
    return {};
  }
  const streak = (before.failStreak ?? 0) + 1;
  const since = before.failingSince ?? record.started;
  let alerted = before.alerted === true;
  if (!alerted && shouldAlert(threshold(task, config), streak, Date.parse(since), nowMs, nextMs)) {
    alerted = await notify(task, config, record, "failed", { failStreak: streak, failingSince: since });
  }
  return { failStreak: streak, failingSince: since, ...(alerted ? { alerted } : {}) };
}

function tail(file: string): string {
  if (!existsSync(file)) return "";
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  return lines.slice(-TAIL_LINES).join("\n");
}

function since(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return ` since ${d.toLocaleString("fr-CH", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
}

export function notifyText(task: Task, record: RunRecord, event: NotifyEvent, alert: AlertState = {}): string {
  const lines: string[] = [];
  const runs = alert.failStreak && alert.failStreak > 1 ? `${alert.failStreak} failed runs` : "1 failed run";
  if (event === "failed") {
    lines.push(`Routine ${task.id}: ${record.status}${record.error ? ` (${record.error})` : ""}, ${runs}${since(alert.failingSince)}`);
  } else {
    lines.push(`Routine ${task.id}: ok again after ${runs}${since(alert.failingSince)}`);
  }
  if (task.description) lines.push(task.description);
  if (record.steps) lines.push(`Steps: ${record.steps.map((s) => `${s.name} ${s.status}`).join(", ")}`);
  lines.push(`Log: ${record.log}`);
  if (event === "failed") {
    const end = tail(record.log);
    if (end) lines.push("", "```", end, "```");
  }
  return `${lines.join("\n")}\n`;
}

// The routine's own on_failure wins over the config's; "none" turns notifications off.
export function notifyCommand(task: Task, config: Config): string | null {
  const command = task.onFailure ?? config.onFailure;
  return command && command !== "none" ? command : null;
}

// Runs the on_failure command with the message on stdin. Its outcome goes to the run log; it never fails the run.
export async function notify(task: Task, config: Config, record: RunRecord, event: NotifyEvent, alert: AlertState = {}): Promise<boolean> {
  const command = notifyCommand(task, config);
  if (!command) return false;
  const [shell, ...shellArgs] = config.shell;
  const note = (text: string) => {
    try {
      appendFileSync(record.log, `[notify] ${text}\n`);
    } catch {
      // the run log is gone
    }
  };
  return await new Promise<boolean>((resolve) => {
    let output = "";
    const child = spawn(shell!, [...shellArgs, command], {
      cwd: homedir(),
      env: {
        ...process.env,
        ...config.env,
        ROUTINE_ID: task.id,
        ROUTINE_EVENT: event,
        ROUTINE_STATUS: record.status,
        ROUTINE_LOG: record.log,
        ...(record.error ? { ROUTINE_ERROR: record.error } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), NOTIFY_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    child.stdin?.on("error", () => {});
    child.stdin?.end(notifyText(task, record, event, alert));
    child.on("error", (error) => {
      clearTimeout(timer);
      note(`${event}: ${error.message}`);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      note(`${event}: ${code === 0 ? "sent" : `on_failure exited ${code}`}${output.trim() ? ` · ${output.trim().split("\n").at(-1)}` : ""}`);
      if (code === 0 && event === "failed") {
        void routineEvent(config, task, "alert", `alert sent: ${record.status}, ${alert.failStreak ?? 1} failed run(s)`).finally(() => resolve(true));
      } else resolve(code === 0);
    });
  });
}
