import { useState } from "react";
import { ApiFailure, api, describeError } from "../api.ts";
import { useApp } from "../app-context.ts";
import { ErrorNote, Hint, Icon, Loading } from "../components/bits.tsx";
import { useChanges } from "../events.ts";
import { ago } from "../format.ts";
import { useDebounced, useResource } from "../hooks.ts";
import type { Contact, ContactTier } from "../types.ts";

export const TIER_LABELS: Readonly<Record<ContactTier, string>> = { partner: "Partner", family: "Family", friend: "Friend", contact: "Contact" };
/** Closest first, as the tiers go. */
export const TIER_ORDER: readonly ContactTier[] = ["partner", "family", "friend", "contact"];

/**
 * People (and their agents) who may reach your flows. Each has a tier, closest first, and a token of
 * their own: their agent sends it, Huddle knows who's asking, and each flow decides whether that tier
 * starts it at once or waits for your OK.
 */
export function ContactsScreen() {
  const { authVersion } = useApp();
  const contacts = useResource(() => api.contacts(), [authVersion]);
  const refetch = useDebounced(() => void contacts.reload(), 200);
  useChanges((change) => {
    if (change.kind === "contacts" || change.kind === "resync") refetch();
  });
  const [fresh, setFresh] = useState<{ readonly name: string; readonly token: string } | null>(null);
  const [error, setError] = useState<{ message: string; problems: readonly string[] } | null>(null);

  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      await contacts.reload();
    } catch (caught) {
      setError({ message: describeError(caught), problems: caught instanceof ApiFailure ? caught.problems : [] });
    }
  };

  return (
    <div className="page page-narrow contacts-page">
      <header className="page-head">
        <div>
          <h1>Contacts</h1>
          <p className="lede">People and their agents who may start your flows. Each gets a token of their own, so Huddle knows who's asking; each flow decides who starts it at once and who waits for your OK.</p>
        </div>
      </header>

      {error && <ErrorNote message={error.message} problems={error.problems} />}
      {fresh && (
        <section className="card token-card" aria-live="polite">
          <p className="eyebrow">{fresh.name}'s token</p>
          <TokenRow token={fresh.token} />
          <Hint>
            Copy it now: Huddle keeps only a fingerprint and can't show it again. Their agent sends it as <code>Authorization: Bearer …</code> to a flow's A2A address.
          </Hint>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFresh(null)}>
            Done
          </button>
        </section>
      )}

      <AddContact
        onAdd={(name, tier, emails) =>
          act(async () => {
            const created = await api.addContact(name, tier, emails);
            setFresh({ name: created.contact.name, token: created.token });
          })
        }
      />

      {contacts.loading && !contacts.data ? (
        <Loading label="Loading your contacts…" />
      ) : contacts.error ? (
        <ErrorNote message={contacts.error} onRetry={() => void contacts.reload()} />
      ) : (contacts.data ?? []).length === 0 ? (
        <p className="hint">Nobody yet. Add the people whose agents should be able to reach you, closest first.</p>
      ) : (
        <ul className="contact-list">
          {(contacts.data ?? []).map((contact) => (
            <ContactRow
              key={contact.id}
              contact={contact}
              onTier={(tier) => act(() => api.updateContact(contact.id, { tier }))}
              onNewToken={() =>
                act(async () => {
                  const { token } = await api.newContactToken(contact.id);
                  setFresh({ name: contact.name, token });
                })
              }
              onRemove={() => act(() => api.removeContact(contact.id))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AddContact({ onAdd }: { readonly onAdd: (name: string, tier: ContactTier, emails: string[]) => Promise<void> }) {
  const [name, setName] = useState("");
  const [tier, setTier] = useState<ContactTier>("friend");
  const [emails, setEmails] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="card add-contact"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim() || busy) return;
        setBusy(true);
        const list = emails
          .split(/[\s,]+/)
          .map((email) => email.trim())
          .filter(Boolean);
        void onAdd(name.trim(), tier, list).finally(() => {
          setBusy(false);
          setName("");
          setEmails("");
        });
      }}
    >
      <h2>Add someone</h2>
      <div className="contact-fields">
        <div className="field">
          <label htmlFor="contact-name">Name</label>
          <input id="contact-name" value={name} maxLength={80} autoComplete="off" placeholder="Asha" onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="contact-tier">How close</label>
          <select id="contact-tier" value={tier} onChange={(event) => setTier(event.target.value as ContactTier)}>
            {TIER_ORDER.map((value) => (
              <option key={value} value={value}>
                {TIER_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="contact-emails">Their email addresses (optional)</label>
        <input id="contact-emails" value={emails} placeholder="asha@example.com" aria-describedby="contact-emails-hint" onChange={(event) => setEmails(event.target.value)} />
        <Hint id="contact-emails-hint">So mail from them counts as them, once flows start from email.</Hint>
      </div>
      <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
        <Icon name="plus" /> Add and make a token
      </button>
    </form>
  );
}

function ContactRow({ contact, onTier, onNewToken, onRemove }: { readonly contact: Contact; readonly onTier: (tier: ContactTier) => void; readonly onNewToken: () => void; readonly onRemove: () => void }) {
  const [removing, setRemoving] = useState(false);
  return (
    <li className="card contact-card">
      <div className="contact-head">
        <div className="contact-who">
          <span className={`tier-badge tier-${contact.tier}`}>{TIER_LABELS[contact.tier]}</span>
          <span className="contact-name">{contact.name}</span>
        </div>
        <select aria-label={`How close ${contact.name} is`} value={contact.tier} onChange={(event) => onTier(event.target.value as ContactTier)}>
          {TIER_ORDER.map((value) => (
            <option key={value} value={value}>
              {TIER_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      <p className="hint">
        {contact.emails.length ? contact.emails.join(", ") : "No email addresses"} · {contact.lastSeenAt ? `last reached Huddle ${ago(contact.lastSeenAt)}` : "hasn't reached Huddle yet"}
      </p>
      <div className="contact-actions">
        <button type="button" className="btn btn-sm" onClick={onNewToken}>
          New token
        </button>
        {removing ? (
          <>
            <span className="hint">Remove {contact.name}? Their token stops working.</span>
            <button type="button" className="btn btn-sm btn-danger-solid" onClick={onRemove}>
              Remove
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRemoving(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRemoving(true)}>
            Remove
          </button>
        )}
      </div>
    </li>
  );
}

function TokenRow({ token }: { readonly token: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-row">
      <input readOnly value={token} aria-label="Token" className="mono" onFocus={(event) => event.currentTarget.select()} />
      <button
        type="button"
        className="btn btn-sm"
        onClick={() =>
          void navigator.clipboard?.writeText(token).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          })
        }
      >
        <Icon name="copy" /> {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
