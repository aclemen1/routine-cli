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

test("rules that differ only by their times read as one sentence", () => {
  assert.equal(buildSchedule(["FREQ=DAILY;BYHOUR=6;BYMINUTE=3", "FREQ=DAILY;BYHOUR=12,18;BYMINUTE=35"], undefined, TZ).text, "every day at 6:03 AM, 12:35 PM and 6:35 PM");
  assert.equal(buildSchedule(["FREQ=DAILY;BYHOUR=7;BYMINUTE=0", "FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0"], undefined, TZ).text, "every day at 7 AM; every week on Monday at 8 AM");
  assert.equal(buildSchedule("FREQ=MINUTELY;INTERVAL=5", undefined, TZ).text, "every 5 minutes");
  assert.equal(buildSchedule("FREQ=DAILY;COUNT=1", "2026-10-10T09:00", TZ).text, "once, on 2026-10-10 09:00");
});

test("day lists and evenly spaced times are shortened", () => {
  const text = (r: string) => buildSchedule(r, undefined, TZ).text;
  assert.equal(text("FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=8;BYMINUTE=0"), "every day at 8 AM");
  assert.equal(text("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=30"), "every weekday at 8:30 AM");
  assert.equal(text("FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=9;BYMINUTE=0"), "every week on weekends at 9 AM");
  assert.equal(
    text("FREQ=HOURLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7,8,9,10,11,12,13,14,15,16,17,18,19;BYMINUTE=5"),
    "every hour from 7:05 AM to 7:05 PM on weekdays",
  );
  assert.equal(text("FREQ=DAILY;BYHOUR=8,10,12;BYMINUTE=0"), "every 2 hours from 8 AM to 12 PM");
  assert.equal(text("FREQ=DAILY;BYHOUR=8,9,12;BYMINUTE=0"), "every day at 8 AM, 9 AM and 12 PM");
});

test("invalid input is rejected", () => {
  assert.throws(() => buildSchedule("FREQ=SOMETIMES", undefined, TZ), /invalid rrule/);
  assert.throws(() => buildSchedule("DTSTART:20260101T000000\nRRULE:FREQ=DAILY", undefined, TZ), /dtstart/);
  assert.throws(() => buildSchedule("FREQ=DAILY", "tomorrow", TZ), /invalid dtstart/);
});
