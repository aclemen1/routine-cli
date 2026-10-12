import { userError } from "./errors.ts";

// Who writes: human:AC@tui, human:AC@cli, agent:<id>, routine:<id>.
// Resolution: --by, then ROUTINE_BY, then OFFICE_ACTOR, then human:AC@tui in the TUI, then
// human:AC@cli when stdin is a terminal. Without an actor a write is signed unknown:cli until
// UNSIGNED_UNTIL (inclusive, in UNSIGNED_TZ), with a warning and an `unsigned` journal entry;
// after that day it is refused.

export const TOOL_BY = "ROUTINE_BY";
export const OFFICE_ACTOR = "OFFICE_ACTOR";
export const TUI_ACTOR = "human:AC@tui";
export const CLI_ACTOR = "human:AC@cli";
export const UNKNOWN_ACTOR = "unknown:cli";
export const UNSIGNED_UNTIL = "2026-10-19";
export const UNSIGNED_TZ = "Europe/Zurich";

const ACTOR_RE = /^(human|agent|routine):[^\s:][^\s]*$/;

export interface ActorInput {
  by?: string | undefined;
  env?: NodeJS.ProcessEnv;
  // stdin is a terminal (a person at the CLI).
  tty?: boolean;
  // The caller is a TUI.
  tui?: boolean;
  now?: Date;
}

export interface Actor {
  actor: string;
  // Where it came from: by, env ROUTINE_BY, env OFFICE_ACTOR, tui, tty, none.
  source: "by" | typeof TOOL_BY | typeof OFFICE_ACTOR | "tui" | "tty" | "none";
  unsigned: boolean;
  warning?: string;
}

export const HOW_TO_SIGN = `pass --by <actor>, or set ${TOOL_BY} or ${OFFICE_ACTOR} (human:AC@cli, agent:<id>, routine:<id>)`;

export function checkActor(value: string, where: string): string {
  const actor = value.trim();
  if (!ACTOR_RE.test(actor)) throw userError(`${where}: invalid actor ${JSON.stringify(value)}; expected human:AC@cli, human:AC@tui, agent:<id> or routine:<id>`);
  return actor;
}

// The day in the time zone of the deadline, YYYY-MM-DD.
export function localDay(now: Date, tz = UNSIGNED_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function resolveActor(input: ActorInput = {}): Actor {
  const env = input.env ?? process.env;
  if (input.by !== undefined && input.by !== "") return { actor: checkActor(input.by, "--by"), source: "by", unsigned: false };
  for (const name of [TOOL_BY, OFFICE_ACTOR] as const) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") return { actor: checkActor(value, name), source: name, unsigned: false };
  }
  if (input.tui) return { actor: TUI_ACTOR, source: "tui", unsigned: false };
  if (input.tty) return { actor: CLI_ACTOR, source: "tty", unsigned: false };
  const now = input.now ?? new Date();
  if (localDay(now) > UNSIGNED_UNTIL) throw userError(`no actor for this write: ${HOW_TO_SIGN}`);
  return {
    actor: UNKNOWN_ACTOR,
    source: "none",
    unsigned: true,
    warning: `unsigned write, signed ${UNKNOWN_ACTOR}: ${HOW_TO_SIGN}; refused after ${UNSIGNED_UNTIL}`,
  };
}

// The environment of a process routine starts for a passage: no inherited <TOOL>_BY, so that
// OFFICE_ACTOR names the routine for every tool it calls.
export function withoutToolActors(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^[A-Z][A-Z0-9]*_BY$/.test(k)));
}
