import { type ReactNode, useEffect, useState } from "react";
import { api, describeError } from "../api.ts";
import { useApp } from "../app-context.ts";
import { Empty, ErrorNote, Hint, Loading } from "../components/bits.tsx";
import { ConfirmDialog } from "../components/Dialog.tsx";
import { TabPanel, Tabs } from "../components/Tabs.tsx";
import { Learning } from "../components/Learning.tsx";
import { TidyUp } from "../components/TidyUp.tsx";
import { useChanges } from "../events.ts";
import { ago, fullTime } from "../format.ts";
import { useDebounced, useResource } from "../hooks.ts";
import type { MemoryHit, Note } from "../types.ts";

type Status = Note["status"];

export function MemoryScreen() {
  const { authVersion } = useApp();
  const [tab, setTab] = useState<Status>("kept");
  const kept = useResource(() => api.memory("kept"), [authVersion]);
  const suggested = useResource(() => api.memory("suggested"), [authVersion]);
  const [forgetting, setForgetting] = useState<Note | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [changes, setChanges] = useState(0);

  const refetch = useDebounced(() => {
    void kept.reload();
    void suggested.reload();
    setChanges((count) => count + 1);
  }, 200);

  useChanges((change) => {
    if (change.kind === "memory" || change.kind === "resync") refetch();
  });

  const slices = [...new Set([...(kept.data ?? []), ...(suggested.data ?? [])].map((note) => note.slice))].sort();

  const keep = async (note: Note) => {
    setBusy(note.id);
    setActionError(null);
    try {
      await api.keepNote(note.id);
      suggested.setData((list) => list?.filter((other) => other.id !== note.id) ?? null);
      kept.setData((list) => (list ? [{ ...note, status: "kept" }, ...list] : list));
      refetch();
    } catch (caught) {
      setActionError(describeError(caught));
    } finally {
      setBusy(null);
    }
  };

  const discard = async (note: Note) => {
    setBusy(note.id);
    setActionError(null);
    try {
      await api.deleteNote(note.id);
      suggested.setData((list) => list?.filter((other) => other.id !== note.id) ?? null);
    } catch (caught) {
      setActionError(describeError(caught));
    } finally {
      setBusy(null);
    }
  };

  const current = tab === "kept" ? kept : suggested;
  const suggestedCount = suggested.data?.length ?? 0;

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <div>
          <h1>Memory</h1>
          <p className="lede">Assistants only see kept notes, and only in the slices they're allowed.</p>
        </div>
      </header>

      <AddNote
        slices={slices}
        onAdded={(note) => {
          kept.setData((list) => (list ? [note, ...list.filter((other) => other.id !== note.id)] : [note]));
          setTab("kept");
        }}
      />

      <Learning />

      {(kept.data?.length ?? 0) + suggestedCount >= 2 && <TidyUp onChanged={refetch} />}

      <div className="field">
        <label htmlFor="memory-search">Search</label>
        <input id="memory-search" type="search" value={query} autoComplete="off" aria-describedby="memory-search-hint" onChange={(event) => setQuery(event.target.value)} />
        <Hint id="memory-search-hint">Ranked the way assistants get notes when there are more than fit: the rarer a word, the more it counts.</Hint>
      </div>

      {query.trim() ? (
        <SearchResults query={query.trim()} changes={changes} />
      ) : (
        <>
          <Tabs
            idPrefix="memory"
            label="Notes"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "kept", label: "Kept" },
              {
                id: "suggested",
                label: (
                  <>
                    Suggested{suggestedCount > 0 && <span className="tab-count">{suggestedCount}</span>}
                  </>
                ),
              },
            ]}
          />

          <TabPanel idPrefix="memory" id={tab} className="tab-panel">
            {tab === "suggested" && <Hint>What assistants and memory steps think is worth remembering. Nothing here reaches an assistant until you keep it.</Hint>}
            {actionError && <ErrorNote message={actionError} />}
            {current.error && <ErrorNote message={current.error} onRetry={() => void current.reload()} />}
            {current.loading && !current.data && <Loading label="Loading notes…" />}
            {current.data && current.data.length === 0 && (
              <Empty title={tab === "kept" ? "No kept notes yet." : "No suggestions waiting."}>
                <p className="hint">{tab === "kept" ? "Add one above, or keep a suggestion." : "Memory steps in your flows put their notes here for you to look over."}</p>
              </Empty>
            )}
            {current.data && current.data.length > 0 && (
              <NoteGroups
                notes={current.data}
                render={(note) => (
                  <div className="note-actions">
                    {tab === "suggested" ? (
                      <>
                        <button type="button" className="btn btn-sm btn-primary" disabled={busy === note.id} onClick={() => void keep(note)}>
                          Keep
                        </button>
                        <button type="button" className="btn btn-sm" disabled={busy === note.id} onClick={() => void discard(note)}>
                          Discard
                        </button>
                      </>
                    ) : (
                      <button type="button" className="btn btn-sm btn-ghost danger-text" onClick={() => setForgetting(note)}>
                        Forget
                      </button>
                    )}
                  </div>
                )}
              />
            )}
          </TabPanel>
        </>
      )}

      <ConfirmDialog
        open={forgetting !== null}
        title="Forget this note?"
        confirmLabel="Forget"
        danger
        onCancel={() => setForgetting(null)}
        onConfirm={async () => {
          if (!forgetting) return;
          await api.deleteNote(forgetting.id);
          kept.setData((list) => list?.filter((other) => other.id !== forgetting.id) ?? null);
          setForgetting(null);
        }}
      >
        <p className="quote">{forgetting?.note}</p>
        <p>No assistant will see it again.</p>
      </ConfirmDialog>
    </div>
  );
}

/** Notes matching what's typed, kept and suggested, best first. */
function SearchResults({ query, changes }: { readonly query: string; readonly changes: number }) {
  const { authVersion } = useApp();
  const [hits, setHits] = useState<MemoryHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // Waits for a pause in typing.
    const timer = window.setTimeout(() => {
      api.searchMemory(query).then(
        (found) => {
          if (!live) return;
          setHits(found);
          setError(null);
        },
        (caught: unknown) => {
          if (live) setError(describeError(caught));
        },
      );
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, changes, authVersion]);

  if (error) return <ErrorNote message={error} />;
  if (!hits) return <Loading label="Searching…" />;
  if (hits.length === 0) {
    return (
      <Empty title="Nothing in memory matches.">
        <p className="hint">Try other words. Common ones like "the" or "when" aren't searched.</p>
      </Empty>
    );
  }
  return (
    <ul className="note-list" aria-label="Search results">
      {hits.map(({ note }) => (
        <li key={note.id} className="note-item">
          <div className="note-text">
            <p>{note.note}</p>
            <p className="note-meta">
              <span>{note.slice}</span>
              {note.status === "suggested" && " · suggested, not kept yet"}
              {" · "}
              <time dateTime={note.createdAt} title={fullTime(note.createdAt)}>
                {ago(note.createdAt)}
              </time>
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function NoteGroups({ notes, render }: { readonly notes: readonly Note[]; readonly render: (note: Note) => ReactNode }) {
  const groups = new Map<string, Note[]>();
  for (const note of notes) groups.set(note.slice, [...(groups.get(note.slice) ?? []), note]);
  const ordered = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="note-groups">
      {ordered.map(([slice, list]) => (
        <section key={slice} className="note-group" aria-label={`Slice ${slice}`}>
          <h2 className="slice-head">
            <span className="chip chip-static">{slice}</span>
            <span className="muted">{list.length}</span>
          </h2>
          <ul className="note-list">
            {[...list]
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map((note) => (
                <li key={note.id} className="note-item">
                  <div className="note-text">
                    <p>{note.note}</p>
                    <p className="note-meta">
                      {note.source && <span>{note.source}</span>}
                      {note.source && " · "}
                      <time dateTime={note.createdAt} title={fullTime(note.createdAt)}>
                        {ago(note.createdAt)}
                      </time>
                    </p>
                  </div>
                  {render(note)}
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function AddNote({ slices, onAdded }: { readonly slices: readonly string[]; readonly onAdded: (note: Note) => void }) {
  const [slice, setSlice] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  const submit = async () => {
    if (!slice.trim() || !text.trim()) {
      setError("Give the note a slice and some words.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const note = await api.addNote(slice.trim(), text.trim());
      setText("");
      setAdded(true);
      onAdded(note);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card add-note"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 className="card-title">Add a note</h2>
      <div className="add-note-grid">
        <div className="field">
          <label htmlFor="note-slice">Slice</label>
          <input
            id="note-slice"
            list="note-slices"
            value={slice}
            autoComplete="off"
            aria-describedby="note-slice-hint"
            onChange={(event) => {
              setSlice(event.target.value);
              setAdded(false);
            }}
          />
          <datalist id="note-slices">
            {slices.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <Hint id="note-slice-hint">Which part of your life it's about, like money or calendar.</Hint>
        </div>
        <div className="field field-grow">
          <label htmlFor="note-text">Note</label>
          <textarea
            id="note-text"
            rows={2}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setAdded(false);
            }}
          />
        </div>
      </div>
      <div className="form-foot">
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {added && !error && (
          <p className="ok-text" role="status">
            Kept.
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Adding…" : "Add note"}
        </button>
      </div>
    </form>
  );
}
