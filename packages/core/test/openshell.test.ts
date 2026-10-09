import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { openshell } from "../src/connectors/openshell.ts";
import { OpenShell } from "../src/openshell/client.ts";
import { Assistant, Flow } from "../src/schema.ts";
import type { Note } from "../src/store.ts";

const note: Note = { id: "note_1", slice: "home", note: "My cat is called Miso.", status: "kept", source: "you", createdAt: "" };

/**
 * A stand-in OpenShell gateway: a real gRPC server built from the same protobuf files, answering the
 * way gateway 0.1.2 did when we ran it (a pending chunk for bash -> example.com:443, exec with stdin).
 */
function fakeGateway() {
  const calls: { method: string; request: Record<string, unknown> }[] = [];
  const definition = loader.loadSync("openshell.proto", { includeDirs: [fileURLToPath(new URL("../src/openshell/proto/", import.meta.url))], longs: String, enums: String, defaults: true, oneofs: true });
  const service = (grpc.loadPackageDefinition(definition) as unknown as { openshell: { v1: { OpenShell: grpc.ServiceClientConstructor } } }).openshell.v1.OpenShell.service;
  const server = new grpc.Server();
  const unary = (method: string, reply: (request: Record<string, unknown>) => object | grpc.ServiceError) => (call: grpc.ServerUnaryCall<Record<string, unknown>, object>, callback: grpc.sendUnaryData<object>) => {
    calls.push({ method, request: call.request });
    const answer = reply(call.request);
    if (answer instanceof Error) callback(answer);
    else callback(null, answer);
  };
  const notFound = (what: string) => Object.assign(new Error(what), { code: grpc.status.NOT_FOUND, details: what, metadata: new grpc.Metadata() }) as grpc.ServiceError;
  server.addService(service, {
    Health: unary("Health", () => ({ status: "SERVICE_STATUS_HEALTHY", version: "0.1.2" })),
    ListSandboxes: unary("ListSandboxes", () => ({ sandboxes: [{ metadata: { name: "agent" }, status: { phase: "SANDBOX_PHASE_READY" } }] })),
    GetDraftPolicy: unary("GetDraftPolicy", (request) =>
      request.sandbox !== "agent"
        ? notFound("sandbox not found")
        : {
            chunks: [
              { id: "chunk-1", status: "pending", ruleName: "allow_example_com_443", proposedRule: { endpoints: [{ host: "example.com", port: 443 }] }, rationale: "Allow bash to connect to example.com:443 (HTTPS).", securityNotes: "", validationResult: "prover: no new findings", binary: "/usr/bin/bash", hitCount: 2, firstSeenTime: { seconds: "1791536390", nanos: 0 }, reviewToken: "token-1" },
              { id: "chunk-0", status: "approved", ruleName: "old", rationale: "", securityNotes: "", validationResult: "", binary: "/usr/bin/curl", hitCount: 1, reviewToken: "" },
            ],
          },
    ),
    ApproveDraftChunk: unary("ApproveDraftChunk", () => ({ policyVersion: 2, policyHash: "abc" })),
    RejectDraftChunk: unary("RejectDraftChunk", () => ({})),
    ExecSandbox: (call: grpc.ServerWritableStream<Record<string, unknown>, object>) => {
      calls.push({ method: "ExecSandbox", request: call.request });
      if (call.request.sandbox !== "agent") {
        call.emit("error", notFound("sandbox not found"));
        return;
      }
      const command = call.request.command as string[];
      const stdin = Buffer.from(call.request.stdin as Uint8Array).toString();
      const said = command.at(-1) === "fail" ? null : (stdin || command.join(" ")).toUpperCase();
      if (said === null) {
        call.write({ stderr: { data: Buffer.from("no model configured\n") } });
        call.write({ exit: { exitCode: 2 } });
      } else if (command.at(-1) === "quiet") {
        call.write({ exit: { exitCode: 0 } });
      } else {
        call.write({ stdout: { data: Buffer.from(`${said}\n`) } });
        call.write({ exit: { exitCode: 0 } });
      }
      call.end();
    },
  });
  return { calls, server };
}

describe("OpenShell", () => {
  const fake = fakeGateway();
  let shell: OpenShell;
  before(
    () =>
      new Promise<void>((resolve, reject) =>
        fake.server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, port) => {
          if (error) return reject(error);
          shell = new OpenShell({ gateway: `http://127.0.0.1:${port}` });
          resolve();
        }),
      ),
  );
  after(() => {
    shell.close();
    fake.server.forceShutdown();
  });
  const agent = (fields: Record<string, unknown> = {}) => Assistant.parse({ id: "hermes", connector: "openshell", agentId: "agent", command: ["hermes", "chat", "--query-file", "/dev/stdin"], ...fields });

  it("checks the gateway and lists its sandboxes", async () => {
    assert.deepEqual(await shell.health(), { status: "SERVICE_STATUS_HEALTHY", version: "0.1.2" });
    assert.deepEqual(await shell.sandboxes(), [{ name: "agent", phase: "ready" }]);
  });

  it("lists only the rules waiting on a person, in plain words, and decides them with what was reviewed", async () => {
    const [request, ...rest] = await shell.requests("agent");
    assert.equal(rest.length, 0, "the approved one isn't waiting");
    assert.deepEqual(request, {
      sandbox: "agent",
      id: "chunk-1",
      rule: "allow_example_com_443",
      endpoints: ["example.com:443"],
      binary: "/usr/bin/bash",
      rationale: "Allow bash to connect to example.com:443 (HTTPS).",
      securityNotes: "",
      validation: "no new findings",
      hits: 2,
      firstSeen: "2026-10-09T08:59:50.000Z",
      reviewToken: "token-1",
    });
    await shell.approve("agent", "chunk-1", "token-1");
    assert.deepEqual(fake.calls.at(-1)?.request, { workspaceScope: { workspace: "default", selection: "workspace" }, sandbox: "agent", chunkId: "chunk-1", reviewToken: "token-1", requestId: "" });
    await shell.reject("agent", "chunk-1", "Not for this task.");
    assert.equal(fake.calls.at(-1)?.request.reason, "Not for this task.");
    await assert.rejects(shell.requests("gone"), /OpenShell: sandbox not found/);
  });

  it("runs the agent in its sandbox with the request and its memory on stdin", async () => {
    const answer = await openshell(() => shell).send({ assistant: agent(), ask: "Plan a walk", memory: [note] });
    assert.equal(answer.text, "PLAN A WALK\n\nWHAT YOU MAY USE ABOUT ME:\n- (HOME) MY CAT IS CALLED MISO.");
    const sent = fake.calls.at(-1)!.request;
    assert.deepEqual([sent.sandbox, sent.command], ["agent", ["hermes", "chat", "--query-file", "/dev/stdin"]]);
  });

  it("puts the request where {{ask}} is when the command wants it as an argument", async () => {
    const answer = await openshell(() => shell).send({ assistant: agent({ command: ["opencode", "run", "{{ask}}"] }), ask: "hi", memory: [] });
    assert.equal(answer.text, "OPENCODE RUN HI");
    assert.equal(Buffer.from(fake.calls.at(-1)!.request.stdin as Uint8Array).length, 0);
  });

  it("says what went wrong: a failing agent, no answer, a missing sandbox, or no gateway", async () => {
    await assert.rejects(openshell(() => shell).send({ assistant: agent({ command: ["sh", "fail"] }), ask: "x", memory: [] }), /hermes \(in sandbox agent\) stopped with exit code 2: no model configured/);
    await assert.rejects(openshell(() => shell).send({ assistant: agent({ command: ["sh", "quiet"] }), ask: "x", memory: [] }), /finished without an answer/);
    await assert.rejects(openshell(() => shell).send({ assistant: agent({ agentId: "gone" }), ask: "x", memory: [] }), /OpenShell: sandbox not found/);
    await assert.rejects(openshell(() => null).send({ assistant: agent(), ask: "x", memory: [] }), /isn't connected to an OpenShell gateway\. Set HUDDLE_OPENSHELL_GATEWAY/);
  });

  it("won't take an OpenShell assistant without its sandbox and command", () => {
    const flow = Flow.safeParse({ name: "x", assistants: [{ id: "box", connector: "openshell" }], steps: [{ id: "a", type: "agent", agent: "box", ask: "hi" }] });
    assert.equal(flow.success, false);
    assert.match(flow.error!.issues[0]!.message, /runs in OpenShell: give its sandbox's name \(agentId\) and the command/);
  });

  it("is off unless a gateway is set", () => {
    assert.equal(OpenShell.fromEnv({}), null);
    const configured = OpenShell.fromEnv({ HUDDLE_OPENSHELL_GATEWAY: "http://127.0.0.1:1" });
    assert.equal(configured?.gateway, "http://127.0.0.1:1");
    configured?.close();
  });
});
