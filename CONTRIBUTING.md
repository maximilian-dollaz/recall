# Contributing to Recall

Thank you for helping. Recall is built in the open, and every change here is public.

## Report a problem or ask for a feature

Open an issue. Say what you did, what you expected, and what happened. A screenshot helps.

## Change the code

1. Fork the repo and install it on your Mac (`zsh install.sh`).
2. Make the change, and try it on the twin: `cl twin start`, then http://localhost:4344. The twin runs your code against a scratch library, so your real one is never touched.
3. Run the tests for what you changed: `bun test tests/<file>.test.ts`.
4. Open a pull request: what it changes, why, and how you tested it.

## How Recall is built

- **Non-resistance.** Count every tap, sign-in, question and decision a person meets. Remove each one that isn't needed.
- **Useful, not fancy.** Solve a real problem someone has today.
- **What people say wins.** The system sorts; a person's words and moves always override it.
- **Plain words on screen.** Say exactly what a thing is or does. Not clever, not cute.
- **Private by default.** Nothing leaves the Mac unless the person turns it on.
- Read [ARCHITECTURE.md](ARCHITECTURE.md) first, and [STORY.md](STORY.md) for why things are the way they are.

## Never commit

Keys, tokens, passwords, anyone's saves, people's names or emails, or `.env`. The pre-commit hook (`tools/check-public.ts`) catches the common cases; put your own private words in `private/denylist.txt` (gitignored) and it will catch those too.

## License

By contributing, you agree your work is released under the [MIT License](LICENSE).
