import type { FactCheck } from "../types.ts";

const LABEL = { supported: "Backed", contradicted: "Contradicted", unclear: "Not settled" } as const;
/** Contradicted first: what the person most needs to see before saying yes. */
const ORDER = { contradicted: 0, supported: 1, unclear: 2 } as const;

/** What the web says about the facts in an approval: each with its verdict, and the source's own words when it settles it. */
export function FactChecks({ checks }: { readonly checks: FactCheck }) {
  if (checks.facts.length === 0) return <p className="hint fact-checks-none">Checked on the web: nothing in it to look up.</p>;
  const facts = [...checks.facts].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict]);
  const contradicted = checks.facts.filter((fact) => fact.verdict === "contradicted").length;
  return (
    <section className="fact-checks" aria-label="Facts checked on the web">
      <p className="fact-checks-head">
        <strong>{contradicted > 0 ? `${contradicted} of ${checks.facts.length} facts don't match the web` : `Checked ${checks.facts.length} facts on the web`}</strong>
        <span className="muted"> · {checks.checkedBy}</span>
      </p>
      <ul className="fact-list">
        {facts.map((fact) => (
          <li key={fact.claim} className={`fact fact-${fact.verdict}`}>
            <span className="fact-verdict">{LABEL[fact.verdict]}</span>
            <div className="fact-body">
              <p className="fact-claim">{fact.claim}</p>
              <p className="fact-note">{fact.note}</p>
              {fact.source && (
                <blockquote className="fact-quote">
                  “{fact.source.quote}”{" "}
                  <a href={fact.source.url} target="_blank" rel="noopener noreferrer">
                    {fact.source.title}
                  </a>
                </blockquote>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
