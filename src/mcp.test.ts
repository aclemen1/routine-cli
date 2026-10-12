import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLI = join(import.meta.dirname, "cli.ts");

test("MCP tools create, list, edit and remove routines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "routine-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp"],
    env: { ...(process.env as Record<string, string>), ROUTINE_CONFIG_DIR: join(dir, "config"), ROUTINE_STATE_DIR: join(dir, "state") },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { error: result.isError === true, data: result.isError ? result.content[0]!.text : JSON.parse(result.content[0]!.text) };
    };
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes("routine_add") && tools.includes("routine_list") && tools.includes("routine_remove"));

    let r = await call("routine_add", {
      id: "office/perso-p-0014-brief",
      rrule: ["FREQ=DAILY;BYHOUR=7;BYMINUTE=0"],
      acp: { command: "herdr-acp", args: ["--workspace", "routine"] },
      owner: "office:perso/P-0014",
      description: "Briefing du matin",
      body: "Prépare le briefing.",
    });
    assert.equal(r.error, false, r.data);
    assert.equal(r.data.description, "Briefing du matin");
    assert.deepEqual(r.data.acp, { command: "herdr-acp", args: ["--workspace", "routine"], close: "on-success", permissions: "reject" });

    r = await call("routine_add", { id: "x", rrule: ["FREQ=DAILY"] });
    assert.equal(r.error, true);
    assert.match(r.data, /run, acp or steps/);

    r = await call("routine_edit", { id: "office/perso-p-0014-brief", meta: { states: ["open", "waiting"] } });
    assert.deepEqual(r.data.meta, { states: ["open", "waiting"] });
    r = await call("routine_show", { id: "office/perso-p-0014-brief" });
    assert.deepEqual(r.data.meta, { states: ["open", "waiting"] });
    r = await call("routine_edit", { id: "office/perso-p-0014-brief", close: "never", owner: null, meta: null });
    assert.equal(r.data.meta, undefined);
    assert.equal(r.data.acp.close, "never");
    assert.equal(r.data.owner, undefined);

    r = await call("routine_edit", { id: "office/perso-p-0014-brief", run: "echo hi" });
    assert.equal(r.data.run, "echo hi");
    assert.equal(r.data.acp, undefined);

    r = await call("routine_list", { owner: "office:*" });
    assert.deepEqual(r.data.routines, []);
    r = await call("routine_list");
    assert.deepEqual(r.data.routines.map((s: { id: string }) => s.id), ["office/perso-p-0014-brief"]);

    r = await call("routine_remove", { id: "office/perso-p-0014-brief" });
    assert.equal(r.data.removed, true);
  } finally {
    await client.close();
  }
});

test("an MCP write takes its actor from the server's environment, else warns", async () => {
  const connect = async (extra: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "routine-mcp-"));
    const { ROUTINE_BY: _a, OFFICE_ACTOR: _b, ...base } = process.env as Record<string, string>;
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env: { ...base, ROUTINE_CONFIG_DIR: join(dir, "config"), ROUTINE_STATE_DIR: join(dir, "state"), ...extra } }),
    );
    return client;
  };
  const add = (client: Client) => client.callTool({ name: "routine_add", arguments: { id: "x", rrule: ["FREQ=DAILY"], run: "true" } }) as Promise<{ content: { text: string }[]; isError?: boolean }>;

  let client = await connect({});
  try {
    const r = await add(client);
    assert.equal(r.isError, undefined);
    assert.match(r.content[1]!.text, /^warning: unsigned write, signed unknown:cli/);
  } finally {
    await client.close();
  }
  client = await connect({ OFFICE_ACTOR: "agent:office-P-0019" });
  try {
    const r = await add(client);
    assert.equal(r.content.length, 1);
  } finally {
    await client.close();
  }
  client = await connect({ OFFICE_ACTOR: "user" });
  try {
    const r = await add(client);
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /OFFICE_ACTOR: invalid actor/);
  } finally {
    await client.close();
  }
});
