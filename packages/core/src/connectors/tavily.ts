import { type Connector, keyFor } from "../connector.ts";
import { TAVILY_CREDIT_USD, tavilySearch } from "../tavily.ts";

/**
 * Web search through Tavily: the step's request is the query; the answer is Tavily's short answer, then
 * its sources, and the data has every source with the text of it that matched. The key comes from
 * TAVILY_API_KEY unless the assistant names another variable. Memory isn't sent: a search engine
 * doesn't need to know you.
 */

export function tavily(fetcher: typeof fetch = globalThis.fetch): Connector {
  return {
    async send({ assistant, ask, signal }) {
      const key = keyFor({ ...assistant, keyEnv: assistant.keyEnv ?? "TAVILY_API_KEY" });
      if (!key) throw new Error(`${assistant.id} needs a Tavily key.`);
      const found = await tavilySearch(key, ask, { depth: "advanced", maxResults: 5, answer: true, ...(signal ? { signal } : {}) }, fetcher);
      const sources = found.results.map((result, index) => `${index + 1}. ${result.title} (${result.url})`).join("\n");
      const text = [found.answer ?? (found.results.length ? "Here's what the web says:" : "Tavily found nothing for that."), sources && `Sources:\n${sources}`].filter(Boolean).join("\n\n");
      const usage = found.credits !== null ? { inputTokens: 0, outputTokens: 0, costUsd: found.credits * TAVILY_CREDIT_USD } : undefined;
      return { text, data: { answer: found.answer, results: found.results }, ...(usage ? { usage } : {}) };
    },
  };
}
