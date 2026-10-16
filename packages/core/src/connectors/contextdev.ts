import { type Connector, keyFor } from "../connector.ts";
import { CONTEXT_DEV_CREDIT_USD, contextDev, taskFor } from "../contextdev.ts";
import type { ContextDevMode } from "../schema.ts";

/**
 * context.dev: reads a page, searches the web, or looks a company up. What it does is the assistant's
 * agentId (read, search or company); left out, it's picked from each request (a link is read, a lone
 * email address or domain is a company, anything else is a search). The key comes from CONTEXT_DEV_API_KEY
 * unless the assistant names another variable. Memory isn't sent: reading a page doesn't need to know you.
 */

export function contextdev(fetcher?: typeof fetch): Connector {
  return {
    async send({ assistant, ask, signal }) {
      const key = keyFor({ ...assistant, keyEnv: assistant.keyEnv ?? "CONTEXT_DEV_API_KEY" });
      if (!key) throw new Error(`${assistant.id} needs a context.dev key.`);
      const task = taskFor(ask, assistant.agentId as ContextDevMode | undefined);
      const done = await contextDev(key, task, { ...(fetcher ? { fetcher } : {}), ...(signal ? { signal } : {}) });
      const usage = done.credits !== null ? { inputTokens: 0, outputTokens: 0, costUsd: done.credits * CONTEXT_DEV_CREDIT_USD } : undefined;
      return { text: done.text, data: { ...done.data, did: task.kind, credits: done.credits }, ...(usage ? { usage } : {}) };
    },
  };
}
