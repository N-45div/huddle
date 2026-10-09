import { timingSafeEqual } from "node:crypto";

/** Compares secrets in constant time. */
export function same(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The token from an `Authorization: Bearer <token>` header. */
export const bearerOf = (header: string | undefined): string | undefined => header?.replace(/^Bearer\s+/i, "") || undefined;
