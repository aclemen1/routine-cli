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
  steps?: Step[];
  meta?: Record<string, unknown>;
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

export interface Step {
  name: string;
  run?: string;
  acp?: AcpSpec;
  timeoutMs?: number;
  cwd?: string;
  continueOnError: boolean;
  // Text of the body section `## <name>`: stdin of a command, prompt of an acp step.
  input: string;
}

const STEP_KEYS = new Set(["name", "run", "acp", "close", "permissions", "timeout", "cwd", "continue_on_error"]);
const STEP_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const TEMPLATE_RE = /\{\{\s*([^}]*?)\s*\}\}/g;

// Splits the body on `## <step name>` headings; other headings stay in their section.
export function bodySections(body: string, names: string[]): Map<string, string> {
  const sections = new Map<string, string>();
  const known = new Set(names);
  let current: string | undefined;
  let lines: string[] = [];
  const flush = () => {
    if (current !== undefined) sections.set(current, lines.join("\n").trim());
  };
  for (const line of body.split(/\r?\n/)) {
    const heading = /^##\s+(\S+)\s*$/.exec(line);
    if (heading && known.has(heading[1]!)) {
      flush();
      current = heading[1]!;
      if (sections.has(current)) throw new Error(`section "## ${current}" appears twice`);
      lines = [];
    } else lines.push(line);
  }
  flush();
  return sections;
}

function parseSteps(value: unknown, body: string): Step[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("steps must be a non-empty list");
  const names: string[] = [];
  const steps = value.map((raw, index) => {
    const where = `steps[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${where} must be a mapping`);
    const step = raw as Record<string, unknown>;
    for (const key of Object.keys(step)) {
      if (!STEP_KEYS.has(key)) throw new Error(`unknown field ${where}.${key}`);
    }
    const name = step.name;
    if (typeof name !== "string" || !STEP_NAME_RE.test(name)) {
      throw new Error(`${where}.name must be lowercase letters, digits, '_' or '-'`);
    }
    if (names.includes(name)) throw new Error(`step ${JSON.stringify(name)} appears twice`);
    names.push(name);
    const run = step.run;
    if (run !== undefined && (typeof run !== "string" || !run.trim())) throw new Error(`step ${name}: run must be a non-empty string`);
    if (run !== undefined && step.acp !== undefined) throw new Error(`step ${name}: give run or acp, not both`);
    if (run === undefined && step.acp === undefined) throw new Error(`step ${name}: missing run or acp`);
    if (step.acp === undefined && (step.close !== undefined || step.permissions !== undefined)) {
      throw new Error(`step ${name}: close and permissions apply only to acp steps`);
    }
    if (step.continue_on_error !== undefined && typeof step.continue_on_error !== "boolean") {
      throw new Error(`step ${name}: continue_on_error must be true or false`);
    }
    if (step.cwd !== undefined && typeof step.cwd !== "string") throw new Error(`step ${name}: cwd must be a string`);
    const result: Step = { name, continueOnError: step.continue_on_error === true, input: "" };
    if (run !== undefined) result.run = run as string;
    if (step.acp !== undefined) {
      try {
        result.acp = parseAcp(step.acp, step.close, step.permissions);
      } catch (error) {
        throw new Error(`step ${name}: ${(error as Error).message}`);
      }
    }
    if (step.timeout !== undefined) result.timeoutMs = parseDuration(step.timeout as string | number);
    if (step.cwd !== undefined) result.cwd = step.cwd as string;
    return result;
  });
  const sections = bodySections(body, names);
  steps.forEach((step, index) => {
    step.input = sections.get(step.name) ?? "";
    if (step.acp && !step.input) throw new Error(`step ${step.name}: an acp step needs its prompt in a "## ${step.name}" section`);
    for (const [, ref] of step.input.matchAll(TEMPLATE_RE)) {
      if (ref === "run_dir") continue;
      const match = /^steps\.([a-z0-9_-]+)\.output$/.exec(ref!);
      if (!match || !names.slice(0, index).includes(match[1]!)) {
        throw new Error(`step ${step.name}: unknown template {{${ref}}} (use {{run_dir}} or {{steps.<earlier step>.output}})`);
      }
    }
  });
  return steps;
}

export interface TaskError {
  id: string;
  file: string;
  error: string;
}

export const FIELDS = ["rrule", "dtstart", "tz", "run", "acp", "close", "permissions", "steps", "cwd", "timeout", "owner", "meta", "active"] as const;
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
  if (fm.steps !== undefined && (run !== undefined || fm.acp !== undefined || fm.close !== undefined || fm.permissions !== undefined)) {
    throw new Error("give steps, or run or acp, not both");
  }
  const steps = fm.steps === undefined ? undefined : parseSteps(fm.steps, body);
  if (run !== undefined && fm.acp !== undefined) throw new Error("give run or acp, not both");
  if (!steps && !run && fm.acp === undefined) throw new Error("missing run, acp or steps");
  if (fm.acp === undefined && (fm.close !== undefined || fm.permissions !== undefined)) {
    throw new Error("close and permissions apply only to acp routines");
  }
  const acp = fm.acp === undefined ? undefined : parseAcp(fm.acp, fm.close, fm.permissions);
  if (acp && !body.trim()) throw new Error("an acp routine needs a prompt in its body");
  if (fm.meta !== undefined && fm.meta !== null && (typeof fm.meta !== "object" || Array.isArray(fm.meta))) {
    throw new Error("meta must be a mapping");
  }
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
  if (steps) task.steps = steps;
  if (fm.meta) task.meta = fm.meta as Record<string, unknown>;
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

export type FieldValues = Partial<Record<Field, unknown>>;

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
