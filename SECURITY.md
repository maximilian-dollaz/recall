# Security

Recall holds people's private libraries, so security reports matter.

## Report a vulnerability

Please do not open a public issue. Use GitHub's private report instead: the repository's **Security** tab → **Report a vulnerability**. Say what you found, how to reproduce it, and what it exposes.

You'll get a reply within 7 days. Once it's fixed, the fix and your credit (if you want it) go in the release notes.

## What counts

- Anyone reading or changing a library that isn't theirs.
- A way past sign-in, an invite link, or a save key.
- Anything that sends saved items, keys or voice outside the Mac without the person turning it on.
- A secret committed to this repository.

## Running your own Recall safely

- Keep `.env`, `~/.gbrain/` and the `library/` and `libraries/` folders private and backed up.
- Reach it from outside through a Cloudflare tunnel or Tailscale, never by opening a port.
- Retire a leaked team link with `cl team-link --new`.
