import { RRuleTemporal } from "rrule-temporal";
import { Temporal } from "temporal-polyfill";

export const DEFAULT_DTSTART = "2026-01-01T00:00";

export interface Schedule {
  rule: RRuleTemporal;
  tz: string;
}

export function buildSchedule(rrule: string, dtstart: string | undefined, tz: string): Schedule {
  const ruleText = rrule.trim().replace(/^RRULE:/i, "");
  if (/DTSTART/i.test(ruleText) || ruleText.includes("\n")) {
    throw new Error("rrule must hold only the RRULE value; give the start in dtstart");
  }
  let start: Temporal.ZonedDateTime;
  try {
    start = Temporal.PlainDateTime.from(dtstart ?? DEFAULT_DTSTART).toZonedDateTime(tz);
  } catch {
    throw new Error(`invalid dtstart: ${JSON.stringify(dtstart)} (expected local date-time, e.g. 2026-10-05T07:00)`);
  }
  let rule: RRuleTemporal;
  try {
    rule = new RRuleTemporal({ rruleString: ruleText, dtstart: start });
  } catch (error) {
    throw new Error(`invalid rrule ${JSON.stringify(rrule)}: ${(error as Error).message}`);
  }
  return { rule, tz };
}

// The latest occurrence in (floor, now], or null. Many missed occurrences collapse into one.
export function dueOccurrence(schedule: Schedule, floorMs: number, nowMs: number): number | null {
  const now = Temporal.Instant.fromEpochMilliseconds(nowMs).toZonedDateTimeISO(schedule.tz);
  const previous = schedule.rule.previous(now, true);
  if (!previous || previous.epochMilliseconds <= floorMs) return null;
  return previous.epochMilliseconds;
}

export function nextOccurrences(schedule: Schedule, afterMs: number, count: number): number[] {
  const result: number[] = [];
  let cursor = Temporal.Instant.fromEpochMilliseconds(afterMs).toZonedDateTimeISO(schedule.tz);
  while (result.length < count) {
    const next = schedule.rule.next(cursor, false);
    if (!next) break;
    result.push(next.epochMilliseconds);
    cursor = Temporal.Instant.fromEpochMilliseconds(next.epochMilliseconds).toZonedDateTimeISO(schedule.tz);
  }
  return result;
}

export function formatLocal(ms: number, tz: string): string {
  return Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(tz)
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" })
    .replace("T", " ");
}
