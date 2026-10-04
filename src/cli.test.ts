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

function setup(): string {
  const dir = mkdtempSync(join(tmpdir(), "routine-cli-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "config.yaml"), "tz: Europe/Zurich\nshell: [/bin/sh, -c]\n");
  return dir;
}

test("add, list, edit, pause, show, run, log, rm", () => {
  const dir = setup();
  let r = cli(dir, "add", "office/perso-p-0014-brief", "--rrule", "FREQ=DAILY;BYHOUR=7;BYMINUTE=0", "--run", "cat", "--owner", "office:perso/P-0014", "--body", "Briefing du jour");
  assert.equal(r.code, 0, r.stderr);

  const file = join(dir, "config", "tasks", "office", "perso-p-0014-brief.md");
  assert.match(readFileSync(file, "utf8"), /^---\nrrule: FREQ=DAILY;BYHOUR=7;BYMINUTE=0\nrun: cat\nowner: office:perso\/P-0014\nactive: true\n---\n\nBriefing du jour\n$/);

  r = cli(dir, "add", "other", "--rrule", "FREQ=HOURLY", "--run", "true");
  assert.equal(r.code, 0, r.stderr);

  r = cli(dir, "ls", "--owner", "office:perso/*", "--json");
  const listed = JSON.parse(r.stdout) as { routines: { id: string; next: string }[] };
  assert.deepEqual(listed.routines.map((x) => x.id), ["office/perso-p-0014-brief"]);
  assert.match(listed.routines[0]!.next, /T05:00:00.000Z$/);

  r = cli(dir, "edit", "office/perso-p-0014-brief", "--timeout", "2m", "--owner", "");
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(readFileSync(file, "utf8"), /owner/);
  assert.match(readFileSync(file, "utf8"), /timeout: 2m/);

  r = cli(dir, "edit", "office/perso-p-0014-brief", "--rrule", "FREQ=NEVER");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid rrule/);
  assert.match(readFileSync(file, "utf8"), /FREQ=DAILY/);

  r = cli(dir, "pause", "office/perso-p-0014-brief");
  assert.equal(r.code, 0, r.stderr);
  r = cli(dir, "show", "office/perso-p-0014-brief", "--json");
  const shown = JSON.parse(r.stdout) as { active: boolean; upcoming: string[]; body: string };
  assert.equal(shown.active, false);
  assert.deepEqual(shown.upcoming, []);

  r = cli(dir, "run", "office/perso-p-0014-brief", "--json");
  assert.equal(r.code, 0, r.stderr);
  const run = JSON.parse(r.stdout) as { status: string; log: string; manual: boolean };
  assert.equal(run.status, "ok");
  assert.equal(readFileSync(run.log, "utf8").trim(), "Briefing du jour");

  r = cli(dir, "log", "--json");
  assert.equal((JSON.parse(r.stdout) as unknown[]).length, 1);

  r = cli(dir, "rm", "office/perso-p-0014-brief");
  assert.equal(r.code, 0, r.stderr);
  r = cli(dir, "show", "office/perso-p-0014-brief");
  assert.equal(r.code, 1);
});

test("usage errors exit with 2, check reports invalid files", () => {
  const dir = setup();
  assert.equal(cli(dir, "add", "x", "--rrule", "FREQ=DAILY").code, 2);
  assert.equal(cli(dir, "add", "Bad Id", "--rrule", "FREQ=DAILY", "--run", "true").code, 1);
  assert.equal(cli(dir, "frobnicate").code, 2);
  mkdirSync(join(dir, "config", "tasks"), { recursive: true });
  writeFileSync(join(dir, "config", "tasks", "broken.md"), "no frontmatter\n");
  const r = cli(dir, "check");
  assert.equal(r.code, 1);
  assert.match(r.stdout, /invalid broken: missing YAML frontmatter/);
});

test("stop and start toggle the kill switch", () => {
  const dir = setup();
  assert.match(cli(dir, "stop").stdout, /^stopped/);
  assert.match(cli(dir, "tick").stdout, /stopped/);
  assert.match(cli(dir, "start").stdout, /^running/);
});
