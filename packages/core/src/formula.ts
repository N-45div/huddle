/**
 * Arithmetic for calculator views: numbers, the calculator's input names, + - * / % ^, parentheses, and
 * a few functions. Parsed, never run as code, so a formula a model wrote can only do sums. No imports:
 * the canvas uses this file too.
 */

type Node =
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "name"; readonly name: string }
  | { readonly type: "unary"; readonly op: "-" | "+"; readonly arg: Node }
  | { readonly type: "binary"; readonly op: "+" | "-" | "*" | "/" | "%" | "^"; readonly left: Node; readonly right: Node }
  | { readonly type: "call"; readonly fn: string; readonly args: readonly Node[] };

const FUNCTIONS: Readonly<Record<string, { readonly arity: readonly number[]; readonly run: (...args: number[]) => number }>> = {
  min: { arity: [2, 3, 4, 5, 6, 7, 8], run: Math.min },
  max: { arity: [2, 3, 4, 5, 6, 7, 8], run: Math.max },
  abs: { arity: [1], run: Math.abs },
  sqrt: { arity: [1], run: Math.sqrt },
  floor: { arity: [1], run: Math.floor },
  ceil: { arity: [1], run: Math.ceil },
  round: { arity: [1, 2], run: (x, digits = 0) => Math.round(x * 10 ** digits) / 10 ** digits },
  pow: { arity: [2], run: Math.pow },
};

const MAX_LENGTH = 300;

export class FormulaError extends Error {}

/** Parses a formula; throws a FormulaError saying what's wrong. */
export function parseFormula(source: string): Node {
  if (source.length > MAX_LENGTH) throw new FormulaError(`A formula can be up to ${MAX_LENGTH} characters.`);
  const tokens = source.match(/\d+(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+|[A-Za-z_][A-Za-z0-9_]*|[-+*/%^(),]|\S/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];
  const expect = (token: string) => {
    if (take() !== token) throw new FormulaError(`Expected "${token}" in "${source}".`);
  };

  const primary = (): Node => {
    const token = take();
    if (token === undefined) throw new FormulaError(`"${source}" ends too soon.`);
    if (/^(\d|\.\d)/.test(token)) return { type: "number", value: Number(token) };
    if (token === "(") {
      const inner = sum();
      expect(")");
      return inner;
    }
    if (/^[A-Za-z_]/.test(token)) {
      if (peek() !== "(") return { type: "name", name: token };
      const fn = FUNCTIONS[token];
      if (!fn) throw new FormulaError(`There's no function "${token}"; there are ${Object.keys(FUNCTIONS).join(", ")}.`);
      take();
      const args: Node[] = [];
      if (peek() !== ")") {
        args.push(sum());
        while (peek() === ",") {
          take();
          args.push(sum());
        }
      }
      expect(")");
      if (!fn.arity.includes(args.length)) throw new FormulaError(`${token}() takes ${fn.arity.join(" or ")} values, not ${args.length}.`);
      return { type: "call", fn: token, args };
    }
    throw new FormulaError(`"${token}" can't go there in "${source}".`);
  };
  const unary = (): Node => {
    const token = peek();
    if (token === "-" || token === "+") {
      take();
      return { type: "unary", op: token, arg: unary() };
    }
    return power();
  };
  const power = (): Node => {
    const base = primary();
    if (peek() !== "^") return base;
    take();
    return { type: "binary", op: "^", left: base, right: unary() };
  };
  const product = (): Node => {
    let left = unary();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = take() as "*" | "/" | "%";
      left = { type: "binary", op, left, right: unary() };
    }
    return left;
  };
  const sum = (): Node => {
    let left = product();
    while (peek() === "+" || peek() === "-") {
      const op = take() as "+" | "-";
      left = { type: "binary", op, left, right: product() };
    }
    return left;
  };

  if (tokens.length === 0) throw new FormulaError("The formula is empty.");
  const tree = sum();
  if (at < tokens.length) throw new FormulaError(`"${tokens[at]}" can't go there in "${source}".`);
  return tree;
}

/** The names a formula uses. */
export function namesIn(node: Node): string[] {
  switch (node.type) {
    case "number": return [];
    case "name": return [node.name];
    case "unary": return namesIn(node.arg);
    case "binary": return [...new Set([...namesIn(node.left), ...namesIn(node.right)])];
    case "call": return [...new Set(node.args.flatMap(namesIn))];
  }
}

function run(node: Node, values: Readonly<Record<string, number>>): number {
  switch (node.type) {
    case "number": return node.value;
    case "name": {
      const value = values[node.name];
      if (value === undefined) throw new FormulaError(`"${node.name}" isn't one of the inputs.`);
      return value;
    }
    case "unary": return node.op === "-" ? -run(node.arg, values) : run(node.arg, values);
    case "binary": {
      const a = run(node.left, values);
      const b = run(node.right, values);
      if ((node.op === "/" || node.op === "%") && b === 0) throw new FormulaError("That divides by zero.");
      return node.op === "+" ? a + b : node.op === "-" ? a - b : node.op === "*" ? a * b : node.op === "/" ? a / b : node.op === "%" ? a % b : a ** b;
    }
    case "call": return FUNCTIONS[node.fn]!.run(...node.args.map((arg) => run(arg, values)));
  }
}

/** Works a formula out; throws a FormulaError for a bad formula, a missing input, or a result that isn't a finite number. */
export function evaluateFormula(source: string, values: Readonly<Record<string, number>>): number {
  const result = run(parseFormula(source), values);
  if (!Number.isFinite(result)) throw new FormulaError("The result isn't a finite number.");
  return result;
}
