import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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
  type RoutineInput,
} from "./ops.ts";

const AGREEMENT =
  "Call only after the user explicitly agreed to this exact change: show them the routine (schedule, command or prompt, recipients) first. " +
  "A routine may send without review only to the user; for anyone else it must produce a draft.";

const id = z.string().describe("Routine id: the path under the tasks directory without .md, e.g. office/perso-p-0014-brief");

const acp = z
  .object({
    command: z.string().describe("ACP server command, e.g. herdr-acp"),
    args: z.array(z.string()).optional().describe("Arguments of the ACP server"),
    meta: z.record(z.string(), z.unknown()).optional().describe("_meta object passed as is in session/new"),
  })
  .describe("Run the body as a prompt in a new ACP session instead of a shell command");

const fields = {
  description: z.string().describe("What the routine does, in one sentence"),
  on_failure: z.string().describe("Command run on the first failure and on recovery, message on stdin; replaces the config's; 'none' turns notices off"),
  dtstart: z.string().describe("Local start of the series, e.g. 2026-10-05T07:00"),
  tz: z.string().describe("Time zone, e.g. Europe/Zurich"),
  run: z.string().describe("Shell command; the body is passed on stdin"),
  acp,
  close: z.enum(["on-success", "always", "never"]).describe("When to close the ACP session (default on-success)"),
  permissions: z.enum(["reject", "allow"]).describe("Answer to ACP permission requests (default reject)"),
  steps: z
    .array(z.record(z.string(), z.unknown()))
    .describe(
      "Ordered steps instead of run or acp. Each: name, run or acp (+ close, permissions), optional timeout, cwd, continue_on_error. " +
        "A step's stdin or prompt is the body section '## <name>', where {{run_dir}} and {{steps.<earlier step>.output}} are replaced.",
    ),
  cwd: z.string().describe("Working directory (default home)"),
  timeout: z.string().describe("Duration such as 30s, 10m, 1h30m"),
  owner: z.string().describe("Label of the program that manages the routine, e.g. office:perso/P-0014"),
  meta: z.record(z.string(), z.unknown()).describe("Free object kept as is and returned by list and show; ignored for scheduling"),
  body: z.string().describe("Body: stdin of the command, or the ACP prompt"),
};

function result(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function guarded<A>(handler: (args: A) => unknown | Promise<unknown>) {
  return async (args: A) => {
    try {
      return result(await handler(args));
    } catch (error) {
      return { content: [{ type: "text" as const, text: (error as Error).message }], isError: true };
    }
  };
}

function input(args: Record<string, unknown>): RoutineInput {
  const { id: _, paused: __, ...rest } = args;
  return rest as RoutineInput;
}

export function createServer(ctx: Context): McpServer {
  const server = new McpServer({ name: "routine", version: "0.1.0" });
  const read = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "routine_list",
    {
      description: "List routines with their state, next occurrence and last run. A trailing * in owner matches a prefix.",
      inputSchema: { owner: z.string().optional().describe("Exact owner, or prefix ending with *") },
      annotations: read,
    },
    guarded(({ owner }) => listRoutines(ctx, owner)),
  );
  server.registerTool(
    "routine_show",
    {
      description: "Show one routine: fields, body, upcoming occurrences, last run.",
      inputSchema: { id, count: z.number().int().min(0).optional().describe("Number of upcoming occurrences (default 5)") },
      annotations: read,
    },
    guarded(({ id, count }) => showRoutine(ctx, id, count)),
  );
  server.registerTool(
    "routine_add",
    {
      description: `Create a routine. It needs rrule and one of run, acp or steps. ${AGREEMENT}`,
      inputSchema: {
        id,
        rrule: z.array(z.string()).min(1).describe("RRULE values without DTSTART, e.g. FREQ=DAILY;BYHOUR=7;BYMINUTE=0"),
        ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])),
        paused: z.boolean().optional().describe("Create the routine paused"),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    guarded((args: Record<string, unknown>) => addRoutine(ctx, args.id as string, input(args), args.paused === true)),
  );
  server.registerTool(
    "routine_edit",
    {
      description: `Change fields of a routine. null removes an optional field; run, acp and steps replace one another. ${AGREEMENT}`,
      inputSchema: {
        id,
        rrule: z.array(z.string()).min(1).optional().describe("Replaces every rule"),
        ...Object.fromEntries(
          Object.entries(fields).map(([k, v]) => [k, k === "run" || k === "acp" || k === "steps" || k === "body" ? v.optional() : v.nullable().optional()]),
        ),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    guarded((args: Record<string, unknown>) => editRoutine(ctx, args.id as string, input(args))),
  );
  server.registerTool(
    "routine_pause",
    { description: "Pause a routine.", inputSchema: { id }, annotations: { idempotentHint: true, openWorldHint: false } },
    guarded(({ id }) => setActive(ctx, id, false)),
  );
  server.registerTool(
    "routine_resume",
    {
      description: "Resume a paused routine. Occurrences missed while paused are not caught up.",
      inputSchema: { id },
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    guarded(({ id }) => setActive(ctx, id, true)),
  );
  server.registerTool(
    "routine_remove",
    { description: `Delete a routine and its schedule state. ${AGREEMENT}`, inputSchema: { id }, annotations: { destructiveHint: true, openWorldHint: false } },
    guarded(({ id }) => removeRoutine(ctx, id)),
  );
  server.registerTool(
    "routine_run",
    {
      description: "Run a routine now, outside its schedule, and wait for the end. The schedule is left untouched.",
      inputSchema: { id },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guarded(({ id }) => runRoutine(ctx, id)),
  );
  server.registerTool(
    "routine_log",
    {
      description: "Recent runs from the journal, oldest first, each with its status and log file.",
      inputSchema: { id: id.optional(), limit: z.number().int().min(1).optional().describe("Default 20") },
      annotations: read,
    },
    guarded(({ id, limit }) => readRuns(ctx, id, limit)),
  );
  server.registerTool(
    "routine_check",
    { description: "Validate every routine file.", inputSchema: {}, annotations: read },
    guarded(() => checkRoutines(ctx)),
  );
  server.registerTool(
    "routine_status",
    { description: "Kill switch state, routines running now, routines due.", inputSchema: {}, annotations: read },
    guarded(() => engineStatus(ctx)),
  );
  server.registerTool(
    "routine_stop",
    {
      description: "Turn on the kill switch: no routine runs until routine_start. Running routines finish.",
      inputSchema: {},
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    guarded(() => setStopped(ctx, true)),
  );
  server.registerTool(
    "routine_start",
    { description: "Turn off the kill switch.", inputSchema: {}, annotations: { idempotentHint: true, openWorldHint: false } },
    guarded(() => setStopped(ctx, false)),
  );
  return server;
}

export async function serveMcp(ctx: Context): Promise<void> {
  await createServer(ctx).connect(new StdioServerTransport());
}
