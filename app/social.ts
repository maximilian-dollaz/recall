// Social scheduling through Metricool: a picture or video from Recall is put in Metricool's planner as a DRAFT.
// It never publishes. The person opens Metricool, reads it, and schedules it themselves.
//
//   The caption    is the person's own words, passed in by the caller and sent exactly as given. This file
//                  never writes, edits, trims or completes a caption. No words given: the draft goes with no
//                  caption, and the result says so.
//   Draft only     every post is sent with draft: true and autoPublish: false. There is no option to change that.
//   The key        ~/.gbrain/serve/metricool.key holds "userToken:userId:blogId" (owner-only, like the other
//                  service keys). The token is under Account settings, API in Metricool; the two ids are in the
//                  address bar when a brand is open.
//   Media          Metricool fetches media from public web addresses, so mediaUrls must be reachable without a sign-in.
//
// API (help.metricool.com, "Basic guide for API integration"): base https://app.metricool.com/api, the token in
// the X-Mc-Auth header, userId and blogId as query parameters, posts at POST /v2/scheduler/posts.
// Written without a key to test against: lines marked UNVERIFIED follow the docs but have not met a live account.

import * as files from "./connector-store.ts";

const BASE = "https://app.metricool.com/api";
export const NETWORKS = ["instagram", "linkedin", "facebook", "tiktok"] as const;
export type Network = (typeof NETWORKS)[number];
export type Post = { networks: Network[]; text: string; mediaUrls: string[]; when?: string };
export type Queued = { ok: boolean; draft: true; id?: string; captionSent: boolean; note: string; error?: string };
type Who = { id: string };
type Creds = { token: string; userId: string; blogId: string };

function creds(): Creds | null {
  const [token, userId, blogId] = files.key("metricool").split(":").map((s) => s.trim());
  return token && userId && blogId ? { token, userId, blogId } : null;
}
/** True when the key file holds all three parts. Nothing is sent to Metricool to find out. */
export const ready = () => !!creds();
export const NEEDS = "A Metricool API token, user id and brand id (saved as metricool.key)";

async function call(c: Creds, method: string, path: string, body?: unknown, query: Record<string, string> = {}): Promise<any> {
  const u = new URL(BASE + path);
  u.searchParams.set("userId", c.userId); u.searchParams.set("blogId", c.blogId);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const r = await fetch(u, { method, headers: { "X-Mc-Auth": c.token, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`Metricool answered ${r.status}: ${text.slice(0, 200)}`); // the answer, never the token
  try { return JSON.parse(text); } catch { return text; }
}

/** The brands this Metricool account can post to. */
export async function brands(): Promise<{ id: string; name: string }[]> {
  const c = creds(); if (!c) throw new Error(NEEDS);
  const list = await call(c, "GET", "/admin/simpleProfiles");
  // UNVERIFIED: the docs say only that each entry "includes its blogId"; the id and label field names are a best reading.
  return (Array.isArray(list) ? list : list?.data ?? []).map((b: any) => ({ id: String(b.id ?? b.blogId ?? ""), name: String(b.label ?? b.title ?? b.name ?? "") })).filter((b: { id: string }) => b.id);
}

/** A moment as Metricool wants it: wall-clock time in a named timezone. */
function localTime(at: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
const isVideo = (u: string) => /\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(u);

/** The request body for one draft. Kept apart from the sending so it can be read and tested on its own. */
export function buildDraft(post: Post, now = new Date(), tz = Bun.env.RECALL_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC") {
  const networks = [...new Set(post.networks)].filter((n): n is Network => (NETWORKS as readonly string[]).includes(n));
  if (!networks.length) throw new Error("Pick at least one of Instagram, LinkedIn, Facebook or TikTok.");
  const media = (post.mediaUrls ?? []).map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u));
  // Metricool wants a date on every post, drafts too, and it must be in the future. No date given: this time tomorrow.
  const asked = post.when ? new Date(post.when) : null;
  if (asked && isNaN(asked.getTime())) throw new Error("That date isn't one Recall can read.");
  const at = asked && asked.getTime() > now.getTime() + 60_000 ? asked : new Date(now.getTime() + 864e5);
  const video = media.some(isVideo);
  return {
    text: typeof post.text === "string" ? post.text : "", // the person's words, untouched; empty stays empty
    publicationDate: { dateTime: localTime(at, tz), timezone: tz },
    providers: networks.map((network) => ({ network })),
    media, saveExternalMediaFiles: true,
    draft: true as const,   // a draft, always
    autoPublish: false,     // and nothing here ever asks Metricool to publish on its own
    // Each network's own settings, left at Metricool's defaults.
    ...(networks.includes("instagram") ? { instagramData: { type: video ? "REEL" : "POST" } } : {}),
    ...(networks.includes("facebook") ? { facebookData: { type: video ? "REEL" : "POST" } } : {}),
    ...(networks.includes("linkedin") ? { linkedinData: {} } : {}),
    ...(networks.includes("tiktok") ? { tiktokData: {} } : {}),
  };
}

/** Put one draft in Metricool's planner. It is never published from here. */
export async function queuePost(person: Who, post: Post): Promise<Queued> {
  const captionSent = typeof post.text === "string" && post.text.length > 0;
  const said = captionSent ? "Draft saved in Metricool with your caption." : "Draft saved in Metricool with no caption. Write it in Metricool.";
  const c = creds(); if (!c) return { ok: false, draft: true, captionSent: false, note: "Not sent.", error: NEEDS };
  let body; try { body = buildDraft(post); } catch (e) { return { ok: false, draft: true, captionSent: false, note: "Not sent.", error: (e as Error).message }; }
  try {
    const r = await call(c, "POST", "/v2/scheduler/posts", body);
    const made = r?.data ?? r; // UNVERIFIED: the created post is expected under "data"
    console.log(`[social] ${person.id}: draft queued in Metricool for ${body.providers.map((p) => p.network).join(", ")}`);
    // If Metricool ever answers that it did not keep it as a draft, say so plainly instead of calling it done.
    if (made?.draft === false) return { ok: false, draft: true, id: made?.id != null ? String(made.id) : undefined, captionSent, note: "Metricool did not keep this as a draft. Open Metricool and check it now.", error: "not a draft" };
    return { ok: true, draft: true, id: made?.id != null ? String(made.id) : undefined, captionSent, note: said };
  } catch (e) {
    const error = String((e as Error).message ?? e).slice(0, 240);
    console.error(`[social] ${person.id}: ${error}`);
    return { ok: false, draft: true, captionSent: false, note: "Not sent.", error };
  }
}
