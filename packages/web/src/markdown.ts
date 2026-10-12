/**
 * The little Markdown assistants write (bold, italics, code, links, lists, headings, tables, code blocks),
 * read into blocks the canvas draws with its own elements. Nothing here becomes HTML: an answer is text
 * from outside, so it is only ever shown, never run.
 */

export type Inline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "strong"; readonly children: readonly Inline[] }
  | { readonly kind: "em"; readonly children: readonly Inline[] }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "link"; readonly href: string; readonly children: readonly Inline[] };

export type Block =
  | { readonly kind: "paragraph"; readonly lines: readonly (readonly Inline[])[] }
  | { readonly kind: "heading"; readonly content: readonly Inline[] }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly (readonly Inline[])[] }
  | { readonly kind: "table"; readonly head: readonly (readonly Inline[])[]; readonly rows: readonly (readonly (readonly Inline[])[])[] }
  | { readonly kind: "code"; readonly text: string };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const ROW = /^\s*\|.*\|\s*$/;
const DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Only web links open; anything else stays plain text. */
const safeHref = (href: string): string | null => (/^https?:\/\/[^\s<>"]+$/i.test(href) ? href : null);

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

/** Bold, italics, inline code and links in one line of text. */
export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ kind: "text", text: plain });
    plain = "";
  };
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    const code = /^`([^`]+)`/.exec(rest);
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    const em = /^(\*|_)(?=\S)([^*_]*?\S)\1(?![*_\w])/.exec(rest);
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (code) {
      flush();
      out.push({ kind: "code", text: code[1]! });
      at += code[0].length;
    } else if (strong) {
      flush();
      out.push({ kind: "strong", children: inline(strong[2]!) });
      at += strong[0].length;
    } else if (em && (at === 0 || !/\w/.test(text[at - 1]!))) {
      flush();
      out.push({ kind: "em", children: inline(em[2]!) });
      at += em[0].length;
    } else if (link) {
      flush();
      const href = safeHref(link[2]!);
      if (href) out.push({ kind: "link", href, children: inline(link[1]!) });
      else out.push(...inline(link[1]!));
      at += link[0].length;
    } else {
      plain += text[at];
      at += 1;
    }
  }
  flush();
  return out;
}

/** An answer's Markdown as blocks. */
export function blocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let paragraph: Inline[][] = [];
  const endParagraph = () => {
    if (paragraph.length) out.push({ kind: "paragraph", lines: paragraph });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; ) {
    const line = lines[index]!;
    if (FENCE.test(line)) {
      endParagraph();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index]!)) body.push(lines[index++]!);
      index += 1;
      out.push({ kind: "code", text: body.join("\n") });
    } else if (ROW.test(line) && index + 1 < lines.length && DIVIDER.test(lines[index + 1]!)) {
      endParagraph();
      const head = cells(line).map(inline);
      const rows: Inline[][][] = [];
      index += 2;
      while (index < lines.length && ROW.test(lines[index]!)) rows.push(cells(lines[index++]!).map(inline));
      out.push({ kind: "table", head, rows });
    } else if (HEADING.test(line)) {
      endParagraph();
      out.push({ kind: "heading", content: inline(HEADING.exec(line)![1]!) });
      index += 1;
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      endParagraph();
      const ordered = !BULLET.test(line);
      const pattern = ordered ? NUMBERED : BULLET;
      const items: Inline[][] = [];
      while (index < lines.length && pattern.test(lines[index]!)) items.push(inline(pattern.exec(lines[index++]!)![1]!));
      out.push({ kind: "list", ordered, items });
    } else if (!line.trim()) {
      endParagraph();
      index += 1;
    } else {
      paragraph.push(inline(line));
      index += 1;
    }
  }
  endParagraph();
  return out;
}

/** Whether a text has any Markdown worth drawing (plain answers stay exactly as written). */
export const hasMarkdown = (source: string): boolean =>
  /(\*\*|__)\S|`[^`]+`|\[[^\]]+\]\(https?:|^\s*([-*•]|\d+[.)])\s+|^\s{0,3}#{1,6}\s|^\s*\|.*\|\s*$|^\s*```/m.test(source);
