import type {
  ApiError,
  Assistant,
  Contact,
  Device,
  ContactTier,
  ConnectorInfo,
  Flow,
  FlowView,
  FoundTool,
  Info,
  LearningView,
  MemoryHit,
  Note,
  Tidy,
  PresentedView,
  RunDetail,
  RouterView,
  RunSummary,
  SandboxRequests,
  SignIn,
  Template,
  WaitingApproval,
  ToolDetails,
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

async function call<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
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

/** What the router answered, as an OpenAI chat completion plus Huddle's own details. */
export interface RouterReply {
  readonly model: string;
  readonly text: string;
  readonly runId: string | null;
  readonly skipped: readonly { readonly id: string; readonly error: string }[];
  readonly route: {
    readonly judge: string;
    readonly order: readonly string[];
    readonly probabilities: Readonly<Record<string, number>> | null;
    readonly confidence: number | null;
    readonly model: string | null;
    readonly note: string | null;
    /** How cost changed the order: the judge's first choice, and what each was expected to cost. */
    readonly cost: { readonly prefer: Prefer; readonly top: string; readonly estimates: Readonly<Record<string, number | null>>; readonly reordered: boolean } | null;
  } | null;
  /** Given again from a kept answer: nothing spent. */
  readonly reused: boolean;
  /** Structured data in the answer, when there is some. */
  readonly data: unknown;
  /** What it cost in dollars (null when the assistant has no price), and whether the tokens were guessed. */
  readonly cost: { readonly usd: number | null; readonly estimated: boolean } | null;
}

/** How much fit "auto" may trade for cost. */
export type Prefer = "quality" | "balanced" | "cheapest";

async function routerChat(model: string, text: string, prefer?: Prefer): Promise<RouterReply> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (memoryToken) headers.Authorization = `Bearer ${memoryToken}`;
  let response: Response;
  try {
    response = await fetch("v1/chat/completions", { method: "POST", headers, body: JSON.stringify({ model, messages: [{ role: "user", content: text }], ...(prefer ? { huddle: { prefer } } : {}) }) });
  } catch {
    throw new ApiFailure(0, "Can't reach the Huddle server. Check that it's running.");
  }
  const body = (await response.json().catch(() => null)) as {
    model?: string;
    choices?: { message?: { content?: string } }[];
    huddle?: { run?: string; skipped?: RouterReply["skipped"]; route?: RouterReply["route"]; reused?: boolean; cost?: RouterReply["cost"]; data?: unknown };
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    if (response.status === 401) for (const listener of unauthorizedListeners) listener();
    throw new ApiFailure(response.status, body?.error?.message ?? fallbackMessage(response.status));
  }
  return {
    model: body?.model ?? model,
    text: body?.choices?.[0]?.message?.content ?? "",
    runId: body?.huddle?.run ?? null,
    skipped: body?.huddle?.skipped ?? [],
    route: body?.huddle?.route ?? null,
    reused: body?.huddle?.reused === true,
    data: body?.huddle?.data ?? null,
    cost: body?.huddle?.cost ?? null,
  };
}

export const api = {
  info: () => call<Info>("GET", "/info"),
  connectors: () => call<ConnectorInfo[]>("GET", "/connectors"),
  monidFind: (need: string) => call<FoundTool[]>("GET", `/monid/find?q=${encodeURIComponent(need)}`),
  monidShow: (tool: string) => call<ToolDetails>("GET", `/monid/show?tool=${encodeURIComponent(tool)}`),
  assistants: () => call<Assistant[]>("GET", "/assistants"),
  saveAssistants: (assistants: readonly Assistant[]) => call<Assistant[]>("PUT", "/assistants", { assistants }),
  router: () => call<RouterView>("GET", "/router"),
  present: (answer: { text: string; data?: unknown; ask?: string; assistant?: string; kind?: string }) => call<PresentedView>("POST", "/present", answer),
  signIns: () => call<SignIn[]>("GET", "/signins"),
  checkSignIn: (signInId: string) => call<{ ok: true }>("POST", `/signins/${id(signInId)}/check`),
  cancelSignIn: (signInId: string) => call<{ ok: true }>("POST", `/signins/${id(signInId)}/cancel`),
  contacts: () => call<Contact[]>("GET", "/contacts"),
  /** Their token comes back this once. */
  addContact: (name: string, tier: ContactTier, emails: readonly string[]) => call<{ contact: Contact; token: string }>("POST", "/contacts", { name, tier, emails }),
  updateContact: (contactId: string, change: { name?: string; tier?: ContactTier; emails?: readonly string[] }) => call<Contact>("PATCH", `/contacts/${id(contactId)}`, change),
  newContactToken: (contactId: string) => call<{ token: string }>("POST", `/contacts/${id(contactId)}/token`),
  removeContact: (contactId: string) => call<null>("DELETE", `/contacts/${id(contactId)}`),
  /** One chat through the router's OpenAI-compatible /v1, the way any app would call it. */
  chat: (model: string, text: string, prefer?: Prefer) => routerChat(model, text, prefer),
  models: (connector: string, url: string, keyEnv = "") => {
    const query = new URLSearchParams({ ...(url ? { url } : {}), ...(keyEnv ? { keyEnv } : {}) }).toString();
    return call<{ models: string[] }>("GET", `/connectors/${id(connector)}/models${query ? `?${query}` : ""}`);
  },

  flows: () => call<FlowView[]>("GET", "/flows"),
  flow: (flowId: string) => call<FlowView>("GET", `/flows/${id(flowId)}`),
  createFlow: (flow: Flow) => call<FlowView>("POST", "/flows", { flow }),
  templates: () => call<Template[]>("GET", "/templates"),
  saveFlow: (flowId: string, flow: Flow) => call<FlowView>("PUT", `/flows/${id(flowId)}`, { flow }),
  deleteFlow: (flowId: string) => call<{ ok: true }>("DELETE", `/flows/${id(flowId)}`),
  /** Resolves when the flow is fine; throws an ApiFailure listing its problems when it isn't. */
  checkFlow: async (flow: Flow): Promise<void> => {
    const result = await call<{ ok: true } | ApiError>("POST", "/flows/check", { flow });
    if (result && "error" in result) throw new ApiFailure(400, result.error, result.problems ?? []);
  },
  runFlow: (flowId: string, input: string, images: readonly string[] = []) => call<{ runId: string }>("POST", `/flows/${id(flowId)}/run`, { input, ...(images.length ? { images } : {}) }),
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
  sandboxRequests: () => call<SandboxRequests>("GET", "/sandbox-requests"),
  answerSandboxRequest: (sandbox: string, requestId: string, yes: boolean, reason?: string) => call<{ ok: true }>("POST", `/sandbox-requests/${id(sandbox)}/${id(requestId)}`, { yes, ...(reason ? { reason } : {}) }),
  answer: (approvalId: string, yes: boolean) => call<{ runId: string }>("POST", `/approvals/${id(approvalId)}`, { yes }),

  memory: (status: Note["status"]) => call<Note[]>("GET", `/memory?status=${status}`),
  searchMemory: (query: string) => call<MemoryHit[]>("GET", `/memory/search?q=${encodeURIComponent(query)}`),
  addNote: (slice: string, note: string) => call<Note>("POST", "/memory", { slice, note }),
  keepNote: (noteId: string) => call<{ ok: true }>("POST", `/memory/${id(noteId)}/keep`),
  deleteNote: (noteId: string) => call<{ ok: true }>("DELETE", `/memory/${id(noteId)}`),
  tidyMemory: () => call<Tidy>("POST", "/memory/tidy", {}),
  devices: () => call<Device[]>("GET", "/devices"),
  addDevice: (name: string) => call<{ device: Device; token: string }>("POST", "/devices", { name }),
  removeDevice: (deviceId: string) => call<null>("DELETE", `/devices/${id(deviceId)}`),
  learning: () => call<LearningView>("GET", "/memory/learning"),
  setLearning: (on: boolean) => call<LearningView>("PUT", "/memory/learning", { on }),
  mergeNotes: (ids: readonly string[], note: string) => call<Note>("POST", "/memory/merge", { ids, note }),

  describe: (text: string) => call<{ flow: Flow }>("POST", "/describe", { text }),
};

/** The event stream's address; EventSource can't send headers, so the token rides in the query. */
/** The address a device (or the virtual button) connects to, with the Huddle token when there is one. */
export function deviceSocketUrl(): string {
  const base = new URL("devices/ws", window.location.href);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  if (memoryToken) base.searchParams.set("token", memoryToken);
  return base.toString();
}

export function eventsUrl(withToken: boolean): string {
  return withToken && memoryToken ? `api/events?token=${encodeURIComponent(memoryToken)}` : "api/events";
}
