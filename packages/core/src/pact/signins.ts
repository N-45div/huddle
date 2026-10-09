import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Store } from "../store.ts";
import type { DeviceAuthorization, Grant, Poll, Scope } from "./delegation.ts";

/** A sign-in waiting for the person: the business's login link and what it would let Huddle do. */
export interface SignIn {
  readonly id: string;
  readonly business: string;
  readonly assistant: string;
  readonly runId: string | null;
  /** What Huddle asked to do, in the business's own words. */
  readonly scopes: readonly Scope[];
  readonly link: string;
  readonly userCode: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

/**
 * Sign-ins waiting for the person (PACT §5.3). Each shows in Approvals with the business's own login link
 * until the person finishes it there, says no, it expires, or they cancel it. Meanwhile the step that
 * needs it keeps running and picks the token up the moment it's issued.
 */
export class SignIns {
  /** Emits "change" whenever one starts or ends. */
  readonly events = new EventEmitter();
  private readonly waiting = new Map<string, { readonly signIn: SignIn; wake: () => void; cancelled: boolean }>();

  pending(): SignIn[] {
    return [...this.waiting.values()].map((entry) => entry.signIn);
  }

  /** Shows the sign-in and waits for the business's token, polling at its interval (sooner on checkNow). */
  async wait(
    details: Pick<SignIn, "business" | "assistant" | "runId" | "scopes">,
    authorization: DeviceAuthorization,
    poll: (deviceCode: string) => Promise<Poll>,
    signal?: AbortSignal,
  ): Promise<Grant> {
    const signIn: SignIn = {
      ...details,
      id: `signin_${randomBytes(6).toString("hex")}`,
      link: authorization.link,
      userCode: authorization.userCode,
      expiresAt: new Date(authorization.expiresAt).toISOString(),
      createdAt: new Date().toISOString(),
    };
    const entry = { signIn, wake: () => {}, cancelled: false };
    this.waiting.set(signIn.id, entry);
    this.events.emit("change");
    let interval = authorization.intervalSeconds;
    try {
      while (Date.now() < authorization.expiresAt) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, interval * 1000);
          entry.wake = () => {
            clearTimeout(timer);
            resolve();
          };
          signal?.addEventListener("abort", entry.wake, { once: true });
        });
        if (entry.cancelled) throw new Error(`You cancelled signing in to ${details.business}.`);
        if (signal?.aborted) throw new Error(`The run stopped while waiting for you to sign in to ${details.business}.`);
        const result = await poll(authorization.deviceCode);
        if (result.status === "granted") return result.grant;
        // RFC 8628 §3.5: five more seconds after slow_down.
        if (result.status === "slow_down") interval += 5;
      }
      throw new Error(`Signing in to ${details.business} expired before it was finished. Run the flow again to get a new link.`);
    } finally {
      this.waiting.delete(signIn.id);
      this.events.emit("change");
    }
  }

  /** The person says they've signed in: check with the business now. */
  checkNow(id: string): boolean {
    const entry = this.waiting.get(id);
    entry?.wake();
    return Boolean(entry);
  }

  cancel(id: string): boolean {
    const entry = this.waiting.get(id);
    if (!entry) return false;
    entry.cancelled = true;
    entry.wake();
    return true;
  }
}

/** Where delegation tokens are kept between runs, one per business. */
export interface GrantStore {
  get(business: string): Grant | null;
  set(business: string, grant: Grant): void;
  drop(business: string): void;
}

/** Grants kept in Huddle's settings (its own database), keyed by the business's interface URL. */
export function storedGrants(store: Store): GrantStore {
  const key = (business: string) => `pact.grant:${business}`;
  return {
    get(business) {
      const raw = store.setting(key(business));
      return raw ? (JSON.parse(raw) as Grant) : null;
    },
    set(business, grant) {
      store.saveSetting(key(business), JSON.stringify(grant));
    },
    drop(business) {
      store.deleteSetting(key(business));
    },
  };
}
