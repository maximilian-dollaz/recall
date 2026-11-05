// This install's own settings: its web address, its owner, its contact. They live in `.env` next to
// the code (never in git; `.env.example` lists them), so the same code runs anyone's Recall.
// Real environment variables win over `.env`.
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { CODE } from "./paths.ts";

const file = join(CODE, ".env");
if (existsSync(file)) for (const line of readFileSync(file, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (!m || Bun.env[m[1]] !== undefined) continue;
  Bun.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
}

/** The address people open Recall at, e.g. https://recall.example.com. Locally, the Mac's own port. */
export const PUBLIC_URL = (Bun.env.RECALL_PUBLIC_URL ?? "http://localhost:3344").replace(/\/$/, "");
export const PUBLIC_HOST = new URL(PUBLIC_URL).host;
/** The Google account that owns this install: its library is the main one, and it can invite. */
export const OWNER_EMAIL = (Bun.env.RECALL_OWNER_EMAIL ?? "owner@example.com").toLowerCase();
/** The owner's first name, as people see it ("Ask Max for a new link"), and who runs this install (privacy page). */
export const OWNER_NAME = Bun.env.RECALL_OWNER_NAME ?? "the owner";
export const OPERATOR = Bun.env.RECALL_OPERATOR ?? OWNER_NAME;
/** Where people write to have their library deleted (shown on the privacy page). */
export const CONTACT_EMAIL = Bun.env.RECALL_CONTACT_EMAIL ?? OWNER_EMAIL;
/** The sender of invite emails (Resend), e.g. Recall <invites@example.com>. */
export const INVITE_FROM = Bun.env.RECALL_INVITE_FROM ?? `Recall <invites@${PUBLIC_HOST.replace(/^recall\./, "")}>`;
/** The team's first board: its name, and the id it is stored under. */
export const TEAM_NAME = Bun.env.RECALL_TEAM_NAME ?? "Team";
export const TEAM_ID = Bun.env.RECALL_TEAM_ID ?? "team";
/** The Mac's private https name on Tailscale, for phones on the private network (optional). */
export const TAILNET_HOST = Bun.env.CL_HTTPS_HOST ?? "";
