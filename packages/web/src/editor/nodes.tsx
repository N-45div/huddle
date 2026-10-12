import { Handle, type NodeProps, type NodeTypes, Position } from "@xyflow/react";
import { createContext, memo, useContext } from "react";
import { triggerSummary } from "../format.ts";
import { STEP_STATE_LABEL, type StepRunState } from "../run-state.ts";
import type { Assistant, StepType, Trigger } from "../types.ts";
import { isIncomplete, type StartNode, type StepNode } from "./graph.ts";
import { Huddler } from "../huddlers/Huddler.tsx";

/** What nodes need from the editor without copying it into every node's data. */
export interface EditorView {
  readonly assistants: ReadonlyMap<string, Assistant>;
  readonly assistantList: readonly Assistant[];
  readonly runStates: Readonly<Record<string, StepRunState>>;
  readonly trigger: Trigger;
}

export const EditorContext = createContext<EditorView>({ assistants: new Map(), assistantList: [], runStates: {}, trigger: { type: "manual" } });

export const KIND_LABEL: Record<StepType, string> = {
  agent: "Assistant",
  condition: "Condition",
  approval: "Approval",
  memory: "Memory",
};

function Missing({ children }: { readonly children: string }) {
  return <span className="missing">{children}</span>;
}

function OutHandles({ type }: { readonly type: StepType }) {
  if (type === "condition" || type === "approval") {
    const [left, right] = type === "condition" ? (["then", "else"] as const) : (["next", "onNo"] as const);
    return (
      <>
        <div className="node-outs" aria-hidden="true">
          <span>yes</span>
          <span>no</span>
        </div>
        <Handle type="source" position={Position.Bottom} id={left} className="handle-out handle-yes" style={{ left: "25%" }} />
        <Handle type="source" position={Position.Bottom} id={right} className="handle-out handle-no" style={{ left: "75%" }} />
      </>
    );
  }
  return <Handle type="source" position={Position.Bottom} id="next" className="handle-out" />;
}

export const StepNodeView = memo(function StepNodeView({ id, data, selected }: NodeProps<StepNode>) {
  const { assistants, assistantList, runStates } = useContext(EditorContext);
  const state = runStates[id];
  const incomplete = isIncomplete(data, assistantList);
  const classes = ["step-node", `kind-${data.type}`, selected ? "is-selected" : "", state ? `run-${state}` : "", incomplete ? "is-incomplete" : ""].filter(Boolean).join(" ");

  let body;
  switch (data.type) {
    case "agent": {
      const assistant = assistants.get(data.agent);
      body = (
        <>
          <p className="node-line">
            {assistant && <Huddler id={assistant.id} connector={assistant.connector} size={22} mood={state === "current" ? "thinking" : state === "waiting" ? "waiting" : state === "failed" ? "oops" : state === "done" ? "happy" : "idle"} />}
            {assistant ? <strong>{assistant.name || assistant.id}</strong> : data.agent ? <Missing>{`No assistant "${data.agent}"`}</Missing> : <Missing>Pick an assistant</Missing>}
          </p>
          <p className="node-text">{data.ask || <Missing>No ask yet</Missing>}</p>
        </>
      );
      break;
    }
    case "condition":
      body = <p className="node-text mono">{data.if || <Missing>No condition yet</Missing>}</p>;
      break;
    case "approval":
      body = <p className="node-text">{data.message || <Missing>No question yet</Missing>}</p>;
      break;
    case "memory":
      body = (
        <>
          <p className="node-line">Suggests to {data.slice ? <span className="chip chip-static">{data.slice}</span> : <Missing>a slice</Missing>}</p>
          <p className="node-text">{data.note || <Missing>No note yet</Missing>}</p>
        </>
      );
      break;
  }

  return (
    <div className={classes}>
      <Handle type="target" position={Position.Top} id="in" className="handle-in" />
      <div className="node-head">
        <span className="node-kind">{KIND_LABEL[data.type]}</span>
        <span className="node-id">{id}</span>
        {state && <span className={`node-state state-${state}`}>{STEP_STATE_LABEL[state]}</span>}
      </div>
      <div className="node-body">{body}</div>
      <OutHandles type={data.type} />
    </div>
  );
});

export const StartNodeView = memo(function StartNodeView({ selected }: NodeProps<StartNode>) {
  const { trigger } = useContext(EditorContext);
  return (
    <div className={selected ? "start-node is-selected" : "start-node"}>
      <span className="start-dot" aria-hidden="true" />
      <span>
        Starts: <strong>{triggerSummary(trigger)}</strong>
      </span>
      <Handle type="source" position={Position.Bottom} id="next" className="handle-out" />
    </div>
  );
});

export const nodeTypes: NodeTypes = { step: StepNodeView, start: StartNodeView };
