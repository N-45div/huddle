import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { email, subjectAndBody } from "../src/connectors/email.ts";
import { Assistant, parseFlow } from "../src/schema.ts";
import type { Note } from "../src/store.ts";

const note: Note = { id: "note_1", slice: "money", note: "Rent is due on the 5th.", status: "kept", source: "you", createdAt: "" };

describe("the email connector (Resend)", () => {
  const assistant = Assistant.parse({ id: "mail", connector: "email", to: ["asha@example.com", "ravi@example.com"], from: "Huddle <huddle@mydomain.com>", memory: ["money"] });
  const calls: { url: string; init: RequestInit }[] = [];
  const answering = (body: unknown, status = 200) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(body, { status });
  }) as typeof fetch;

  it("sends the step's text to the assistant's addresses, with the key, a User-Agent, and no memory", async () => {
    process.env.RESEND_API_KEY = "re_test_123";
    const answer = await email(answering({ id: "49a3999c-0ce1" })).send({ assistant, ask: "Subject: Rent\n\nRent is paid for October.\nThanks!", memory: [note] });
    assert.deepEqual(answer, { text: "Sent to asha@example.com, ravi@example.com (id 49a3999c-0ce1).", data: { id: "49a3999c-0ce1", to: ["asha@example.com", "ravi@example.com"], subject: "Rent" } });
    const call = calls.at(-1)!;
    assert.equal(call.url, "https://api.resend.com/emails");
    assert.equal(call.init.method, "POST");
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer re_test_123");
    assert.equal(headers["content-type"], "application/json");
    assert.match(headers["user-agent"] ?? "", /^Huddle/);
    const body = JSON.parse(String(call.init.body));
    assert.deepEqual(body, { from: "Huddle <huddle@mydomain.com>", to: ["asha@example.com", "ravi@example.com"], subject: "Rent", text: "Rent is paid for October.\nThanks!" });
    assert.ok(!String(call.init.body).includes("Rent is due on the 5th"), "memory never goes out in an email");
  });

  it("takes the subject from a first line that starts with Subject:, else uses a plain default", () => {
    assert.deepEqual(subjectAndBody("subject:  Lunch?  \nAre you free Tuesday?"), { subject: "Lunch?", body: "Are you free Tuesday?" });
    assert.deepEqual(subjectAndBody("\n  Subject: Hi\r\n\r\nBody\n"), { subject: "Hi", body: "Body" });
    assert.deepEqual(subjectAndBody("Are you free Tuesday?\nSubject: not this"), { subject: "A message from Huddle", body: "Are you free Tuesday?\nSubject: not this" });
    assert.deepEqual(subjectAndBody("Subject:\nJust a body"), { subject: "A message from Huddle", body: "Just a body" });
  });

  it("won't send an empty message, and says which variable is missing", async () => {
    process.env.RESEND_API_KEY = "re_test_123";
    await assert.rejects(email(answering({ id: "x" })).send({ assistant, ask: "Subject: Only a subject", memory: [] }), /nothing to send/);
    delete process.env.RESEND_API_KEY;
    await assert.rejects(email(answering({ id: "x" })).send({ assistant, ask: "Hi", memory: [] }), /RESEND_API_KEY environment variable/);
    const own = Assistant.parse({ ...assistant, keyEnv: "MY_RESEND_KEY" });
    await assert.rejects(email(answering({ id: "x" })).send({ assistant: own, ask: "Hi", memory: [] }), /MY_RESEND_KEY environment variable/);
  });

  it("says plainly what went wrong: a bad key, an unverified domain, sending too fast, a used-up quota", async () => {
    process.env.RESEND_API_KEY = "re_test_123";
    const fails = async (body: unknown, status: number) => {
      try {
        await email(answering(body, status)).send({ assistant, ask: "Hi", memory: [] });
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("it should have failed");
    };
    assert.equal(await fails({ statusCode: 403, name: "validation_error", message: "API key is invalid" }, 403), "Resend didn't take the key in RESEND_API_KEY: API key is invalid. Check it in Resend → API Keys.");
    assert.match(await fails({ statusCode: 401, name: "missing_api_key", message: "Missing API key in the authorization header." }, 401), /^Resend didn't take the key in RESEND_API_KEY/);
    assert.equal(
      await fails({ statusCode: 403, name: "validation_error", message: "The mydomain.com domain is not verified. Please, add and verify your domain." }, 403),
      "Resend won't send from Huddle <huddle@mydomain.com>: its domain isn't verified. Verify it in Resend → Domains, or send from an address on a domain you did verify.",
    );
    assert.match(await fails({ statusCode: 403, name: "validation_error", message: "You can only send testing emails to your own email address (you@example.com)." }, 403), /^Resend only sends to your own address until you verify a domain/);
    assert.match(await fails({ statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests." }, 429), /calling too fast/);
    assert.match(await fails({ statusCode: 429, name: "daily_quota_exceeded", message: "You have exceeded your daily email sending quota." }, 429), /daily sending quota is used up/);
    assert.match(await fails({ statusCode: 422, name: "validation_error", message: "Invalid `to` field." }, 422), /^Resend turned it down: Invalid `to` field\.$/);
    assert.match(await fails({ statusCode: 500, name: "application_error", message: "An unexpected error occurred." }, 500), /Resend is having trouble/);
    assert.equal(await fails({ name: "validation_error", message: "bad key re_test_123" }, 400), "Resend turned it down: bad key [key]", "the key is never repeated");
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(email(down).send({ assistant, ask: "Hi", memory: [] }), /^Error: Can't reach Resend: fetch failed$/);
  });

  it("needs who it goes to and who it's from, as real addresses", () => {
    const flow = (fields: object) => () =>
      parseFlow({ name: "Mail", assistants: [{ id: "mail", connector: "email", ...fields }], steps: [{ id: "send", type: "agent", agent: "mail", ask: "Hi" }] });
    assert.throws(flow({}), /sends email: give who it goes to \(to\) and who it's from/);
    assert.throws(flow({ to: ["not an address"], from: "huddle@mydomain.com" }), /to\.0: an email address/);
    assert.throws(flow({ to: ["asha@example.com"], from: "Huddle <nope>" }), /from: an email address, or "Name <address>"/);
    assert.doesNotThrow(flow({ to: ["asha@example.com"], from: "huddle@mydomain.com" }));
    assert.doesNotThrow(flow({ to: ["asha@example.com"], from: "Your Huddle <huddle@mydomain.com>" }));
  });
});
