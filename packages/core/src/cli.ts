import { readFileSync } from "node:fs";
import { defaultConnectors } from "./connectors/index.ts";
import { Engine, type RunView } from "./engine.ts";
import { parseFlow } from "./schema.ts";
import { Store } from "./store.ts";

/**
 * The command line, until the canvas exists. Everything is kept in huddle.db in the current folder
 * (or wherever HUDDLE_DB points), so a run waiting on an approval can be answered later.
 *
 *   huddle run <flow.json> [--input <text> | --input @<file>]
 *   huddle approve <run-or-approval-id> yes|no
 *   huddle runs                    recent runs
 *   huddle show <run-id>           a run's steps, what went in and what came out
 *   huddle memory [suggested|kept] the shared memory
 *   huddle memory add <slice> <note…> | keep <note-id> | forget <note-id>
 */


const store = new Store(process.env.HUDDLE_DB ?? "huddle.db");
const engine = new Engine(store, defaultConnectors());
const [command, ...args] = process.argv.slice(2);

function option(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined) return undefined;
  return value.startsWith("@") ? readFileSync(value.slice(1), "utf8").trim() : value;
}

function printRun(view: RunView, from = 0): void {
  for (const line of store.logOf(view.id).slice(from)) {
    const detail = line.detail as Record<string, unknown> | null;
    const what =
      line.kind === "asked" ? `asked ${String(detail?.assistant)}: ${String(detail?.ask)}`
      : line.kind === "answered" ? `answer: ${String(detail?.text)}`
      : line.kind === "checked" ? `checked ${String(detail?.if)} -> ${String(detail?.result)}`
      : line.kind === "waiting" ? `waiting for you: ${String(detail?.message)}`
      : line.kind === "suggested" ? `suggested to memory (${String(detail?.slice)}): ${String(detail?.text)}`
      : line.kind === "failed" ? `failed: ${String(detail?.error)}`
      : `${line.kind}: ${String(detail?.message ?? "")}`;
    console.log(`  [${line.stepId}] ${what}`);
  }
  console.log(`\nRun ${view.id}: ${view.state}${view.error ? ` (${view.error})` : ""}`);
  if (view.waiting) console.log(`Answer it with:  npm run huddle -- approve ${view.id} yes   (or no)`);
}

async function main(): Promise<void> {
  switch (command) {
    case "run": {
      const file = args[0];
      if (!file) throw new Error("Which flow? huddle run <flow.json>");
      const flow = parseFlow(JSON.parse(readFileSync(file, "utf8")));
      console.log(`Running "${flow.name}"\n`);
      printRun(await engine.start(flow, option("input") ?? ""));
      return;
    }
    case "approve": {
      const [id, answer] = args;
      if (!id || (answer !== "yes" && answer !== "no")) throw new Error("huddle approve <run-or-approval-id> yes|no");
      // A run id works too: it answers whatever that run is waiting on.
      const approval = id.startsWith("run_") ? store.waitingApproval(id) : store.approval(id);
      if (!approval) throw new Error(`Nothing is waiting on ${id}.`);
      const before = store.logOf(approval.runId).length;
      printRun(await engine.decide(approval.id, answer === "yes"), before);
      return;
    }
    case "runs": {
      for (const run of store.runs()) console.log(`${run.id}  ${run.state.padEnd(8)}  ${run.flow.name}  ${run.createdAt}`);
      return;
    }
    case "show": {
      if (!args[0]) throw new Error("huddle show <run-id>");
      printRun(engine.view(args[0]));
      return;
    }
    case "memory": {
      const [sub, ...rest] = args;
      if (sub === "add") {
        const [slice, ...words] = rest;
        if (!slice || words.length === 0) throw new Error("huddle memory add <slice> <note…>");
        console.log(`Kept ${store.remember(slice, words.join(" ")).id}`);
      } else if (sub === "keep") {
        console.log(store.keep(rest[0] ?? "") ? "Kept. Assistants allowed that slice will see it." : "No suggestion with that id.");
      } else if (sub === "forget") {
        console.log(store.forget(rest[0] ?? "") ? "Forgotten." : "No note with that id.");
      } else {
        const status = sub === "suggested" || sub === "kept" ? sub : undefined;
        for (const note of store.notes(status)) console.log(`${note.id}  ${note.status.padEnd(9)}  ${note.slice.padEnd(10)}  ${note.note}`);
      }
      return;
    }
    default:
      console.log("huddle run <flow.json> [--input <text>|@<file>] | approve <id> yes|no | runs | show <run-id> | memory [suggested|kept|add|keep|forget]");
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => store.close());
