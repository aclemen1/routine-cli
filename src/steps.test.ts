import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, type Config } from "./config.ts";
import { runNow } from "./engine.ts";
import { resolvePaths, type Paths } from "./paths.ts";
import { bodySections, parseTask, writeTaskFile } from "./task.ts";

const FAKE = join(import.meta.dirname, "..", "test", "fake-acp-agent.ts");

function setup(): { paths: Paths; config: Config; recordFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "routine-steps-"));
  const recordFile = join(dir, "record.jsonl");
  const paths = resolvePaths({ ROUTINE_CONFIG_DIR: join(dir, "config"), ROUTINE_STATE_DIR: join(dir, "state") });
  const config: Config = { ...defaultConfig(), tz: "UTC", shell: ["/bin/sh", "-c"], env: { FAKE_MODE: "ok", FAKE_RECORD: recordFile } };
  return { paths, config, recordFile };
}

function add(paths: Paths, fields: Record<string, unknown>, body: string): void {
  writeTaskFile(join(paths.tasks, "chain.md"), { rrule: "FREQ=DAILY", ...fields }, body);
}

test("a command step feeds an acp step through the run directory and templates", async () => {
  const { paths, config, recordFile } = setup();
  add(
    paths,
    {
      steps: [
        { name: "measure", run: 'echo "coverage: 81%"; cat > "$ROUTINE_RUN_DIR/stdin.txt"' },
        { name: "analyse", acp: { command: process.execPath, args: [FAKE] } },
      ],
    },
    "Intro ignored.\n\n## measure\nhello stdin\n\n## analyse\nAnalyse this:\n{{steps.measure.output}}\n## Not a step\nFiles in {{run_dir}}\n",
  );
  const { record } = await runNow(paths, config, "chain");
  assert.equal(record?.status, "ok", record?.error);
  assert.deepEqual(record?.steps?.map((s) => [s.name, s.status]), [["measure", "ok"], ["analyse", "ok"]]);
  assert.equal(record?.steps?.[1]?.stopReason, "end_turn");
  const runDir = record!.log.replace(/\.log$/, ".d");
  assert.equal(readFileSync(join(runDir, "stdin.txt"), "utf8"), "hello stdin");
  assert.equal(readFileSync(join(runDir, "analyse.out"), "utf8"), "Bonjour. Fini.");
  const prompt = readFileSync(recordFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((c) => c.method === "session/prompt").text;
  assert.equal(prompt, `Analyse this:\ncoverage: 81%\n\n## Not a step\nFiles in ${runDir}`);
  const log = readFileSync(record!.log, "utf8");
  assert.match(log, /=== step measure ===\ncoverage: 81%\n=== step measure: ok ===\n\n=== step analyse ===\n/);
});

test("a failed step stops the rest; continue_on_error lets the next run", async () => {
  const { paths, config } = setup();
  add(paths, { steps: [{ name: "a", run: "exit 3" }, { name: "b", run: "echo b" }] }, "");
  let { record } = await runNow(paths, config, "chain");
  assert.equal(record?.status, "failed");
  assert.equal(record?.error, "step a");
  assert.deepEqual(record?.steps?.map((s) => [s.name, s.status, s.exitCode]), [["a", "failed", 3], ["b", "skipped", undefined]]);

  add(paths, { steps: [{ name: "a", run: "exit 3", continue_on_error: true }, { name: "b", run: "echo b" }] }, "");
  ({ record } = await runNow(paths, config, "chain"));
  assert.equal(record?.status, "ok");
  assert.deepEqual(record?.steps?.map((s) => s.status), ["failed", "ok"]);
});

test("the routine timeout bounds the whole run, a step timeout bounds its step", async () => {
  const { paths, config } = setup();
  add(paths, { timeout: "2s", steps: [{ name: "slow", run: "sleep 5" }, { name: "after", run: "true" }] }, "");
  const started = Date.now();
  let { record } = await runNow(paths, config, "chain");
  assert.ok(Date.now() - started < 4500);
  assert.equal(record?.status, "timeout");
  assert.deepEqual(record?.steps?.map((s) => s.status), ["timeout", "skipped"]);

  add(paths, { timeout: "1m", steps: [{ name: "slow", run: "sleep 5", timeout: "1s", continue_on_error: true }, { name: "after", run: "true" }] }, "");
  ({ record } = await runNow(paths, config, "chain"));
  assert.equal(record?.status, "ok");
  assert.deepEqual(record?.steps?.map((s) => s.status), ["timeout", "ok"]);
});

test("invalid steps are rejected", () => {
  const config = defaultConfig();
  const parse = (frontmatter: string, body = "") => () => parseTask("x", "x.md", `---\nrrule: FREQ=DAILY\n${frontmatter}\n---\n${body}`, config);
  assert.throws(parse("run: 'true'\nsteps: [{name: a, run: 'true'}]"), /one of|not both/);
  assert.throws(parse("steps: []"), /non-empty list/);
  assert.throws(parse("steps: [{name: A, run: 'true'}]"), /name must be/);
  assert.throws(parse("steps: [{name: a, run: 'true'}, {name: a, run: 'true'}]"), /appears twice/);
  assert.throws(parse("steps: [{name: a, acp: {command: x}}]"), /needs its prompt in a "## a" section/);
  assert.throws(parse("steps: [{name: a, run: 'true'}, {name: b, run: 'true'}]", "## a\n{{steps.b.output}}\n"), /unknown template/);
  assert.throws(parse("steps: [{name: a, run: 'true', when: now}]"), /unknown field steps\[0\]\.when/);
  assert.doesNotThrow(parse("steps: [{name: a, run: 'true'}, {name: b, acp: {command: x}}]", "## b\nUse {{steps.a.output}} in {{run_dir}}\n"));
});

test("only headings that name a step split the body", () => {
  const sections = bodySections("pre\n## a\nA1\n## other\nA2\n##  b \nB\n", ["a", "b"]);
  assert.deepEqual([...sections], [["a", "A1\n## other\nA2"], ["b", "B"]]);
  assert.equal(existsSync("/nonexistent"), false);
});
