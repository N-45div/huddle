/**
 * Every shape the app uses comes from the server's API contract (types only, so nothing from the
 * server or the engine ends up in the browser bundle).
 */
import type { Flow } from "../../server/src/api-types.ts";

export type {
  ApiError,
  ChangeEvent,
  Choice,
  ConnectorField,
  ConnectorInfo,
  Contact,
  ContactTier,
  FactCheck,
  Flow,
  FlowView,
  FoundTool,
  HeldBy,
  Info,
  LogLine,
  MemoryHit,
  Note,
  PresentedView,
  Receipt,
  RunDetail,
  RunState,
  RunSummary,
  RouterUsage,
  RouterView,
  SpendView,
  ToolDetails,
  RunView,
  SignIn,
  SandboxRequests,
  SandboxRequestView,
  Trigger,
  View,
  WaitingApproval,
} from "../../server/src/api-types.ts";

export type Step = Flow["steps"][number];
export type StepType = Step["type"];
export type Assistant = Flow["assistants"][number];
/** Who may start a flow from outside: see the Trigger tab. */
export type Callers = NonNullable<Flow["callers"]>;
export type ConnectorId = Assistant["connector"];
export type StepOf<T extends StepType> = Extract<Step, { type: T }>;

/** Step and assistant ids: letters, numbers, - and _ (up to 64), as the flow format requires. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
/** An environment variable's name, never a key. */
export const ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/;
/** A schedule's "every": a number and m, h or d. */
export const EVERY_PATTERN = /^[1-9]\d*(m|h|d)$/;
/** A plain email address, as the flow format checks it. */
export const EMAIL_PATTERN = /^[^\s@<>,;"]+@[^\s@<>,;".]+(?:\.[^\s@<>,;".]+)+$/;

/** Whether this is an address, or "Name <address>". */
export function isSender(value: string): boolean {
  return EMAIL_PATTERN.test(value) || EMAIL_PATTERN.test(/^[^<>]*<([^<>]+)>$/.exec(value)?.[1] ?? "");
}
