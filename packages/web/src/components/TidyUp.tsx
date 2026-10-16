import { useState } from "react";
import { ApiFailure, api, describeError } from "../api.ts";
import { ago, dollars, fullTime, plural } from "../format.ts";
import type { Note, Tidy, TidyProposal } from "../types.ts";
import { ErrorNote } from "./bits.tsx";

const TITLE = { conflict: "These disagree", merge: "These say the same thing", copies: "The same note more than once" } as const;

/** A note in quotes inside a sentence, without its own full stop. */
const quote = (note: string): string => `“${note.trim().replace(/[.!?]$/, "")}”`;

/** Forgets notes; one that's already gone (another proposal took it) is fine. */
async function forget(notes: readonly Note[]): Promise<void> {
  for (const note of notes) {
    try {
      await api.deleteNote(note.id);
    } catch (caught) {
      if (!(caught instanceof ApiFailure && caught.status === 404)) throw caught;
    }
  }
}

/** Tidying memory up: Huddle proposes, and each proposal changes memory only when the person agrees to it. */
export function TidyUp({ onChanged }: { readonly onChanged: () => void }) {
  const [tidy, setTidy] = useState<Tidy | null>(null);
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Readonly<Record<string, string>>>({});

  const look = async () => {
    setLooking(true);
    setError(null);
    try {
      setTidy(await api.tidyMemory());
      setDone({});
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setLooking(false);
    }
  };

  /** A proposal settled; copies of a note it took away go too, so the old wording doesn't linger. */
  const settle = async (proposal: TidyProposal, outcome: string, removed: readonly string[]) => {
    const outcomes: Record<string, string> = { [proposal.id]: outcome };
    for (const copies of tidy?.proposals ?? []) {
      if (copies.kind !== "copies" || done[copies.id] || !copies.keep || !removed.includes(copies.keep)) continue;
      try {
        await forget(copies.notes.filter((note) => !removed.includes(note.id)));
        outcomes[copies.id] = `Its copies of ${quote(copies.notes[0]?.note ?? "")} went too.`;
      } catch (caught) {
        setError(describeError(caught));
      }
    }
    setDone((before) => ({ ...before, ...outcomes }));
    if (removed.length > 0) onChanged();
  };

  const open = tidy ? tidy.proposals.filter((proposal) => !done[proposal.id]).length : 0;
  return (
    <section className="card tidy" aria-labelledby="tidy-title">
      <div className="tidy-head">
        <div>
          <h2 className="card-title" id="tidy-title">
            Tidy up
          </h2>
          <p className="hint">Finds notes that say the same thing twice, and notes that disagree. Nothing changes until you say so.</p>
        </div>
        <button type="button" className="btn" disabled={looking} onClick={() => void look()}>
          {looking ? "Looking…" : tidy ? "Look again" : "Tidy up"}
        </button>
      </div>
      {error && <ErrorNote message={error} />}
      {tidy && <TidyFrom tidy={tidy} />}
      {tidy && tidy.proposals.length === 0 && (
        <p className="ok-text" role="status">
          Nothing to tidy{tidy.readBy ? ": no copies, and nothing that disagrees." : ": no copies."}
        </p>
      )}
      {tidy && tidy.proposals.length > 0 && (
        <>
          <p className="tidy-count" role="status">
            {open === 0 ? "All done." : `${plural(open, "thing")} to look at.`}
          </p>
          <ul className="tidy-list">
            {tidy.proposals.map((proposal) =>
              done[proposal.id] ? (
                <li key={proposal.id} className="tidy-item tidy-settled">
                  {done[proposal.id]}
                </li>
              ) : (
                <Proposal key={proposal.id} proposal={proposal} onDone={(outcome, removed) => void settle(proposal, outcome, removed)} />
              ),
            )}
          </ul>
        </>
      )}
    </section>
  );
}

/** Where the notes went to be read, and what that cost. */
function TidyFrom({ tidy }: { readonly tidy: Tidy }) {
  const slices = new Set(tidy.proposals.map((proposal) => proposal.slice)).size;
  return (
    <p className="note-meta">
      {tidy.readBy
        ? `${tidy.readBy} read ${plural(tidy.sent, "kept note")}, one slice at a time (sent to ${tidy.sentTo.join(", ")}; ${dollars(tidy.costUsd)}).`
        : `Looked for exact copies among ${plural(tidy.looked, "note")}, here only: nothing left this computer.`}
      {tidy.proposals.length > 0 && ` Found in ${plural(slices, "slice")}.`}
      {tidy.failed.length > 0 && ` Couldn't read ${tidy.failed.join(", ")} this time; look again in a moment.`}
    </p>
  );
}

/** What a proposal did, and the notes it took out of memory. */
type Outcome = readonly [outcome: string, removed: readonly string[]];

function Proposal({ proposal, onDone }: { readonly proposal: TidyProposal; readonly onDone: (outcome: string, removed: readonly string[]) => void }) {
  const [merged, setMerged] = useState(proposal.merged ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { kind, notes } = proposal;

  const act = async (work: () => Promise<Outcome>) => {
    setBusy(true);
    setError(null);
    try {
      onDone(...(await work()));
    } catch (caught) {
      setError(describeError(caught));
      setBusy(false);
    }
  };

  const keepOnly = (note: Note) =>
    act(async () => {
      const others = notes.filter((other) => other.id !== note.id);
      await forget(others);
      return [`Kept ${quote(note.note)}, forgot ${others.length === 1 ? "the other" : `the other ${others.length}`}.`, others.map((other) => other.id)];
    });

  const mergeAll = () =>
    act(async () => {
      const note = await api.mergeNotes(
        notes.map((one) => one.id),
        merged.trim(),
      );
      return [`${kind === "conflict" ? "Settled as" : "Merged into"} ${quote(note.note)}.`, notes.map((one) => one.id)];
    });

  return (
    <li className={`tidy-item tidy-${kind}`}>
      <p className="tidy-what">
        <strong>{TITLE[kind]}</strong> <span className="chip chip-static">{proposal.slice}</span>
      </p>
      <p className="tidy-why">{proposal.why}</p>
      <ul className="tidy-notes">
        {notes.map((note) => (
          <li key={note.id} className={kind === "copies" && note.id !== proposal.keep ? "tidy-copy" : undefined}>
            <span className="tidy-note">{note.note}</span>
            <span className="note-meta">
              {note.status === "suggested" ? "suggested, " : ""}
              <time dateTime={note.createdAt} title={fullTime(note.createdAt)}>
                {ago(note.createdAt)}
              </time>
            </span>
            {kind === "conflict" && (
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void keepOnly(note)}>
                Keep only this
              </button>
            )}
          </li>
        ))}
      </ul>
      {proposal.merged !== undefined && (
        <div className="field">
          <label htmlFor={`merged-${proposal.id}`}>{kind === "conflict" ? "Or as one note, going by the newer" : "As one note"}</label>
          <textarea id={`merged-${proposal.id}`} rows={2} value={merged} onChange={(event) => setMerged(event.target.value)} />
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="note-actions">
        {kind === "copies" && (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const copies = notes.filter((note) => note.id !== proposal.keep);
                await forget(copies);
                const kept = notes.find((note) => note.id === proposal.keep)?.note ?? "";
                return [`Forgot ${plural(copies.length, "copy", "copies")} of ${quote(kept)}.`, copies.map((note) => note.id)];
              })
            }
          >
            Forget the copies
          </button>
        )}
        {proposal.merged !== undefined && (
          <button type="button" className="btn btn-sm btn-primary" disabled={busy || !merged.trim()} onClick={() => void mergeAll()}>
            {kind === "conflict" ? "Use this note" : "Merge"}
          </button>
        )}
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => onDone(kind === "conflict" ? "Left both: they can both be true." : "Left as it is.", [])}>
          {kind === "conflict" ? "Both are right" : "Leave it"}
        </button>
      </div>
    </li>
  );
}
