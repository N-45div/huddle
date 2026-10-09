import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { Engine, mock, parseFlow, type Run, Store } from "@huddle/core";
import { createApp } from "../src/app.ts";
import { type EmailOptions, htmlToText, verifySvix } from "../src/email.ts";

const TOKEN = "test-token-0123456789";
const SECRET = `whsec_${Buffer.from("a signing secret for these tests").toString("base64")}`;
const ME = "me@mine.example";

const inbox = parseFlow({
  name: "Inbox",
  trigger: { type: "email", address: "Inbox@Huddle.Example" },
  assistants: [{ id: "host", connector: "mock", replies: { "*": "Read it." } }],
  steps: [{ id: "read", type: "agent", agent: "host", ask: "Read: {{input}}" }],
});

/** A Resend event signed the Svix way, as Resend posts it. */
function signed(event: unknown, { id = "msg_1", at = Math.floor(Date.now() / 1000), secret = SECRET } = {}) {
  const body = JSON.stringify(event);
  const signature = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64")).update(`${id}.${at}.${body}`).digest("base64");
  return { method: "POST", headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(at), "svix-signature": `v1,${signature}` }, body };
}

const receivedEvent = (emailId: string) => ({
  type: "email.received",
  created_at: "2026-10-10T09:00:00.000Z",
  data: { email_id: emailId, created_at: "2026-10-10T09:00:00.000Z", from: "someone@example.com", to: ["inbox@huddle.example"], cc: [], bcc: [], received_for: [], message_id: "<1@example.com>", subject: "Hi", attachments: [] },
});

/** Resend's receiving API, standing in: the mails it holds by id, and the calls it got. */
function resend(mails: Record<string, object>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const id = decodeURIComponent(String(input).split("/").pop() ?? "");
    const mail = mails[id];
    if (!mail) return Response.json({ statusCode: 404, name: "not_found", message: "Email not found" }, { status: 404 });
    return Response.json({
      object: "email",
      id,
      created_at: "2026-10-10T09:00:00.000Z",
      to: ["inbox@huddle.example"],
      cc: [],
      bcc: [],
      reply_to: [],
      received_for: [],
      subject: "Hi",
      text: "Hello.",
      html: null,
      headers: {},
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
      attachments: [],
      ...mail,
    });
  }) as typeof fetch;
  return { fetcher, calls };
}

function setup(mails: Record<string, object>, email: Partial<EmailOptions> = {}) {
  const store = new Store();
  const engine = new Engine(store, { mock });
  const { fetcher, calls } = resend(mails);
  const app = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test", token: TOKEN, fetcher, email: { webhookSecret: SECRET, apiKey: "re_full_key", ownerEmails: [" Me@Mine.example "], ...email } });
  return { store, engine, app, calls };
}

async function settle(store: Store, runId: string): Promise<Run> {
  for (let tries = 0; tries < 400; tries += 1) {
    const run = store.run(runId);
    if (run && run.state !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`run ${runId} never settled`);
}

describe("email in, through Resend", () => {
  it("checks the Svix signature: the right secret and body pass, anything else or a stale one doesn't", async () => {
    const at = 1_800_000_000;
    const request = signed({ type: "email.received" }, { id: "msg_a", at });
    const headers = { id: "msg_a", timestamp: String(at), signature: request.headers["svix-signature"] };
    assert.equal(verifySvix(SECRET, headers, request.body, at * 1000), true);
    assert.equal(verifySvix(SECRET, { ...headers, signature: `v1,bm9wZQ== ${headers.signature}` }, request.body, at * 1000), true, "any one of several signatures will do");
    assert.equal(verifySvix(SECRET, headers, `${request.body} `, at * 1000), false, "the body changed");
    assert.equal(verifySvix(SECRET, { ...headers, id: "msg_b" }, request.body, at * 1000), false, "another event's id");
    assert.equal(verifySvix(`whsec_${Buffer.from("another secret").toString("base64")}`, headers, request.body, at * 1000), false);
    assert.equal(verifySvix(SECRET, { ...headers, signature: headers.signature.replace("v1,", "v2,") }, request.body, at * 1000), false);
    assert.equal(verifySvix(SECRET, headers, request.body, (at + 301) * 1000), false, "more than 5 minutes old");
    assert.equal(verifySvix(SECRET, headers, request.body, (at - 301) * 1000), false, "more than 5 minutes ahead");
    assert.equal(verifySvix(SECRET, { ...headers, timestamp: undefined }, request.body, at * 1000), false);

    const { app, calls } = setup({ e1: {} });
    const good = signed(receivedEvent("e1"));
    assert.equal((await app.request("/hooks/email", { ...good, headers: { ...good.headers, "svix-signature": "v1,AAAA" } })).status, 401);
    assert.equal((await app.request("/hooks/email", signed(receivedEvent("e1"), { secret: `whsec_${Buffer.from("not ours").toString("base64")}` }))).status, 401);
    assert.equal((await app.request("/hooks/email", signed(receivedEvent("e1"), { at: Math.floor(Date.now() / 1000) - 600 }))).status, 401);
    assert.equal((await app.request("/hooks/email", { method: "POST", body: JSON.stringify(receivedEvent("e1")) })).status, 401);
    assert.equal(calls.length, 0, "nothing was fetched for an event that wasn't Resend's");
    assert.equal((await setup({}, { webhookSecret: undefined }).app.request("/hooks/email", good)).status, 401, "no secret set: every event is turned away");
  });

  it("says OK to events other than email.received, and does nothing with them", async () => {
    const { app, calls } = setup({});
    const response = await app.request("/hooks/email", signed({ type: "email.delivered", data: { email_id: "sent-1" } }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ignored: "email.delivered" });
    assert.equal(calls.length, 0);
  });

  it("starts the flows whose address the mail went to, ignoring case, with who, to and subject in the input", async () => {
    const { app, store, calls } = setup({
      e1: { from: ME, to: ["Ravi <ravi@example.com>"], cc: ["INBOX@huddle.example"], subject: "Lunch\nTuesday?", text: "Are you free?\n", headers: { From: "Me Myself <me@mine.example>" } },
      e2: { from: ME, to: ["nobody@huddle.example"] },
    });
    const elsewhere = store.saveFlow({ ...inbox, name: "Elsewhere", trigger: { type: "email", address: "other@huddle.example" } });
    const saved = store.saveFlow(inbox);
    const response = await app.request("/hooks/email", signed(receivedEvent("e1"), { id: "msg_1" }));
    assert.equal(response.status, 200);
    const { started } = (await response.json()) as { started: string[] };
    assert.equal(started.length, 1);
    const run = await settle(store, started[0]!);
    assert.equal(run.flowId, saved.id);
    assert.equal(run.state, "done");
    assert.equal(run.context.input, "From: Me Myself <me@mine.example>\nTo: Ravi <ravi@example.com>\nSubject: Lunch Tuesday?\n\nAre you free?");
    assert.deepEqual(store.logOf(run.id)[0]?.detail, { name: "You", tier: "owner", via: "email" });
    assert.equal(store.runs(10, elsewhere.id).length, 0);

    assert.equal(calls[0]?.url, "https://api.resend.com/emails/receiving/e1");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer re_full_key");
    assert.match(headers["user-agent"] ?? "", /^Huddle/);

    assert.deepEqual(await (await app.request("/hooks/email", signed(receivedEvent("e2"), { id: "msg_2" }))).json(), { started: [] }, "no flow answers that address");
  });

  it("reads an HTML-only email as text, and keeps the input to 100,000 characters", async () => {
    const html = '<html><head><style>p{color:red}</style></head><body><p>Hi&nbsp;there,</p><ul><li>one &amp; two</li><li>&#x2713; done</li></ul><script>alert(1)</script><p>Bye<br>Me</p></body></html>';
    assert.equal(htmlToText(html), "Hi there,\n\n- one & two\n- ✓ done\n\nBye\nMe");
    const { app, store } = setup({ e1: { from: ME, text: null, html }, e2: { from: ME, text: "x".repeat(200_000) } });
    store.saveFlow(inbox);
    const [first] = ((await (await app.request("/hooks/email", signed(receivedEvent("e1"), { id: "msg_1" }))).json()) as { started: string[] }).started;
    assert.match((await settle(store, first!)).context.input, /\n\nHi there,\n\n- one & two\n- ✓ done\n\nBye\nMe$/);
    const [second] = ((await (await app.request("/hooks/email", signed(receivedEvent("e2"), { id: "msg_2" }))).json()) as { started: string[] }).started;
    assert.equal((await settle(store, second!)).context.input.length, 100_000);
  });

  it("counts the sender as you, a contact or a stranger, and follows the flow's callers rule", async () => {
    const mail = (from: string) => ({ from, subject: "Can we talk?", text: "Tuesday?" });
    const { app, store, engine } = setup({ owner: mail(ME), friend: mail("Asha@Example.com"), further: mail("ravi@example.com"), stranger: mail("bob@elsewhere.example") });
    const saved = store.saveFlow({ ...inbox, callers: { starts: "friend", others: "ask", strangers: "refuse" } });
    store.addContact({ name: "Asha", tier: "friend", emails: ["asha@example.com"] });
    store.addContact({ name: "Ravi", tier: "contact", emails: ["ravi@example.com"] });
    const send = async (id: string) => ((await (await app.request("/hooks/email", signed(receivedEvent(id), { id: `msg_${id}` }))).json()) as { started: string[] }).started;

    const [mine] = await send("owner");
    assert.equal((await settle(store, mine!)).state, "done");
    const [asha] = await send("friend");
    assert.equal((await settle(store, asha!)).state, "done");
    assert.deepEqual(store.logOf(asha!)[0]?.detail, { name: "Asha", tier: "friend", via: "email" });

    const [ravi] = await send("further");
    assert.equal((await settle(store, ravi!)).state, "waiting");
    const waiting = store.waitingApproval(ravi!);
    assert.match(waiting?.message ?? "", /^Ravi \(contact\) wants to run "Inbox" with: From: ravi@example\.com\nTo: inbox@huddle\.example\nSubject: Can we talk\?\n\nTuesday\?$/);
    await engine.decide(waiting!.id, true);
    assert.equal((await settle(store, ravi!)).state, "done");

    assert.deepEqual(await send("stranger"), [], "strangers are turned away: the mail is dropped");
    assert.equal(store.runs(10, saved.id).length, 3);

    store.saveFlow({ ...saved.flow, callers: { starts: "friend", others: "ask", strangers: "ask" } }, saved.id);
    const [bob] = ((await (await app.request("/hooks/email", signed(receivedEvent("stranger"), { id: "msg_stranger_again" }))).json()) as { started: string[] }).started;
    assert.equal((await settle(store, bob!)).state, "waiting");
    assert.match(store.waitingApproval(bob!)?.message ?? "", /^bob@elsewhere\.example \(not in your contacts\) wants to run "Inbox"/);
  });

  it("doesn't believe a From line the mail can't back up: you or a contact only when DKIM or DMARC passed", async () => {
    const forged = { spf: "pass", dkim: "fail", dmarc: "fail" };
    const { app, store } = setup({
      forged: { from: ME, authentication: forged },
      unchecked: { from: ME, authentication: null },
      dmarc: { from: ME, authentication: { spf: "gray", dkim: "gray", dmarc: "pass" } },
    });
    const saved = store.saveFlow({ ...inbox, callers: { starts: "owner", others: "ask", strangers: "ask" } });
    const send = async (id: string, eventId = `msg_${id}`) => ((await (await app.request("/hooks/email", signed(receivedEvent(id), { id: eventId }))).json()) as { started: string[] }).started;
    for (const id of ["forged", "unchecked"]) {
      const [run] = await send(id);
      assert.equal((await settle(store, run!)).state, "waiting", `${id}: it asks you first`);
      assert.match(store.waitingApproval(run!)?.message ?? "", /^me@mine\.example \(not proven to be them\) wants to run/);
      assert.equal((store.logOf(run!)[0]?.detail as { tier: string }).tier, "stranger");
    }
    const [proven] = await send("dmarc");
    assert.equal((await settle(store, proven!)).state, "done");
    store.saveFlow({ ...saved.flow, callers: undefined }, saved.id);
    assert.deepEqual(await send("forged", "msg_forged_again"), [], "and under the default rule, a forged mail is dropped");
  });

  it("handles each event once, however often Resend sends it, and lets a retry through when fetching failed", async () => {
    const mails: Record<string, object> = { e1: { from: ME } };
    const { app, store, calls } = setup(mails);
    store.saveFlow(inbox);
    const first = await (await app.request("/hooks/email", signed(receivedEvent("e1"), { id: "msg_retry" }))).json();
    const again = await app.request("/hooks/email", signed(receivedEvent("e1"), { id: "msg_retry" }));
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { duplicate: true });
    assert.equal((first as { started: string[] }).started.length, 1);
    assert.equal(store.runs(10).length, 1);
    assert.equal(calls.length, 1, "a retry doesn't even fetch the mail again");

    // Resend couldn't give the mail yet: a 502 so Resend tries again, and that try goes through.
    const failed = await app.request("/hooks/email", signed(receivedEvent("e2"), { id: "msg_later" }));
    assert.equal(failed.status, 502);
    assert.match(((await failed.json()) as { error: string }).error, /Couldn't fetch the mail from Resend: Resend turned it down: Email not found/);
    mails.e2 = { from: ME };
    const retried = (await (await app.request("/hooks/email", signed(receivedEvent("e2"), { id: "msg_later" }))).json()) as { started: string[] };
    assert.equal(retried.started.length, 1);
  });

  it("won't take mail it can't read, and tells the canvas whether email in is set up", async () => {
    const { app } = setup({ e1: { from: ME } }, { apiKey: undefined });
    assert.equal((await app.request("/hooks/email", signed(receivedEvent("e1")))).status, 500, "so Resend sends it again once the key is set");
    assert.deepEqual((await (await app.request("/api/info")).json()).email, { hook: "http://huddle.test/hooks/email", receiving: false });
    assert.deepEqual((await (await setup({}).app.request("/api/info")).json()).email, { hook: "http://huddle.test/hooks/email", receiving: true });
  });

  it("offers the email connector in the assistant form, asking who it goes to and who it's from", async () => {
    const connectors = (await (await setup({}).app.request("/api/connectors", { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { id: string; fields: { key: string; required: boolean }[] }[];
    const email = connectors.find((connector) => connector.id === "email");
    assert.deepEqual(email?.fields.map((field) => [field.key, field.required]), [["to", true], ["from", true], ["keyEnv", false]]);
  });
});
