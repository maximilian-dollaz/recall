// cl invite <name> [email] [browsers]: a personal link to this Recall (RECALL_PUBLIC_URL).
import { mintInvite } from "../app/door.ts";
import { PUBLIC_URL } from "../app/config.ts";
const [name, email, uses] = Bun.argv.slice(2);
if (!name) { console.error("usage: cl invite <name> [email] [browsers, default 3]"); process.exit(1); }
const token = await mintInvite(name, email || undefined, uses ? Number(uses) : 3);
console.log(`${PUBLIC_URL}/join/${token}`);
