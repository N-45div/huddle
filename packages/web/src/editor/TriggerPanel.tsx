import { type ReactNode, useRef, useState } from "react";
import { api } from "../api.ts";
import { ConfirmDialog } from "../components/Dialog.tsx";
import { Hint, Icon } from "../components/bits.tsx";
import { EVERY_PATTERN, type FlowView, type Trigger } from "../types.ts";

interface Props {
  readonly flowId: string;
  readonly trigger: Trigger;
  readonly savedTrigger: Trigger | undefined;
  readonly webhookUrl: string;
  readonly a2aUrl: string;
  readonly stepIds: readonly string[];
  readonly firstStep: string | undefined;
  readonly onChange: (trigger: Trigger) => void;
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

export function TriggerPanel({ flowId, trigger, savedTrigger, webhookUrl, a2aUrl, stepIds, firstStep, onChange, onFirstStep, onRotated }: Props) {
  const [lastEvery, setLastEvery] = useState(trigger.type === "schedule" ? trigger.every : "1d");
  const changed = JSON.stringify(trigger) !== JSON.stringify(savedTrigger ?? { type: "manual" });

  const pick = (type: Trigger["type"]) => {
    if (type === trigger.type) return;
    if (trigger.type === "schedule") setLastEvery(trigger.every);
    if (type === "schedule") onChange({ type, every: lastEvery, input: "" });
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
        </div>
      </fieldset>

      {trigger.type === "schedule" && (
        <>
          <div className="field">
            <label htmlFor="trigger-every">Every</label>
            <input
              id="trigger-every"
              className="mono input-short"
              value={trigger.every}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={EVERY_PATTERN.test(trigger.every) ? undefined : true}
              aria-describedby="trigger-every-hint"
              onChange={(event) => onChange({ ...trigger, every: event.target.value.trim() })}
            />
            {EVERY_PATTERN.test(trigger.every) ? (
              <Hint id="trigger-every-hint">A number and m, h or d: 15m, 2h, 1d. At least a minute.</Hint>
            ) : (
              <p className="error-text" id="trigger-every-hint">
                Use a number and m, h or d, like 15m, 2h or 1d.
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor="trigger-input">Input for each run</label>
            <textarea id="trigger-input" rows={3} value={trigger.input} aria-describedby="trigger-input-hint" onChange={(event) => onChange({ ...trigger, input: event.target.value })} />
            <Hint id="trigger-input-hint">
              Steps read it as <code>{"{{input}}"}</code>.
            </Hint>
          </div>
        </>
      )}

      {trigger.type === "webhook" && <WebhookAddress flowId={flowId} webhookUrl={webhookUrl} onRotated={onRotated} />}

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
        Give this address to OpenClaw, Hermes or any A2A assistant, with Huddle's A2A token, and it can start this flow
        whatever its trigger. What it sends becomes the input.
      </CopyAddress>
    </div>
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
