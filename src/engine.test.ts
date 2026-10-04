import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, type Config } from "./config.ts";
import { execScheduled, runNow, tick } from "./engine.ts";
import { resolvePaths, type Paths } from "./paths.ts";
import { readJournal, readState, writeState } from "./state.ts";
import { writeTaskFile } from "./task.ts";

function setup(): { paths: Paths; config: Config; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "routine-test-"));
  const paths = resolvePaths({ ROUTINE_CONFIG_DIR: join(dir, "config"), ROUTINE_STATE_DIR: join(dir, "state") });
  const config: Config = { ...defaultConfig(), tz: "UTC", shell: ["/bin/sh", "-c"] };
  return { paths, config, dir };
}

function addTask(paths: Paths, id: string, fields: Record<string, string | boolean>, body?: string): void {
  writeTaskFile(join(paths.tasks, `${id}.md`), fields, body);
}

const T = (iso: string) => Date.parse(`${iso}Z`);

test("a new routine is not run on first sight, then runs once per occurrence", async () => {
  const { paths, config, dir } = setup();
  const out = join(dir, "out.txt");
  addTask(paths, "hourly", { rrule: "FREQ=HOURLY;BYMINUTE=0", run: `echo ran >> ${out}` });

  let result = await tick(paths, config, { nowMs: T("2026-10-04T10:30:00"), foreground: true });
  assert.deepEqual(result.due, []);
  assert.equal(readState(paths, "hourly")?.since, "2026-10-04T10:30:00.000Z");

  result = await tick(paths, config, { nowMs: T("2026-10-04T11:00:30"), foreground: true });
  assert.deepEqual(result.due, ["hourly"]);
  assert.equal(result.results[0]?.record?.status, "ok");
  assert.equal(readState(paths, "hourly")?.lastScheduled, "2026-10-04T11:00:00.000Z");

  result = await tick(paths, config, { nowMs: T("2026-10-04T11:01:30"), foreground: true });
  assert.deepEqual(result.due, []);
  assert.equal(readFileSync(out, "utf8"), "ran\n");
});

test("missed occurrences while asleep are caught up once", async () => {
  const { paths, config, dir } = setup();
  const out = join(dir, "out.txt");
  addTask(paths, "every5", { rrule: "FREQ=MINUTELY;INTERVAL=5", run: `echo x >> ${out}` });
  writeState(paths, "every5", { since: "2026-10-04T08:00:00.000Z" });

  const result = await tick(paths, config, { nowMs: T("2026-10-04T11:02:00"), foreground: true });
  assert.deepEqual(result.due, ["every5"]);
  assert.equal(readState(paths, "every5")?.lastScheduled, "2026-10-04T11:00:00.000Z");
  assert.equal(readFileSync(out, "utf8"), "x\n");
});

test("body goes to stdin, routine variables to the environment, output to the run log", async () => {
  const { paths, config } = setup();
  addTask(paths, "office/brief", { rrule: "FREQ=DAILY", run: 'cat; echo "$ROUTINE_ID $ROUTINE_SCHEDULED"' }, "hello\n");
  writeState(paths, "office/brief", { since: "2026-10-03T12:00:00.000Z" });
  const result = await execScheduled(paths, config, "office/brief", T("2026-10-04T08:00:00"));
  assert.equal(result.outcome, "ran");
  assert.equal(readFileSync(result.record!.log, "utf8"), "hello\noffice/brief 2026-10-04T00:00:00.000Z\n");
  assert.equal(readJournal(paths, { id: "office/brief", limit: 5 }).length, 1);
});

test("a failing command is recorded as failed, its occurrence is not retried", async () => {
  const { paths, config } = setup();
  addTask(paths, "fails", { rrule: "FREQ=DAILY", run: "exit 3" });
  writeState(paths, "fails", { since: "2026-10-03T12:00:00.000Z" });
  const now = T("2026-10-04T08:00:00");
  const first = await execScheduled(paths, config, "fails", now);
  assert.equal(first.record?.status, "failed");
  assert.equal(first.record?.exitCode, 3);
  assert.equal((await execScheduled(paths, config, "fails", now)).outcome, "not-due");
});

test("a run past its timeout is killed with its children", async () => {
  const { paths, config, dir } = setup();
  const marker = join(dir, "late.txt");
  addTask(paths, "slow", { rrule: "FREQ=DAILY", run: `sleep 5; touch ${marker}`, timeout: "1s" });
  writeState(paths, "slow", { since: "2026-10-03T12:00:00.000Z" });
  const started = Date.now();
  const result = await execScheduled(paths, config, "slow", T("2026-10-04T08:00:00"));
  assert.equal(result.record?.status, "timeout");
  assert.ok(Date.now() - started < 4000);
  await new Promise((r) => setTimeout(r, 4500));
  assert.equal(existsSync(marker), false);
});

test("a routine held by a live process is skipped and stays due", async () => {
  const { paths, config } = setup();
  addTask(paths, "locked", { rrule: "FREQ=DAILY", run: "true" });
  writeState(paths, "locked", { since: "2026-10-03T12:00:00.000Z" });
  mkdirSync(paths.locks, { recursive: true });
  writeFileSync(join(paths.locks, "locked.lock"), String(process.pid));
  const now = T("2026-10-04T08:00:00");
  assert.equal((await execScheduled(paths, config, "locked", now)).outcome, "busy");
  writeFileSync(join(paths.locks, "locked.lock"), "999999");
  assert.equal((await execScheduled(paths, config, "locked", now)).outcome, "ran");
});

test("a routine resumed after a pause does not catch up the paused period", async () => {
  const { paths, config } = setup();
  addTask(paths, "daily", { rrule: "FREQ=DAILY;BYHOUR=7", run: "true", active: false });
  await tick(paths, config, { nowMs: T("2026-10-01T12:00:00"), foreground: true });
  addTask(paths, "daily", { active: true });
  let result = await tick(paths, config, { nowMs: T("2026-10-04T12:00:00"), foreground: true });
  assert.deepEqual(result.due, []);
  result = await tick(paths, config, { nowMs: T("2026-10-05T07:00:10"), foreground: true });
  assert.deepEqual(result.due, ["daily"]);
});

test("the kill switch stops every tick; a manual run still works", async () => {
  const { paths, config } = setup();
  addTask(paths, "daily", { rrule: "FREQ=DAILY", run: "true" });
  writeState(paths, "daily", { since: "2026-10-03T12:00:00.000Z" });
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.stopFile, "");
  const result = await tick(paths, config, { nowMs: T("2026-10-04T08:00:00"), foreground: true });
  assert.equal(result.stopped, true);
  const manual = await runNow(paths, config, "daily");
  assert.equal(manual.record?.manual, true);
  assert.equal(readState(paths, "daily")?.lastScheduled, undefined);
});

test("invalid routine files are reported and do not block the others", async () => {
  const { paths, config } = setup();
  addTask(paths, "good", { rrule: "FREQ=DAILY", run: "true" });
  mkdirSync(paths.tasks, { recursive: true });
  writeFileSync(join(paths.tasks, "bad.md"), "---\nrrule: FREQ=DAILY\nrun: true\nwhen: now\n---\n");
  const result = await tick(paths, config, { nowMs: T("2026-10-04T08:00:00"), foreground: true });
  assert.deepEqual(result.errors.map((e) => [e.id, e.error]), [["bad", 'unknown field "when"']]);
  assert.ok(readState(paths, "good"));
});
