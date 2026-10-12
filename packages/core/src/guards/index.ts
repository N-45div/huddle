import type { Guard } from "../guard.ts";
import { armoriq } from "./armoriq.ts";
import { httpGuard } from "./http.ts";

/**
 * Which guard checks hand-offs, if any: HUDDLE_GUARD names it, the way a flow names a connector. None by
 * default; Huddle's own Approvals are the usual way to say yes. Every guard is an option you switch on.
 *
 *   HUDDLE_GUARD=armoriq   ArmorIQ (ARMORIQ_API_KEY; HUDDLE_ARMORIQ_AGENT, HUDDLE_ARMORIQ_REQUESTER)
 *   HUDDLE_GUARD=http      your own policy service (HUDDLE_GUARD_URL, HUDDLE_GUARD_KEY, HUDDLE_GUARD_ON_FAILURE)
 */

export const GUARDS = ["armoriq", "http"] as const;

export function guardFromEnv(env: Readonly<Record<string, string | undefined>>): Guard | null {
  const get = (name: string) => env[name]?.trim() || undefined;
  const name = get("HUDDLE_GUARD")?.toLowerCase();
  if (!name || name === "none") return null;
  if (name === "armoriq") {
    const apiKey = get("ARMORIQ_API_KEY");
    if (!apiKey) throw new Error("HUDDLE_GUARD=armoriq needs ARMORIQ_API_KEY (Settings, API Keys on platform.armoriq.ai).");
    return armoriq({ apiKey, agentId: get("HUDDLE_ARMORIQ_AGENT"), requester: get("HUDDLE_ARMORIQ_REQUESTER") });
  }
  if (name === "http") {
    const url = get("HUDDLE_GUARD_URL");
    if (!url) throw new Error("HUDDLE_GUARD=http needs HUDDLE_GUARD_URL: where Huddle asks about each hand-off.");
    const onFailure = get("HUDDLE_GUARD_ON_FAILURE");
    if (onFailure && onFailure !== "block" && onFailure !== "allow") throw new Error(`HUDDLE_GUARD_ON_FAILURE is block or allow, not "${onFailure}".`);
    return httpGuard({ url, key: get("HUDDLE_GUARD_KEY"), ...(onFailure ? { onFailure: onFailure as "block" | "allow" } : {}) });
  }
  throw new Error(`There's no "${name}" guard. HUDDLE_GUARD is one of: ${GUARDS.join(", ")} (or leave it out).`);
}
