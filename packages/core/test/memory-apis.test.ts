import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cosine, embedder, fromBlob, toBlob } from "../src/memory/embeddings.ts";
import { reranker } from "../src/memory/rerank.ts";

describe("memory's optional APIs", () => {
  it("talks to an OpenAI-compatible embeddings API, and says what went wrong without the key", async () => {
    const sent: { url: string; body: unknown; auth: string | null }[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") });
      if (sent.length > 1) return Response.json({ error: { message: "bad key sk-test-secret" } }, { status: 401 });
      return Response.json({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
    }) as typeof fetch;
    const embed = embedder({ url: "http://embed.test/v1/", model: "tiny", key: "sk-test-secret", fetcher });
    assert.deepEqual((await embed.embed(["a", "b"], 1_000)).map((vector) => [...vector]), [[1, 0], [0, 1]]);
    assert.deepEqual(sent[0], { url: "http://embed.test/v1/embeddings", body: { model: "tiny", input: ["a", "b"] }, auth: "Bearer sk-test-secret" });
    await assert.rejects(embed.embed(["a"], 1_000), /The embeddings API said: bad key \[key\]/);
  });

  it("keeps vectors as BLOBs and compares them by cosine", () => {
    const vector = Float32Array.from([0.6, 0.8]);
    assert.deepEqual([...fromBlob(toBlob(vector))], [...vector]);
    assert.ok(Math.abs(cosine(vector, Float32Array.from([3, 4])) - 1) < 1e-6);
    assert.equal(cosine(vector, Float32Array.from([1, 0, 0])), 0, "another model's vector");
  });

  it("talks to Voyage-, Cohere- and Jina-style rerank APIs", async () => {
    const answers = [{ data: [{ index: 0, relevance_score: 0.2 }, { index: 2, relevance_score: 0.9 }] }, { results: [{ index: 1, relevance_score: 0.7 }, { index: 7, relevance_score: 1 }] }];
    const urls: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json(answers[urls.length - 1]);
    }) as typeof fetch;
    const rank = reranker({ url: "http://rerank.test/v1", model: "lite", fetcher });
    assert.deepEqual(await rank.rank("q", ["a", "b", "c"], 1_000), [2, 0]);
    assert.deepEqual(await rank.rank("q", ["a", "b", "c"], 1_000), [1], "an index that isn't there is dropped");
    assert.deepEqual(urls, ["http://rerank.test/v1/rerank", "http://rerank.test/v1/rerank"]);
  });
});
