import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { MiddlewareHandler } from "hono";

/**
 * Serves the built web app from `root`. The app routes with the hash (/#/flows/...), so a path like
 * /flows/abc is sent there instead; a file that isn't there is a 404, never the page in its place.
 */

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Paths that belong to the server, never the app. */
const SERVER = /^\/(api|hooks|a2a|mcp|v1|\.well-known)(\/|$)/;

export function webApp(root: string): MiddlewareHandler {
  const base = normalize(root);
  return async (c, next) => {
    if ((c.req.method !== "GET" && c.req.method !== "HEAD") || SERVER.test(c.req.path)) return next();
    let path: string;
    try {
      path = decodeURIComponent(c.req.path);
    } catch {
      return next();
    }
    const wanted = normalize(join(base, path));
    const inside = wanted.startsWith(base + sep);
    const found = inside && (await stat(wanted).catch(() => null))?.isFile();
    if (!found && path !== "/") {
      if (extname(path) || !inside) return next();
      const query = new URL(c.req.url).search;
      return c.redirect(`/#${path}${query}`, 302);
    }
    const file = found ? wanted : join(base, "index.html");
    const body = await readFile(file).catch(() => null);
    if (!body) return next();
    const hashed = file.includes(`${sep}assets${sep}`);
    return c.body(body, 200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
    });
  };
}
