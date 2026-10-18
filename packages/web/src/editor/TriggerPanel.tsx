import { type ReactNode, useRef, useState } from "react";
import { api } from "../api.ts";
import { ConfirmDialog } from "../components/Dialog.tsx";
import { Hint, Icon } from "../components/bits.tsx";
import { href } from "../router.ts";
import { TIER_LABELS, TIER_ORDER } from "../screens/ContactsScreen.tsx";
import { type Callers, EMAIL_PATTERN, EVERY_PATTERN, type FlowView, type Info, type Trigger } from "../types.ts";

interface Props {
  readonly flowId: string;
  readonly trigger: Trigger;
  readonly savedTrigger: Trigger | undefined;
  /** When the saved schedule runs next, if it's at a time of day. */
  readonly nextRunAt?: string | null;
  readonly webhookUrl: string;
  readonly a2aUrl: string;
  /** Huddle's MCP address and token (from /api/info), and the tool that starts this flow there. */
  readonly mcp: Info["mcp"] | undefined;
  readonly mcpTool: string;
  /** Where Resend's inbound webhook posts, and whether this Huddle can take mail (from /api/info). */
  readonly email: Info["email"] | undefined;
  readonly stepIds: readonly string[];
  readonly firstStep: string | undefined;
  readonly onChange: (trigger: Trigger) => void;
  readonly callers: Callers | undefined;
  readonly onCallers: (callers: Callers) => void;
  readonly onFirstStep: (stepId: string | null) => void;
  readonly onRotated: (view: FlowView) => void;
}

/** The webhook address as a full URL, whether the server sent a path or a whole address. */
function absolute(address: string): string {
  try {
    return new URL(address, window.location.href).toString();
  } catch {
    return address;
  }
}

export function TriggerPanel({ flowId, trigger, savedTrigger, nextRunAt, webhookUrl, a2aUrl, mcp, mcpTool, email, stepIds, firstStep, onChange, callers, onCallers, onFirstStep, onRotated }: Props) {
  const [lastEvery, setLastEvery] = useState((trigger.type === "schedule" && trigger.every) || "1d");
  const [lastAddress, setLastAddress] = useState(trigger.type === "email" ? trigger.address : "");
  const changed = JSON.stringify(trigger) !== JSON.stringify(savedTrigger ?? { type: "manual" });

  const pick = (type: Trigger["type"]) => {
    if (type === trigger.type) return;
    if (trigger.type === "schedule" && trigger.every) setLastEvery(trigger.every);
    if (trigger.type === "email") setLastAddress(trigger.address);
    if (type === "schedule") onChange({ type, every: lastEvery, input: "" });
    else if (type === "email") onChange({ type, address: lastAddress });
    else if (type === "button") onChange({ type, input: "" });
    else onChange({ type });
  };

  return (
    <div className="inspector-section">
      <fieldset className="field">
        <legend>How it starts</legend>
        <div className="radio-list">
          <Radio name="trigger" value="manual" checked={trigger.type === "manual"} onPick={pick} label="When I press Run" />
          <Radio name="trigger" value="schedule" checked={trigger.type === "schedule"} onPick={pick} label="On a schedule" />
          <Radio name="trigger" value="webhook" checked={trigger.type === "webhook"} onPick={pick} label="When something posts to its address" />
          <Radio name="trigger" value="email" checked={trigger.type === "email"} onPick={pick} label="When an email arrives" />
          <Radio name="trigger" value="button" checked={trigger.type === "button"} onPick={pick} label="From my Huddle button" />
        </div>
      </fieldset>

      {trigger.type === "schedule" && (
        <>
          <ScheduleWhen trigger={trigger} lastEvery={lastEvery} onEvery={setLastEvery} onChange={onChange} />
          {!changed && nextRunAt && (
            <p className="hint">
              Next run: <time dateTime={nextRunAt}>{new Date(nextRunAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time> (your time)
            </p>
          )}
          <div className="field">
            <label htmlFor="trigger-input">Input for each run</label>
            <textarea id="trigger-input" rows={3} value={trigger.input} aria-describedby="trigger-input-hint" onChange={(event) => onChange({ ...trigger, input: event.target.value })} />
            <Hint id="trigger-input-hint">
              Steps read it as <code>{"{{input}}"}</code>.
            </Hint>
          </div>
        </>
      )}

      {trigger.type === "button" && (
        <div className="field">
          <label htmlFor="trigger-button-input">Input when you just press it</label>
          <textarea id="trigger-button-input" rows={2} value={trigger.input} aria-describedby="trigger-button-hint" onChange={(event) => onChange({ ...trigger, input: event.target.value })} />
          <Hint id="trigger-button-hint">
            It shows on your Huddle button (and the virtual one in Devices) to pick and start. What you say holding the button is the input instead; steps read it as <code>{"{{input}}"}</code>.
          </Hint>
        </div>
      )}

      {trigger.type === "webhook" && <WebhookAddress flowId={flowId} webhookUrl={webhookUrl} onRotated={onRotated} />}

      {trigger.type === "email" && (
        <>
          <div className="field">
            <label htmlFor="trigger-address">Mail to</label>
            <input
              id="trigger-address"
              className="mono"
              type="email"
              value={trigger.address}
              placeholder="inbox@yourdomain.com"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={trigger.address && !EMAIL_PATTERN.test(trigger.address) ? true : undefined}
              aria-describedby="trigger-address-hint"
              onChange={(event) => onChange({ ...trigger, address: event.target.value.trim() })}
            />
            {EMAIL_PATTERN.test(trigger.address) || !trigger.address ? (
              <Hint id="trigger-address-hint">
                An address Resend receives mail for: one at your own domain, or at the <code>{"<id>.resend.app"}</code> domain Resend gives you. The email (from,
                to, subject and message) becomes the input.
              </Hint>
            ) : (
              <p className="error-text" id="trigger-address-hint">
                That isn't an email address.
              </p>
            )}
          </div>
          <CopyAddress id="email-hook" label="Resend's inbound webhook" address={absolute(email?.hook ?? "/hooks/email")}>
            In Resend, add a webhook for <code>email.received</code> pointing here, then set its signing secret as <code>RESEND_WEBHOOK_SECRET</code> and a
            full-access key as <code>RESEND_API_KEY</code> where Huddle runs. Mail from you counts as you once your addresses are in{" "}
            <code>HUDDLE_OWNER_EMAILS</code>; other senders follow "Who can start it from outside" below.
          </CopyAddress>
          {email && !email.receiving && <p className="note note-warn">This Huddle can't take mail yet: set RESEND_WEBHOOK_SECRET and RESEND_API_KEY, then restart it.</p>}
        </>
      )}

      {changed && <p className="note note-soft">Save the flow to put this into effect.</p>}

      <div className="field">
        <label htmlFor="trigger-first">First step</label>
        <select id="trigger-first" value={firstStep ?? ""} onChange={(event) => onFirstStep(event.target.value || null)}>
          {!firstStep && <option value="">The first one on the canvas</option>}
          {stepIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <Hint>Or drag from the start marker on the canvas to a step.</Hint>
      </div>

      <CopyAddress id="a2a-url" label="For your other assistants (A2A)" address={absolute(a2aUrl)}>
        Give this address to OpenClaw, Hermes or any A2A assistant, with Huddle's A2A token or a contact's own token, and it
        can start this flow whatever its trigger. What it sends becomes the input.
      </CopyAddress>

      {mcp && (
        <CopyAddress id="mcp-url" label="For Claude, Cursor and other MCP clients" address={absolute(mcp.url)}>
          Add this address as an MCP server{mcp.token ? <>, with <code>{mcp.token}</code> or a contact's own token,</> : ""} and this flow is its tool{" "}
          <code>{mcpTool}</code>, whatever its trigger. What the tool is given becomes the input. How to add it to each app is on the{" "}
          <a href={href.assistants()}>Assistants</a> page.
        </CopyAddress>
      )}

      <CallersFields callers={callers} onChange={onCallers} />
    </div>
  );
}

const DEFAULT_CALLERS: Callers = { starts: "owner", others: "ask", strangers: "refuse" };

/** Who may start the flow from outside: closer tiers at once, the rest after your OK, strangers only if you let them. */
function CallersFields({ callers, onChange }: { readonly callers: Callers | undefined; readonly onChange: (callers: Callers) => void }) {
  const rules = { ...DEFAULT_CALLERS, ...callers };
  return (
    <fieldset className="field callers">
      <legend>Who can start it from outside</legend>
      <div className="field">
        <label htmlFor="callers-starts">Starts at once for</label>
        <select id="callers-starts" value={rules.starts} onChange={(event) => onChange({ ...rules, starts: event.target.value as Callers["starts"] })}>
          <option value="owner">Only you</option>
          {TIER_ORDER.map((tier, index) => (
            <option key={tier} value={tier}>
              {index === 0 ? TIER_LABELS[tier] : `${TIER_LABELS[tier]} and closer`}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="callers-others">Contacts further away</label>
        <select id="callers-others" value={rules.others} onChange={(event) => onChange({ ...rules, others: event.target.value as Callers["others"] })}>
          <option value="ask">Ask me first</option>
          <option value="refuse">Turn them away</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="callers-strangers">People not in your contacts</label>
        <select id="callers-strangers" value={rules.strangers} onChange={(event) => onChange({ ...rules, strangers: event.target.value as Callers["strangers"] })}>
          <option value="refuse">Turn them away</option>
          <option value="ask">Ask me first</option>
        </select>
      </div>
      <Hint>
        A run you're asked about waits in Approvals, saying who sent it and what. Add people and their tokens in{" "}
        <a href={href.contacts()}>Contacts</a>.
      </Hint>
    </fieldset>
  );
}

/** A read-only address with a Copy button that falls back to selecting it. */
function CopyAddress({ id, label, address, children }: { readonly id: string; readonly label: string; readonly address: string; readonly children: ReactNode }) {
  const [copied, setCopied] = useState<"yes" | "manual" | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied("yes");
    } catch {
      input.current?.select();
      setCopied("manual");
    }
    window.setTimeout(() => setCopied(null), 2500);
  };

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="copy-row">
        <input id={id} ref={input} className="mono" readOnly value={address} onFocus={(event) => event.target.select()} aria-describedby={`${id}-hint`} />
        <button type="button" className="btn btn-sm" onClick={() => void copy()}>
          <Icon name="copy" /> {copied === "yes" ? "Copied" : "Copy"}
        </button>
      </div>
      {copied === "manual" && <p className="hint">Selected. Press Ctrl+C (or ⌘C) to copy.</p>}
      <Hint id={`${id}-hint`}>{children}</Hint>
    </div>
  );
}

type ScheduleTrigger = Extract<Trigger, { type: "schedule" }>;
const DAYS = [
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
  ["sun", "Sun"],
] as const;
type Day = (typeof DAYS)[number][0];
/** This browser's time zone, the starting point for a schedule at a time of day. */
const HERE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const ZONES: readonly string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
})();

/** When a schedule runs: every so often, or at a time of day on some days, by a time zone's clock. */
function ScheduleWhen({ trigger, lastEvery, onEvery, onChange }: { readonly trigger: ScheduleTrigger; readonly lastEvery: string; readonly onEvery: (every: string) => void; readonly onChange: (trigger: Trigger) => void }) {
  const atTime = Boolean(trigger.at);
  const days = new Set<Day>(trigger.on ?? DAYS.map(([day]) => day));
  const toggle = (day: Day) => {
    const next = new Set(days);
    if (next.has(day)) next.delete(day);
    else next.add(day);
    if (next.size === 0) return;
    const on = DAYS.map(([d]) => d).filter((d) => next.has(d));
    const { on: _on, ...rest } = trigger;
    onChange(on.length === 7 ? rest : { ...rest, on });
  };
  const every = trigger.every ?? "";
  return (
    <>
      <fieldset className="field">
        <legend>When</legend>
        <div className="radio-list">
          <div className="radio">
            <input type="radio" id="schedule-every" name="schedule-kind" checked={!atTime} onChange={() => onChange({ type: "schedule", every: lastEvery, input: trigger.input })} />
            <label htmlFor="schedule-every">Every so often</label>
          </div>
          <div className="radio">
            <input type="radio" id="schedule-at" name="schedule-kind" checked={atTime} onChange={() => { if (trigger.every) onEvery(trigger.every); onChange({ type: "schedule", at: "08:00", timezone: HERE, input: trigger.input }); }} />
            <label htmlFor="schedule-at">At a time of day</label>
          </div>
        </div>
      </fieldset>
      {atTime ? (
        <>
          <div className="field">
            <label htmlFor="trigger-at">At</label>
            <input id="trigger-at" type="time" className="input-short" value={trigger.at} onChange={(event) => event.target.value && onChange({ ...trigger, at: event.target.value })} />
          </div>
          <fieldset className="field">
            <legend>On</legend>
            <div className="day-toggles">
              {DAYS.map(([day, label]) => (
                <button key={day} type="button" className={days.has(day) ? "day-toggle on" : "day-toggle"} aria-pressed={days.has(day)} onClick={() => toggle(day)}>
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="field">
            <label htmlFor="trigger-timezone">By the clock in</label>
            <input id="trigger-timezone" className="mono" list="trigger-timezones" value={trigger.timezone ?? ""} placeholder={HERE} autoComplete="off" spellCheck={false} aria-describedby="trigger-timezone-hint" onChange={(event) => { const timezone = event.target.value.trim(); const { timezone: _tz, ...rest } = trigger; onChange(timezone ? { ...rest, timezone } : rest); }} />
            <datalist id="trigger-timezones">
              {ZONES.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            <Hint id="trigger-timezone-hint">A time zone like Asia/Kolkata. Left empty, the server's own clock.</Hint>
          </div>
        </>
      ) : (
        <div className="field">
          <label htmlFor="trigger-every">Every</label>
          <input
            id="trigger-every"
            className="mono input-short"
            value={every}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={EVERY_PATTERN.test(every) ? undefined : true}
            aria-describedby="trigger-every-hint"
            onChange={(event) => onChange({ ...trigger, every: event.target.value.trim() })}
          />
          {EVERY_PATTERN.test(every) ? (
            <Hint id="trigger-every-hint">A number and m, h or d: 15m, 2h, 1d. At least a minute.</Hint>
          ) : (
            <p className="error-text" id="trigger-every-hint">
              Use a number and m, h or d, like 15m, 2h or 1d.
            </p>
          )}
        </div>
      )}
    </>
  );
}

function Radio({ name, value, checked, label, onPick }: { readonly name: string; readonly value: Trigger["type"]; readonly checked: boolean; readonly label: string; readonly onPick: (value: Trigger["type"]) => void }) {
  const id = `${name}-${value}`;
  return (
    <div className="radio">
      <input type="radio" id={id} name={name} value={value} checked={checked} onChange={() => onPick(value)} />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

function WebhookAddress({ flowId, webhookUrl, onRotated }: { readonly flowId: string; readonly webhookUrl: string; readonly onRotated: (view: FlowView) => void }) {
  const [rotating, setRotating] = useState(false);

  return (
    <div className="field">
      <CopyAddress id="webhook-url" label="Its address" address={absolute(webhookUrl)}>
        Anything that POSTs here starts a run. The body becomes the input: plain text, or JSON <code>{'{ "input": "…" }'}</code>. Keep the address secret; it works like a password.
      </CopyAddress>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRotating(true)}>
        New address
      </button>

      <ConfirmDialog
        open={rotating}
        title="Make a new address?"
        confirmLabel="Make a new address"
        onCancel={() => setRotating(false)}
        onConfirm={async () => {
          onRotated(await api.rotateWebhook(flowId));
          setRotating(false);
        }}
      >
        <p>The current address stops working straight away. Anything posting to it will need the new one.</p>
      </ConfirmDialog>
    </div>
  );
}
