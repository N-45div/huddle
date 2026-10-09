import { createPublicKey, type JsonWebKey as NodeJwk, verify } from "node:crypto";

/*
 * PACT's Delegated profile (spec §5), personal-agent side: OAuth 2.0 device code (RFC 8628) with Huddle
 * as the client, authenticated by its own PACT JWT. The person signs in on the business's own login page
 * (Huddle only shows the link), approves scopes, and Huddle gets a delegation token to send with each
 * message. Every reply under it carries a receipt the business signed. Adapted from the PACT reference
 * client (Apache-2.0, github.com/openpactprotocol/openpactprotocol, packages/client/src/delegation.ts).
 */

export interface Scope {
  readonly id: string;
  /** The business's own words for it, shown to the person as they are. */
  readonly description: string;
}

/** What a business's Agent Card says about delegation (§5.1). */
export interface DelegationScheme {
  readonly deviceAuthorizationUrl: string;
  readonly tokenUrl: string;
  readonly refreshUrl: string;
  readonly metadataUrl: string;
  readonly scopes: readonly Scope[];
}

/** A delegation token and what the person approved (which can be less than asked). */
export interface Grant {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly scopes: readonly string[];
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
}

export interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  /** The business's login link, with the code in it: the only thing Huddle shows. */
  readonly link: string;
  readonly expiresAt: number;
  readonly intervalSeconds: number;
}

export type Poll = { readonly status: "pending" } | { readonly status: "slow_down" } | { readonly status: "granted"; readonly grant: Grant };

/** A refusal from the business's authorization server: access_denied, expired_token, invalid_scope... */
export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, description?: string) {
    super(description ? `${code}: ${description}` : code);
    this.code = code;
  }
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** The delegation scheme on a card: a requirement naming a bearer scheme and an OAuth device-code one. */
export function delegationScheme(card: unknown): DelegationScheme | null {
  if (!isObject(card)) return null;
  const schemes = isObject(card.securitySchemes) ? card.securitySchemes : {};
  const requirements = Array.isArray(card.securityRequirements) ? card.securityRequirements : [];
  for (const requirement of requirements) {
    const names = isObject(requirement) && isObject(requirement.schemes) ? Object.keys(requirement.schemes) : [];
    if (names.length !== 2) continue;
    let bearer = false;
    let oauth: Json | undefined;
    for (const name of names) {
      const scheme = schemes[name];
      if (!isObject(scheme)) continue;
      if (isObject(scheme.httpAuthSecurityScheme) && String(scheme.httpAuthSecurityScheme.scheme).toLowerCase() === "bearer") bearer = true;
      if (isObject(scheme.oauth2SecurityScheme)) oauth = scheme.oauth2SecurityScheme;
    }
    const flow = oauth && isObject(oauth.flows) && isObject(oauth.flows.deviceCode) ? oauth.flows.deviceCode : undefined;
    const deviceAuthorizationUrl = string(flow?.deviceAuthorizationUrl);
    const tokenUrl = string(flow?.tokenUrl);
    const metadataUrl = string(oauth?.oauth2MetadataUrl);
    if (!bearer || !flow || !deviceAuthorizationUrl || !tokenUrl || !metadataUrl) continue;
    const scopes = isObject(flow.scopes) ? Object.entries(flow.scopes).map(([id, description]) => ({ id, description: String(description) })) : [];
    return { deviceAuthorizationUrl, tokenUrl, refreshUrl: string(flow.refreshUrl) ?? tokenUrl, metadataUrl, scopes };
  }
  return null;
}

/** The OAuth calls, each made as Huddle (its PACT JWT as the client credential). */
export class DeviceCode {
  private readonly scheme: DelegationScheme;
  private readonly clientId: string;
  private readonly sign: () => string;
  private readonly fetcher: typeof fetch;

  constructor(options: { readonly scheme: DelegationScheme; readonly clientId: string; readonly sign: () => string; readonly fetcher?: typeof fetch }) {
    this.scheme = options.scheme;
    this.clientId = options.clientId;
    this.sign = options.sign;
    this.fetcher = options.fetcher ?? globalThis.fetch;
  }

  /** Asks for scopes (only ones on the card); the answer holds the login link to show the person. */
  async start(scopes: readonly string[]): Promise<DeviceAuthorization> {
    const known = new Set(this.scheme.scopes.map((scope) => scope.id));
    const unknown = scopes.filter((scope) => !known.has(scope));
    if (scopes.length === 0) throw new Error("Ask for at least one scope.");
    if (unknown.length) throw new Error(`Not on the business's Agent Card: ${unknown.join(", ")}.`);
    const body = await this.post(this.scheme.deviceAuthorizationUrl, { scope: scopes.join(" ") });
    const deviceCode = string(body.device_code);
    const link = string(body.verification_uri_complete) ?? string(body.verification_uri);
    if (!deviceCode || !link) throw new Error("The business's sign-in answer had no device code or link.");
    return {
      deviceCode,
      userCode: string(body.user_code) ?? "",
      link,
      expiresAt: Date.now() + (Number(body.expires_in) || 600) * 1000,
      intervalSeconds: Number(body.interval) || 5,
    };
  }

  async poll(deviceCode: string): Promise<Poll> {
    try {
      return { status: "granted", grant: toGrant(await this.post(this.scheme.tokenUrl, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode })) };
    } catch (error) {
      if (error instanceof OAuthError && error.code === "authorization_pending") return { status: "pending" };
      if (error instanceof OAuthError && error.code === "slow_down") return { status: "slow_down" };
      throw error;
    }
  }

  async refresh(refreshToken: string): Promise<Grant> {
    return toGrant(await this.post(this.scheme.refreshUrl, { grant_type: "refresh_token", refresh_token: refreshToken }));
  }

  private async post(url: string, params: Record<string, string>): Promise<Json> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        headers: { accept: "application/json", authorization: `Bearer ${this.sign()}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...params, client_id: this.clientId }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error(`Can't reach the business's sign-in service at ${new URL(url).origin}.`);
    }
    const body = (await response.json().catch(() => null)) as unknown;
    if (response.ok && isObject(body)) return body;
    if (response.status === 401) throw new Error("The business turned down Huddle's identity (401) when asking to act for you.");
    if (isObject(body) && typeof body.error === "string") throw new OAuthError(body.error, string(body.error_description));
    throw new Error(`The business's sign-in service answered HTTP ${response.status}.`);
  }
}

function toGrant(body: Json): Grant {
  const accessToken = string(body.access_token);
  if (!accessToken) throw new Error("The business's token answer had no access token.");
  const refreshToken = string(body.refresh_token);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    scopes: String(body.scope ?? "").split(/\s+/).filter(Boolean),
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  };
}

/** A receipt as Huddle keeps it: what the business says it did for you, and whether its signature checks out. */
export interface ReceiptCheck {
  readonly verified: boolean;
  readonly claims: Json;
  /** Why it didn't verify. */
  readonly problem?: string;
}

/**
 * Checks a receipt (§5.6): its compact JWS against the business's keys (from its RFC 8414 metadata's
 * jwks_uri), and that the signed claims are the ones shown. ES256 and RS256.
 */
export async function checkReceipt(receipt: unknown, metadataUrl: string, fetcher: typeof fetch = globalThis.fetch): Promise<ReceiptCheck> {
  const claims = isObject(receipt) && isObject(receipt.claims) ? receipt.claims : {};
  const fail = (problem: string): ReceiptCheck => ({ verified: false, claims, problem });
  const jws = isObject(receipt) ? string(receipt.jws) : undefined;
  if (!jws) return fail("The receipt has no signature.");
  const [head, payload, signature] = jws.split(".");
  if (!head || !payload || !signature) return fail("The receipt's signature isn't a compact JWS.");
  try {
    const header = JSON.parse(Buffer.from(head, "base64url").toString()) as Json;
    const alg = header.alg;
    if (alg !== "ES256" && alg !== "RS256") return fail(`The receipt is signed with ${String(alg)}, not ES256 or RS256.`);
    const keys = await jwksOf(metadataUrl, fetcher);
    const jwk = keys.find((key) => !header.kid || key.kid === header.kid);
    if (!jwk) return fail("None of the business's published keys matches the receipt.");
    const ok = verify("sha256", Buffer.from(`${head}.${payload}`), { key: createPublicKey({ key: jwk as NodeJwk, format: "jwk" }), ...(alg === "ES256" ? { dsaEncoding: "ieee-p1363" as const } : {}) }, Buffer.from(signature, "base64url"));
    if (!ok) return fail("The receipt's signature doesn't match the business's key.");
    const signed = JSON.parse(Buffer.from(payload, "base64url").toString()) as unknown;
    if (canonical(signed) !== canonical(claims)) return fail("The receipt's claims don't match what was signed.");
    return { verified: true, claims };
  } catch (error) {
    return fail(`Couldn't check the receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const jwksCache = new Map<string, { readonly keys: readonly Json[]; readonly at: number }>();

async function jwksOf(metadataUrl: string, fetcher: typeof fetch): Promise<readonly Json[]> {
  const cached = jwksCache.get(metadataUrl);
  if (cached && Date.now() - cached.at < 300_000) return cached.keys;
  const metadata = (await (await fetcher(metadataUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) })).json()) as unknown;
  const jwksUri = isObject(metadata) ? string(metadata.jwks_uri) : undefined;
  if (!jwksUri) throw new Error("the business's metadata has no jwks_uri");
  const jwks = (await (await fetcher(jwksUri, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) })).json()) as unknown;
  const keys = isObject(jwks) && Array.isArray(jwks.keys) ? jwks.keys.filter(isObject) : [];
  jwksCache.set(metadataUrl, { keys, at: Date.now() });
  return keys;
}

/** JSON with keys sorted, so the same claims compare equal whatever their order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
