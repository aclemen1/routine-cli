import assert from "node:assert/strict";
import { test } from "node:test";
import { localDay, resolveActor, UNSIGNED_UNTIL, withoutToolActors } from "./actor.ts";
import { RoutineError } from "./errors.ts";

const BEFORE = new Date("2026-10-12T10:00:00Z");
// 19.10 at 23:30 in Zurich is still the last day; 20.10 at 00:30 in Zurich is the day after.
const LAST = new Date("2026-10-19T21:30:00Z");
const AFTER = new Date("2026-10-19T22:30:00Z");

test("--by, then ROUTINE_BY, then OFFICE_ACTOR, then the TUI, then a terminal", () => {
  const env = { ROUTINE_BY: "agent:greffier", OFFICE_ACTOR: "agent:office-P-0019" };
  assert.deepEqual(resolveActor({ by: "routine:brief", env, tty: true, now: BEFORE }), { actor: "routine:brief", source: "by", unsigned: false });
  assert.equal(resolveActor({ env, tty: true, now: BEFORE }).actor, "agent:greffier");
  assert.equal(resolveActor({ env: { OFFICE_ACTOR: "agent:office-P-0019" }, tty: true, tui: true }).actor, "agent:office-P-0019");
  assert.equal(resolveActor({ env: { ROUTINE_BY: " ", OFFICE_ACTOR: "" }, tui: true }).actor, "human:AC@tui");
  assert.equal(resolveActor({ env: {}, tty: true, now: AFTER }).actor, "human:AC@cli");
});

test("off a terminal and without an actor: unknown:cli with a warning until the deadline", () => {
  for (const now of [BEFORE, LAST]) {
    const a = resolveActor({ env: {}, tty: false, now });
    assert.equal(a.actor, "unknown:cli");
    assert.equal(a.unsigned, true);
    assert.match(a.warning!, /ROUTINE_BY or OFFICE_ACTOR/);
  }
  assert.equal(localDay(LAST), UNSIGNED_UNTIL);
});

test("after the deadline an unsigned write is refused with a user error", () => {
  assert.throws(
    () => resolveActor({ env: {}, tty: false, now: AFTER }),
    (e: unknown) => e instanceof RoutineError && e.code === 2 && e.kind === "user_error" && /--by <actor>/.test(e.message),
  );
});

test("an actor out of the convention is refused", () => {
  for (const bad of ["user", "contact:AC", "agent:", "human:AC cli"]) {
    assert.throws(() => resolveActor({ by: bad, env: {} }), /invalid actor/);
    assert.throws(() => resolveActor({ env: { OFFICE_ACTOR: bad } }), /OFFICE_ACTOR: invalid actor/);
  }
});

test("a passage drops inherited <TOOL>_BY variables", () => {
  assert.deepEqual(withoutToolActors({ ROUTINE_BY: "x", TASK_BY: "y", OFFICE_ACTOR: "z", PATH: "/bin" }), { OFFICE_ACTOR: "z", PATH: "/bin" });
});
