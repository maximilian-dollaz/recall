# The always-on server

Why: the library and the librarian run wherever the app runs. On a laptop that means "works while the lid is open." On a server it works all the time, for everyone, and a laptop becomes just another client.

## What to buy (prices checked 27 Oct 2026)

Hetzner raised its US cloud prices in June 2026 (the CPX41 in Ashburn I first wrote down is now €120.99/month). The server does background work nobody waits on, so distance does not matter; memory does. 8 GB is the floor for the two local models.

**Cheapest that I trust: Hetzner CAX21, Germany (Falkenstein or Nuremberg). 4 ARM cores, 8 GB, 80 GB. €10.49/month, no contract.** Everything in this project runs on ARM Linux (Bun, Ollama, GBrain, tesseract, faster-whisper).

**Cheapest overall: Contabo Cloud VPS 4. 4 vCPU, 8 GB, 100 GB. €5.50/month on a 24-month term (monthly term costs more; check at checkout).** US locations available. Cores are shared more aggressively, so filing a photo takes longer; fine for background work. Less reliable reputation than Hetzner.

**€0: keep the Mac awake** (`sudo pmset -a disablesleep 1`, lid closed, on power). Fails whenever the laptop travels.

Not worth it now: Hetzner US (CPX31 €62.99), DigitalOcean/Vultr ($40 to $48 for 8 GB), a hosted Mac mini (~$100). A used Mac mini at the lounge (~$400 once) beats all of these on speed and has no monthly bill, but depends on the lounge's power and internet.

## Steps (you)

1. **Account:** https://www.hetzner.com/cloud → Sign up → add a payment method. (The part only you can do.)
2. **Project** → **Add Server** → Location **Falkenstein** or **Nuremberg** → Image Ubuntu 24.04 → Type Shared vCPU, **Arm64**, **CAX21** → SSH key: paste the key below → Create.
3. Send me the server's IP. Everything from there is mine: run `server/provision.sh`, restore the libraries, join it to the private network, repoint the phones.

Your Mac's public SSH key (add it in step 2):

```
ssh-ed25519 AAAA… (your Mac's public key: cat ~/.ssh/id_ed25519.pub)
```

## What moves and what doesn't

- **Moves:** the GBrain brain, every person's library folders, the app, the models.
- **Stays private:** the server joins the same Tailscale network; nothing is opened to the internet. Phones use the server's Tailscale name instead of the Mac's address (the Shortcut URL changes once).
- **Your Mac afterwards:** Claude Code points at the server's GBrain; `cl` commands work the same.

## Costs to expect

About €10.49/month for the server. No other recurring cost: models are local, Tailscale is free at this size.
