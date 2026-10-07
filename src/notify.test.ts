import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, type Config } from "./config.ts";
import { runNow } from "./engine.ts";
import { resolvePaths, type Paths } from "./paths.ts";
import { readState } from "./state.ts";
import { writeTaskFile } from "./task.ts";

function setup(): { paths: Paths; config: Config; inbox: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "routine-notify-"));
  const inbox = join(dir, "inbox.txt");
  const paths = resolvePaths({ ROUTINE_CONFIG_DIR: join(dir, "config"), ROUTINE_STATE_DIR: join(dir, "state") });
  const config: Config = {
    ...defaultConfig(),
    tz: "UTC",
    shell: ["/bin/sh", "-c"],
    onFailure: `{ echo "== $ROUTINE_EVENT $ROUTINE_ID $ROUTINE_STATUS"; cat; } >> ${inbox}`,
  };
  return { paths, config, inbox, dir };
}

const notices = (inbox: string) => (existsSync(inbox) ? readFileSync(inbox, "utf8").split("\n").filter((l) => l.startsWith("== ")) : []);

test("a first failure and the recovery are notified, repeated failures are not", async () => {
  const { paths, config, inbox, dir } = setup();
  const flag = join(dir, "fail");
  writeTaskFile(join(paths.tasks, "flaky.md"), { description: "Relève les sources", rrule: "FREQ=DAILY", run: `echo working; [ ! -f ${flag} ]` }, undefined);

  await runNow(paths, config, "flaky");
  assert.deepEqual(notices(inbox), []);

  writeFileSync(flag, "");
  const { record } = await runNow(paths, config, "flaky");
  await runNow(paths, config, "flaky");
  assert.deepEqual(notices(inbox), ["== failed flaky failed"]);
  assert.equal(readState(paths, "flaky")?.failing, true);
  const message = readFileSync(inbox, "utf8");
  assert.match(message, /Routine flaky: failed\nRelève les sources\nLog: .+\.log\n\n```\nworking\n```/);
  assert.match(readFileSync(record!.log, "utf8"), /\[notify\] failed: sent/);

  const { rmSync } = await import("node:fs");
  rmSync(flag);
  await runNow(paths, config, "flaky");
  assert.deepEqual(notices(inbox), ["== failed flaky failed", "== recovered flaky ok"]);
  assert.match(readFileSync(inbox, "utf8"), /Routine flaky: ok again/);
});

test("a routine's on_failure overrides the config's; none turns notices off", async () => {
  const { paths, config, inbox, dir } = setup();
  writeTaskFile(join(paths.tasks, "quiet.md"), { rrule: "FREQ=DAILY", run: "exit 1", on_failure: "none" }, undefined);
  await runNow(paths, config, "quiet");
  assert.deepEqual(notices(inbox), []);

  const own = join(dir, "own.txt");
  writeTaskFile(join(paths.tasks, "own.md"), { rrule: "FREQ=DAILY", run: "exit 1", on_failure: `cat > ${own}` }, undefined);
  await runNow(paths, config, "own");
  assert.match(readFileSync(own, "utf8"), /^Routine own: failed/);
  assert.deepEqual(notices(inbox), []);
});

test("a failing on_failure command is logged and does not change the run", async () => {
  const { paths, config } = setup();
  writeTaskFile(join(paths.tasks, "broken.md"), { rrule: "FREQ=DAILY", run: "exit 2", on_failure: "echo nope >&2; exit 5" }, undefined);
  const { record } = await runNow(paths, config, "broken");
  assert.equal(record?.status, "failed");
  assert.match(readFileSync(record!.log, "utf8"), /\[notify\] failed: on_failure exited 5 · nope/);
});
