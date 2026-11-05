// The Soul Map door. The Soul Map (../soul-map/app, a Next.js app with
// basePath "/soul") runs on this Mac as its own launchd service on 127.0.0.1:3355.
// Phones reach it through Recall's public gate on :3344: every path under /soul is
// handed over unchanged, with the person resolved exactly as the rest of the gate
// resolves them (the network address, or the login tailscale serve attaches).
// The Soul Map trusts the x-person header, so it is never taken from the network.

import { whoIs } from "./identity.ts";
import { OWNER_NAME } from "./config.ts";

export const SOUL_URL = (Bun.env.CL_SOUL_URL ?? "http://127.0.0.1:3355").replace(/\/$/, "");

/** True for /soul and anything below it (not /soulful). */
export function isSoulPath(pathname: string) { return pathname === "/soul" || pathname.startsWith("/soul/"); }

const plain = (msg: string, status: number) => new Response(msg, { status, headers: { "content-type": "text/plain" } });

/**
 * Forward one request to the Soul Map. `ip` is the client address the gate saw;
 * `local` means it came from this Mac (the owner, or tailscale serve on their behalf).
 */
export async function soulProxy(req: Request, u: URL, ip: string, local: boolean): Promise<Response> {
  // Same resolution as the inner server's who(): local requests may carry the
  // https proxy's login (or x-person for local testing); the network never may.
  const override = local ? (req.headers.get("tailscale-user-login") || req.headers.get("x-tailscale-login") || req.headers.get("x-person")) : null;
  const person = await whoIs(local ? "127.0.0.1" : ip, override);
  if (!person) return plain(`Your phone is on the network but isn't set up in the library yet. Ask ${OWNER_NAME} to add you.`, 401);

  const headers = new Headers(req.headers);
  headers.delete("x-person"); headers.delete("x-tailscale-login"); headers.delete("tailscale-user-login");
  headers.set("x-person", person.id);
  headers.set("x-person-name", person.name);
  headers.set("x-client-ip", ip);
  headers.set("x-forwarded-host", u.host);
  headers.set("x-forwarded-proto", u.protocol.replace(":", ""));
  // Hop-by-hop headers must not be forwarded; Next does not need them either.
  for (const h of ["connection", "keep-alive", "upgrade", "transfer-encoding", "host"]) headers.delete(h);

  // The Soul Map lets ?p= pick a profile, ahead of the x-person header set above. Never pass it through.
  const q = new URLSearchParams(u.search); q.delete("p");
  const search = q.toString() ? `?${q}` : "";
  const upstream = new Request(`${SOUL_URL}${u.pathname}${search}`, {
    method: req.method, headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual", // the phone's browser follows redirects, not this gate
    duplex: "half",
  } as any);
  try {
    return await fetch(upstream);
  } catch (e) {
    console.error(`[soul] upstream ${SOUL_URL} unreachable: ${e}`);
    return plain(`The Soul Map isn't running on this Mac. Ask ${OWNER_NAME} to run: cl soul start`, 502);
  }
}
