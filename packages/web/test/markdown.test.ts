import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blocks, hasMarkdown, inline } from "../src/markdown.ts";

describe("an answer's Markdown", () => {
  it("reads bold, italics, code and links in a line", () => {
    assert.deepEqual(inline("I'd pick **Jintana Thai Farmhouse** for `7:30`, *easily*."), [
      { kind: "text", text: "I'd pick " },
      { kind: "strong", children: [{ kind: "text", text: "Jintana Thai Farmhouse" }] },
      { kind: "text", text: " for " },
      { kind: "code", text: "7:30" },
      { kind: "text", text: ", " },
      { kind: "em", children: [{ kind: "text", text: "easily" }] },
      { kind: "text", text: "." },
    ]);
    assert.deepEqual(inline("Split 2*3*4 and snake_case_names stay"), [{ kind: "text", text: "Split 2*3*4 and snake_case_names stay" }], "no italics inside words or sums");
  });

  it("only opens web links; anything else is plain text", () => {
    assert.deepEqual(inline("[menu](https://example.com/menu)"), [{ kind: "link", href: "https://example.com/menu", children: [{ kind: "text", text: "menu" }] }]);
    assert.deepEqual(inline("[click](javascript:alert(1))"), [{ kind: "text", text: "click" }, { kind: "text", text: ")" }]);
    assert.deepEqual(inline("[x](data:text/html,hi)"), [{ kind: "text", text: "x" }]);
  });

  it("reads lists, headings, paragraphs and code blocks", () => {
    const read = blocks("## Saturday\nI'd pick **Jintana**.\nIt's cozy.\n\n- **Getting there:** leave at 7\n- **After:** a walk\n\n1. one\n2. two\n\n```\nnpm start\n```");
    assert.deepEqual(read.map((block) => block.kind), ["heading", "paragraph", "list", "list", "code"]);
    assert.equal(read[1]!.kind === "paragraph" && read[1]!.lines.length, 2, "lines in a paragraph stay lines");
    assert.equal(read[3]!.kind === "list" && read[3]!.ordered, true);
    assert.equal(read[4]!.kind === "code" && read[4]!.text, "npm start");
  });

  it("reads a pipe table, header and rows", () => {
    const table = blocks("| | Nourish Thai | Jintana |\n|---|---|---|\n| **Area** | Prospect Heights | Park Slope |\n| Dish | Green curry | Salad |")[0];
    assert.equal(table?.kind, "table");
    if (table?.kind !== "table") return;
    assert.equal(table.head.length, 3);
    assert.equal(table.rows.length, 2);
    assert.deepEqual(table.rows[0]![0], [{ kind: "strong", children: [{ kind: "text", text: "Area" }] }]);
  });

  it("leaves plain answers alone", () => {
    assert.equal(hasMarkdown("Hey Sam, I found a cozy date-night spot for Saturday."), false);
    assert.equal(hasMarkdown("Total with tip: **$101.95**"), true);
    assert.equal(hasMarkdown("- one\n- two"), true);
  });
});
