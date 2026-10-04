import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { expandHome, type Paths } from "./paths.ts";
import type { RunRecord, RunStatus } from "./state.ts";
import type { Task } from "./task.ts";

const KILL_GRACE_MS = 10_000;

export interface RunOptions {
  scheduled?: string;
  manual?: boolean;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // group already gone
  }
}

// Runs the routine's command in its own process group; stdout and stderr go to a log file.
export async function runCommand(task: Task, config: Config, paths: Paths, options: RunOptions = {}): Promise<RunRecord> {
  const started = new Date();
  const logDir = join(paths.runs, task.id);
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, `${stamp(started)}.log`);
  const out = openSync(log, "a");
  const [shell, ...shellArgs] = config.shell;
  let timedOut = false;
  let spawnError: string | undefined;

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    const child = spawn(shell!, [...shellArgs, task.run], {
      cwd: task.cwd ? expandHome(task.cwd) : homedir(),
      env: {
        ...process.env,
        ...config.env,
        ROUTINE_ID: task.id,
        ROUTINE_LOG: log,
        ...(options.scheduled ? { ROUTINE_SCHEDULED: options.scheduled } : {}),
      },
      stdio: ["pipe", out, out],
      detached: true,
    });
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        killGroup(child.pid, "SIGTERM");
        killTimer = setTimeout(() => killGroup(child.pid!, "SIGKILL"), KILL_GRACE_MS);
      }
    }, task.timeoutMs);
    child.stdin?.on("error", () => {});
    child.stdin?.end(task.body);
    child.on("error", (error) => {
      spawnError = error.message;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ code: null, signal: null });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ code, signal });
    });
  });
  closeSync(out);

  const status: RunStatus = spawnError ? "error" : timedOut ? "timeout" : result.code === 0 ? "ok" : "failed";
  const record: RunRecord = {
    id: task.id,
    started: started.toISOString(),
    ended: new Date().toISOString(),
    status,
    exitCode: result.code,
    log,
  };
  if (options.scheduled) record.scheduled = options.scheduled;
  if (options.manual) record.manual = true;
  if (spawnError) record.error = spawnError;
  else if (result.signal) record.error = `killed by ${result.signal}`;
  return record;
}
