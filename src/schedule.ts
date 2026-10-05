import { RRuleTemporal } from "rrule-temporal";
import { toText } from "rrule-temporal/totext";
import { Temporal } from "temporal-polyfill";

export const DEFAULT_DTSTART = "2026-01-01T00:00";

// Several rules form one schedule: the union of their occurrences.
export interface Schedule {
  rules: RRuleTemporal[];
  tz: string;
  // The rules in plain English, e.g. "every day at 6:03 AM; every day at 12:35 PM and 6:35 PM".
  text: string;
}

export function buildSchedule(rrules: string | string[], dtstart: string | undefined, tz: string): Schedule {
  const list = typeof rrules === "string" ? [rrules] : rrules;
  if (list.length === 0) throw new Error("rrule is empty");
  let start: Temporal.ZonedDateTime;
  try {
    start = Temporal.PlainDateTime.from(dtstart ?? DEFAULT_DTSTART).toZonedDateTime(tz);
  } catch {
    throw new Error(`invalid dtstart: ${JSON.stringify(dtstart)} (expected local date-time, e.g. 2026-10-05T07:00)`);
  }
  const rules = list.map((rrule) => {
    const ruleText = rrule.trim().replace(/^RRULE:/i, "");
    if (/DTSTART/i.test(ruleText) || ruleText.includes("\n")) {
      throw new Error("rrule must hold only the RRULE value; give the start in dtstart");
    }
    try {
      return new RRuleTemporal({ rruleString: ruleText, dtstart: start });
    } catch (error) {
      throw new Error(`invalid rrule ${JSON.stringify(rrule)}: ${(error as Error).message}`);
    }
  });
  return { rules, tz, text: mergeTexts(rules.map((rule) => describe(rule, start))) };
}

const TIME_RE = /^(\d{1,2})(?::(\d{2}))? (AM|PM)$/;

function minutesOfDay(time: string): number {
  const m = TIME_RE.exec(time)!;
  const hour = (Number(m[1]) % 12) + (m[3] === "PM" ? 12 : 0);
  return hour * 60 + Number(m[2] ?? 0);
}

// Rules that differ only by their times read as one: "every day at 6:03 AM, 12:35 PM and 6:35 PM".
export function mergeTexts(texts: string[]): string {
  if (texts.length < 2) return texts.join("");
  const parts = texts.map((text) => /^(.*) at (.+)$/.exec(text));
  const prefix = parts[0]?.[1];
  if (parts.some((p) => !p || p[1] !== prefix)) return texts.join("; ");
  const times = parts.flatMap((p) => p![2]!.split(/, | and /));
  if (!times.every((t) => TIME_RE.test(t))) return texts.join("; ");
  const sorted = [...new Set(times)].sort((a, b) => minutesOfDay(a) - minutesOfDay(b));
  const list = sorted.length === 1 ? sorted[0] : `${sorted.slice(0, -1).join(", ")} and ${sorted.at(-1)}`;
  return `${prefix} at ${list}`;
}

function describe(rule: RRuleTemporal, start: Temporal.ZonedDateTime): string {
  if (rule.options().count === 1) return `once, on ${start.toPlainDateTime().toString({ smallestUnit: "minute" }).replace("T", " ")}`;
  return toText(rule, "en", { excludeTzAbbreviation: true });
}

function zoned(ms: number, tz: string) {
  return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(tz);
}

// The latest occurrence in (floor, now], or null. Many missed occurrences collapse into one.
export function dueOccurrence(schedule: Schedule, floorMs: number, nowMs: number): number | null {
  let latest: number | null = null;
  for (const rule of schedule.rules) {
    const previous = rule.previous(zoned(nowMs, schedule.tz), true);
    if (previous && previous.epochMilliseconds > floorMs && (latest === null || previous.epochMilliseconds > latest)) {
      latest = previous.epochMilliseconds;
    }
  }
  return latest;
}

export function nextOccurrences(schedule: Schedule, afterMs: number, count: number): number[] {
  const all = new Set<number>();
  for (const rule of schedule.rules) {
    let cursor = afterMs;
    for (let i = 0; i < count; i++) {
      const next = rule.next(zoned(cursor, schedule.tz), false);
      if (!next) break;
      all.add(next.epochMilliseconds);
      cursor = next.epochMilliseconds;
    }
  }
  return [...all].sort((a, b) => a - b).slice(0, count);
}

export function formatLocal(ms: number, tz: string): string {
  return zoned(ms, tz).toPlainDateTime().toString({ smallestUnit: "minute" }).replace("T", " ");
}
