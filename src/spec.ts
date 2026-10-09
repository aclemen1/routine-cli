import { parseArgs, type ParseArgsConfig } from "node:util";
import { asRoutineError, userError, type RoutineError } from "./errors.ts";

// The catalog of actions: it drives parsing, `routine schema`, help and output, like task, due and oj.

export type ParamType = "string" | "boolean" | "integer" | "string[]";

export interface Param {
  name: string;
  type: ParamType;
  description: string;
  default?: string | number | boolean;
  enum?: string[];
  required?: boolean;
  // Given in order on the command line, without a flag.
  positional?: boolean;
  short?: string;
}

export interface Outcome {
  result?: unknown;
  // Exit code when the action ran but its object did not succeed (a failed run, an invalid file).
  exitCode?: number;
}

export interface Action {
  name: string;
  category: string;
  summary: string;
  discussion?: string;
  params: Param[];
  examples: string[];
  // Meta actions print text unless --format json.
  meta?: boolean;
  // Streamed actions write their own output (tui, mcp).
  streamed?: boolean;
  hidden?: boolean;
  run: (args: Record<string, unknown>) => Promise<Outcome> | Outcome;
  text?: (result: never) => string;
}

export const COMMAND = "routine";

export function usage(a: Action): string {
  const parts = [`${COMMAND} ${a.name}`];
  for (const p of a.params) {
    if (p.positional) parts.push(p.required ? `<${p.name}>` : `[<${p.name}>]`);
    else if (p.type === "boolean") parts.push(`[--${p.name}]`);
    else parts.push(p.required ? `--${p.name} <${p.name}>` : `[--${p.name} <${p.name}>]`);
  }
  return parts.join(" ");
}

export function parseAction(a: Action, argv: string[]): Record<string, unknown> {
  const options: NonNullable<ParseArgsConfig["options"]> = {};
  for (const p of a.params) {
    if (p.positional) continue;
    options[p.name] = { type: p.type === "boolean" ? "boolean" : "string", multiple: p.type === "string[]", ...(p.short ? { short: p.short } : {}) };
  }
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw userError(`${(error as Error).message}. Usage: ${usage(a)}`);
  }
  const out: Record<string, unknown> = {};
  const positionals = a.params.filter((p) => p.positional);
  if (parsed.positionals.length > positionals.length) {
    throw userError(`too many arguments. Usage: ${usage(a)}`);
  }
  positionals.forEach((p, i) => {
    if (parsed.positionals[i] !== undefined) out[p.name] = parsed.positionals[i];
  });
  for (const p of a.params) {
    if (!p.positional && parsed.values[p.name] !== undefined) out[p.name] = parsed.values[p.name];
    const value = out[p.name];
    if (value === undefined) {
      if (p.required) throw userError(`${p.positional ? `<${p.name}>` : `--${p.name}`} is required. Usage: ${usage(a)}`);
      if (p.default !== undefined) out[p.name] = p.default;
      continue;
    }
    if (p.type === "integer") {
      const n = Number(value);
      if (!Number.isInteger(n)) throw userError(`--${p.name} expects an integer, got ${JSON.stringify(value)}`);
      out[p.name] = n;
    }
    if (p.enum && typeof value === "string" && !p.enum.includes(value)) {
      throw userError(`--${p.name} takes ${p.enum.join(", ")}, got ${JSON.stringify(value)}`);
    }
  }
  return out;
}

export function emit(a: Action | undefined, format: string | undefined, outcome: Outcome | undefined, error?: unknown): number {
  const fmt = format ?? (a?.meta ? "text" : "json");
  if (error !== undefined) {
    const e: RoutineError = asRoutineError(error);
    if (fmt === "text") process.stderr.write(`error: ${e.message}\n`);
    else write({ ok: false, error: e });
    return e.code;
  }
  const result = outcome?.result;
  if (fmt === "text") {
    if (a?.text && result !== undefined) {
      const out = a.text(result as never);
      if (out) process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
    } else if (typeof result === "string") process.stdout.write(result.endsWith("\n") ? result : `${result}\n`);
    else if (result !== undefined) write(result);
  } else write(result === undefined ? { ok: true } : { ok: true, result });
  return outcome?.exitCode ?? 0;
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function paramSpec(p: Param) {
  return {
    name: p.name,
    type: p.type,
    ...(p.positional ? { positional: true } : {}),
    ...(p.required ? { required: true } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.enum ? { enum: p.enum } : {}),
    description: p.description,
  };
}

export function actionSpec(a: Action) {
  return {
    category: a.category,
    name: a.name,
    command: `${COMMAND} ${a.name}`,
    usage: usage(a),
    summary: a.summary,
    ...(a.discussion ? { discussion: a.discussion } : {}),
    params: a.params.map(paramSpec),
    examples: a.examples,
  };
}

export function actionText(a: Action): string {
  const lines = [usage(a), "", a.summary];
  if (a.discussion) lines.push("", a.discussion);
  if (a.params.length) {
    lines.push("", "Parameters:");
    for (const p of a.params) {
      const label = p.positional ? `<${p.name}>` : `--${p.name}`;
      const extra = [p.enum ? `(${p.enum.join("|")})` : "", p.default !== undefined ? `default ${p.default}` : "", p.required ? "required" : ""].filter(Boolean).join(" ");
      lines.push(`  ${label.padEnd(20)} ${p.description}${extra ? ` ${extra}` : ""}`);
    }
  }
  if (a.examples.length) lines.push("", "Examples:", ...a.examples.map((e) => `  ${e}`));
  return lines.join("\n");
}
