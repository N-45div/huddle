import { api } from "../api.ts";
import { useChanges } from "../events.ts";
import { useDebounced, useResource } from "../hooks.ts";
import { Huddler } from "../huddlers/Huddler.tsx";
import { href } from "../router.ts";
import type { AskReply, LogLine } from "../types.ts";
import { AnswerView } from "../views/AnswerView.tsx";
import { ErrorNote, Link } from "./bits.tsx";
import { Markdown } from "./Markdown.tsx";

const textOf = (line: LogLine | undefined): string => {
  const said = (line?.detail as { text?: unknown } | null | undefined)?.text;
  return typeof said === "string" ? said : "";
};

/**
 * What Just ask did with what you typed: the plan and who's on it, in order; then, as the run goes, who has the
 * work, and once it's done the answer (Hud's, for a team). A run waiting for your OK says where to give it.
 */
export function JustAskResult({ asked, question, onAsk }: { readonly asked: AskReply; readonly question: string; readonly onAsk: (follow: string) => void }) {
  const runId = asked.run?.runId ?? null;
  const detail = useResource(() => (runId ? api.run(runId) : Promise.resolve(null)), [runId]);
  const refetch = useDebounced(() => void detail.reload(), 150);
  useChanges((change) => {
    if (runId && (change.kind === "resync" || ((change.kind === "run" || change.kind === "approval") && change.runId === runId))) refetch();
  });

  // One assistant answered at once.
  if (asked.answer) {
    const who = asked.answer.assistant;
    return (
      <section className="quick-reply" aria-live="polite">
        <p className="eyebrow reply-who">
          <Huddler id={who.id} connector={who.connector} mood="happy" size={30} live />
          {who.name}
        </p>
        <Markdown className="try-answer" text={asked.answer.text} />
        <AnswerView key={asked.answer.runId} text={asked.answer.text} ask={question} assistant={who.name} auto onAsk={onAsk} />
      </section>
    );
  }

  const run = detail.data?.run;
  const flow = detail.data?.flow;
  const step = run?.state === "running" ? flow?.steps.find((candidate) => candidate.id === (run.at ?? flow.steps[0]?.id)) : undefined;
  const workingId = step?.type === "agent" ? step.agent : null;
  const working = asked.plan.team.find((who) => who.id === workingId);
  const answer = run?.state === "done" ? textOf(detail.data?.log.findLast((line) => line.kind === "answered")) : "";
  const answeredBy = asked.plan.team.at(-1);

  return (
    <section className="quick-reply just-ask" aria-live="polite">
      {asked.plan.say && <p className="eyebrow">{asked.plan.say}</p>}
      <ol className="just-ask-team" aria-label="Who's on it, in order">
        {asked.plan.team.map((who) => (
          <li key={who.id} className={who.id === workingId ? "just-ask-member on" : "just-ask-member"}>
            <Huddler id={who.id} connector={who.connector} mood={who.id === workingId ? "thinking" : run?.state === "done" ? "happy" : "idle"} size={28} live={who.id === workingId} />
            {who.name}
          </li>
        ))}
      </ol>
      {(!run || run.state === "running") && <p className="hint" role="status">{working ? `${working.name} is on it…` : "On it…"}</p>}
      {run?.state === "waiting" && (
        <p className="hint">
          Waiting for your OK: <Link to={href.approvals()}>answer it in Approvals</Link>, or on the button.
        </p>
      )}
      {run?.state === "failed" && <ErrorNote message={run.error ?? "The run stopped."} />}
      {run?.state === "declined" && <p className="hint">You said no, so it stopped there.</p>}
      {answer && (
        <>
          <Markdown className="try-answer" text={answer} />
          <AnswerView key={`${runId}-${answer.length}`} text={answer} ask={question} {...(answeredBy ? { assistant: answeredBy.name } : {})} auto onAsk={onAsk} />
        </>
      )}
      {runId && (
        <p className="hint">
          <Link to={href.run(runId)}>Open the run</Link>
        </p>
      )}
    </section>
  );
}
