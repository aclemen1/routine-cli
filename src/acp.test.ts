import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, type Config } from "./config.ts";
import { runNow } from "./engine.ts";
import { resolvePaths, type Paths } from "./paths.ts";
import { writeTaskFile } from "./task.ts";

const FAKE = join(import.meta.dirname, "..", "test", "fake-acp-agent.ts");

function setup(mode: string): { paths: Paths; config: Config; recordFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "routine-acp-"));
  const recordFile = join(dir, "record.jsonl");
  const paths = resolvePaths({ ROUTINE_CONFIG_DIR: join(dir, "config"), ROUTINE_STATE_DIR: join(dir, "state") });
  const config: Config = { ...defaultConfig(), tz: "UTC", env: { FAKE_MODE: mode, FAKE_RECORD: recordFile } };
  return { paths, config, recordFile };
}

function addAcp(paths: Paths, fields: Record<string, unknown>): void {
  writeTaskFile(
    join(paths.tasks, "agent.md"),
    { rrule: "FREQ=DAILY", acp: { command: process.execPath, args: [FAKE], meta: { herdr: { tabLabel: "test" } } }, ...fields },
    "Fais le point.\n",
  );
}

function calls(recordFile: string): { method: string; [key: string]: unknown }[] {
  if (!existsSync(recordFile)) return [];
  return readFileSync(recordFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("a prompt runs to end_turn, permissions are rejected, the session is closed on success", async () => {
  const { paths, config, recordFile } = setup("ok");
  addAcp(paths, {});
  const { record } = await runNow(paths, config, "agent");
  assert.equal(record?.status, "ok");
  assert.equal(record?.stopReason, "end_turn");
  assert.equal(record?.sessionId, "s1");
  const log = readFileSync(record!.log, "utf8");
  assert.match(log, /Bonjour\. \n\[tool\] Lire le fichier\n\[permission\] Lire le fichier → r\nFini\.\n\[acp\] stop: end_turn\n\[acp\] session closed/);
  const recorded = calls(recordFile);
  assert.deepEqual(recorded.find((c) => c.method === "session/new")?.meta, { herdr: { tabLabel: "test" } });
  assert.equal(recorded.find((c) => c.method === "session/prompt")?.text, "Fais le point.\n");
  assert.deepEqual(recorded.find((c) => c.method === "permission")?.answer, { outcome: "selected", optionId: "r" });
  assert.ok(recorded.some((c) => c.method === "session/close"));
});

test("close: never keeps the session; permissions: allow accepts", async () => {
  const { paths, config, recordFile } = setup("ok");
  addAcp(paths, { close: "never", permissions: "allow" });
  const { record } = await runNow(paths, config, "agent");
  assert.equal(record?.status, "ok");
  const recorded = calls(recordFile);
  assert.deepEqual(recorded.find((c) => c.method === "permission")?.answer, { outcome: "selected", optionId: "a" });
  assert.ok(!recorded.some((c) => c.method === "session/close"));
});

test("a turn that does not end with end_turn fails and keeps its session", async () => {
  const { paths, config, recordFile } = setup("refuse");
  addAcp(paths, {});
  const { record } = await runNow(paths, config, "agent");
  assert.equal(record?.status, "failed");
  assert.equal(record?.stopReason, "refusal");
  assert.ok(!calls(recordFile).some((c) => c.method === "session/close"));
});

test("past its timeout the prompt is cancelled", async () => {
  const { paths, config, recordFile } = setup("hang");
  addAcp(paths, { timeout: "1s" });
  const { record } = await runNow(paths, config, "agent");
  assert.equal(record?.status, "timeout");
  assert.ok(calls(recordFile).some((c) => c.method === "session/cancel"));
});

test("a missing ACP server is an error", async () => {
  const { paths, config } = setup("ok");
  writeTaskFile(join(paths.tasks, "agent.md"), { rrule: "FREQ=DAILY", acp: { command: "/nonexistent/acp" } }, "Bonjour\n");
  const { record } = await runNow(paths, config, "agent");
  assert.equal(record?.status, "error");
  assert.match(record?.error ?? "", /ENOENT/);
});
