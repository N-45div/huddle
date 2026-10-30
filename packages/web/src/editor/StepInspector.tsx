import { useState } from "react";
import { Hint, TemplateHint } from "../components/bits.tsx";
import type { Assistant } from "../types.ts";
import { FEWEST_MEMBERS, type LinkHandle, type MemberContent, MOST_MEMBERS, type StepContent, type StepNode } from "./graph.ts";
import { KIND_LABEL } from "./nodes.tsx";

interface Props {
  readonly node: StepNode;
  readonly stepIds: readonly string[];
  readonly links: Partial<Record<LinkHandle, string>>;
  readonly assistants: readonly Assistant[];
  /** Slices named anywhere in the flow, offered when typing one. */
  readonly slices: readonly string[];
  readonly onChange: (content: StepContent) => void;
  /** Returns a reason when the new id can't be used. */
  readonly onRename: (to: string) => string | null;
  /** A together step's member renamed: returns a reason when the new id can't be used. */
  readonly onRenameMember: (from: string, to: string) => string | null;
  /** An id no step or member uses yet, for a together step's new member. */
  readonly newMemberId: () => string;
  readonly onLink: (handle: LinkHandle, target: string | null) => void;
  readonly onRemove: () => void;
  readonly onOpenAssistants: () => void;
}

export function StepInspector({ node, stepIds, links, assistants, slices, onChange, onRename, onRenameMember, newMemberId, onLink, onRemove, onOpenAssistants }: Props) {
  const content = node.data;

  return (
    <div className="inspector-section">
      <p className="eyebrow">{KIND_LABEL[content.type]} step</p>
      <StepIdField key={node.id} id={node.id} onRename={onRename} />

      {content.type === "together" && (
        <>
          <Hint>
            These assistants work at the same time, each on its own part, and the run goes on once all of them have answered. None sees another's answer. Later steps read each one's as{" "}
            <code>{`{{${content.members[0]?.id ?? "part"}.text}}`}</code>, and all of them, by name, as <code>{`{{${node.id}.text}}`}</code>.
          </Hint>
          {assistants.length === 0 && (
            <div className="note note-soft">
              <p>This flow has no assistants yet.</p>
              <button type="button" className="btn btn-sm" onClick={onOpenAssistants}>
                Add an assistant
              </button>
            </div>
          )}
          {content.members.map((member, index) => {
            const change = (changed: MemberContent) => onChange({ ...content, members: content.members.map((other) => (other.id === member.id ? changed : other)) });
            return (
              <fieldset key={member.id} className="member-part">
                <legend>Part {index + 1}</legend>
                <StepIdField id={member.id} inputId={`member-id-${index}`} label="Its id" onRename={(to) => onRenameMember(member.id, to)} />
                <div className="field">
                  <label htmlFor={`member-agent-${index}`}>Assistant</label>
                  <select id={`member-agent-${index}`} value={member.agent} onChange={(event) => change({ ...member, agent: event.target.value })}>
                    {!assistants.some((assistant) => assistant.id === member.agent) && <option value={member.agent}>{member.agent ? `"${member.agent}" (not in this flow)` : "Pick one"}</option>}
                    {assistants.map((assistant) => (
                      <option key={assistant.id} value={assistant.id}>
                        {assistant.name ? `${assistant.name} (${assistant.id})` : assistant.id}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`member-ask-${index}`}>Ask</label>
                  <textarea id={`member-ask-${index}`} rows={3} value={member.ask} onChange={(event) => change({ ...member, ask: event.target.value })} />
                </div>
                <div className="field">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={member.optional === true}
                      onChange={(event) => {
                        const { optional: _optional, ...rest } = member;
                        change(event.target.checked ? { ...rest, optional: true } : rest);
                      }}
                    />
                    The others go on if it can't answer
                  </label>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost danger-text"
                  disabled={content.members.length <= FEWEST_MEMBERS}
                  title={content.members.length <= FEWEST_MEMBERS ? `A together step needs at least ${FEWEST_MEMBERS}` : undefined}
                  onClick={() => onChange({ ...content, members: content.members.filter((other) => other.id !== member.id) })}
                >
                  Remove this part
                </button>
              </fieldset>
            );
          })}
          <button
            type="button"
            className="btn btn-sm"
            disabled={content.members.length >= MOST_MEMBERS}
            onClick={() => onChange({ ...content, members: [...content.members, { id: newMemberId(), agent: assistants[0]?.id ?? "", ask: "" }] })}
          >
            Add another part
          </button>
          <TemplateHint id="step-together-hint" />
          <LinkSelect id="step-next" label="Then" value={links.next} options={stepIds} self={node.id} endLabel="End the run" onChange={(target) => onLink("next", target)} />
        </>
      )}

      {content.type === "agent" && (
        <>
          <div className="field">
            <label htmlFor="step-agent">Assistant</label>
            {assistants.length === 0 ? (
              <div className="note note-soft">
                <p>This flow has no assistants yet.</p>
                <button type="button" className="btn btn-sm" onClick={onOpenAssistants}>
                  Add an assistant
                </button>
              </div>
            ) : (
              <select id="step-agent" value={content.agent} onChange={(event) => onChange({ ...content, agent: event.target.value })}>
                {!assistants.some((assistant) => assistant.id === content.agent) && <option value={content.agent}>{content.agent ? `"${content.agent}" (not in this flow)` : "Pick one"}</option>}
                {assistants.map((assistant) => (
                  <option key={assistant.id} value={assistant.id}>
                    {assistant.name ? `${assistant.name} (${assistant.id})` : assistant.id}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="field">
            <label htmlFor="step-ask">Ask</label>
            <textarea id="step-ask" rows={5} value={content.ask} aria-describedby="step-ask-hint" onChange={(event) => onChange({ ...content, ask: event.target.value })} />
            <TemplateHint id="step-ask-hint" />
          </div>
          <LinkSelect id="step-next" label="Then" value={links.next} options={stepIds} self={node.id} endLabel="End the run" onChange={(target) => onLink("next", target)} />
        </>
      )}

      {content.type === "condition" && (
        <>
          <div className="field">
            <label htmlFor="step-if">If</label>
            <input id="step-if" className="mono" value={content.if} aria-describedby="step-if-hint" onChange={(event) => onChange({ ...content, if: event.target.value })} />
            <Hint id="step-if-hint">
              Two values and one of <code>&gt;</code> <code>&lt;</code> <code>&gt;=</code> <code>&lt;=</code> <code>==</code> <code>!=</code> <code>contains</code>. Values can be templates like{" "}
              <code>{"{{stepId.data.field}}"}</code>.
            </Hint>
          </div>
          <LinkSelect id="step-then" label="If yes, go to" value={links.then} options={stepIds} self={node.id} endLabel="End the run" onChange={(target) => onLink("then", target)} />
          <LinkSelect id="step-else" label="If no, go to" value={links.else} options={stepIds} self={node.id} endLabel="End the run" onChange={(target) => onLink("else", target)} />
        </>
      )}

      {content.type === "approval" && (
        <>
          <div className="field">
            <label htmlFor="step-message">Question</label>
            <textarea id="step-message" rows={3} value={content.message} aria-describedby="step-message-hint" onChange={(event) => onChange({ ...content, message: event.target.value })} />
            <TemplateHint id="step-message-hint" />
          </div>
          <LinkSelect id="step-yes" label="If yes, go to" value={links.next} options={stepIds} self={node.id} endLabel="End the run" onChange={(target) => onLink("next", target)} />
          <LinkSelect
            id="step-no"
            label="If no, go to"
            value={links.onNo ?? (content.noFinishes ? FINISH : undefined)}
            options={stepIds}
            self={node.id}
            endLabel="End the run as declined"
            extra={{ value: FINISH, label: "End the run as done" }}
            onChange={(target) => {
              if (Boolean(content.noFinishes) !== (target === FINISH)) onChange({ ...content, noFinishes: target === FINISH });
              onLink("onNo", target === FINISH ? null : target);
            }}
          />
        </>
      )}

      {content.type === "pay" && (
        <>
          <Hint>
            The shop prices the cart, never an assistant. Your board shows the shop, each line and the total, and the run goes on only once you hold its button to sign; then the shop charges your PayPal saved
            there. Later steps read what was paid as <code>{`{{${node.id}.text}}`}</code>, and PayPal's order id as <code>{`{{${node.id}.data.paypal.orderId}}`}</code>.
          </Hint>
          <div className="field">
            <label htmlFor="step-shop">Shop</label>
            <select id="step-shop" value={content.shop} onChange={(event) => onChange({ ...content, shop: event.target.value })}>
              {!assistants.some((assistant) => assistant.id === content.shop && assistant.connector === "shop") && <option value={content.shop}>{content.shop ? `${content.shop} (not a shop)` : "Pick a shop"}</option>}
              {assistants
                .filter((assistant) => assistant.connector === "shop")
                .map((assistant) => (
                  <option key={assistant.id} value={assistant.id}>
                    {assistant.name || assistant.id}
                  </option>
                ))}
            </select>
            {!assistants.some((assistant) => assistant.connector === "shop") && (
              <div className="note note-soft">
                <p>
                  This flow has no shop yet: add an assistant with the Shop connector, like Bean & Leaf at <code>/shop</code>.
                </p>
                <button type="button" className="btn btn-sm" onClick={onOpenAssistants}>
                  Add a shop
                </button>
              </div>
            )}
          </div>
          <div className="field">
            <label htmlFor="step-cart">Cart</label>
            <textarea id="step-cart" className="mono" rows={3} value={content.cart} aria-describedby="step-cart-hint" onChange={(event) => onChange({ ...content, cart: event.target.value })} />
            <Hint id="step-cart-hint">
              What to buy, as JSON: <code>{'[{ "sku": "beans-house", "qty": 2 }]'}</code>, usually an earlier step's answer, like <code>{"{{pick.data}}"}</code>.
            </Hint>
          </div>
          <LinkSelect id="step-paid" label="Once paid, go to" value={links.next} options={stepIds} self={node.id} endLabel="End the run" onChange={(target) => onLink("next", target)} />
          <LinkSelect
            id="step-pay-no"
            label="If no, go to"
            value={links.onNo ?? (content.noFinishes ? FINISH : undefined)}
            options={stepIds}
            self={node.id}
            endLabel="End the run as declined"
            extra={{ value: FINISH, label: "End the run as done" }}
            onChange={(target) => {
              if (Boolean(content.noFinishes) !== (target === FINISH)) onChange({ ...content, noFinishes: target === FINISH });
              onLink("onNo", target === FINISH ? null : target);
            }}
          />
        </>
      )}

      {content.type === "memory" && (
        <>
          <div className="field">
            <label htmlFor="step-slice">Slice</label>
            <input id="step-slice" list="step-slices" value={content.slice} autoComplete="off" onChange={(event) => onChange({ ...content, slice: event.target.value })} />
            <datalist id="step-slices">
              {slices.map((slice) => (
                <option key={slice} value={slice} />
              ))}
            </datalist>
          </div>
          <div className="field">
            <label htmlFor="step-note">Note</label>
            <textarea id="step-note" rows={4} value={content.note} aria-describedby="step-note-hint" onChange={(event) => onChange({ ...content, note: event.target.value })} />
            <TemplateHint id="step-note-hint" />
            <Hint>It goes in as a suggestion; you keep it or discard it in Memory.</Hint>
          </div>
          <LinkSelect id="step-next" label="Then" value={links.next} options={stepIds} self={node.id} endLabel="End the run" onChange={(target) => onLink("next", target)} />
        </>
      )}

      <div className="inspector-foot">
        <button type="button" className="btn btn-sm btn-ghost danger-text" onClick={onRemove}>
          Remove this step
        </button>
      </div>
    </div>
  );
}

function StepIdField({ id, onRename, inputId = "step-id", label = "Step id" }: { readonly id: string; readonly onRename: (to: string) => string | null; readonly inputId?: string; readonly label?: string }) {
  const [draft, setDraft] = useState(id);
  const [error, setError] = useState<string | null>(null);
  const hintId = `${inputId}-hint`;

  const apply = () => {
    const next = draft.trim();
    if (next === id) {
      setError(null);
      return;
    }
    const problem = onRename(next);
    setError(problem);
  };

  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        className="mono"
        value={draft}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={hintId}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onBlur={apply}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            apply();
          } else if (event.key === "Escape") {
            setDraft(id);
            setError(null);
          }
        }}
      />
      {error ? (
        <p className="error-text" id={hintId} role="alert">
          {error}
        </p>
      ) : (
        <Hint id={hintId}>
          Later steps read its answer as <code>{`{{${id}.text}}`}</code>. Renaming updates those references.
        </Hint>
      )}
    </div>
  );
}

/** The "no" choice that finishes the run as done (onNo: "end"); not a step id, since ids can't start with "_". */
const FINISH = "__finish";

function LinkSelect({
  id,
  label,
  value,
  options,
  endLabel,
  extra,
  onChange,
  self,
}: {
  readonly extra?: { readonly value: string; readonly label: string };
  readonly self: string;
  readonly id: string;
  readonly label: string;
  readonly value: string | undefined;
  readonly options: readonly string[];
  readonly endLabel: string;
  readonly onChange: (target: string | null) => void;
}) {
  return (
    <div className="field field-link">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">{endLabel}</option>
        {extra && <option value={extra.value}>{extra.label}</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {option === self ? `${option} (this step again)` : option}
          </option>
        ))}
      </select>
    </div>
  );
}
