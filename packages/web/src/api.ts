import type {
  ApiError,
  ConnectorInfo,
  Flow,
  FlowView,
  Info,
  Note,
  RunDetail,
  RunSummary,
  WaitingApproval,
} from "./types.ts";

/**
 * The one way the app talks to the server. Paths are relative to the page, so the app works wherever
 * the server mounts it. When the server has a token, it's kept in localStorage and sent as a bearer.
 */

const TOKEN_KEY = "huddle.token";

export function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage can be blocked (private windows); the token then lasts until the page reloads.
  }
  memoryToken = token;
}

let memoryToken = readToken();

/** A call that didn't work, in words a person can read. `problems` lists what's wrong with a flow. */
export class ApiFailure extends Error {
  readonly status: number;
  readonly problems: readonly string[];

  constructor(status: number, message: string, problems: readonly string[] = []) {
    super(message);
    this.name = "ApiFailure";
    this.status = status;
    this.problems = problems;
  }
}

/** Plain words for whatever was thrown. */
export function describeError(error: unknown): string {
  if (error instanceof ApiFailure) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

const unauthorizedListeners = new Set<() => void>();

/** Called whenever the server says the token is missing or wrong. */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function fallbackMessage(status: number): string {
  if (status === 401) return "This Huddle needs its access token.";
  if (status === 403) return "That token isn't allowed to do this.";
  if (status === 404) return "That isn't there any more.";
  if (status === 501) return "This server doesn't have that set up.";
  if (status >= 500) return "The server ran into a problem. Its log will say more.";
  return `The server said no (${status}).`;
}

async function call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (memoryToken) headers.Authorization = `Bearer ${memoryToken}`;
  let response: Response;
  try {
    response = await fetch(`api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiFailure(0, "Can't reach the Huddle server. Check that it's running.");
  }
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    if (response.status === 401) for (const listener of unauthorizedListeners) listener();
    const failure = (data && typeof data === "object" ? data : {}) as Partial<ApiError>;
    const message = typeof failure.error === "string" && failure.error ? failure.error : fallbackMessage(response.status);
    const problems = Array.isArray(failure.problems) ? failure.problems.filter((line): line is string => typeof line === "string") : [];
    throw new ApiFailure(response.status, message, problems);
  }
  return data as T;
}

const id = encodeURIComponent;

export const api = {
  info: () => call<Info>("GET", "/info"),
  connectors: () => call<ConnectorInfo[]>("GET", "/connectors"),
  models: (connector: string, url: string) => call<{ models: string[] }>("GET", `/connectors/${id(connector)}/models` + (url ? `?url=${id(url)}` : "")),

  flows: () => call<FlowView[]>("GET", "/flows"),
  flow: (flowId: string) => call<FlowView>("GET", `/flows/${id(flowId)}`),
  createFlow: (flow: Flow) => call<FlowView>("POST", "/flows", { flow }),
  saveFlow: (flowId: string, flow: Flow) => call<FlowView>("PUT", `/flows/${id(flowId)}`, { flow }),
  deleteFlow: (flowId: string) => call<{ ok: true }>("DELETE", `/flows/${id(flowId)}`),
  /** Resolves when the flow is fine; throws an ApiFailure listing its problems when it isn't. */
  checkFlow: async (flow: Flow): Promise<void> => {
    const result = await call<{ ok: true } | ApiError>("POST", "/flows/check", { flow });
    if (result && "error" in result) throw new ApiFailure(400, result.error, result.problems ?? []);
  },
  runFlow: (flowId: string, input: string) => call<{ runId: string }>("POST", `/flows/${id(flowId)}/run`, { input }),
  rotateWebhook: (flowId: string) => call<FlowView>("POST", `/flows/${id(flowId)}/webhook/rotate`),

  runs: (options: { flow?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.flow) query.set("flow", options.flow);
    if (options.limit) query.set("limit", String(options.limit));
    const search = query.toString();
    return call<RunSummary[]>("GET", `/runs${search ? `?${search}` : ""}`);
  },
  run: (runId: string) => call<RunDetail>("GET", `/runs/${id(runId)}`),

  approvals: () => call<WaitingApproval[]>("GET", "/approvals"),
  answer: (approvalId: string, yes: boolean) => call<{ runId: string }>("POST", `/approvals/${id(approvalId)}`, { yes }),

  memory: (status: Note["status"]) => call<Note[]>("GET", `/memory?status=${status}`),
  addNote: (slice: string, note: string) => call<Note>("POST", "/memory", { slice, note }),
  keepNote: (noteId: string) => call<{ ok: true }>("POST", `/memory/${id(noteId)}/keep`),
  deleteNote: (noteId: string) => call<{ ok: true }>("DELETE", `/memory/${id(noteId)}`),

  describe: (text: string) => call<{ flow: Flow }>("POST", "/describe", { text }),
};

/** The event stream's address; EventSource can't send headers, so the token rides in the query. */
export function eventsUrl(withToken: boolean): string {
  return withToken && memoryToken ? `api/events?token=${encodeURIComponent(memoryToken)}` : "api/events";
}
