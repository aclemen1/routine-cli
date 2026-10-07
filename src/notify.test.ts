import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, type Config } from "./config.ts";
import { runNow } from "./engine.ts";
import { shouldAlert } from "./notify.ts";
import { resolvePaths, type Paths } from "./paths.ts";
import { readState } from "./state.ts";
import { writeTaskFile } from "./task.ts";

function setup(onFailure?: string): { paths: Paths; config: Config; inbox: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "routine-notify-"));
  const inbox = join(dir, "inbox.txt");
  const paths = resolvePaths({ ROUTINE_CONFIG_DIR: join(dir, "config"), ROUTINE_STATE_DIR: join(dir, "state") });
  const config: Config = {
    ...defaultConfig(),
    tz: "UTC",
    shell: ["/bin/sh", "-c"],
    onFailure: onFailure ?? `{ echo "== $ROUTINE_EVENT $ROUTINE_ID $ROUTINE_STATUS"; cat; } >> ${inbox}`,
  };
  return { paths, config, inbox, dir };
}

const notices = (inbox: string) => (existsSync(inbox) ? readFileSync(inbox, "utf8").split("\n").filter((l) => l.startsWith("== ")) : []);
const MIN = 60_000;

test("the threshold: failures in a row, time failing, or a next run beyond the delay", () => {
  const t = { failures: 3, durationMs: 30 * MIN };
  const since = 0;
  assert.equal(shouldAlert(t, 1, since, 0, 5 * MIN), false);
  assert.equal(shouldAlert(t, 2, since, 5 * MIN, 10 * MIN), false);
  assert.equal(shouldAlert(t, 3, since, 10 * MIN, 15 * MIN), true);
  assert.equal(shouldAlert(t, 2, since, 30 * MIN, 35 * MIN), true);
  assert.equal(shouldAlert(t, 1, since, 0, 24 * 60 * MIN), true);
  assert.equal(shouldAlert(t, 1, since, 0, null), true);
});

test("a frequent routine alerts after 3 failures in a row, once, then tells its recovery", async () => {
  const { paths, config, inbox, dir } = setup();
  const flag = join(dir, "fail");
  writeTaskFile(join(paths.tasks, "ingest.md"), { description: "Relève les sources", rrule: "FREQ=MINUTELY;INTERVAL=5", run: `echo working; [ ! -f ${flag} ]` }, undefined);

  writeFileSync(flag, "");
  await runNow(paths, config, "ingest");
  await runNow(paths, config, "ingest");
  assert.deepEqual(notices(inbox), []);
  assert.equal(readState(paths, "ingest")?.failStreak, 2);

  await runNow(paths, config, "ingest");
  await runNow(paths, config, "ingest");
  assert.deepEqual(notices(inbox), ["== failed ingest failed"]);
  assert.match(readFileSync(inbox, "utf8"), /Routine ingest: failed, 3 failed runs since .+\nRelève les sources\nLog: .+\.log\n\n```\nworking\n```/);

  rmSync(flag);
  await runNow(paths, config, "ingest");
  assert.deepEqual(notices(inbox), ["== failed ingest failed", "== recovered ingest ok"]);
  assert.match(readFileSync(inbox, "utf8"), /Routine ingest: ok again after 4 failed runs since/);
  assert.deepEqual(readState(paths, "ingest")?.failStreak, undefined);
});

test("isolated failures under the threshold stay quiet, recovery included", async () => {
  const { paths, config, inbox, dir } = setup();
  const flag = join(dir, "fail");
  writeTaskFile(join(paths.tasks, "ingest.md"), { rrule: "FREQ=MINUTELY;INTERVAL=5", run: `[ ! -f ${flag} ]` }, undefined);
  for (let i = 0; i < 3; i++) {
    writeFileSync(flag, "");
    await runNow(paths, config, "ingest");
    rmSync(flag);
    await runNow(paths, config, "ingest");
  }
  assert.deepEqual(notices(inbox), []);
});

test("a daily routine alerts on its first failure", async () => {
  const { paths, config, inbox } = setup();
  writeTaskFile(join(paths.tasks, "daily.md"), { rrule: "FREQ=DAILY", run: "exit 1" }, undefined);
  await runNow(paths, config, "daily");
  assert.deepEqual(notices(inbox), ["== failed daily failed"]);
});

test("a routine's alert_after and on_failure override the config; none turns notices off", async () => {
  const { paths, config, inbox, dir } = setup();
  writeTaskFile(join(paths.tasks, "eager.md"), { rrule: "FREQ=MINUTELY;INTERVAL=5", run: "exit 1", alert_after: { failures: 1 } }, undefined);
  await runNow(paths, config, "eager");
  assert.deepEqual(notices(inbox), ["== failed eager failed"]);

  writeTaskFile(join(paths.tasks, "quiet.md"), { rrule: "FREQ=DAILY", run: "exit 1", on_failure: "none" }, undefined);
  await runNow(paths, config, "quiet");
  const own = join(dir, "own.txt");
  writeTaskFile(join(paths.tasks, "own.md"), { rrule: "FREQ=DAILY", run: "exit 1", on_failure: `cat > ${own}` }, undefined);
  await runNow(paths, config, "own");
  assert.match(readFileSync(own, "utf8"), /^Routine own: failed/);
  assert.deepEqual(notices(inbox), ["== failed eager failed"]);
});

test("an alert that could not be sent is tried again, and no recovery is told without it", async () => {
  const { paths, config, dir } = setup();
  const gate = join(dir, "gate");
  const inbox = join(dir, "sent.txt");
  config.onFailure = `[ -f ${gate} ] && { echo "== $ROUTINE_EVENT"; cat; } >> ${inbox}`;
  const flag = join(dir, "fail");
  writeTaskFile(join(paths.tasks, "daily.md"), { rrule: "FREQ=DAILY", run: `[ ! -f ${flag} ]` }, undefined);

  writeFileSync(flag, "");
  const { record } = await runNow(paths, config, "daily");
  assert.match(readFileSync(record!.log, "utf8"), /\[notify\] failed: on_failure exited 1/);
  rmSync(flag);
  await runNow(paths, config, "daily");
  assert.equal(existsSync(inbox), false);

  writeFileSync(flag, "");
  await runNow(paths, config, "daily");
  writeFileSync(gate, "");
  await runNow(paths, config, "daily");
  assert.deepEqual(notices(inbox), ["== failed"]);
  assert.equal(readState(paths, "daily")?.alerted, true);
});
