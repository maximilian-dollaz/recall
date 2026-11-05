// Thin client for the shared GBrain server (MCP over HTTP). Each person has their
// own client credential (app → Max's "default" source, app-pat → "pat", …),
// read through bin/gbrain-mcp-headers so no secret lives in this code.

import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const URL = process.env.GBRAIN_URL ?? "http://127.0.0.1:3131/mcp";

export type Scope = { client: string; source: string };
export const OWNER: Scope = { client: "app", source: "default" };
export function scopeFor(source: string): Scope { return source === "default" ? OWNER : { client: `app-${source}`, source }; }

const cached = new Map<string, { auth: string; at: number }>();
async function auth(client: string): Promise<string> {
  const c = cached.get(client);
  if (c && Date.now() - c.at < 5 * 60_000) return c.auth;
  const proc = Bun.spawn([join(ROOT, "bin/gbrain-mcp-headers"), client], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`no library credential for ${client}: ` + (await new Response(proc.stderr).text()));
  const a = JSON.parse(out).Authorization;
  cached.set(client, { auth: a, at: Date.now() });
  return a;
}

let id = 0;
export async function callTool<T = unknown>(name: string, args: Record<string, unknown> = {}, scope: Scope = OWNER): Promise<T> {
  const res = await fetch(URL, {
    method: "POST", signal: AbortSignal.timeout(60_000),
    headers: { Authorization: await auth(scope.client), "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: { source_id: scope.source, ...args } } }),
  });
  const raw = await res.text();
  const line = raw.split("\n").map((l) => l.replace(/^data: /, "")).find((l) => l.startsWith("{"));
  if (!line) throw new Error(`library server gave no JSON (${res.status})`);
  const msg = JSON.parse(line);
  if (msg.error) throw new Error(msg.error.message ?? JSON.stringify(msg.error));
  const text = msg.result?.content?.find((c: any) => c.type === "text")?.text ?? "";
  if (msg.result?.isError) throw new Error(text || "library tool error");
  try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
}

export type Hit = { slug: string; title: string; type: string; chunk_text?: string; score?: number };

export async function search(scope: Scope, query: string, limit = 12): Promise<Hit[]> {
  const r = await callTool<any>("query", { query, limit, snippet_chars: 240, autocut: true }, scope);
  return Array.isArray(r) ? r : [];
}
export async function keyword(scope: Scope, query: string, limit = 8): Promise<Hit[]> {
  const r = await callTool<any>("search", { query, limit, snippet_chars: 240 }, scope);
  return Array.isArray(r) ? r : [];
}
export async function listPages(scope: Scope, opts: { slug_prefix?: string; tag?: string; type?: string; limit?: number } = {}) {
  const r = await callTool<any>("list_pages", { limit: 100, sort: "updated_desc", ...opts }, scope);
  return Array.isArray(r) ? r : r?.pages ?? r?.rows ?? [];
}
export async function getPage(scope: Scope, slug: string) {
  return callTool<any>("get_page", { slug, include_content: true }, scope);
}
export async function putPage(scope: Scope, slug: string, content: string) {
  return callTool<any>("put_page", { slug, content, content_origin: "user_said", force: true }, scope);
}
export async function deletePage(scope: Scope, slug: string) {
  return callTool<any>("delete_page", { slug, force: true }, scope);
}
export async function removeTag(scope: Scope, slug: string, tag: string) {
  return callTool("remove_tag", { slug, tag }, scope);
}
export async function addTag(scope: Scope, slug: string, tag: string) {
  return callTool<any>("add_tag", { slug, tag }, scope);
}
