import {
  Background,
  type Connection,
  Controls,
  type Edge,
  type FitViewOptions,
  type Node,
  type OnSelectionChangeParams,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type XYPosition,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiFailure, api, describeError } from "../api.ts";
import { useApp } from "../app-context.ts";
import { ErrorNote, Icon, Link, Loading } from "../components/bits.tsx";
import { ConfirmDialog } from "../components/Dialog.tsx";
import { TabPanel, Tabs } from "../components/Tabs.tsx";
import { useChanges } from "../events.ts";
import { useDebounced, useResource } from "../hooks.ts";
import { href, replaceHash, useLeaveGuard } from "../router.ts";
import { stepStates } from "../run-state.ts";
import { type Assistant, type Flow, type FlowView, ID_PATTERN, type RunDetail, type StepType } from "../types.ts";
import { AssistantsPanel } from "./AssistantsPanel.tsx";
import { FlowPanel } from "./FlowPanel.tsx";
import {
  defaultContent,
  type EditorNode,
  flowToGraph,
  type Graph,
  graphToFlow,
  handleOf,
  isStepNode,
  layoutSteps,
  type LinkHandle,
  linkTarget,
  makeEdge,
  type Meta,
  NODE_WIDTH,
  renameInEdges,
  retargetContent,
  START_ID,
  startPosition,
  type StepContent,
  type StepNode,
  uniqueStepId,
} from "./graph.ts";
import { EditorContext, type EditorView, KIND_LABEL, nodeTypes } from "./nodes.tsx";
import { RunPanel } from "./RunPanel.tsx";
import { StepInspector } from "./StepInspector.tsx";
import { TriggerPanel } from "./TriggerPanel.tsx";

type PanelTab = "step" | "flow" | "assistants" | "trigger" | "run";

interface Notice {
  readonly tone: "ok" | "error";
  readonly message: string;
  readonly problems?: readonly string[];
}

type Confirming = { readonly kind: "discard" } | { readonly kind: "describe"; readonly flow: Flow };

const FIT: FitViewOptions<EditorNode> = { padding: 0.25, maxZoom: 1 };
const DELETE_KEYS = ["Backspace", "Delete"];
const STEP_TYPES: readonly StepType[] = ["agent", "condition", "approval", "memory"];
const EMPTY_META: Meta = { name: "", description: "", example: "", trigger: { type: "manual" }, assistants: [] };

function problemNotice(headline: string, caught: unknown): Notice {
  if (caught instanceof ApiFailure && caught.problems.length) return { tone: "error", message: caught.message || headline, problems: caught.problems };
  return { tone: "error", message: `${headline} ${describeError(caught)}` };
}

const serialize = (graph: Graph) => JSON.stringify(graphToFlow(graph.meta, graph.nodes, graph.edges));

export function FlowEditor(props: { readonly flowId: string; readonly openDescribe: boolean; readonly openRun: boolean }) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}

function Editor({ flowId, openDescribe, openRun }: { readonly flowId: string; readonly openDescribe: boolean; readonly openRun: boolean }) {
  const { info, authVersion } = useApp();
  const [view, setView] = useState<FlowView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [meta, setMeta] = useState<Meta>(EMPTY_META);
  const [nodes, setNodes, onNodesChange] = useNodesState<EditorNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [baseline, setBaseline] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<PanelTab>(openDescribe ? "flow" : openRun ? "run" : "step");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<"save" | "check" | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [watching, setWatching] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const connectors = useResource(() => api.connectors(), [authVersion]);
  const library = useResource(() => api.assistants(), [authVersion]);
  const { fitView, screenToFlowPosition } = useReactFlow<EditorNode, Edge>();
  const canvasRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);
  const [focusDescribe] = useState(openDescribe);

  // "?describe" and "?try" only open their tab once; drop them from the address.
  useEffect(() => {
    if (openDescribe || openRun) replaceHash(href.flow(flowId));
  }, [openDescribe, openRun, flowId]);

  const applyFlow = useCallback(
    (flow: Flow): Graph => {
      const graph = flowToGraph(flow);
      setMeta(graph.meta);
      setNodes(graph.nodes);
      setEdges(graph.edges);
      setSelectedId(null);
      return graph;
    },
    [setNodes, setEdges],
  );

  const refit = useCallback(() => {
    window.setTimeout(() => void fitView(FIT), 80);
  }, [fitView]);

  useEffect(() => {
    if (loaded.current) return;
    let cancelled = false;
    setLoadError(null);
    api.flow(flowId).then(
      (saved) => {
        if (cancelled) return;
        loaded.current = true;
        setView(saved);
        setBaseline(serialize(applyFlow(saved.flow)));
      },
      (caught: unknown) => {
        if (!cancelled) setLoadError(describeError(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [flowId, authVersion, attempt, applyFlow]);

  // What would be saved right now, and whether it differs from what is saved.
  const flow = useMemo(() => graphToFlow(meta, nodes, edges), [meta, nodes, edges]);
  const flowJson = useMemo(() => JSON.stringify(flow), [flow]);
  const dirty = view !== null && flowJson !== baseline;
  useLeaveGuard(dirty ? "Your changes to this flow aren't saved yet. Leave anyway and lose them?" : null);

  const stepNodes = useMemo(() => nodes.filter(isStepNode), [nodes]);
  const stepIds = useMemo(() => stepNodes.map((node) => node.id), [stepNodes]);
  const selected = selectedId ? stepNodes.find((node) => node.id === selectedId) : undefined;
  const firstStep = linkTarget(edges, START_ID, "next");

  const usage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of stepNodes) if (node.data.type === "agent") counts.set(node.data.agent, (counts.get(node.data.agent) ?? 0) + 1);
    return counts;
  }, [stepNodes]);

  const slices = useMemo(() => {
    const names = new Set<string>();
    for (const assistant of meta.assistants) for (const slice of assistant.memory) names.add(slice);
    for (const node of stepNodes) if (node.data.type === "memory" && node.data.slice.trim()) names.add(node.data.slice.trim());
    return [...names].sort();
  }, [meta.assistants, stepNodes]);

  const watchedRun = runDetail && runDetail.run.id === watching ? runDetail : null;
  const runStates = useMemo(() => (watchedRun ? stepStates(watchedRun.run) : {}), [watchedRun]);

  const editorView = useMemo<EditorView>(
    () => ({ assistants: new Map(meta.assistants.map((assistant) => [assistant.id, assistant])), assistantList: meta.assistants, runStates, trigger: meta.trigger }),
    [meta.assistants, meta.trigger, runStates],
  );

  // ---- Links ----

  const typeOf = useCallback(
    (id: string): StepType | "start" => {
      if (id === START_ID) return "start";
      const node = nodes.find((candidate) => candidate.id === id);
      return node && isStepNode(node) ? node.data.type : "agent";
    },
    [nodes],
  );

  /** Points one handle at a step, or at nothing (the end of the run). A handle has one link at most. */
  const setLink = useCallback(
    (source: string, handle: LinkHandle, target: string | null) => {
      const sourceType = typeOf(source);
      setEdges((current) => {
        const rest = current.filter((edge) => !(edge.source === source && handleOf(edge) === handle));
        return target ? [...rest, makeEdge(source, sourceType, handle, target)] : rest;
      });
    },
    [typeOf, setEdges],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      const handle = connection.sourceHandle === "then" || connection.sourceHandle === "else" || connection.sourceHandle === "onNo" ? connection.sourceHandle : "next";
      setLink(connection.source, handle, connection.target);
    },
    [setLink],
  );

  const isValidConnection = useCallback((connection: Edge | Connection) => connection.target !== START_ID, []);

  // Dragging a link's end to another step moves it; dropping it on empty canvas removes it.
  const reconnecting = useRef<string | null>(null);
  const onReconnectStart = useCallback((_: unknown, edge: Edge) => {
    reconnecting.current = edge.id;
  }, []);
  const onReconnect = useCallback(
    (old: Edge, connection: Connection) => {
      reconnecting.current = null;
      setEdges((current) => current.filter((edge) => edge.id !== old.id));
      onConnect(connection);
    },
    [setEdges, onConnect],
  );
  const onReconnectEnd = useCallback(() => {
    const id = reconnecting.current;
    reconnecting.current = null;
    if (id) setEdges((current) => current.filter((edge) => edge.id !== id));
  }, [setEdges]);

  // ---- Selection ----

  const onSelectionChange = useCallback(({ nodes: picked }: OnSelectionChangeParams) => {
    const only = picked.length === 1 ? picked[0] : undefined;
    setSelectedId(only && only.type === "step" ? only.id : null);
  }, []);

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    setTab(node.type === "start" ? "trigger" : "step");
  }, []);

  // ---- Steps ----

  const addStep = (type: StepType) => {
    const taken = new Set(nodes.map((node) => node.id));
    taken.add("end");
    const id = uniqueStepId(type, taken);
    const anchor = selected;
    let position: XYPosition;
    if (anchor) {
      position = { x: anchor.position.x, y: anchor.position.y + 170 };
    } else {
      const rect = canvasRef.current?.getBoundingClientRect();
      const center = rect ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 3 }) : { x: 0, y: 0 };
      position = { x: center.x - NODE_WIDTH / 2, y: center.y };
    }
    // Don't land on top of another step.
    for (let tries = 0; tries < 20 && nodes.some((node) => Math.abs(node.position.x - position.x) < 80 && Math.abs(node.position.y - position.y) < 60); tries += 1) {
      position = { x: position.x + 70, y: position.y + 40 };
    }
    const node: StepNode = { id, type: "step", position, data: defaultContent(type, meta.assistants), selected: true };
    const hadSteps = stepNodes.length > 0;
    setNodes((current) => [...current.map((other) => (other.selected ? { ...other, selected: false } : other)), node]);
    setEdges((current) => {
      let next = current;
      if (!hadSteps && !linkTarget(current, START_ID, "next")) next = [...next, makeEdge(START_ID, "start", "next", id)];
      // Carry on from the selected step when its way out is free.
      if (anchor && anchor.data.type !== "condition" && !linkTarget(current, anchor.id, "next")) next = [...next, makeEdge(anchor.id, anchor.data.type, "next", id)];
      return next;
    });
    setSelectedId(id);
    setTab("step");
  };

  const updateStep = (id: string, content: StepContent) => {
    setNodes((current) => current.map((node) => (node.id === id && isStepNode(node) ? { ...node, data: content } : node)));
  };

  const removeStep = (id: string) => {
    setNodes((current) => current.filter((node) => node.id !== id));
    setEdges((current) => {
      const wasFirst = linkTarget(current, START_ID, "next") === id;
      const after = linkTarget(current, id, "next") ?? linkTarget(current, id, "then");
      const rest = current.filter((edge) => edge.source !== id && edge.target !== id);
      // Removing the first step makes the one after it first.
      return wasFirst && after && after !== id ? [...rest, makeEdge(START_ID, "start", "next", after)] : rest;
    });
    setSelectedId(null);
  };

  const renameStep = (from: string, to: string): string | null => {
    if (from === to) return null;
    if (!ID_PATTERN.test(to)) return "Use letters, numbers, - and _ (up to 64), starting with a letter or number.";
    if (to === "end") return 'A link to "end" finishes the run, so a step can\'t be called that.';
    if (nodes.some((node) => node.id === to)) return `There's already a step called "${to}".`;
    setNodes((current) =>
      current.map((node) => {
        if (!isStepNode(node)) return node;
        return { ...node, id: node.id === from ? to : node.id, data: retargetContent(node.data, from, to) };
      }),
    );
    setEdges((current) => renameInEdges(current, from, to));
    setSelectedId(to);
    return null;
  };

  const changeAssistants = (assistants: Assistant[], renamed?: { readonly from: string; readonly to: string }) => {
    setMeta((current) => ({ ...current, assistants }));
    if (renamed) {
      setNodes((current) => current.map((node) => (isStepNode(node) && node.data.type === "agent" && node.data.agent === renamed.from ? { ...node, data: { ...node.data, agent: renamed.to } } : node)));
    }
  };

  const tidy = () => {
    const positions = layoutSteps(stepIds, edges);
    const first = firstStep ?? stepIds[0];
    setNodes((current) => current.map((node) => (node.type === "start" ? { ...node, position: startPosition(first ? positions[first] : undefined) } : { ...node, position: positions[node.id] ?? node.position })));
    refit();
  };

  // ---- Save, check, run ----

  const save = useCallback(async (): Promise<boolean> => {
    const sending = flow;
    const sendingJson = flowJson;
    setBusy("save");
    setNotice(null);
    try {
      const saved = await api.saveFlow(flowId, sending);
      setView(saved);
      setBaseline(sendingJson);
      return true;
    } catch (caught) {
      setNotice(problemNotice("Couldn't save.", caught));
      return false;
    } finally {
      setBusy(null);
    }
  }, [flow, flowJson, flowId]);

  const check = async () => {
    setBusy("check");
    setNotice(null);
    try {
      await api.checkFlow(flow);
      setNotice({ tone: "ok", message: "No problems found. This flow is ready to run." });
    } catch (caught) {
      setNotice(problemNotice("Couldn't check the flow.", caught));
    } finally {
      setBusy(null);
    }
  };

  const runFlow = async (input: string, images: readonly string[] = []) => {
    if (dirty && !(await save())) throw new Error("It couldn't be saved, so it didn't run. The problems are listed above the canvas.");
    const { runId } = await api.runFlow(flowId, input, images);
    setWatching(runId);
  };

  // Ctrl+S / ⌘S saves.
  const saveRef = useRef(save);
  const canSave = dirty && busy === null;
  const canSaveRef = useRef(canSave);
  useEffect(() => {
    saveRef.current = save;
    canSaveRef.current = canSave;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (canSaveRef.current) void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A "No problems" note fades on its own; problems stay until dismissed.
  useEffect(() => {
    if (notice?.tone !== "ok") return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // ---- Watching a run ----

  const watchingRef = useRef<string | null>(null);
  useEffect(() => {
    watchingRef.current = watching;
  }, [watching]);

  const loadRun = useCallback(async (runId: string) => {
    try {
      const detail = await api.run(runId);
      if (watchingRef.current === runId) {
        setRunDetail(detail);
        setRunError(null);
      }
    } catch (caught) {
      if (watchingRef.current === runId) setRunError(describeError(caught));
    }
  }, []);

  useEffect(() => {
    setRunDetail(null);
    setRunError(null);
    if (watching) void loadRun(watching);
  }, [watching, loadRun]);

  const refetchRun = useDebounced(() => {
    const id = watchingRef.current;
    if (id) void loadRun(id);
  }, 120);

  useChanges((change) => {
    if (change.kind === "resync") refetchRun();
    else if ((change.kind === "run" || change.kind === "approval") && change.runId === watchingRef.current) refetchRun();
  });

  // ---- Describe it, discard ----

  const loadDescribed = (described: Flow) => {
    applyFlow(described);
    setNotice({ tone: "ok", message: "Here's a first draft from your sentence. Look it over, then Save." });
    refit();
  };

  const discard = () => {
    if (!view) return;
    setBaseline(serialize(applyFlow(view.flow)));
    setNotice(null);
    refit();
  };

  // ---- Render ----

  if (!view) {
    return (
      <div className="page">
        <Link to={href.flows()} className="back-link">
          <Icon name="back" /> Flows
        </Link>
        {loadError ? <ErrorNote message={loadError} onRetry={() => setAttempt((count) => count + 1)} /> : <Loading label="Opening the flow…" />}
      </div>
    );
  }

  const live = watchedRun && (watchedRun.run.state === "running" || watchedRun.run.state === "waiting");

  return (
    <div className="editor">
      <div className="editor-bar">
        <Link to={href.flows()} className="icon-btn" aria-label="Back to flows">
          <Icon name="back" />
        </Link>
        <label htmlFor="flow-name" className="visually-hidden">
          Flow name
        </label>
        <input id="flow-name" className="name-input" value={meta.name} autoComplete="off" onChange={(event) => setMeta((current) => ({ ...current, name: event.target.value }))} />
        <span className={dirty ? "save-state is-dirty" : "save-state"} role="status">
          {dirty ? "Unsaved changes" : "All changes saved"}
        </span>
        <div className="bar-actions">
          {dirty && (
            <button type="button" className="btn btn-ghost" onClick={() => setConfirming({ kind: "discard" })}>
              Discard
            </button>
          )}
          <button type="button" className="btn" onClick={() => void check()} disabled={busy !== null}>
            {busy === "check" ? "Checking…" : "Check"}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!dirty || busy !== null} title="Save (Ctrl+S)">
            {busy === "save" ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {notice && (
        <div className={`editor-notice tone-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
          <div>
            <p>{notice.message}</p>
            {notice.problems && notice.problems.length > 0 && (
              <ul className="problem-list">
                {notice.problems.map((problem, index) => (
                  <li key={index}>{problem}</li>
                ))}
              </ul>
            )}
          </div>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setNotice(null)}>
            <Icon name="close" />
          </button>
        </div>
      )}

      <div className="editor-body">
        <section className="canvas" ref={canvasRef} aria-label="Flow canvas">
          <EditorContext.Provider value={editorView}>
            <ReactFlow<EditorNode, Edge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onReconnectStart={onReconnectStart}
              onReconnect={onReconnect}
              onReconnectEnd={onReconnectEnd}
              onSelectionChange={onSelectionChange}
              onNodeClick={onNodeClick}
              deleteKeyCode={DELETE_KEYS}
              fitView
              fitViewOptions={FIT}
              minZoom={0.25}
              maxZoom={1.75}
            >
              <Background gap={22} size={1.4} />
              <Controls showInteractive={false} position="bottom-left" />
              <Panel position="top-left" className="palette" aria-label="Add a step">
                <span className="palette-title">Add a step</span>
                {STEP_TYPES.map((type) => (
                  <button key={type} type="button" className={`palette-btn kind-${type}`} onClick={() => addStep(type)}>
                    <span className="kind-dot" aria-hidden="true" />
                    {KIND_LABEL[type]}
                  </button>
                ))}
                <button type="button" className="palette-btn palette-tidy" onClick={tidy} disabled={stepNodes.length === 0}>
                  Tidy up
                </button>
              </Panel>
              <Panel position="bottom-right" className="canvas-help">
                Drag from a step's bottom dot to another step to link them. Select a link and press Delete to remove it.
              </Panel>
              {stepNodes.length === 0 && (
                <Panel position="top-center" className="canvas-empty">
                  No steps yet. Add one{info?.describe ? ", or describe the flow in the Flow tab" : ""}.
                </Panel>
              )}
            </ReactFlow>
          </EditorContext.Provider>
        </section>

        <aside className="inspector" aria-label="Flow settings">
          <Tabs
            idPrefix="editor"
            label="Flow settings"
            className="inspector-tabs"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "step", label: "Step" },
              { id: "flow", label: "Flow" },
              { id: "assistants", label: "Assistants" },
              { id: "trigger", label: "Trigger" },
              {
                id: "run",
                label: (
                  <>
                    Run{live && <span className="live-dot" aria-label="a run is going" />}
                  </>
                ),
              },
            ]}
          />
          <TabPanel idPrefix="editor" id={tab} className="inspector-body">
            {tab === "step" &&
              (selected ? (
                <StepInspector
                  node={selected}
                  stepIds={stepIds}
                  links={{
                    next: linkTarget(edges, selected.id, "next"),
                    then: linkTarget(edges, selected.id, "then"),
                    else: linkTarget(edges, selected.id, "else"),
                    onNo: linkTarget(edges, selected.id, "onNo"),
                  }}
                  assistants={meta.assistants}
                  slices={slices}
                  onChange={(content) => updateStep(selected.id, content)}
                  onRename={(to) => renameStep(selected.id, to)}
                  onLink={(handle, target) => setLink(selected.id, handle, target)}
                  onRemove={() => removeStep(selected.id)}
                  onOpenAssistants={() => setTab("assistants")}
                />
              ) : (
                <div className="empty empty-small">
                  <p className="empty-title">Pick a step on the canvas to edit it.</p>
                  <p className="hint">Or add one with the buttons at the top left of the canvas.</p>
                </div>
              ))}
            {tab === "flow" && (
              <FlowPanel
                view={view}
                description={meta.description}
                onDescription={(description) => setMeta((current) => ({ ...current, description }))}
                example={meta.example}
                onExample={(example) => setMeta((current) => ({ ...current, example }))}
                learn={meta.learn !== false}
                onLearn={(learn) => setMeta(({ learn: _learn, ...current }) => (learn ? current : { ...current, learn: false }))}
                canDescribe={info?.describe ?? false}
                focusDescribe={focusDescribe}
                onDescribed={(described) => (dirty ? setConfirming({ kind: "describe", flow: described }) : loadDescribed(described))}
              />
            )}
            {tab === "assistants" && <AssistantsPanel assistants={meta.assistants} connectors={connectors} usage={usage} slices={slices} onChange={changeAssistants} library={library.data ?? []} />}
            {tab === "trigger" && (
              <TriggerPanel
                flowId={flowId}
                trigger={meta.trigger}
                savedTrigger={view.flow.trigger}
                nextRunAt={view.nextRunAt}
                webhookUrl={view.webhookUrl}
                a2aUrl={view.a2aUrl}
                mcp={info?.mcp}
                mcpTool={view.mcpTool}
                email={info?.email}
                stepIds={stepIds}
                firstStep={firstStep}
                onChange={(trigger) => setMeta((current) => ({ ...current, trigger }))}
                callers={meta.callers}
                onCallers={(callers) => setMeta((current) => ({ ...current, callers }))}
                onFirstStep={(stepId) => setLink(START_ID, "next", stepId)}
                onRotated={(rotated) => setView((current) => (current ? { ...current, webhookUrl: rotated.webhookUrl } : rotated))}
              />
            )}
            {tab === "run" && (
              <RunPanel
                flowId={flowId}
                example={meta.example}
                dirty={dirty}
                watching={watching}
                detail={runDetail}
                detailError={runError}
                onRun={runFlow}
                onWatch={setWatching}
                onAnswered={refetchRun}
              />
            )}
          </TabPanel>
        </aside>
      </div>

      <ConfirmDialog
        open={confirming?.kind === "discard"}
        title="Discard your changes?"
        confirmLabel="Discard"
        danger
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          discard();
          setConfirming(null);
        }}
      >
        <p>The flow goes back to how it was when you last saved it.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirming?.kind === "describe"}
        title="Replace what's on the canvas?"
        confirmLabel="Replace"
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming?.kind === "describe") loadDescribed(confirming.flow);
          setConfirming(null);
        }}
      >
        <p>You have unsaved changes. The new draft takes their place; nothing is saved until you press Save.</p>
      </ConfirmDialog>
    </div>
  );
}
