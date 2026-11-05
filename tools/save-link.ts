// Save a web page into the library as a readable markdown page.
// Usage: bun save-link.ts <url> [--note "why this matters"]
// Prints the page slug on success.

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const url = process.argv[2];
if (!url || !/^https?:\/\//.test(url)) {
  console.error("usage: save-link <url> [--note \"...\"]");
  process.exit(2);
}
const noteIdx = process.argv.indexOf("--note");
const note = noteIdx > -1 ? process.argv[noteIdx + 1] ?? "" : "";

const res = await fetch(url, {
  headers: { "user-agent": "Mozilla/5.0 (Macintosh) context-library/0.1" },
  redirect: "follow",
});
if (!res.ok) {
  console.error(`fetch failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const html = await res.text();
const dom = new JSDOM(html, { url });
const article = new Readability(dom.window.document).parse();
const title = (article?.title || dom.window.document.title || url).trim();
const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
const body = article?.content ? td.turndown(article.content) : td.turndown(html);

const today = new Date().toISOString().slice(0, 10);
const slugBase = title
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "")
  .slice(0, 60);
const slug = `links/${today}-${slugBase || "page"}`;

const page = [
  "---",
  `title: ${JSON.stringify(title)}`,
  "type: source",
  `url: ${url}`,
  `saved: ${today}`,
  article?.byline ? `author: ${JSON.stringify(article.byline)}` : null,
  article?.siteName ? `site: ${JSON.stringify(article.siteName)}` : null,
  "---",
  "",
  note ? `> ${note}\n` : null,
  `Source: ${url}`,
  "",
  body.trim(),
  "",
]
  .filter((l) => l !== null)
  .join("\n");

const proc = Bun.spawn(
  ["gbrain", "capture", "--stdin", "--slug", slug, "--type", "source", "--force", "--quiet"],
  { stdin: new TextEncoder().encode(page), stdout: "pipe", stderr: "pipe" }
);
const out = await new Response(proc.stdout).text();
const err = await new Response(proc.stderr).text();
if ((await proc.exited) !== 0) {
  console.error(err || out);
  process.exit(1);
}
console.log(out.trim() || slug);
