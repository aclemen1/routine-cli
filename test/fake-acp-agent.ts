// ACP agent for tests. FAKE_MODE: ok (default), hang, refuse. Every call is appended to FAKE_RECORD.
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const mode = process.env.FAKE_MODE ?? "ok";
const record = (entry: unknown) => {
  if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, `${JSON.stringify(entry)}\n`);
};
let release: (() => void) | undefined;

acp
  .agent({ name: "fake" })
  .onRequest("initialize", () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
  .onRequest("session/new", ({ params }) => {
    record({ method: "session/new", cwd: params.cwd, meta: params._meta });
    return { sessionId: "s1" };
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const sessionId = params.sessionId;
    record({ method: "session/prompt", text: params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("") });
    if (mode === "hang") {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { stopReason: "cancelled" as const };
    }
    if (mode === "refuse") return { stopReason: "refusal" as const };
    const say = (text: string) =>
      client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
    await say("Bonjour. ");
    await client.notify("session/update", {
      sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Lire le fichier", kind: "read", status: "pending" },
    });
    const answer = await client.request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "t1", title: "Lire le fichier" },
      options: [
        { optionId: "a", name: "Allow", kind: "allow_once" },
        { optionId: "r", name: "Reject", kind: "reject_once" },
      ],
    });
    record({ method: "permission", answer: answer.outcome });
    await say("Fini.");
    return { stopReason: "end_turn" as const };
  })
  .onNotification("session/cancel", () => {
    record({ method: "session/cancel" });
    release?.();
  })
  .onRequest("session/close", () => {
    record({ method: "session/close" });
    return {};
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
