import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CLI = join(import.meta.dirname, "cli.ts");

function cli(dir: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ROUTINE_CONFIG_DIR: join(dir, "config"), ROUTINE_STATE_DIR: join(dir, "state") },
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// The JSON envelope of a command: {ok, result} or {ok: false, error}.
function call(dir: string, ...args: string[]) {
  const r = cli(dir, ...args);
  const env = JSON.parse(r.stdout) as { ok: boolean; result?: any; error?: { code: number; kind: string; message: string } };
  return { code: r.code, ...env };
}

function setup(): string {
  const dir = mkdtempSync(join(tmpdir(), "routine-cli-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "config.yaml"), "tz: Europe/Zurich\nshell: [/bin/sh, -c]\n");
  return dir;
}

test("add, list, edit, pause, show, run, log, rm through the JSON envelope", () => {
  const dir = setup();
  let r = call(dir, "add", "office/perso-p-0014-brief", "--rrule", "FREQ=DAILY;BYHOUR=7;BYMINUTE=0", "--run", "cat", "--owner", "office:perso/P-0014", "--body", "Briefing du jour");
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(r.code, 0);

  const file = join(dir, "config", "tasks", "office", "perso-p-0014-brief.md");
  assert.match(readFileSync(file, "utf8"), /^---\nrrule: FREQ=DAILY;BYHOUR=7;BYMINUTE=0\nrun: cat\nowner: office:perso\/P-0014\nactive: true\n---\n\nBriefing du jour\n$/);

  call(dir, "add", "other", "--rrule", "FREQ=HOURLY", "--run", "true");

  r = call(dir, "ls", "--owner", "office:perso/*");
  assert.deepEqual(r.result.routines.map((x: { id: string }) => x.id), ["office/perso-p-0014-brief"]);
  assert.match(r.result.routines[0].next, /T05:00:00.000Z$/);

  r = call(dir, "edit", "office/perso-p-0014-brief", "--timeout", "2m", "--owner", "");
  assert.equal(r.ok, true);
  assert.doesNotMatch(readFileSync(file, "utf8"), /owner/);
  assert.match(readFileSync(file, "utf8"), /timeout: 2m/);

  r = call(dir, "edit", "office/perso-p-0014-brief", "--rrule", "FREQ=NEVER");
  assert.equal(r.code, 2);
  assert.deepEqual([r.ok, r.error?.kind], [false, "user_error"]);
  assert.match(r.error!.message, /invalid rrule/);
  assert.match(readFileSync(file, "utf8"), /FREQ=DAILY/);

  call(dir, "pause", "office/perso-p-0014-brief");
  r = call(dir, "show", "office/perso-p-0014-brief");
  assert.equal(r.result.active, false);
  assert.deepEqual(r.result.upcoming, []);

  r = call(dir, "run", "office/perso-p-0014-brief");
  assert.equal(r.code, 0);
  assert.equal(r.result.status, "ok");
  assert.equal(readFileSync(r.result.log, "utf8").trim(), "Briefing du jour");

  assert.equal(call(dir, "log").result.length, 1);

  assert.equal(call(dir, "rm", "office/perso-p-0014-brief").ok, true);
  r = call(dir, "show", "office/perso-p-0014-brief");
  assert.equal(r.code, 3);
  assert.equal(r.error?.kind, "not_found");
});

test("--format text prints for people; --json is the envelope", () => {
  const dir = setup();
  cli(dir, "add", "d", "--rrule", "FREQ=DAILY", "--run", "true", "--description", "Pousse le cockpit");
  assert.match(cli(dir, "ls", "--format", "text").stdout, /^ID +DESCRIPTION/);
  assert.match(cli(dir, "show", "d", "--format=text").stdout, /about: +Pousse le cockpit/);
  assert.equal(JSON.parse(cli(dir, "status", "--json").stdout).ok, true);
  const bad = cli(dir, "show", "nope", "--format", "text");
  assert.equal(bad.code, 3);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /^error: no routine "nope"/);
  assert.equal(call(dir, "ls", "--format", "yaml").error?.kind, "user_error");
});

test("a repeated --rrule writes a list", () => {
  const dir = setup();
  const r = call(dir, "add", "capteurs", "--rrule", "FREQ=DAILY;BYHOUR=6;BYMINUTE=3", "--rrule", "FREQ=DAILY;BYHOUR=12,18;BYMINUTE=35", "--run", "true");
  assert.deepEqual(r.result.rrules, ["FREQ=DAILY;BYHOUR=6;BYMINUTE=3", "FREQ=DAILY;BYHOUR=12,18;BYMINUTE=35"]);
  assert.match(readFileSync(join(dir, "config", "tasks", "capteurs.md"), "utf8"), /^rrule:\n  - FREQ=DAILY;BYHOUR=6;BYMINUTE=3\n  - FREQ=DAILY;BYHOUR=12,18;BYMINUTE=35\n/m);
});

test("meta is kept as is, shown by ls and show, removed by an empty value", () => {
  const dir = setup();
  call(dir, "add", "m", "--rrule", "FREQ=DAILY", "--run", "true", "--meta", '{"states":["open","waiting"]}');
  assert.match(readFileSync(join(dir, "config", "tasks", "m.md"), "utf8"), /meta:\n  states:\n    - open\n    - waiting\n/);
  assert.deepEqual(call(dir, "show", "m").result.meta, { states: ["open", "waiting"] });
  assert.match(cli(dir, "ls", "--format", "text").stdout, /\{"states":\["open","waiting"\]\}/);
  assert.equal(call(dir, "edit", "m", "--meta", "[1]").code, 2);
  assert.equal(call(dir, "edit", "m", "--meta", "").result.meta, undefined);
  assert.doesNotMatch(readFileSync(join(dir, "config", "tasks", "m.md"), "utf8"), /meta/);
});

test("description is written first and removed by an empty value", () => {
  const dir = setup();
  call(dir, "add", "d", "--rrule", "FREQ=DAILY", "--run", "true", "--description", "Pousse le cockpit sur GitHub");
  assert.match(readFileSync(join(dir, "config", "tasks", "d.md"), "utf8"), /^---\ndescription: Pousse le cockpit sur GitHub\n/);
  call(dir, "add", "e", "--rrule", "FREQ=DAILY", "--run", `echo ${"x".repeat(100)}`);
  call(dir, "edit", "e", "--description", "Une description ajoutée après coup");
  assert.match(readFileSync(join(dir, "config", "tasks", "e.md"), "utf8"), /^---\ndescription: Une description ajoutée après coup\nrrule: FREQ=DAILY\nrun: echo x{100}\n/);
  assert.equal(call(dir, "edit", "d", "--description", "").result.description, undefined);
});

test("errors carry a kind and an exit code", () => {
  const dir = setup();
  assert.deepEqual(pick(call(dir, "add", "x", "--rrule", "FREQ=DAILY")), [2, "user_error"]);
  assert.deepEqual(pick(call(dir, "add", "Bad Id", "--rrule", "FREQ=DAILY", "--run", "true")), [2, "user_error"]);
  assert.deepEqual(pick(call(dir, "frobnicate")), [2, "user_error"]);
  assert.deepEqual(pick(call(dir, "ls", "--nope")), [2, "user_error"]);
  call(dir, "add", "x", "--rrule", "FREQ=DAILY", "--run", "true");
  assert.deepEqual(pick(call(dir, "add", "x", "--rrule", "FREQ=DAILY", "--run", "true")), [4, "conflict"]);
  mkdirSync(join(dir, "config", "tasks"), { recursive: true });
  writeFileSync(join(dir, "config", "tasks", "broken.md"), "no frontmatter\n");
  const r = call(dir, "check");
  assert.deepEqual([r.code, r.ok], [1, true]);
  assert.match(r.result.errors[0].error, /missing YAML frontmatter/);
});

function pick(r: { code: number | null; error?: { kind: string } }) {
  return [r.code, r.error?.kind];
}

test("stop and start toggle the kill switch", () => {
  const dir = setup();
  assert.equal(call(dir, "stop").result.stopped, true);
  assert.equal(call(dir, "tick").result.stopped, true);
  assert.match(cli(dir, "tick", "--format", "text").stdout, /stopped/);
  assert.equal(call(dir, "start").result.stopped, false);
});

test("schema browses the catalog, a category and an action", () => {
  const dir = setup();
  assert.match(cli(dir, "schema").stdout, /^routine +11 actions\nengine +4 actions\nmeta +5 actions\n$/);
  assert.match(cli(dir, "schema", "routine").stdout, /routine add +Create a routine/);
  const spec = call(dir, "schema", "routine", "add", "--format", "json").result;
  assert.equal(spec.command, "routine add");
  assert.ok(spec.params.some((p: { name: string; positional?: boolean }) => p.name === "id" && p.positional));
  assert.ok(spec.params.some((p: { name: string; type: string }) => p.name === "rrule" && p.type === "string[]"));
  assert.match(cli(dir, "schema", "show").stdout, /^routine show <id> \[--n <n>\]/);
  assert.equal(call(dir, "schema", "nothing", "--format", "json").error?.kind, "not_found");
  assert.match(cli(dir, "add", "--help").stdout, /^routine add <id>/);
  const d = call(dir, "describe", "--rrule", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=30");
  assert.equal(d.result.recurrence, "every weekday at 8:30 AM");
  assert.equal(d.result.upcoming.length, 5);
  assert.equal(call(dir, "describe", "--rrule", "FREQ=NEVER").error?.kind, "user_error");
  assert.match(cli(dir, "version").stdout, /^routine \d+\.\d+\.\d+\n$/);
});

test("skill show prints the embedded skill, install writes it", () => {
  const dir = setup();
  const shown = cli(dir, "skill", "show");
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /^---\nname: routine\ndescription: /);
  const target = join(dir, "skills");
  const r = cli(dir, "skill", "install", "--dir", target);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `installed ${join(target, "SKILL.md")}\n`);
  assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), shown.stdout);
  assert.equal(cli(dir, "skill", "remove").code, 2);
});
