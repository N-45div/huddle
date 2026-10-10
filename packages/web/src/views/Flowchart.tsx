import { type Edge, MarkerType, type Node, Position, ReactFlow } from "@xyflow/react";
import { useMemo } from "react";
import type { View } from "../types.ts";

/** A flowchart from a checked view, laid out top to bottom, on the same canvas library as the flow editor. */

export type FlowchartSpec = Extract<View, { kind: "flowchart" }>;

const ROW = 110;
const COLUMN = 210;

/**
 * Where each node goes: its row is its longest path from a start (ignoring edges that loop back), and a
 * decision's branches split left and right below it, so an edge that skips a row doesn't run behind a node.
 */
function layout(view: FlowchartSpec): Map<string, { x: number; y: number }> {
  const out = new Map<string, string[]>();
  for (const edge of view.edges) out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
  const targets = new Set(view.edges.filter((edge) => edge.from !== edge.to).map((edge) => edge.to));
  const starts = view.nodes.filter((node) => node.shape === "start" || !targets.has(node.id)).map((node) => node.id);
  // Edges back into the path being walked are loops: leave them out of the layering.
  const forward: { from: string; to: string }[] = [];
  const done = new Set<string>();
  const walking = new Set<string>();
  const walk = (id: string) => {
    if (done.has(id)) return;
    walking.add(id);
    for (const to of out.get(id) ?? []) {
      if (walking.has(to)) continue;
      forward.push({ from: id, to });
      walk(to);
    }
    walking.delete(id);
    done.add(id);
  };
  const roots = starts.length ? starts : [view.nodes[0]!.id];
  for (const id of roots) walk(id);
  for (const node of view.nodes) walk(node.id);
  const row = new Map(view.nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < view.nodes.length; pass += 1) {
    let changed = false;
    for (const edge of forward) {
      const next = (row.get(edge.from) ?? 0) + 1;
      if (next > (row.get(edge.to) ?? 0)) {
        row.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Columns: a node takes its first parent's column, and a node's children spread out around it.
  const column = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const edge of forward) children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
  // Breadth first, so all of a decision's branches are placed before any branch's own children.
  const queue: string[] = [];
  const place = (id: string, at: number) => {
    if (column.has(id)) return;
    column.set(id, at);
    queue.push(id);
  };
  roots.forEach((id, index) => place(id, index - (roots.length - 1) / 2));
  for (let next = 0; next < queue.length || column.size < view.nodes.length; next += 1) {
    if (next >= queue.length) place(view.nodes.find((node) => !column.has(node.id))!.id, 0);
    const id = queue[next]!;
    const below = (children.get(id) ?? []).filter((child) => !column.has(child));
    below.forEach((child, index) => place(child, (column.get(id) ?? 0) + (index - (below.length - 1) / 2)));
  }
  // Two nodes in one row never overlap: spread them at least a column apart, keeping their order.
  const byRow = new Map<number, string[]>();
  for (const node of view.nodes) byRow.set(row.get(node.id) ?? 0, [...(byRow.get(row.get(node.id) ?? 0) ?? []), node.id]);
  for (const ids of byRow.values()) {
    ids.sort((a, b) => (column.get(a) ?? 0) - (column.get(b) ?? 0));
    for (let index = 1; index < ids.length; index += 1) {
      const before = column.get(ids[index - 1]!) ?? 0;
      if ((column.get(ids[index]!) ?? 0) < before + 1) column.set(ids[index]!, before + 1);
    }
  }
  return new Map(view.nodes.map((node) => [node.id, { x: (column.get(node.id) ?? 0) * COLUMN, y: (row.get(node.id) ?? 0) * ROW }]));
}

export function Flowchart({ view }: { readonly view: FlowchartSpec }) {
  const { nodes, edges, depth } = useMemo(() => {
    const placed = layout(view);
    const nodes: Node[] = view.nodes.map((node) => {
      return {
        id: node.id,
        position: placed.get(node.id) ?? { x: 0, y: 0 },
        data: { label: node.label },
        className: `flow-node flow-node-${node.shape}`,
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        draggable: false,
        connectable: false,
        selectable: false,
      };
    });
    const edges: Edge[] = view.edges.map((edge, index) => ({
      id: `edge-${index}`,
      source: edge.from,
      target: edge.to,
      ...(edge.label ? { label: edge.label } : {}),
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed },
      className: "flow-edge",
    }));
    return { nodes, edges, depth: Math.max(0, ...[...placed.values()].map((point) => point.y / ROW)) + 1 };
  }, [view]);

  const after = (id: string) => view.edges.filter((edge) => edge.from === id).map((edge) => `${view.nodes.find((node) => node.id === edge.to)?.label ?? edge.to}${edge.label ? ` (${edge.label})` : ""}`);

  return (
    <div className="flowchart">
      <div className="flowchart-canvas" style={{ height: Math.min(520, 70 + depth * ROW) }} aria-hidden="true">
        <ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.15 }} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnScroll={false} panOnScroll={false} preventScrolling={false} minZoom={0.3} proOptions={{ hideAttribution: true }} />
      </div>
      {/* The same steps in words, for screen readers and for copying. */}
      <ol className="visually-hidden">
        {view.nodes.map((node) => {
          const next = after(node.id);
          return (
            <li key={node.id}>
              {node.label}
              {next.length ? `, then ${next.join(" or ")}` : ""}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
