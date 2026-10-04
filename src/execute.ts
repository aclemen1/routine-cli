import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { Config } from "./config.ts";
import { expandHome, type Paths } from "./paths.ts";
import type { RunRecord, RunStatus } from "./state.ts";
import type { AcpSpec, Task } from "./task.ts";

const KILL_GRACE_MS = 10_000;

export interface RunOptions {
  scheduled?: string;
  manual?: boolean;
}

interface RunContext {
  task: Task;
  config: Config;
  options: RunOptions;
  started: Date;
  log: string;
  out: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface Outcome {
  status: RunStatus;
  exitCode: number | null;
  error?: string;
  sessionId?: string;
  stopReason?: string;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // group already gone
  }
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", () => resolve()));
}

// Runs a routine with its executor; output goes to a per-run log file.
export async function runTask(task: Task, config: Config, paths: Paths, options: RunOptions = {}): Promise<RunRecord> {
  const started = new Date();
  const logDir = join(paths.runs, task.id);
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, `${stamp(started)}.log`);
  const out = openSync(log, "a");
  const context: RunContext = {
    task,
    config,
    options,
    started,
    log,
    out,
    cwd: task.cwd ? expandHome(task.cwd) : homedir(),
    env: {
      ...process.env,
      ...config.env,
      ROUTINE_ID: task.id,
      ROUTINE_LOG: log,
      ...(options.scheduled ? { ROUTINE_SCHEDULED: options.scheduled } : {}),
    },
  };
  let outcome: Outcome;
  try {
    outcome = task.acp ? await runAcp(context, task.acp) : await runCommand(context, task.run!);
  } finally {
    closeSync(out);
  }
  const record: RunRecord = {
    id: task.id,
    started: started.toISOString(),
    ended: new Date().toISOString(),
    status: outcome.status,
    exitCode: outcome.exitCode,
    log,
  };
  if (options.scheduled) record.scheduled = options.scheduled;
  if (options.manual) record.manual = true;
  if (outcome.error) record.error = outcome.error;
  if (outcome.sessionId) record.sessionId = outcome.sessionId;
  if (outcome.stopReason) record.stopReason = outcome.stopReason;
  return record;
}

// The command runs in its own process group, so a timeout kills its children too.
async function runCommand(context: RunContext, run: string): Promise<Outcome> {
  const [shell, ...shellArgs] = context.config.shell;
  let timedOut = false;
  let spawnError: string | undefined;
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    const child = spawn(shell!, [...shellArgs, run], {
      cwd: context.cwd,
      env: context.env,
      stdio: ["pipe", context.out, context.out],
      detached: true,
    });
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
    }, context.task.timeoutMs);
    child.stdin?.on("error", () => {});
    child.stdin?.end(context.task.body);
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
  if (spawnError) return { status: "error", exitCode: null, error: spawnError };
  const outcome: Outcome = { status: timedOut ? "timeout" : result.code === 0 ? "ok" : "failed", exitCode: result.code };
  if (result.signal) outcome.error = `killed by ${result.signal}`;
  return outcome;
}

function choosePermission(params: acp.RequestPermissionRequest, policy: AcpSpec["permissions"]): acp.RequestPermissionResponse {
  const kinds = policy === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of kinds) {
    const option = params.options.find((o) => o.kind === kind);
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

// Starts the ACP server, opens a session, sends the body as the prompt and waits for the end of the turn.
async function runAcp(context: RunContext, spec: AcpSpec): Promise<Outcome> {
  const write = (text: string) => writeSync(context.out, text);
  const child = spawn(expandHome(spec.command), spec.args.map(expandHome), {
    cwd: context.cwd,
    env: context.env,
    stdio: ["pipe", "pipe", context.out],
    detached: true,
  });
  const failed = new Promise<never>((_, reject) => {
    child.once("error", (error) => reject(error));
    child.once("close", (code, signal) => reject(new Error(`ACP server exited (${signal ?? `code ${code}`})`)));
  });
  failed.catch(() => {});

  let timedOut = false;
  let sessionId: string | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let lastWasText = false;
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);

  const session = acp
    .client({ name: "routine" })
    .onRequest("session/request_permission", ({ params }) => {
      const answer = choosePermission(params, spec.permissions);
      write(`${lastWasText ? "\n" : ""}[permission] ${params.toolCall.title ?? "tool"} → ${answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled"}\n`);
      lastWasText = false;
      return answer;
    })
    .onNotification("session/update", ({ params }) => {
      const update = params.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        write(update.content.text);
        lastWasText = true;
      } else if (update.sessionUpdate === "tool_call") {
        write(`${lastWasText ? "\n" : ""}[tool] ${update.title}\n`);
        lastWasText = false;
      }
    })
    .connectWith(stream, async (ctx) => {
      await ctx.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const created = await ctx.request("session/new", {
        cwd: context.cwd,
        mcpServers: [],
        ...(spec.meta ? { _meta: spec.meta } : {}),
      });
      sessionId = created.sessionId;
      write(`[acp] session ${sessionId}\n`);
      const timer = setTimeout(() => {
        timedOut = true;
        write("\n[acp] timeout: session/cancel\n");
        void ctx.notify("session/cancel", { sessionId: sessionId! }).catch(() => {});
        killTimer = setTimeout(() => killGroup(child.pid, "SIGTERM"), KILL_GRACE_MS);
      }, context.task.timeoutMs);
      let response: acp.PromptResponse;
      try {
        response = await ctx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: context.task.body }] });
      } finally {
        clearTimeout(timer);
        clearTimeout(killTimer);
      }
      const status: RunStatus = timedOut ? "timeout" : response.stopReason === "end_turn" ? "ok" : "failed";
      write(`${lastWasText ? "\n" : ""}[acp] stop: ${response.stopReason}\n`);
      if (spec.close === "always" || (spec.close === "on-success" && status === "ok")) {
        try {
          await ctx.request("session/close", { sessionId });
          write("[acp] session closed\n");
        } catch (error) {
          write(`[acp] session/close failed: ${(error as Error).message}\n`);
        }
      }
      return { status, stopReason: response.stopReason };
    });

  let outcome: Outcome;
  try {
    const result = await Promise.race([session, failed]);
    outcome = { status: result.status, exitCode: null, stopReason: result.stopReason };
  } catch (error) {
    const message = (error as Error).message;
    write(`\n[acp] ${message}\n`);
    outcome = { status: timedOut ? "timeout" : "error", exitCode: null, error: message };
  }
  if (sessionId) outcome.sessionId = sessionId;

  child.stdin?.end();
  const stop = setTimeout(() => killGroup(child.pid, "SIGTERM"), KILL_GRACE_MS);
  await exited(child);
  clearTimeout(stop);
  return outcome;
}
