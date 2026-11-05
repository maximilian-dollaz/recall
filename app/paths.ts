// Where the code lives and where the data lives. They are the same folder in production.
// The twin (`cl twin`) runs this same code against a scratch data folder on other ports,
// so tests never touch anyone's real library.
import { join } from "node:path";

export const CODE = join(import.meta.dir, "..");
export const DATA = Bun.env.RECALL_DATA ?? CODE;
export const TWIN = !!Bun.env.RECALL_DATA;
export const PORTS = {
  gate: Number(Bun.env.RECALL_PORT_GATE ?? 3344),
  inner: Number(Bun.env.RECALL_PORT_INNER ?? 3345),
  door: Number(Bun.env.RECALL_PORT_DOOR ?? 3346),
};
