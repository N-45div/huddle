import { createHash, createPrivateKey, generateKeyPairSync, type JsonWebKey, randomBytes, randomUUID, sign } from "node:crypto";
import type { Store } from "../store.ts";

/**
 * Huddle's identity as a personal agent under PACT (the Personal Agent Consent & Trust Protocol,
 * https://github.com/openpactprotocol/openpactprotocol). Huddle signs every request to a business's
 * agent with its own ES256 key; the business checks it against the public key Huddle publishes at
 * {issuer}/.well-known/jwks.json. The key and the user's opaque id are made once and kept in the store.
 */

export interface PrivateJwk extends JsonWebKey {
  readonly kid: string;
}

export interface PublicJwk {
  readonly kty: string;
  readonly crv: string;
  readonly x: string;
  readonly y: string;
  readonly kid: string;
  readonly alg: "ES256";
  readonly use: "sig";
}

/** The key's RFC 7638 thumbprint, used as its kid. */
export function thumbprint(jwk: { readonly crv?: string; readonly kty?: string; readonly x?: string; readonly y?: string }): string {
  return createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest("base64url");
}

export function newKey(): PrivateJwk {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  return { ...jwk, kid: thumbprint(jwk) };
}

const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

export class PactIdentity {
  /** The URL Huddle puts in `iss`; its JWKS lives under it. */
  readonly issuer: string;
  /** Stable and opaque: the one person this Huddle acts for, as businesses see them. */
  readonly subject: string;
  private readonly jwk: PrivateJwk;

  constructor(issuer: string, jwk: PrivateJwk, subject: string) {
    this.issuer = issuer.replace(/\/$/, "");
    this.jwk = jwk;
    this.subject = subject;
  }

  /** Huddle's identity from the store, making the key and the subject the first time. */
  static load(store: Store, issuer: string): PactIdentity {
    const jwk = JSON.parse(store.settingOr("pact.key", () => JSON.stringify(newKey()))) as PrivateJwk;
    const subject = store.settingOr("pact.subject", () => `huddle-${randomBytes(12).toString("hex")}`);
    return new PactIdentity(issuer, jwk, subject);
  }

  get jwksUri(): string {
    return `${this.issuer}/.well-known/jwks.json`;
  }

  publicJwk(): PublicJwk {
    return { kty: this.jwk.kty!, crv: this.jwk.crv!, x: this.jwk.x!, y: this.jwk.y!, kid: this.jwk.kid, alg: "ES256", use: "sig" };
  }

  jwks(): { keys: PublicJwk[] } {
    return { keys: [this.publicJwk()] };
  }

  /** A short-lived ES256 JWT: for a request (`aud` = the Provider's audience) or for registering. */
  sign(claims: { readonly aud: string; readonly sub?: string; readonly ttlSeconds?: number }): string {
    const ttl = claims.ttlSeconds ?? 120;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 300) throw new Error("A PACT token lives between 1 and 300 seconds.");
    const iat = Math.floor(Date.now() / 1000);
    const header = segment({ alg: "ES256", kid: this.jwk.kid, typ: "JWT" });
    const payload = segment({ iss: this.issuer, sub: claims.sub ?? this.subject, aud: claims.aud, iat, exp: iat + ttl, jti: randomUUID() });
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key: createPrivateKey({ key: this.jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" });
    return `${header}.${payload}.${signature.toString("base64url")}`;
  }
}
