import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { parseDuration } from "./duration.ts";
import type { Paths } from "./paths.ts";

export interface Config {
  tz: string;
  timeoutMs: number;
  shell: string[];
  env: Record<string, string>;
  retentionDays: number;
  // Shell command run on a routine's first failure and on its recovery; the message comes on stdin.
  onFailure?: string;
  // on_failure fires after this many failed runs in a row, or after this long failing.
  alertAfter: { failures: number; durationMs: number };
}

const KEYS = new Set(["tz", "timeout", "shell", "env", "retention_days", "on_failure", "alert_after"]);

export function defaultConfig(): Config {
  return {
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timeoutMs: parseDuration("25m"),
    shell: ["/bin/zsh", "-lc"],
    env: {},
    retentionDays: 14,
    alertAfter: { failures: 3, durationMs: parseDuration("30m") },
  };
}

export function loadConfig(paths: Paths): Config {
  const config = defaultConfig();
  if (!existsSync(paths.configFile)) return config;
  const raw: unknown = parse(readFileSync(paths.configFile, "utf8")) ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${paths.configFile}: expected a mapping`);
  const data = raw as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    if (!KEYS.has(key)) throw new Error(`${paths.configFile}: unknown key ${JSON.stringify(key)}`);
  }
  if (data.tz !== undefined) config.tz = checkTimeZone(String(data.tz));
  if (data.timeout !== undefined) config.timeoutMs = parseDuration(data.timeout as string | number);
  if (data.shell !== undefined) {
    if (!Array.isArray(data.shell) || data.shell.length === 0 || !data.shell.every((s) => typeof s === "string")) {
      throw new Error(`${paths.configFile}: shell must be a non-empty list of strings`);
    }
    config.shell = data.shell;
  }
  if (data.env !== undefined) {
    if (typeof data.env !== "object" || data.env === null || Array.isArray(data.env)) {
      throw new Error(`${paths.configFile}: env must be a mapping`);
    }
    config.env = Object.fromEntries(Object.entries(data.env).map(([k, v]) => [k, String(v)]));
  }
  if (data.on_failure !== undefined && data.on_failure !== null) {
    if (typeof data.on_failure !== "string" || !data.on_failure.trim()) throw new Error(`${paths.configFile}: on_failure must be a command`);
    config.onFailure = data.on_failure;
  }
  if (data.alert_after !== undefined) config.alertAfter = { ...config.alertAfter, ...parseAlertAfter(data.alert_after, paths.configFile) };
  if (data.retention_days !== undefined) {
    const days = Number(data.retention_days);
    if (!Number.isInteger(days) || days < 1) throw new Error(`${paths.configFile}: retention_days must be a positive integer`);
    config.retentionDays = days;
  }
  return config;
}

export function checkTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    throw new Error(`unknown time zone: ${JSON.stringify(tz)}`);
  }
  return tz;
}

// alert_after: { failures: 3, duration: 30m }; either key may be left out.
export function parseAlertAfter(value: unknown, where: string): Partial<{ failures: number; durationMs: number }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where}: alert_after must be a mapping`);
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (key !== "failures" && key !== "duration") throw new Error(`${where}: unknown key alert_after.${key}`);
  }
  const result: Partial<{ failures: number; durationMs: number }> = {};
  if (v.failures !== undefined) {
    if (!Number.isInteger(v.failures) || (v.failures as number) < 1) throw new Error(`${where}: alert_after.failures must be a positive integer`);
    result.failures = v.failures as number;
  }
  if (v.duration !== undefined) result.durationMs = parseDuration(v.duration as string | number);
  return result;
}
