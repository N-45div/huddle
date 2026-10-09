import { type RunContext, render } from "./template.ts";

/**
 * A condition step's test: "<left> <op> <right>" after its {{...}} are filled. Parsed, never run as
 * code. Numbers compare as numbers ("$1,200" counts as 1200); everything else compares as text,
 * ignoring case.
 */

const OPERATORS = [">=", "<=", "!=", "==", ">", "<", " contains "] as const;
type Operator = (typeof OPERATORS)[number];

function asNumber(text: string): number | null {
  const cleaned = text.replace(/[,\s$€£₹]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

function split(expression: string): { left: string; op: Operator; right: string } {
  for (const op of OPERATORS) {
    const at = expression.indexOf(op);
    if (at > 0) return { left: expression.slice(0, at).trim(), op, right: expression.slice(at + op.length).trim() };
  }
  throw new Error(`"${expression}" isn't a comparison. Use one of: > < >= <= == != contains`);
}

const unquote = (text: string) => text.replace(/^(["'])(.*)\1$/, "$2");

export function evaluate(expression: string, context: RunContext): boolean {
  const { left, op, right } = split(render(expression, context));
  const a = unquote(left);
  const b = unquote(right);
  if (op === " contains ") return a.toLowerCase().includes(b.toLowerCase());
  const x = asNumber(a);
  const y = asNumber(b);
  if (x !== null && y !== null) {
    switch (op) {
      case ">": return x > y;
      case "<": return x < y;
      case ">=": return x >= y;
      case "<=": return x <= y;
      case "==": return x === y;
      case "!=": return x !== y;
    }
  }
  const p = a.toLowerCase();
  const q = b.toLowerCase();
  switch (op) {
    case "==": return p === q;
    case "!=": return p !== q;
    // Ordering text that isn't a number would be a guess, so it's a mistake in the flow.
    default: throw new Error(`Can't compare "${a}" ${op.trim()} "${b}": both sides must be numbers`);
  }
}
