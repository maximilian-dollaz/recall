# Setting up Recall and the Soul Map with an AI assistant

This page is written for an AI assistant (ChatGPT, Claude or any other) that is helping a person set up **Recall** and the **Soul Map** on their Mac. The person runs each step; you guide them. Read the whole page before your first reply.

## Rules for the assistant

1. **One step at a time.** Give one step, then wait for the person's reply, screenshot or Terminal output before the next.
2. **Use the exact commands on this page.** Don't add commands of your own. In particular, never suggest `caffeinate`, `sudo`, `brew`, or editing any file. `caffeinate` keeps running until it's stopped, so the next command never runs.
3. **Never ask for passwords, API keys or codes in chat.** Each one is typed or pasted straight into the page or window that asks for it.
4. **Recall runs online** at https://recall.nextmissionsi.com. Nothing of Recall installs except two small add-ons: the Save to Recall shortcut and, optionally, Recall for Chrome. Only the Soul Map installs as an app.
5. **Plain words.** Name exactly what to click and where. Say what the person should see when it worked.
6. **If the same step fails twice,** stop and tell the person to send a screenshot to the person who sent them the Recall invite.
7. **If a window asks for something this page doesn't list** (Full Disk Access, other apps, other folders, an admin password), the person clicks **Don't Allow** and sends a screenshot.
8. **Money is the person's own step.** Adding credit on Anthropic's site is optional and done by them; you never handle payment details.

## What the person needs

- A Mac (macOS 13 or newer) with about 3 GB free.
- The Recall invite link they were sent (it looks like `https://recall.nextmissionsi.com/invite/...`). No link, or it says it doesn't work: ask the person who shared Recall for a new one. Part 1 doesn't need it.
- Google Chrome or Safari, and a Google account.
- About 15 minutes.

## Part 1: The Soul Map (installs on the Mac)

**Step 1. Open Terminal.**
Press ⌘ Space, type `Terminal`, press Return. A window with a text line opens.
If an older Terminal window is still busy (for example, running `caffeinate`), click it and press Control-C, or close it.

**Step 2. Run the installer.** Paste this one line and press Return:

```
curl -fsSL https://soulmap.nextmissionsi.com/install.sh | bash
```

- To read the installer first, open https://soulmap.nextmissionsi.com/install.sh in the browser. The code is public at https://github.com/maximilian-dollaz/soulmap.
- It needs no admin password and no keys. It takes 3 to 8 minutes. The window stays quiet for a few minutes while it says "Building the app". That is normal.
- **It worked** when the last lines say `The Soul Map is running: http://localhost:3355/soul` and the page opens in the browser.
- If a window asks to install "command line developer tools", click **Not Now**. The installer doesn't need them.
- If it says `The install stopped before it finished`, run the same line again (at most twice). It picks up where it stopped; anything it left behind is reused.
- If it says `The app did not start`, paste this and send the person's output to the person who invited them:
  ```
  tail -20 ~/.soulmap/logs/com.soulmap.app.err
  ```

**Step 3. Onboarding in the browser.** If the page didn't open by itself, open http://localhost:3355/soul. The person answers the questions on screen. One screen asks who does the thinking:
- **Claude (recommended):** needs an Anthropic API key. The person creates it at https://console.anthropic.com (Billing: add $5, then Settings → API keys → Create key) and pastes it **into the Soul Map page**, never into chat. About 30 cents a report.
- **Only this Mac:** free and fully private. A one-time download of about 5 GB.

After the install, the Soul Map starts by itself when the Mac starts, and updates itself once a day.

## Part 2: Recall (online, nothing to install)

**Step 1. Sign in.** Open the invite link in **Chrome or Safari**. Not inside Gmail, WhatsApp, Instagram or Messages: Google sign-in doesn't work in those apps' built-in browsers. If the page says **Open in Safari**, tap it.
Click **Sign in with Google**. A new person's library is made the first time.
- "doesn't have a Recall account yet": open the invite link again in this same browser, then sign in.
- "Access blocked": tell the person who invited them. They add the Google account.

**Step 2. The welcome page** opens after sign-in. It walks through each step with a picture. On a Mac:
1. Click **Add Recall Shortcut**. A file named `Save to Recall.shortcut` downloads.
2. Open the download, then click **Add Shortcut**.
3. Back on the welcome page, click **Open in Shortcuts**, then **Open Shortcuts**.
4. Click **ⓘ**, then **Add Keyboard Shortcut**, then press **⌃⌥S** (Control, Option, S).
5. Click **Done**, name up to 3 main projects (or Skip), then connect Granola or Otter (or Skip). Connecting signs in to that meeting app so meetings save to Recall on their own; it is optional.

Only add **one** Save to Recall shortcut. Each copy carries its own key to the library of the person who downloaded it. Files the person downloaded from their own welcome page are theirs: use the newest and delete the rest. A shortcut file someone else sent them saves to that other person's library: delete it. A `recall-chrome.zip` downloaded earlier is fine to use.

**Permissions the shortcut asks for, and why:**
- **Allow "Save to Recall" to connect to recall.nextmissionsi.com** → **Always Allow.** That is how a save reaches the person's library.
- **Access to the clipboard or selected files** → **Allow.** It saves what was copied or selected, only when ⌃⌥S is pressed.

If ⌃⌥S is already used by another app, pick another combination in the same place.

**To save:** copy an image, link or text (or select files in Finder), then press ⌃⌥S and say or type what it is.

**Step 3 (optional). Recall for Chrome:** right-click anything on a web page → Add to Recall.
1. Open https://recall.nextmissionsi.com/extension and click **Download**.
2. Double-click `recall-chrome.zip` in Downloads. A `recall-chrome` folder appears.
3. Go to `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, choose the `recall-chrome` folder.
4. When it asks for the microphone, click **Allow** (only used when the person speaks a note).

**Permissions the extension has, and why:**
- Right-click menu: to show Add to Recall.
- The page right-clicked, only at that moment: to save that page.
- Storage: to remember the person's Recall.
- recall.nextmissionsi.com: where saves go.
- Google Docs and Drive: optional, only when saving from them.

Chrome may show a "developer mode extensions" notice when it starts. That is expected for extensions installed this way.

## Done when

- http://localhost:3355/soul opens the Soul Map, and
- the person pressed ⌃⌥S once and the item shows in Recall at https://recall.nextmissionsi.com.

## For the person: what to paste into ChatGPT

```
Help me set up Recall and the Soul Map on my Mac. Read this page first and follow it exactly, one step at a time:
https://raw.githubusercontent.com/maximilian-dollaz/recall/main/AI-SETUP.md
```
