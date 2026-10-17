import { type Edge, MarkerType, type Node, type XYPosition } from "@xyflow/react";
import type { Assistant, Callers, Flow, Step, StepType, Trigger } from "../types.ts";

/**
 * The flow file on one side, the canvas on the other. On the canvas a step's content lives in its
 * node and every hand-off is an edge; nothing is implied by array order. Saving writes every link
 * out explicitly, because the engine reads a missing `next` as "the following step in the array",
 * which a canvas can't show.
 */

/** The trigger's marker. Step ids can't start with "_", so this never clashes with one. */
export const START_ID = "__start";

export type StepContent =
  | { readonly type: "agent"; readonly agent: string; readonly ask: string }
  | { readonly type: "condition"; readonly if: string }
  /** `noFinishes`: a "no" with no link finishes the run as done (onNo: "end") instead of ending it as declined. */
  | { readonly type: "approval"; readonly message: string; readonly noFinishes?: boolean }
  | { readonly type: "memory"; readonly slice: string; readonly note: string };

export type StepNode = Node<StepContent, "step">;
export type StartNode = Node<Record<string, never>, "start">;
export type EditorNode = StepNode | StartNode;

/** The source handles: agent, memory and the trigger have `next`; conditions `then`/`else`; approvals `next`/`onNo`. */
export type LinkHandle = "next" | "then" | "else" | "onNo";
const LINK_ORDER: readonly LinkHandle[] = ["next", "then", "else", "onNo"];

/** Everything about a flow that isn't on the canvas. */
export interface Meta {
  readonly name: string;
  readonly description: string;
  /** A request to try it with: the run box starts with it. */
  readonly example: string;
  readonly trigger: Trigger;
  /** Who may start it from outside; none means only you. */
  readonly callers?: Callers;
  readonly assistants: readonly Assistant[];
}

export const NODE_WIDTH = 240;
const START_WIDTH = 160;
const COLUMN = 290;
const ROW = 170;

export function handlesOf(type: StepType | "start"): readonly LinkHandle[] {
  if (type === "condition") return ["then", "else"];
  if (type === "approval") return ["next", "onNo"];
  return ["next"];
}

export function handleOf(edge: Edge): LinkHandle {
  const handle = edge.sourceHandle;
  return handle === "then" || handle === "else" || handle === "onNo" ? handle : "next";
}

function edgeLabel(sourceType: StepType | "start", handle: LinkHandle): string | undefined {
  if (sourceType === "condition") return handle === "then" ? "yes" : "no";
  if (sourceType === "approval") return handle === "onNo" ? "if no" : "if yes";
  return undefined;
}

export function makeEdge(source: string, sourceType: StepType | "start", handle: LinkHandle, target: string): Edge {
  const label = edgeLabel(sourceType, handle);
  return {
    id: `${source}:${handle}`,
    source,
    sourceHandle: handle,
    target,
    targetHandle: "in",
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    className: `link link-${handle}${sourceType === "start" ? " link-start" : ""}`,
    ...(label ? { label, labelBgPadding: [6, 3] as [number, number], labelBgBorderRadius: 6 } : {}),
  };
}

export function isStepNode(node: EditorNode): node is StepNode {
  return node.type === "step";
}

/** Where `source` goes through `handle`, if anywhere. */
export function linkTarget(edges: readonly Edge[], source: string, handle: LinkHandle): string | undefined {
  return edges.find((edge) => edge.source === source && handleOf(edge) === handle)?.target;
}

export function contentOf(step: Step): StepContent {
  switch (step.type) {
    case "agent":
      return { type: "agent", agent: step.agent, ask: step.ask };
    case "condition":
      return { type: "condition", if: step.if };
    case "approval":
      return step.onNo === "end" ? { type: "approval", message: step.message, noFinishes: true } : { type: "approval", message: step.message };
    case "memory":
      return { type: "memory", slice: step.slice, note: step.note };
  }
}

export function defaultContent(type: StepType, assistants: readonly Assistant[]): StepContent {
  switch (type) {
    case "agent":
      return { type, agent: assistants[0]?.id ?? "", ask: "" };
    case "condition":
      return { type, if: "" };
    case "approval":
      return { type, message: "" };
    case "memory":
      return { type, slice: "", note: "" };
  }
}

/** Is anything a step needs still empty? (The server has the last word; this only marks the node.) */
export function isIncomplete(content: StepContent, assistants: readonly Assistant[]): boolean {
  switch (content.type) {
    case "agent":
      return !content.ask.trim() || !assistants.some((assistant) => assistant.id === content.agent);
    case "condition":
      return !content.if.trim();
    case "approval":
      return !content.message.trim();
    case "memory":
      return !content.slice.trim() || !content.note.trim();
  }
}

export function uniqueStepId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Lays steps out top to bottom from the first one. Each step sits a row below every step that leads to
 * it (links that loop back up are left out of that), and where a step splits two ways its "yes" goes
 * left and its "no" right, so links don't run behind other steps.
 */
export function layoutSteps(stepIds: readonly string[], edges: readonly Edge[]): Record<string, XYPosition> {
  const valid = new Set(stepIds);
  const first = linkTarget(edges, START_ID, "next");
  const children = new Map<string, { readonly id: string; readonly handle: LinkHandle }[]>();
  const visited = new Set<string>();
  const onPath = new Set<string>();
  const finished: string[] = [];

  const visit = (id: string) => {
    visited.add(id);
    onPath.add(id);
    const out: { id: string; handle: LinkHandle }[] = [];
    for (const handle of LINK_ORDER) {
      const target = linkTarget(edges, id, handle);
      if (!target || !valid.has(target) || onPath.has(target)) continue;
      out.push({ id: target, handle });
      if (!visited.has(target)) visit(target);
    }
    children.set(id, out);
    onPath.delete(id);
    finished.push(id);
  };

  const row = new Map<string, number>();
  const column = new Map<string, number>();
  let nextRow = 0;
  for (const root of [...(first && valid.has(first) ? [first] : []), ...stepIds]) {
    if (visited.has(root)) continue;
    const from = finished.length;
    visit(root);
    // Reversed finishing order is a topological order once loops are left out.
    const component = finished.slice(from).reverse();
    const inComponent = new Set(component);
    row.set(root, nextRow);
    column.set(root, 0);
    for (const id of component) {
      const here = row.get(id) ?? nextRow;
      const kids = (children.get(id) ?? []).filter((kid) => inComponent.has(kid.id));
      const split = kids.length > 1;
      for (const kid of kids) {
        row.set(kid.id, Math.max(row.get(kid.id) ?? 0, here + 1));
        if (!column.has(kid.id)) column.set(kid.id, (column.get(id) ?? 0) + (split ? (kid.handle === "then" || kid.handle === "next" ? -0.5 : 0.5) : 0));
      }
    }
    nextRow = Math.max(...component.map((id) => row.get(id) ?? 0)) + 1;
  }

  // Steps that land on the same spot in a row are pushed apart.
  const rows = new Map<number, string[]>();
  for (const id of stepIds) rows.set(row.get(id) ?? 0, [...(rows.get(row.get(id) ?? 0) ?? []), id]);
  const positions: Record<string, XYPosition> = {};
  for (const [index, ids] of rows) {
    const sorted = [...ids].sort((a, b) => (column.get(a) ?? 0) - (column.get(b) ?? 0));
    let last = -Infinity;
    for (const id of sorted) {
      const x = Math.max((column.get(id) ?? 0) * COLUMN, last + COLUMN);
      last = x;
      positions[id] = { x: Math.round(x - NODE_WIDTH / 2), y: ROW * (index + 1) };
    }
  }
  return positions;
}

/** Saved positions where there are some; any step without one goes in a column to the right. */
function placeSteps(stepIds: readonly string[], edges: readonly Edge[], saved: Readonly<Record<string, XYPosition>>): Record<string, XYPosition> {
  const known = stepIds.filter((id) => saved[id]);
  if (known.length === 0) return layoutSteps(stepIds, edges);
  const positions: Record<string, XYPosition> = {};
  let maxX = -Infinity;
  let minY = Infinity;
  for (const id of known) {
    const position = saved[id] as XYPosition;
    positions[id] = { x: position.x, y: position.y };
    maxX = Math.max(maxX, position.x);
    minY = Math.min(minY, position.y);
  }
  let row = 0;
  for (const id of stepIds) {
    if (positions[id]) continue;
    positions[id] = { x: maxX + COLUMN, y: minY + row * ROW };
    row += 1;
  }
  return positions;
}

/** The trigger marker sits just above the first step. */
export function startPosition(first: XYPosition | undefined): XYPosition {
  if (!first) return { x: -START_WIDTH / 2, y: 0 };
  return { x: first.x + (NODE_WIDTH - START_WIDTH) / 2, y: first.y - 110 };
}

export interface Graph {
  readonly meta: Meta;
  readonly nodes: EditorNode[];
  readonly edges: Edge[];
}

export function flowToGraph(flow: Flow): Graph {
  const steps = flow.steps ?? [];
  const ids = new Set(steps.map((step) => step.id));
  const edges: Edge[] = [];
  const link = (step: Step, handle: LinkHandle, target: string | undefined) => {
    if (target && target !== "end" && ids.has(target)) edges.push(makeEdge(step.id, step.type, handle, target));
  };
  steps.forEach((step, index) => {
    // What the engine would do: a missing `next` means the following step.
    const following = steps[index + 1]?.id ?? "end";
    switch (step.type) {
      case "condition":
        link(step, "then", step.then);
        link(step, "else", step.else);
        break;
      case "approval":
        link(step, "next", step.next ?? following);
        link(step, "onNo", step.onNo);
        break;
      default:
        link(step, "next", step.next ?? following);
    }
  });
  const first = steps[0]?.id;
  if (first) edges.push(makeEdge(START_ID, "start", "next", first));

  const positions = placeSteps(
    steps.map((step) => step.id),
    edges,
    flow.ui?.positions ?? {},
  );
  const start: StartNode = { id: START_ID, type: "start", position: startPosition(first ? positions[first] : undefined), data: {}, deletable: false };
  const nodes: EditorNode[] = [start, ...steps.map((step): StepNode => ({ id: step.id, type: "step", position: positions[step.id] ?? { x: 0, y: 0 }, data: contentOf(step) }))];
  return {
    meta: {
      name: flow.name ?? "",
      description: flow.description ?? "",
      example: flow.example ?? "",
      trigger: flow.trigger ?? { type: "manual" },
      ...(flow.callers ? { callers: flow.callers } : {}),
      assistants: flow.assistants ?? [],
    },
    nodes,
    edges,
  };
}

/** The step order to save: the trigger's first step first, then as the links lead, then the rest. */
function orderSteps(stepIds: readonly string[], edges: readonly Edge[]): string[] {
  const valid = new Set(stepIds);
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (start: string) => {
    const stack = [start];
    while (stack.length) {
      const id = stack.pop() as string;
      if (seen.has(id) || !valid.has(id)) continue;
      seen.add(id);
      order.push(id);
      // Push in reverse so the first link is visited first.
      for (const handle of [...LINK_ORDER].reverse()) {
        const target = linkTarget(edges, id, handle);
        if (target) stack.push(target);
      }
    }
  };
  const first = linkTarget(edges, START_ID, "next");
  if (first) visit(first);
  for (const id of stepIds) visit(id);
  return order;
}

const round = (value: number) => Math.round(value);

export function graphToFlow(meta: Meta, nodes: readonly EditorNode[], edges: readonly Edge[]): Flow {
  const stepNodes = nodes.filter(isStepNode);
  const byId = new Map(stepNodes.map((node) => [node.id, node]));
  const to = (id: string, handle: LinkHandle) => {
    const target = linkTarget(edges, id, handle);
    return target && byId.has(target) ? target : undefined;
  };
  const steps: Step[] = [];
  for (const id of orderSteps(
    stepNodes.map((node) => node.id),
    edges,
  )) {
    const content = byId.get(id)?.data;
    if (!content) continue;
    switch (content.type) {
      case "agent":
        steps.push({ id, type: "agent", agent: content.agent, ask: content.ask, next: to(id, "next") ?? "end" });
        break;
      case "condition":
        steps.push({ id, type: "condition", if: content.if, then: to(id, "then") ?? "end", else: to(id, "else") ?? "end" });
        break;
      case "approval": {
        const onNo = to(id, "onNo") ?? (content.noFinishes ? "end" : undefined);
        steps.push(onNo ? { id, type: "approval", message: content.message, next: to(id, "next") ?? "end", onNo } : { id, type: "approval", message: content.message, next: to(id, "next") ?? "end" });
        break;
      }
      case "memory":
        steps.push({ id, type: "memory", slice: content.slice, note: content.note, next: to(id, "next") ?? "end" });
        break;
    }
  }
  const positions: Record<string, XYPosition> = {};
  for (const node of stepNodes) positions[node.id] = { x: round(node.position.x), y: round(node.position.y) };
  const description = meta.description.trim();
  return {
    name: meta.name,
    ...(description ? { description: meta.description } : {}),
    ...(meta.example.trim() ? { example: meta.example } : {}),
    trigger: meta.trigger,
    ...(meta.callers ? { callers: meta.callers } : {}),
    assistants: [...meta.assistants],
    steps,
    ui: { positions },
  };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Points {{from...}} references in a template at `to` instead. */
export function retarget(template: string, from: string, to: string): string {
  return template.replace(new RegExp(`\\{\\{(\\s*)${escapeRegExp(from)}(?=[.\\s}])`, "g"), `{{$1${to}`);
}

export function retargetContent(content: StepContent, from: string, to: string): StepContent {
  switch (content.type) {
    case "agent":
      return { ...content, ask: retarget(content.ask, from, to) };
    case "condition":
      return { ...content, if: retarget(content.if, from, to) };
    case "approval":
      return { ...content, message: retarget(content.message, from, to) };
    case "memory":
      return { ...content, note: retarget(content.note, from, to) };
  }
}

/** A step's renamed edges keep their handles and labels. */
export function renameInEdges(edges: readonly Edge[], from: string, to: string): Edge[] {
  return edges.map((edge) => {
    if (edge.source !== from && edge.target !== from) return edge;
    const source = edge.source === from ? to : edge.source;
    const target = edge.target === from ? to : edge.target;
    return { ...edge, id: `${source}:${handleOf(edge)}`, source, target };
  });
}
