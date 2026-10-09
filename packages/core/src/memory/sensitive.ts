/**
 * Memory must never hold credentials or payment data (ported from Sochen's lib/memory/sensitive.ts).
 * `findSecret` names the first kind of secret in a text so a note can be refused; `redactSecrets`
 * masks them in suggestions, which keep the rest of what a flow or an assistant wrote.
 */

interface SecretPattern {
  readonly label: string;
  readonly pattern: RegExp;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    label: "a password",
    pattern: /\b(?:pass(?:word|code|phrase)|pwd)\b(?:\s+for\s+[\w.@-]+)?\s*(?:is|was|=|:)\s*["'`]?\S{3,}/gi,
  },
  {
    // "PIN code" and "pincode" are Indian postal codes, not secrets.
    label: "a PIN",
    pattern: /\b(?:atm|card|upi|bank|debit|credit|sim)?\s*pin\b(?!\s*code)(?:\s*number)?\s*(?:is|was|=|:)\s*\d{4,6}\b/gi,
  },
  {
    label: "a one-time code",
    pattern:
      /\b(?:otp|one[- ]time\s+(?:pass(?:word|code)?|code)|verification\s+code|security\s+code|2fa\s+code|login\s+code|auth(?:entication)?\s+code)\b\D{0,24}\d{4,8}\b/gi,
  },
  {
    label: "a card security code",
    pattern: /\b(?:cvv2?|cvc2?|card\s+security\s+code)\b\D{0,12}\d{3,4}\b/gi,
  },
  {
    label: "a secret key",
    pattern:
      /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
  },
  { label: "a private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    label: "an API key or token",
    pattern:
      /\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret[_ -]?key|client[_ -]?secret|bearer)\b\s*(?:is|was|=|:)?\s*["'`]?[A-Za-z0-9_\-./+=]{16,}/gi,
  },
];

/** 13 to 19 digits, optionally grouped by spaces or dashes. */
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function cardNumbers(text: string): string[] {
  return [...text.matchAll(CARD_CANDIDATE)]
    .map((match) => match[0])
    .filter((candidate) => {
      const digits = candidate.replace(/[ -]/g, "");
      return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits);
    });
}

/** What kind of secret the text holds ("a password", "a card number", ...), or null. */
export function findSecret(text: string): string | null {
  if (cardNumbers(text).length > 0) return "a card number";
  for (const { label, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return label;
  }
  return null;
}

/** The text with every secret replaced by "[redacted]". */
export function redactSecrets(text: string): string {
  let result = text;
  for (const card of cardNumbers(result)) result = result.replaceAll(card, "[redacted]");
  for (const { pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[redacted]");
  }
  return result;
}

/** A note memory won't keep because it holds a secret; the message says which kind. */
export class SensitiveNote extends Error {
  constructor(label: string, verb = "saved") {
    super(`Not ${verb}: this looks like ${label}. Huddle never keeps passwords, card numbers, one-time codes or keys in memory.`);
    this.name = "SensitiveNote";
  }
}
