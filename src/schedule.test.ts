import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSchedule, dueOccurrence, nextOccurrences } from "./schedule.ts";

const TZ = "Europe/Zurich";
const at = (local: string) => Date.parse(new Date(`${local}+02:00`).toISOString());

test("latest occurrence after the floor is due, earlier ones collapse into it", () => {
  const s = buildSchedule("FREQ=DAILY;BYHOUR=7;BYMINUTE=0", undefined, TZ);
  const floor = at("2026-10-01T12:00:00");
  assert.equal(dueOccurrence(s, floor, at("2026-10-04T09:00:00")), at("2026-10-04T07:00:00"));
  assert.equal(dueOccurrence(s, at("2026-10-04T07:00:00"), at("2026-10-04T09:00:00")), null);
  assert.equal(dueOccurrence(s, floor, at("2026-10-01T18:00:00")), null);
});

test("occurrence exactly at now is due", () => {
  const s = buildSchedule("FREQ=MINUTELY;INTERVAL=5", undefined, TZ);
  assert.equal(dueOccurrence(s, at("2026-10-04T10:01:00"), at("2026-10-04T10:05:00")), at("2026-10-04T10:05:00"));
});

test("dtstart anchors the series and accepts an RRULE: prefix", () => {
  const s = buildSchedule("RRULE:FREQ=WEEKLY;INTERVAL=2", "2026-10-05T08:30", TZ);
  assert.deepEqual(nextOccurrences(s, at("2026-10-04T00:00:00"), 2), [at("2026-10-05T08:30:00"), at("2026-10-19T08:30:00")]);
});

test("a one-shot rule fires once", () => {
  const s = buildSchedule("FREQ=DAILY;COUNT=1", "2026-10-10T09:00", TZ);
  assert.equal(dueOccurrence(s, at("2026-10-04T00:00:00"), at("2026-10-12T00:00:00")), at("2026-10-10T09:00:00"));
  assert.deepEqual(nextOccurrences(s, at("2026-10-11T00:00:00"), 3), []);
});

test("several rules form the union of their occurrences", () => {
  const s = buildSchedule(["FREQ=DAILY;BYHOUR=6;BYMINUTE=3", "FREQ=DAILY;BYHOUR=12,18;BYMINUTE=35"], undefined, TZ);
  assert.deepEqual(nextOccurrences(s, at("2026-10-04T05:00:00"), 4), [
    at("2026-10-04T06:03:00"),
    at("2026-10-04T12:35:00"),
    at("2026-10-04T18:35:00"),
    at("2026-10-05T06:03:00"),
  ]);
  assert.equal(dueOccurrence(s, at("2026-10-04T06:03:00"), at("2026-10-04T19:00:00")), at("2026-10-04T18:35:00"));
});

test("invalid input is rejected", () => {
  assert.throws(() => buildSchedule("FREQ=SOMETIMES", undefined, TZ), /invalid rrule/);
  assert.throws(() => buildSchedule("DTSTART:20260101T000000\nRRULE:FREQ=DAILY", undefined, TZ), /dtstart/);
  assert.throws(() => buildSchedule("FREQ=DAILY", "tomorrow", TZ), /invalid dtstart/);
});
