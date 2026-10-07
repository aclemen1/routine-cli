import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Config } from "./config.ts";
import type { RunRecord } from "./state.ts";
import type { Task } from "./task.ts";

const NOTIFY_TIMEOUT_MS = 60_000;
const TAIL_LINES = 12;

export type NotifyEvent = "failed" | "recovered";

// The event a run brings: a first failure, or the first success after failures.
export function notifyEvent(wasFailing: boolean, record: RunRecord): NotifyEvent | null {
  const failing = record.status !== "ok";
  if (failing && !wasFailing) return "failed";
  if (!failing && wasFailing) return "recovered";
  return null;
}

function tail(file: string): string {
  if (!existsSync(file)) return "";
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  return lines.slice(-TAIL_LINES).join("\n");
}

export function notifyText(task: Task, record: RunRecord, event: NotifyEvent): string {
  const lines: string[] = [];
  if (event === "failed") {
    lines.push(`Routine ${task.id}: ${record.status}${record.error ? ` (${record.error})` : ""}`);
  } else {
    lines.push(`Routine ${task.id}: ok again`);
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
export async function notify(task: Task, config: Config, record: RunRecord, event: NotifyEvent): Promise<void> {
  const command = notifyCommand(task, config);
  if (!command) return;
  const [shell, ...shellArgs] = config.shell;
  const note = (text: string) => {
    try {
      appendFileSync(record.log, `[notify] ${text}\n`);
    } catch {
      // the run log is gone
    }
  };
  await new Promise<void>((resolve) => {
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
    child.stdin?.end(notifyText(task, record, event));
    child.on("error", (error) => {
      clearTimeout(timer);
      note(`${event}: ${error.message}`);
      resolve();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      note(`${event}: ${code === 0 ? "sent" : `on_failure exited ${code}`}${output.trim() ? ` · ${output.trim().split("\n").at(-1)}` : ""}`);
      resolve();
    });
  });
}
