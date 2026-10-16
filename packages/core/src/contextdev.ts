import ContextDev, { APIConnectionError, APIConnectionTimeoutError, APIError } from "context.dev";
import type { ContextDevMode } from "./schema.ts";

/**
 * context.dev (brand.dev until September 2026): web data for agents. Huddle uses three of its APIs, through
 * its official SDK (pinned: it has changed shape between releases). Scrape reads a page as Markdown, and
 * with a question, only the passages that answer it; Search finds pages with those passages; Brand looks a
 * company up from its domain, a work email or its name. A page read is 1 credit (2 with passages), a search
 * of five results 2, a company 10; 1,000 credits free a month, then $19 for 7,500 (October 2026).
 */

export const CONTEXT_DEV_API = "https://api.context.dev/v1";
/** One credit on the Developer plan ($19 for 7,500 a month), in US dollars: what Huddle counts a call at. */
export const CONTEXT_DEV_CREDIT_USD = 19 / 7_500;

export type ContextDevTask =
  | { readonly kind: "read"; readonly url: string; readonly question: string | null }
  | { readonly kind: "search"; readonly query: string }
  | { readonly kind: "company"; readonly by: "email" | "domain" | "name"; readonly value: string };

export interface ContextDevResult {
  readonly text: string;
  readonly data: Readonly<Record<string, unknown>>;
  /** Credits it took, as context.dev reports them. */
  readonly credits: number | null;
}

export interface ContextDevOptions {
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
}

const URL_IN = /https?:\/\/[^\s<>"'`]+/i;
const EMAIL = /^[\w.%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;
const PAGE_CHARS = 12_000;

/** The text without the closing punctuation a sentence leaves on a word or a link. */
function trailing(text: string): string {
  let end = text.length;
  while (end > 0 && `)"'>],.;:!?`.includes(text[end - 1]!)) end--;
  return text.slice(0, end);
}

/** The ask's words, each without the punctuation around it. */
const tokens = (text: string): string[] => text.split(/\s+/).map((word) => trailing(word.replace(/^[("'<[]+/, ""))).filter(Boolean);

/**
 * What a request asks of context.dev. With a mode, that; without one: a link is read (the rest of the
 * request, when it's a question, picks the passages), a lone email address or domain is looked up as a
 * company, and anything else is searched for.
 */
export function taskFor(ask: string, mode?: ContextDevMode): ContextDevTask {
  const text = ask.trim();
  const words = tokens(text);
  const found = URL_IN.exec(text)?.[0];
  const url = found ? trailing(found) : undefined;
  const email = words.find((word) => EMAIL.test(word));
  const domainWord = words.find((word) => DOMAIN.test(word.replace(/^www\./i, "")));
  const domain = domainWord?.replace(/^www\./i, "").toLowerCase();
  const alone = words.length === 1;

  if (mode === "search") return { kind: "search", query: text.slice(0, 500) };
  if (mode === "company") {
    if (email) return { kind: "company", by: "email", value: email };
    if (url) return { kind: "company", by: "domain", value: new URL(url).hostname.replace(/^www\./i, "") };
    if (domain) return { kind: "company", by: "domain", value: domain };
    if (!text) throw new Error("Give context.dev a company to look up: its website, a work email, or its name.");
    return { kind: "company", by: "name", value: text.slice(0, 200) };
  }
  if (url || (mode === "read" && domain)) {
    const page = url ?? `https://${domain}`;
    const rest = text.replace(found ?? domainWord ?? "", " ").replace(/\s+/g, " ").trim();
    return { kind: "read", url: page, question: rest.split(" ").length >= 3 ? rest.slice(0, 2_000) : null };
  }
  if (mode === "read") throw new Error("Give context.dev a link to read.");
  if (alone && email) return { kind: "company", by: "email", value: email };
  if (alone && domain) return { kind: "company", by: "domain", value: domain };
  return { kind: "search", query: text.slice(0, 500) };
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}\n…` : text);
const credits = (response: { key_metadata?: { credits_consumed: number } }): number | null => response.key_metadata?.credits_consumed ?? null;

async function read(api: ContextDev, url: string, question: string | null, signal?: AbortSignal): Promise<ContextDevResult> {
  const page = await api.web.scrape(
    {
      url,
      formats: { markdown: true, ...(question ? { highlights: true } : {}) },
      ...(question ? { highlightsParams: { query: question, maxCharacters: 3_000 } } : {}),
      sharedParams: { mainContentOnly: true },
      timeoutOpts: { milliseconds: 60_000, behavior: "return-partial" },
    },
    signal ? { signal } : undefined,
  );
  const markdown = page.markdown?.success ? (page.markdown.data ?? "") : "";
  const passages = page.highlights?.success ? (page.highlights.data ?? []) : [];
  if (!markdown && passages.length === 0) throw new Error(`context.dev couldn't read ${url}: ${page.markdown?.message ?? "the page had no usable content"}`);
  const title = page.metadata?.title || url;
  const body = passages.length > 0 ? passages.join("\n\n") : clip(markdown, PAGE_CHARS);
  return { text: `${title} (${url})\n\n${body}`, data: { url, title, question, passages, markdown: clip(markdown, 20_000) }, credits: credits(page) };
}

async function search(api: ContextDev, query: string, signal?: AbortSignal): Promise<ContextDevResult> {
  const found = await api.web.search({ query, numResults: 5, highlightsOptions: { enabled: true, maxCharacters: 800 } }, signal ? { signal } : undefined);
  const results = found.results.map((result) => ({
    title: result.title || result.url,
    url: result.url,
    description: result.description,
    passages: result.highlights.code === "SUCCESS" ? (result.highlights.highlights ?? []) : [],
  }));
  const text = results.length
    ? results.map((result, index) => `${index + 1}. ${result.title} (${result.url})\n${clip(result.passages.length ? result.passages.join(" … ") : result.description, 800)}`).join("\n\n")
    : "context.dev found nothing for that.";
  return { text, data: { query, results }, credits: credits(found) };
}

const errorCode = (error: APIError): string => {
  const body = error.error as { error_code?: unknown } | undefined;
  return typeof body?.error_code === "string" ? body.error_code : "";
};

async function company(api: ContextDev, by: "email" | "domain" | "name", value: string, signal?: AbortSignal): Promise<ContextDevResult> {
  // A company context.dev hasn't seen takes a while to look up: up to a minute, then what it has.
  const timeoutOpts = { milliseconds: 60_000, behavior: "return-partial" as const };
  const lookups = {
    email: { type: "by_email" as const, email: value, timeoutOpts },
    domain: { type: "by_domain" as const, domain: value, timeoutOpts },
    name: { type: "by_name" as const, name: value, timeoutOpts },
  };
  const params = lookups[by];
  let found;
  try {
    found = await api.brand.retrieve(params, signal ? { signal } : undefined);
  } catch (error) {
    // Nothing to find isn't a failure: a flow can go on with data.found false.
    const code = error instanceof APIError ? errorCode(error) : "";
    if (code === "FREE_EMAIL_DETECTED" || code === "DISPOSABLE_EMAIL_DETECTED") {
      return { text: `${value} is a personal email address, so there's no company behind it to look up.`, data: { found: false, why: "personal email" }, credits: 0 };
    }
    if (error instanceof APIError && error.status === 400 && (code === "NOT_FOUND" || code === "WEBSITE_NOT_FOUND")) {
      return { text: `context.dev doesn't know a company at ${value}.`, data: { found: false, why: "not found" }, credits: 0 };
    }
    throw error;
  }
  const brand = found.brand;
  const name = brand.title ?? brand.domain ?? value;
  const place = [brand.address?.city, brand.address?.country].filter(Boolean).join(", ");
  const industries = (brand.industries?.eic ?? []).map((entry) => entry.industry);
  const employees = brand.employees?.exact ? String(brand.employees.exact) : (brand.employees?.range ?? null);
  const socials = (brand.socials ?? []).filter((social) => social.url).map((social) => ({ type: social.type ?? "link", url: social.url! }));
  const logo = brand.logos?.find((one) => one.type === "logo")?.url ?? brand.logos?.[0]?.url ?? null;
  const lines = [
    `${name}${brand.domain ? ` (${brand.domain})` : ""}${brand.description ? `: ${brand.description}` : ""}`,
    brand.slogan && `“${brand.slogan}”`,
    industries.length > 0 && `Industry: ${[...new Set(industries)].join(", ")}`,
    place && `Based in ${place}`,
    employees && `Employees: ${employees}`,
    socials.length > 0 && `Elsewhere: ${socials.map((social) => social.url).join(", ")}`,
  ].filter(Boolean);
  return {
    text: lines.join("\n"),
    data: { found: true, name, domain: brand.domain ?? null, description: brand.description ?? null, slogan: brand.slogan ?? null, industries, place: place || null, employees, phone: brand.phone ?? null, email: brand.email ?? null, socials, logo },
    credits: credits(found),
  };
}

/** What went wrong, in plain words, with the key never in it. */
function plainly(error: unknown, key: string): Error {
  if (error instanceof APIConnectionTimeoutError) return new Error("context.dev took too long; try again in a moment.");
  if (error instanceof APIConnectionError) return new Error("Can't reach context.dev.");
  if (error instanceof APIError) {
    const code = errorCode(error);
    if (error.status === 401 && code === "USAGE_EXCEEDED") return new Error("context.dev's credits for this key are used up for the month.");
    if (error.status === 401) return new Error("context.dev didn't accept the key.");
    if (error.status === 429) return new Error("context.dev is busy with this key's other requests (its plans allow only a few at once); try again in a moment.");
    const said = (error.error as { message?: unknown } | undefined)?.message;
    return new Error(`context.dev said: ${(typeof said === "string" ? said : error.message).replaceAll(key, "[key]")}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** Does one task on context.dev. */
export async function contextDev(key: string, task: ContextDevTask, options: ContextDevOptions = {}): Promise<ContextDevResult> {
  const api = new ContextDev({ apiKey: key, maxRetries: 1, timeout: 90_000, ...(options.fetcher ? { fetch: options.fetcher } : {}) });
  try {
    if (task.kind === "read") return await read(api, task.url, task.question, options.signal);
    if (task.kind === "search") return await search(api, task.query, options.signal);
    return await company(api, task.by, task.value, options.signal);
  } catch (error) {
    throw plainly(error, key);
  }
}
