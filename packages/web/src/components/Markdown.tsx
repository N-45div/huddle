import { Fragment, type ReactNode } from "react";
import { blocks, hasMarkdown, type Block, type Inline } from "../markdown.ts";

/**
 * An assistant's answer, with its Markdown drawn (bold, lists, tables, code) by the canvas's own elements,
 * never as HTML. Text with no Markdown in it shows exactly as written.
 */
export function Markdown({ text, className }: { readonly text: string; readonly className?: string }) {
  if (!hasMarkdown(text)) return <p className={className}>{text}</p>;
  return <div className={`${className ?? ""} md`.trim()}>{blocks(text).map(block)}</div>;
}

function inlines(items: readonly Inline[]): ReactNode {
  return items.map((item, index) => {
    switch (item.kind) {
      case "text":
        return <Fragment key={index}>{item.text}</Fragment>;
      case "strong":
        return <strong key={index}>{inlines(item.children)}</strong>;
      case "em":
        return <em key={index}>{inlines(item.children)}</em>;
      case "code":
        return <code key={index}>{item.text}</code>;
      case "link":
        return (
          <a href={item.href} key={index} rel="noopener noreferrer" target="_blank">
            {inlines(item.children)}
          </a>
        );
    }
  });
}

function block(item: Block, index: number): ReactNode {
  switch (item.kind) {
    case "paragraph":
      return (
        <p key={index}>
          {item.lines.map((line, at) => (
            <Fragment key={at}>
              {at > 0 && <br />}
              {inlines(line)}
            </Fragment>
          ))}
        </p>
      );
    case "heading":
      return (
        <p className="md-heading" key={index}>
          <strong>{inlines(item.content)}</strong>
        </p>
      );
    case "list": {
      const items = item.items.map((entry, at) => <li key={at}>{inlines(entry)}</li>);
      return item.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
    }
    case "table":
      return (
        <div className="md-table" key={index}>
          <table>
            <thead>
              <tr>
                {item.head.map((cell, at) => (
                  <th key={at}>{inlines(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {item.rows.map((row, at) => (
                <tr key={at}>
                  {row.map((cell, column) => (
                    <td key={column}>{inlines(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "code":
      return <pre key={index}>{item.text}</pre>;
  }
}
