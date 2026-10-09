import { useId, useRef, useState } from "react";

interface Props {
  readonly id: string;
  readonly values: readonly string[];
  readonly onChange: (values: string[]) => void;
  readonly describedBy?: string;
  /** Known values offered as you type. */
  readonly suggestions?: readonly string[];
}

/** A list of short words typed with commas or Enter, shown as removable chips. */
export function ChipsInput({ id, values, onChange, describedBy, suggestions = [] }: Props) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const add = (raw: string) => {
    const parts = raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length) {
      const next = [...values];
      for (const part of parts) if (!next.includes(part)) next.push(part);
      onChange(next);
    }
    setText("");
  };

  const offered = suggestions.filter((suggestion) => !values.includes(suggestion));

  return (
    <div
      className="chips-input"
      onClick={(event) => {
        if (event.target === event.currentTarget) input.current?.focus();
      }}
    >
      {values.map((value) => (
        <span className="chip" key={value}>
          {value}
          <button type="button" className="chip-remove" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter((other) => other !== value))}>
            ×
          </button>
        </span>
      ))}
      <input
        ref={input}
        id={id}
        value={text}
        aria-describedby={describedBy}
        list={offered.length ? listId : undefined}
        onChange={(event) => {
          const value = event.target.value;
          if (value.includes(",")) add(value);
          else setText(value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add(text);
          } else if (event.key === "Backspace" && !text && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={() => add(text)}
      />
      {offered.length > 0 && (
        <datalist id={listId}>
          {offered.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      )}
    </div>
  );
}
