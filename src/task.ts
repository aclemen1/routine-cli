import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Document, parseDocument } from "yaml";
import { checkTimeZone, type Config } from "./config.ts";
import { parseDuration } from "./duration.ts";
import { buildSchedule, type Schedule } from "./schedule.ts";

export interface Task {
  id: string;
  file: string;
  rrules: string[];
  dtstart?: string;
  tz: string;
  active: boolean;
  owner?: string;
  timeoutMs: number;
  cwd?: string;
  run?: string;
  acp?: AcpSpec;
  body: string;
  schedule: Schedule;
}

export type ClosePolicy = "on-success" | "always" | "never";
export type PermissionPolicy = "reject" | "allow";

export interface AcpSpec {
  command: string;
  args: string[];
  meta?: Record<string, unknown>;
  close: ClosePolicy;
  permissions: PermissionPolicy;
}

function parseAcp(value: unknown, close: unknown, permissions: unknown): AcpSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("acp must be a mapping");
  const acp = value as Record<string, unknown>;
  for (const key of Object.keys(acp)) {
    if (!["command", "args", "meta"].includes(key)) throw new Error(`unknown field acp.${key}`);
  }
  if (typeof acp.command !== "string" || !acp.command.trim()) throw new Error("acp.command must be a non-empty string");
  const args = acp.args ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string" || typeof a === "number")) {
    throw new Error("acp.args must be a list of strings");
  }
  if (acp.meta !== undefined && (typeof acp.meta !== "object" || acp.meta === null || Array.isArray(acp.meta))) {
    throw new Error("acp.meta must be a mapping");
  }
  const closePolicy = close ?? "on-success";
  if (closePolicy !== "on-success" && closePolicy !== "always" && closePolicy !== "never") {
    throw new Error("close must be on-success, always or never");
  }
  const permissionPolicy = permissions ?? "reject";
  if (permissionPolicy !== "reject" && permissionPolicy !== "allow") throw new Error("permissions must be reject or allow");
  const spec: AcpSpec = { command: acp.command, args: args.map(String), close: closePolicy, permissions: permissionPolicy };
  if (acp.meta !== undefined) spec.meta = acp.meta as Record<string, unknown>;
  return spec;
}

export interface TaskError {
  id: string;
  file: string;
  error: string;
}

export const FIELDS = ["rrule", "dtstart", "tz", "run", "acp", "close", "permissions", "cwd", "timeout", "owner", "active"] as const;
export type Field = (typeof FIELDS)[number];
const FIELD_SET = new Set<string>(FIELDS);
const ID_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function checkId(id: string): string {
  if (!ID_RE.test(id) || id.split("/").some((part) => part.endsWith(".md"))) {
    throw new Error(`invalid id ${JSON.stringify(id)}: lowercase letters, digits, '.', '_', '-', segments separated by '/'`);
  }
  return id;
}

export function taskFile(tasksDir: string, id: string): string {
  return join(tasksDir, `${checkId(id)}.md`);
}

function split(text: string): { frontmatter: string; body: string } {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) throw new Error("missing YAML frontmatter (--- … ---)");
  return { frontmatter: match[1]!, body: match[2]! };
}

export function parseTask(id: string, file: string, text: string, config: Config): Task {
  const { frontmatter, body: rawBody } = split(text);
  const body = rawBody.replace(/^\r?\n/, "");
  const doc = parseDocument(frontmatter);
  if (doc.errors.length) throw new Error(`frontmatter: ${doc.errors[0]!.message}`);
  const data: unknown = doc.toJS() ?? {};
  if (typeof data !== "object" || Array.isArray(data)) throw new Error("frontmatter must be a mapping");
  const fm = data as Record<string, unknown>;
  for (const key of Object.keys(fm)) {
    if (!FIELD_SET.has(key)) throw new Error(`unknown field ${JSON.stringify(key)}`);
  }
  const str = (key: Field): string | undefined => {
    const value = fm[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" && typeof value !== "number") throw new Error(`${key} must be a string`);
    return String(value);
  };
  const rawRrule = fm.rrule;
  const rrules = Array.isArray(rawRrule) ? rawRrule : rawRrule === undefined || rawRrule === null ? [] : [rawRrule];
  if (rrules.length === 0) throw new Error("missing rrule");
  if (!rrules.every((r): r is string => typeof r === "string" && r.trim() !== "")) {
    throw new Error("rrule must be a string or a list of strings");
  }
  const run = str("run");
  if (run !== undefined && fm.acp !== undefined) throw new Error("give run or acp, not both");
  if (!run && fm.acp === undefined) throw new Error("missing run or acp");
  if (fm.acp === undefined && (fm.close !== undefined || fm.permissions !== undefined)) {
    throw new Error("close and permissions apply only to acp routines");
  }
  const acp = fm.acp === undefined ? undefined : parseAcp(fm.acp, fm.close, fm.permissions);
  if (acp && !body.trim()) throw new Error("an acp routine needs a prompt in its body");
  if (fm.active !== undefined && typeof fm.active !== "boolean") throw new Error("active must be true or false");
  const dtstart = str("dtstart");
  const tz = checkTimeZone(str("tz") ?? config.tz);
  const timeout = fm.timeout;
  const task: Task = {
    id,
    file,
    rrules,
    tz,
    active: fm.active !== false,
    timeoutMs: timeout === undefined ? config.timeoutMs : parseDuration(timeout as string | number),
    body: body.trim() ? body : "",
    schedule: buildSchedule(rrules, dtstart, tz),
  };
  if (run) task.run = run;
  if (acp) task.acp = acp;
  if (dtstart !== undefined) task.dtstart = dtstart;
  const owner = str("owner");
  if (owner !== undefined) task.owner = owner;
  const cwd = str("cwd");
  if (cwd !== undefined) task.cwd = cwd;
  return task;
}

export function readTask(tasksDir: string, id: string, config: Config): Task {
  const file = taskFile(tasksDir, id);
  if (!existsSync(file)) throw new Error(`no routine ${JSON.stringify(id)}`);
  try {
    return parseTask(id, file, readFileSync(file, "utf8"), config);
  } catch (error) {
    throw new Error(`${id}: ${(error as Error).message}`);
  }
}

export function loadTasks(tasksDir: string, config: Config): { tasks: Task[]; errors: TaskError[] } {
  const tasks: Task[] = [];
  const errors: TaskError[] = [];
  if (!existsSync(tasksDir)) return { tasks, errors };
  const files = readdirSync(tasksDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  for (const file of files) {
    const id = relative(tasksDir, file).slice(0, -3).split("\\").join("/");
    try {
      checkId(id);
      tasks.push(parseTask(id, file, readFileSync(file, "utf8"), config));
    } catch (error) {
      errors.push({ id, file, error: (error as Error).message });
    }
  }
  return { tasks, errors };
}

export type FieldValues = Partial<Record<Field, string | string[] | boolean | Record<string, unknown> | null>>;

// Sets fields in place (null removes one), keeping comments and the order of existing keys.
export function writeTaskFile(file: string, values: FieldValues, body: string | undefined): void {
  let doc: Document;
  let currentBody = "";
  if (existsSync(file)) {
    const parts = split(readFileSync(file, "utf8"));
    doc = parseDocument(parts.frontmatter);
    currentBody = parts.body;
  } else {
    doc = new Document({});
  }
  for (const key of FIELDS) {
    const value = values[key];
    if (value === undefined) continue;
    if (value === null) doc.delete(key);
    else doc.set(key, value);
  }
  const newBody = body ?? currentBody;
  const text = `---\n${doc.toString().trimEnd()}\n---\n${newBody && !newBody.startsWith("\n") ? "\n" : ""}${newBody}`;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text.endsWith("\n") ? text : `${text}\n`);
  renameSync(tmp, file);
}
