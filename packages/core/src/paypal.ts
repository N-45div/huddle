import { randomUUID } from "node:crypto";

/**
 * PayPal's REST API, the parts a shop needs to sell to an agent: sign in with the app's client id and secret
 * (OAuth client credentials), save a payer's PayPal once (Vault v3: a setup token the payer approves on
 * PayPal's own page, then a payment token), charge that saved PayPal later without sending the payer back to
 * PayPal (Orders v2 with the token as `vault_id`), refund a capture, and check that a webhook really came from
 * PayPal. The sandbox unless told otherwise. Plain fetch, so tests pass a stand-in.
 */

export const PAYPAL_SANDBOX = "https://api-m.sandbox.paypal.com";
export const PAYPAL_LIVE = "https://api-m.paypal.com";

export interface PayPalOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** The sandbox (true when left out) or live PayPal. */
  readonly sandbox?: boolean;
  /** Another API base, for tests. */
  readonly base?: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
}

/** An amount as PayPal takes it: a currency and a decimal string ("32.50"). */
export interface Money {
  readonly currency_code: string;
  readonly value: string;
}

/** One line of an order, as the shop priced it. */
export interface OrderItem {
  readonly name: string;
  readonly sku?: string;
  readonly quantity: number;
  /** The price of one, in the order's currency ("12.00"). */
  readonly unitAmount: string;
}

/** A payer's PayPal, saved with the shop: what it's charged by from then on. */
export interface SavedPayPal {
  /** The payment token's id: the `vault_id` an order is charged with. */
  readonly vaultId: string;
  /** PayPal's id for the shop's customer the token belongs to. */
  readonly customerId: string | null;
  /** The PayPal account it charges, as PayPal shows it. */
  readonly email: string | null;
  readonly payerId: string | null;
}

/** What came of charging a saved PayPal. */
export interface Charge {
  readonly orderId: string;
  /** COMPLETED once the money has moved; PENDING while PayPal holds it for a review. */
  readonly status: string;
  readonly captureId: string | null;
  readonly captureStatus: string | null;
  readonly amount: Money;
}

/** Why PayPal said no: its own error name and message, the fields at fault, and its debug id for its support. */
export class PayPalError extends Error {
  readonly status: number;
  /** PayPal's name for the error, like "UNPROCESSABLE_ENTITY" or "invalid_client". */
  readonly code: string;
  readonly debugId: string | null;
  readonly issues: readonly string[];
  constructor(what: string, status: number, body: unknown) {
    const parsed = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const name = typeof parsed.name === "string" ? parsed.name : typeof parsed.error === "string" ? parsed.error : `HTTP ${status}`;
    const message = typeof parsed.message === "string" ? parsed.message : typeof parsed.error_description === "string" ? parsed.error_description : "";
    const details = Array.isArray(parsed.details) ? (parsed.details as Record<string, unknown>[]) : [];
    const issues = details.map((detail) => [detail.issue, detail.field, detail.description].filter((part) => typeof part === "string" && part).join(": "));
    super(`PayPal didn't ${what}: ${name}${message ? ` (${message.replace(/\s+/g, " ").trim()})` : ""}${issues.length ? `. ${issues.join("; ")}` : ""}.`);
    this.status = status;
    this.code = name;
    this.debugId = typeof parsed.debug_id === "string" ? parsed.debug_id : null;
    this.issues = issues;
  }
}

/** A decimal amount as whole cents, or null when it isn't one ("12.5" and "12.50" are 1250; "1.234" isn't). */
export function cents(value: string): number | null {
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** Whole cents as PayPal writes them: "32.50". */
export function decimal(amount: number): string {
  if (!Number.isInteger(amount) || amount < 0) throw new Error(`${amount} isn't a whole number of cents.`);
  return `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`;
}

/** The link in a PayPal answer with this rel ("approve", "payer-action"), if there is one. */
function linkOf(body: unknown, rel: string): string | null {
  const links = (body as { links?: unknown } | null)?.links;
  if (!Array.isArray(links)) return null;
  const found = (links as { rel?: unknown; href?: unknown }[]).find((link) => link.rel === rel && typeof link.href === "string");
  return found ? String(found.href) : null;
}

export class PayPal {
  readonly base: string;
  readonly sandbox: boolean;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private token: { readonly value: string; readonly until: number } | null = null;

  constructor(options: PayPalOptions) {
    if (!options.clientId.trim() || !options.clientSecret.trim()) throw new Error("PayPal needs the app's client id and secret (Apps & Credentials in PayPal's Developer Dashboard).");
    this.clientId = options.clientId.trim();
    this.clientSecret = options.clientSecret.trim();
    this.sandbox = options.sandbox ?? true;
    this.base = (options.base ?? (this.sandbox ? PAYPAL_SANDBOX : PAYPAL_LIVE)).replace(/\/$/, "");
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  /** PayPal from PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, in the sandbox unless PAYPAL_ENVIRONMENT says live; null without them. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, fetcher?: typeof fetch): PayPal | null {
    const clientId = env.PAYPAL_CLIENT_ID?.trim();
    const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) return null;
    const mode = (env.PAYPAL_ENVIRONMENT ?? "sandbox").trim().toLowerCase();
    if (!["sandbox", "live", "production"].includes(mode)) throw new Error(`PAYPAL_ENVIRONMENT is "${env.PAYPAL_ENVIRONMENT}": use sandbox or live.`);
    return new PayPal({ clientId, clientSecret, sandbox: mode === "sandbox", ...(fetcher ? { fetcher } : {}) });
  }

  /** The text with the app's secret and the current access token taken out, for errors and logs. */
  private masked(text: string): string {
    let out = text.replaceAll(this.clientSecret, "[secret]");
    if (this.token) out = out.replaceAll(this.token.value, "[token]");
    return out;
  }

  /** An access token, reused until a minute before PayPal says it expires. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > this.now()) return this.token.value;
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: "grant_type=client_credentials",
      });
    } catch (error) {
      // Said the same way as any call that can't get through, so a caller can tell it from PayPal saying no.
      throw new Error(this.masked(`PayPal couldn't be reached to sign Huddle in: ${error instanceof Error ? error.message : String(error)}`));
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new PayPalError("sign Huddle in (check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, and that they're the sandbox's)", response.status, body);
    const token = (body as { access_token?: unknown; expires_in?: unknown } | null) ?? {};
    if (typeof token.access_token !== "string" || !token.access_token) throw new Error("PayPal signed Huddle in but gave no access token.");
    const seconds = typeof token.expires_in === "number" && token.expires_in > 0 ? token.expires_in : 3_600;
    this.token = { value: token.access_token, until: this.now() + Math.max(seconds - 60, 30) * 1_000 };
    return this.token.value;
  }

  /**
   * One call to the API. `requestId` goes as PayPal-Request-Id, so the same call sent twice (a retry after a
   * dropped connection) is done once. A token PayPal no longer takes is renewed once.
   */
  async call(what: string, method: "GET" | "POST" | "PATCH", path: string, body?: unknown, requestId?: string): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.accessToken();
      let response: Response;
      try {
        response = await this.fetcher(`${this.base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            prefer: "return=representation",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(requestId ? { "paypal-request-id": requestId } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        throw new Error(this.masked(`PayPal couldn't be reached to ${what}: ${error instanceof Error ? error.message : String(error)}`));
      }
      const parsed: unknown = response.status === 204 ? null : await response.json().catch(() => null);
      if (response.status === 401 && attempt === 0) {
        this.token = null;
        continue;
      }
      if (!response.ok) {
        const error = new PayPalError(what, response.status, parsed);
        error.message = this.masked(error.message);
        throw error;
      }
      return parsed;
    }
  }

  /**
   * Starts saving a payer's PayPal with this shop, without a purchase: PayPal answers with a page for the payer
   * to approve it on. PayPal sends them back to `returnUrl` with `approval_token_id` (this setup token's id),
   * and `savePayPal` finishes it.
   */
  async startSaving(options: { readonly returnUrl: string; readonly cancelUrl: string; readonly brand: string; readonly description: string; readonly requestId?: string }): Promise<{ readonly setupTokenId: string; readonly approveUrl: string }> {
    const body = {
      payment_source: {
        paypal: {
          description: options.description.slice(0, 127),
          usage_type: "MERCHANT",
          usage_pattern: "IMMEDIATE",
          customer_type: "CONSUMER",
          permit_multiple_payment_tokens: false,
          experience_context: {
            brand_name: options.brand.slice(0, 127),
            locale: "en-US",
            shipping_preference: "NO_SHIPPING",
            return_url: options.returnUrl,
            cancel_url: options.cancelUrl,
          },
        },
      },
    };
    const answer = await this.call("start saving PayPal", "POST", "/v3/vault/setup-tokens", body, options.requestId ?? randomUUID());
    const id = (answer as { id?: unknown } | null)?.id;
    const approveUrl = linkOf(answer, "approve") ?? linkOf(answer, "payer-action");
    if (typeof id !== "string" || !approveUrl) throw new Error("PayPal made a setup token but gave no page for the payer to approve it on.");
    return { setupTokenId: id, approveUrl };
  }

  /** Finishes saving a payer's PayPal once they've approved it: the setup token becomes a payment token. */
  async savePayPal(setupTokenId: string, requestId?: string): Promise<SavedPayPal> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(setupTokenId)) throw new Error("That isn't a PayPal setup token id.");
    const answer = (await this.call("save PayPal", "POST", "/v3/vault/payment-tokens", { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } }, requestId ?? `save-${setupTokenId}`)) as {
      id?: unknown;
      customer?: { id?: unknown };
      payment_source?: { paypal?: { email_address?: unknown; payer_id?: unknown } };
    } | null;
    if (typeof answer?.id !== "string") throw new Error("PayPal saved the payer's PayPal but gave no payment token.");
    const paypal = answer.payment_source?.paypal;
    return {
      vaultId: answer.id,
      customerId: typeof answer.customer?.id === "string" ? answer.customer.id : null,
      email: typeof paypal?.email_address === "string" ? paypal.email_address : null,
      payerId: typeof paypal?.payer_id === "string" ? paypal.payer_id : null,
    };
  }

  /**
   * Charges a saved PayPal for an order the shop priced: no PayPal page, since the payer approved saving it.
   * `invoiceId` must be new for every order (PayPal turns away one it has seen, so a charge is never made
   * twice), and is sent as the request id too. Throws unless PayPal took the money or holds it pending.
   */
  async charge(options: {
    readonly vaultId: string;
    readonly currency: string;
    readonly items: readonly OrderItem[];
    readonly invoiceId: string;
    readonly description?: string;
    /** Yours to keep with the order, like the cart it was for (up to 127 characters). */
    readonly customId?: string;
  }): Promise<Charge> {
    if (!options.items.length) throw new Error("An order needs at least one item.");
    let total = 0;
    const items = options.items.map((item) => {
      const each = cents(item.unitAmount);
      if (each === null || each === 0) throw new Error(`"${item.name}" has no price PayPal can take (${item.unitAmount}).`);
      if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new Error(`"${item.name}" needs a whole quantity of one or more.`);
      total += each * item.quantity;
      return {
        name: item.name.slice(0, 127),
        quantity: String(item.quantity),
        unit_amount: { currency_code: options.currency, value: decimal(each) },
        ...(item.sku ? { sku: item.sku.slice(0, 127) } : {}),
        category: "PHYSICAL_GOODS",
      };
    });
    const amount: Money = { currency_code: options.currency, value: decimal(total) };
    const body = {
      intent: "CAPTURE",
      purchase_units: [
        {
          invoice_id: options.invoiceId,
          ...(options.customId ? { custom_id: options.customId.slice(0, 127) } : {}),
          ...(options.description ? { description: options.description.slice(0, 127) } : {}),
          amount: { ...amount, breakdown: { item_total: amount } },
          items,
        },
      ],
      payment_source: { paypal: { vault_id: options.vaultId } },
    };
    let order = (await this.call("charge the saved PayPal", "POST", "/v2/checkout/orders", body, options.invoiceId)) as OrderBody | null;
    // A saved PayPal is usually charged as the order is made; when it isn't yet, it's captured now.
    if (order?.status === "CREATED" || order?.status === "APPROVED") {
      order = (await this.call("take the payment", "POST", `/v2/checkout/orders/${encodeURIComponent(String(order.id))}/capture`, {}, `${options.invoiceId}-capture`)) as OrderBody | null;
    }
    if (typeof order?.id !== "string") throw new Error("PayPal answered the order without an id.");
    if (order.status === "PAYER_ACTION_REQUIRED") throw new Error("PayPal wants the payer to approve this one on its page, so the saved PayPal can't pay it on its own. Save PayPal again.");
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
    const captureStatus = typeof capture?.status === "string" ? capture.status : null;
    if (order.status !== "COMPLETED" || (captureStatus !== "COMPLETED" && captureStatus !== "PENDING")) {
      throw new Error(`PayPal didn't take the payment: the order is ${String(order.status ?? "unknown").toLowerCase()}${captureStatus ? `, and its capture ${captureStatus.toLowerCase()}` : ""}.`);
    }
    return { orderId: order.id, status: captureStatus === "PENDING" ? "PENDING" : "COMPLETED", captureId: typeof capture?.id === "string" ? capture.id : null, captureStatus, amount };
  }

  /** Gives money back for a capture: all of it, or `amount` of it. */
  async refund(captureId: string, options: { readonly amount?: Money; readonly requestId?: string; readonly note?: string } = {}): Promise<{ readonly id: string; readonly status: string }> {
    const body = { ...(options.amount ? { amount: options.amount } : {}), ...(options.note ? { note_to_payer: options.note.slice(0, 255) } : {}) };
    const answer = (await this.call("refund it", "POST", `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, body, options.requestId ?? randomUUID())) as { id?: unknown; status?: unknown } | null;
    if (typeof answer?.id !== "string") throw new Error("PayPal refunded it but gave no refund id.");
    return { id: answer.id, status: typeof answer.status === "string" ? answer.status : "UNKNOWN" };
  }

  /**
   * Whether a webhook is really from PayPal, asked of PayPal itself with the headers it was sent with and the
   * webhook's id (shown where you added it, in the Developer Dashboard).
   */
  async verifyWebhook(headers: (name: string) => string | undefined, event: unknown, webhookId: string): Promise<boolean> {
    const header = (name: string) => headers(name) ?? headers(name.toLowerCase()) ?? "";
    const needed = {
      auth_algo: header("PAYPAL-AUTH-ALGO"),
      cert_url: header("PAYPAL-CERT-URL"),
      transmission_id: header("PAYPAL-TRANSMISSION-ID"),
      transmission_sig: header("PAYPAL-TRANSMISSION-SIG"),
      transmission_time: header("PAYPAL-TRANSMISSION-TIME"),
    };
    if (Object.values(needed).some((value) => !value)) return false;
    const answer = (await this.call("check the webhook", "POST", "/v1/notifications/verify-webhook-signature", { ...needed, webhook_id: webhookId, webhook_event: event })) as { verification_status?: unknown } | null;
    return answer?.verification_status === "SUCCESS";
  }
}

interface OrderBody {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly purchase_units?: readonly { readonly payments?: { readonly captures?: readonly { readonly id?: unknown; readonly status?: unknown }[] } }[];
}
