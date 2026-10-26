import { type Assistant, Assistants, NEMOTRON, type Store } from "@huddle/core";

/**
 * A crew to start with: a fresh Huddle that has the keys for them saves a few assistants for you, so Just ask,
 * the router and the button have someone to hand work to from the first minute. It happens once per database:
 * remove them and they stay removed, and a Huddle that already had assistants is left as it was.
 */

/** The setting that records the starter crew was settled (added, or skipped), so it's never added twice. */
export const STARTERS = "assistants.starters";

/** Who'd start on a server with these keys set (only whether each is set matters, never its value). */
export function starterCrew(env: Readonly<Record<string, string | undefined>>): Assistant[] {
  const has = (name: string) => Boolean(env[name]?.trim());
  const crew: unknown[] = [];
  if (has("NEBIUS_API_KEY")) {
    crew.push(
      { id: "quick", name: "Quick answers", description: "Quick everyday answers: facts, sums, conversions, a word or a sentence.", connector: "nebius", model: NEMOTRON.lightning, memory: ["me"], maxTokens: 400 },
      { id: "writer", name: "Writer", description: "Writes emails, messages and posts in the person's voice.", connector: "nebius", model: NEMOTRON.super, memory: ["me"], maxTokens: 800 },
      { id: "planner", name: "Planner", description: "Plans with several steps or trade-offs: trips, budgets, schedules, decisions.", connector: "nebius", model: NEMOTRON.ultra, thinking: true, memory: ["me"], maxTokens: 3000 },
    );
  }
  if (has("TAVILY_API_KEY")) crew.push({ id: "web", name: "Web search", description: "Searches the web for current facts: weather, news, prices, opening hours. The ask is the search.", connector: "tavily", memory: [] });
  if (has("CONTEXT_DEV_API_KEY")) crew.push({ id: "reader", name: "Reader", description: "Reads a web page, or looks a company up from its name or website.", connector: "contextdev", memory: [] });
  return Assistants.parse(crew);
}

/**
 * Saves the starter crew on a Huddle with no assistants yet, the first time there's anyone to add; returns who was
 * added. With no keys yet, nothing is settled, so the crew comes once the keys do.
 */
export function addStarters(store: Store, crew: readonly Assistant[], at: Date = new Date()): Assistant[] {
  if (store.setting(STARTERS) !== null) return [];
  if (store.assistants().length > 0) {
    store.saveSetting(STARTERS, "skipped: there were assistants already");
    return [];
  }
  if (!crew.length) return [];
  store.saveAssistants(crew);
  store.saveSetting(STARTERS, `added ${at.toISOString()}`);
  return [...crew];
}
