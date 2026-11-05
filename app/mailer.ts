// Email from Recall, through Resend (resend.com): only invites, only to the addresses the inviter typed.
// On once Max has pasted a Resend key on the Keys page and Resend has verified the sending domain; until then
// `ready()` is false and the invite box hands back a ready email to send yourself instead.
// The sender is library/settings.json {"inviteFrom": "..."}, else RECALL_INVITE_FROM.
// Replies go to the person who sent the invite.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA as ROOT } from "./paths.ts";
import { INVITE_FROM } from "./config.ts";

const KEY = join(Bun.env.HOME ?? "", ".gbrain/serve/resend.key");
const key = () => { try { return readFileSync(KEY, "utf8").trim(); } catch { return ""; } };
const from = () => { try { return String(JSON.parse(readFileSync(join(ROOT, "library/settings.json"), "utf8")).inviteFrom || ""); } catch { return ""; } } ;
export const ready = () => existsSync(KEY) && key().startsWith("re_");

/** Send one plain email. Throws with Resend's reason when it isn't sent. */
export async function send(to: string, subject: string, text: string, replyTo?: string): Promise<void> {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${key()}`, "content-type": "application/json" },
    body: JSON.stringify({ from: from() || INVITE_FROM, to: [to], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
