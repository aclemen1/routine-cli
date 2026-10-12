import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, type Config } from "./config.ts";
import { runNow } from "./engine.ts";
import { refOf, sphereOf } from "./events.ts";
import { addRoutine, editRoutine, removeRoutine, setActive, setStopped } from "./ops.ts";
import { resolvePaths, type Paths } from "./paths.ts";
import { writeTaskFile } from "./task.ts";

// A journal command that records each call: its arguments, then its stdin.
function setup(): { paths: Paths; config: Config; calls: () => { args: string[]; text: string }[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "routine-events-"));
  const out = join(dir, "journal.jsonl");
  const bin = join(dir, "journal.sh");
  writeFileSync(bin, `#!/bin/sh\n{ printf '%s\\037' "$@"; printf '\\036'; cat; printf '\\035\\n'; } >> ${out}\n`);
  chmodSync(bin, 0o755);
  const paths = resolvePaths({ ROUTINE_CONFIG_DIR: join(dir, "config"), ROUTINE_STATE_DIR: join(dir, "state") });
  const config: Config = { ...defaultConfig(), tz: "Europe/Zurich", shell: ["/bin/sh", "-c"], journal: [bin] };
  const calls = () =>
    existsSync(out)
      ? readFileSync(out, "utf8")
          .split("\x1d\n")
          .filter(Boolean)
          .map((rec) => {
            const [args, text] = rec.split("\x1e");
            return { args: args!.split("\x1f").filter(Boolean), text: text ?? "" };
          })
      : [];
  return { paths, config, calls, dir };
}

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

test("sphere and ref come from the routine or its office owner", () => {
  assert.equal(sphereOf({ sphere: "pro" }), "pro");
  assert.equal(sphereOf({ owner: "office:perso/P-0045" }), "perso");
  assert.equal(sphereOf({ owner: "office:pro" }), "pro");
  assert.equal(sphereOf({ owner: "task:x" }), undefined);
  assert.equal(refOf("office:perso/P-0045"), "office:P-0045");
  assert.equal(refOf("office:pro"), undefined);
});

test("runs, recoveries, state and changes are journaled; a routine without sphere is not", async () => {
  const { paths, config, calls, dir } = setup();
  const ctx = { paths, config, actor: { actor: "human:AC@cli", source: "tty" as const, unsigned: false } };
  const fail = join(dir, "fail");
  await addRoutine(ctx, "office/perso-p-0045-brief", { rrule: ["FREQ=DAILY;BYHOUR=7;BYMINUTE=0"], run: `[ ! -f ${fail} ] || { echo "Error: no network" >&2; exit 2; }`, owner: "office:perso/P-0045" });
  let c = calls().at(-1)!;
  assert.deepEqual([flag(c.args, "--source"), flag(c.args, "--type"), flag(c.args, "--sphere"), flag(c.args, "--by"), flag(c.args, "--ref")], ["routine:office/perso-p-0045-brief", "change", "perso", "human:AC@cli", "office:P-0045"]);
  assert.equal(c.args[0], "add");
  assert.equal(c.args[1], "-");
  assert.equal(c.text, "created · every day at 7 AM");

  await runNow(paths, config, "office/perso-p-0045-brief");
  c = calls().at(-1)!;
  assert.equal(flag(c.args, "--type"), "run");
  assert.equal(flag(c.args, "--by"), "routine:office/perso-p-0045-brief");
  assert.match(c.text, /^ok · \ds · manual$/);

  writeFileSync(fail, "");
  await runNow(paths, config, "office/perso-p-0045-brief");
  c = calls().at(-1)!;
  assert.match(c.text, /^failed exit 2 · \ds · manual · Error: no network$/);

  rmSync(fail);
  await runNow(paths, config, "office/perso-p-0045-brief");
  const last2 = calls().slice(-2);
  assert.deepEqual(last2.map((x) => flag(x.args, "--type")), ["run", "alert"]);
  assert.match(last2[1]!.text, /^ok again after 1 failed run/);

  await setActive(ctx, "office/perso-p-0045-brief", false);
  assert.deepEqual([flag(calls().at(-1)!.args, "--type"), calls().at(-1)!.text], ["state", "paused"]);
  assert.equal(flag(calls().at(-1)!.args, "--by"), "human:AC@cli");
  await editRoutine(ctx, "office/perso-p-0045-brief", { timeout: "10m" });
  assert.equal(calls().at(-1)!.text, "edited: timeout · every day at 7 AM");
  await removeRoutine(ctx, "office/perso-p-0045-brief");
  assert.equal(calls().at(-1)!.text, "removed");

  await setStopped(ctx, true);
  c = calls().at(-1)!;
  assert.deepEqual([flag(c.args, "--source"), flag(c.args, "--sphere"), c.text], ["routine:engine", "perso", "kill switch on: nothing runs"]);
  assert.equal(flag(c.args, "--by"), "human:AC@cli");

  const before = calls().length;
  writeTaskFile(join(paths.tasks, "nosphere.md"), { rrule: "FREQ=DAILY", run: "true" }, undefined);
  await runNow(paths, config, "nosphere");
  assert.equal(calls().length, before);
});

test("a failing journal command never fails a run", async () => {
  const { paths, config } = setup();
  config.journal = ["/nonexistent/journal"];
  writeTaskFile(join(paths.tasks, "x.md"), { rrule: "FREQ=DAILY", run: "true", sphere: "perso" }, undefined);
  const { record } = await runNow(paths, config, "x");
  assert.equal(record?.status, "ok");
});

test("an unsigned write is signed unknown:cli and leaves an unsigned entry", async () => {
  const { paths, config, calls } = setup();
  const ctx = { paths, config, via: "mcp", actor: { actor: "unknown:cli", source: "none" as const, unsigned: true, warning: "unsigned" } };
  await addRoutine(ctx, "brief", { rrule: ["FREQ=DAILY"], run: "true", sphere: "pro" });
  const [change, unsigned] = calls().slice(-2);
  assert.deepEqual([flag(change!.args, "--type"), flag(change!.args, "--by")], ["change", "unknown:cli"]);
  assert.deepEqual([flag(unsigned!.args, "--source"), flag(unsigned!.args, "--type"), flag(unsigned!.args, "--sphere"), flag(unsigned!.args, "--by")], ["routine:brief", "unsigned", "pro", "unknown:cli"]);
  assert.equal(unsigned!.text, "routine add brief · tool routine via mcp");

  await setStopped(ctx, true);
  const last = calls().at(-1)!;
  assert.deepEqual([flag(last.args, "--source"), flag(last.args, "--type"), last.text], ["routine:engine", "unsigned", "routine stop · tool routine via mcp"]);
});

test("a refused write writes nothing", async () => {
  const { paths, config, calls } = setup();
  const saved = { by: process.env.ROUTINE_BY, office: process.env.OFFICE_ACTOR };
  delete process.env.ROUTINE_BY;
  delete process.env.OFFICE_ACTOR;
  try {
    // An actor that does not parse is refused like a missing one after the deadline.
    process.env.OFFICE_ACTOR = "user";
    await assert.rejects(addRoutine({ paths, config }, "x", { rrule: ["FREQ=DAILY"], run: "true", sphere: "perso" }), /invalid actor "user"/);
    assert.equal(existsSync(join(paths.tasks, "x.md")), false);
    assert.equal(calls().length, 0);
  } finally {
    if (saved.by === undefined) delete process.env.ROUTINE_BY;
    else process.env.ROUTINE_BY = saved.by;
    if (saved.office === undefined) delete process.env.OFFICE_ACTOR;
    else process.env.OFFICE_ACTOR = saved.office;
  }
});

test("a passage runs with OFFICE_ACTOR=routine:<id>, or the actor the routine declares, and no inherited <TOOL>_BY", async () => {
  const { paths, config, calls } = setup();
  const saved = process.env.ROUTINE_BY;
  process.env.ROUTINE_BY = "human:AC@tui";
  try {
    writeTaskFile(join(paths.tasks, "office", "p.md"), { rrule: "FREQ=DAILY", run: 'echo "actor=$OFFICE_ACTOR by=${ROUTINE_BY:-none}"', sphere: "perso" }, undefined);
    let { record } = await runNow(paths, config, "office/p");
    assert.equal(readFileSync(record!.log, "utf8").trim(), "actor=routine:office/p by=none");
    assert.equal(flag(calls().at(-1)!.args, "--by"), "routine:office/p");

    writeTaskFile(join(paths.tasks, "office", "p.md"), { actor: "agent:greffier" }, undefined);
    ({ record } = await runNow(paths, config, "office/p"));
    assert.equal(readFileSync(record!.log, "utf8").trim(), "actor=agent:greffier by=none");
    assert.equal(flag(calls().at(-1)!.args, "--by"), "agent:greffier");

    writeTaskFile(join(paths.tasks, "office", "p.md"), { actor: "user" }, undefined);
    await assert.rejects(runNow(paths, config, "office/p"), /invalid actor/);
  } finally {
    if (saved === undefined) delete process.env.ROUTINE_BY;
    else process.env.ROUTINE_BY = saved;
  }
});
