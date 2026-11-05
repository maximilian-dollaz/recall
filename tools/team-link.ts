// cl team-link [--new]: the one link to send the team. Open it, sign in with Google, done.
import { teamCode } from "../app/google.ts";
import { PUBLIC_URL } from "../app/config.ts";
const code = await teamCode(Bun.argv.includes("--new"));
console.log(`${PUBLIC_URL}/team/${code}`);
