import type { Receipt } from "../types.ts";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A run's privacy receipt: where each request went, with which of your notes, and what a fact check sent to the web. */
export function ReceiptPanel({ receipt }: { readonly receipt: Receipt }) {
  if (receipt.disclosures.length === 0 && receipt.searches.length === 0) return <p className="hint">Nothing in this run was sent to an assistant.</p>;
  const notes = receipt.disclosures.reduce((sum, disclosure) => sum + disclosure.notes.length, 0);
  return (
    <div className="receipt">
      <p className="receipt-summary">
        {receipt.services.length === 0 ? (
          <strong>Nothing left this machine.</strong>
        ) : (
          <>
            <strong>
              Sent to {plural(receipt.services.length, "service")}: {receipt.services.join(", ")}.
            </strong>{" "}
            Everything else stayed on this machine.
          </>
        )}{" "}
        <span className="muted">{notes === 0 ? "No notes from your memory went with it." : `${plural(notes, "note")} from your memory went with it, each only to an assistant allowed its slice.`}</span>
      </p>
      <ul className="receipt-list">
        {receipt.disclosures.map((disclosure, index) => (
          <li key={`${disclosure.stepId}-${index}`} className={disclosure.to.local ? "receipt-line local" : "receipt-line"}>
            <span className="step-chip">{disclosure.stepId}</span>
            <div>
              <p className="receipt-to">
                <strong>{disclosure.assistant}</strong> → {disclosure.to.label}
              </p>
              <p className="receipt-what muted">
                {plural(disclosure.chars, "character")} of request{disclosure.images > 0 ? `, ${plural(disclosure.images, "photo")}` : ""}
                {disclosure.notes.length === 0 ? ", no notes" : `, and ${plural(disclosure.notes.length, "note")}:`}
              </p>
              {disclosure.notes.length > 0 && (
                <ul className="receipt-notes">
                  {disclosure.notes.map((note) => (
                    <li key={note.id}>
                      {note.slice ? (
                        <>
                          <span className="slice-chip">{note.slice}</span> {note.note}
                        </>
                      ) : (
                        <span className="muted">a note you've since forgotten</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
        {receipt.searches.map((search, index) => (
          <li key={`search-${search.stepId}-${index}`} className="receipt-line">
            <span className="step-chip">{search.stepId}</span>
            <div>
              <p className="receipt-to">
                <strong>Fact check</strong> → {search.sentTo.join(", ")}
              </p>
              <p className="receipt-what muted">The approval's message, and {plural(search.queries.length, "search")}:</p>
              <ul className="receipt-notes">
                {search.queries.map((query) => (
                  <li key={query}>{query}</li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
