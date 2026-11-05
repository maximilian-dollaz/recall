// Add a document (md, txt, docx, pdf, html) to the library as a markdown page.
// Usage: bun add-doc.ts <file> [--type note|writing|media] [--prefix docs]
// Prints the page slug on success.

import { basename, extname } from "node:path";
import mammoth from "mammoth";
import TurndownService from "turndown";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const file = process.argv[2];
if (!file) {
  console.error("usage: add-doc <file> [--type note|writing|media] [--prefix docs]");
  process.exit(2);
}
const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] ?? dflt : dflt;
};
const type = arg("--type", "note");
const prefix = arg("--prefix", "docs");
const noDate = process.argv.includes("--no-date"); // imports: the title alone is the name

const ext = extname(file).toLowerCase();
const base = basename(file, extname(file));
const today = new Date().toISOString().slice(0, 10);
const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

async function toMarkdown(): Promise<string> {
  switch (ext) {
    case ".md":
    case ".markdown":
    case ".mdx":
    case ".txt":
      return await Bun.file(file).text();
    case ".docx": {
      const buf = Buffer.from(await Bun.file(file).arrayBuffer());
      // Drop embedded images: as base64 text they bloat a page 100x and index as noise.
      const { value } = await mammoth.convertToHtml(
        { buffer: buf },
        { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) }
      );
      return td.turndown(value);
    }
    case ".html":
    case ".htm": {
      const html = await Bun.file(file).text();
      const dom = new JSDOM(html);
      const article = new Readability(dom.window.document).parse();
      return td.turndown(article?.content ?? html);
    }
    case ".pdf": {
      const bin = Bun.which("pdftotext") ?? "/opt/homebrew/bin/pdftotext";
      const proc = Bun.spawn([bin, "-layout", file, "-"], { stdout: "pipe", stderr: "pipe" });
      const text = await new Response(proc.stdout).text();
      if ((await proc.exited) !== 0) throw new Error("pdftotext failed (install poppler)");
      return text;
    }
    default:
      throw new Error(`unsupported file type: ${ext}`);
  }
}

let body: string;
try {
  body = (await toMarkdown()).trim();
} catch (e) {
  console.error(`skip ${file}: ${(e as Error).message}`);
  process.exit(1);
}
if (body.length < 20) {
  console.error(`skip ${file}: no readable text`);
  process.exit(1);
}

// Strip a frontmatter block the file already carries so we can write our own.
let existing = body.startsWith("---") ? body.replace(/^---[\s\S]*?\n---\n?/, "") : body;
// Belt and braces: remove any inline data-URI images and empty image tags from any source.
existing = existing.replace(/!\[[^\]]*\]\(data:[^)]*\)/g, "").replace(/!\[[^\]]*\]\(\)/g, "");

// Mask anything that looks like a secret before it reaches the library.
const redactions: [RegExp, string][] = [
  [/\b(sk|pk|rk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9]{16,}/g, "[redacted key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted key]"],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[redacted key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, "[redacted token]"],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, "[redacted token]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
  [/\b(password|passwd|pwd)(\s*[:=]\s*)\S{4,}/gi, "$1$2[redacted]"],
];
let redacted = 0;
for (const [re, rep] of redactions) existing = existing.replace(re, (m) => { redacted++; return typeof rep === "string" ? m.replace(re, rep) : rep; });
if (redacted) console.error(`  (${redacted} secret-looking value${redacted > 1 ? "s" : ""} masked in ${basename(file)})`);
const slugBase = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const slug = noDate ? `${prefix}/${slugBase || "doc"}` : `${prefix}/${today}-${slugBase || "doc"}`;

const page = [
  "---",
  `title: ${JSON.stringify(base)}`,
  `type: ${type}`,
  `source_file: ${JSON.stringify(basename(file))}`,
  `added: ${today}`,
  "---",
  "",
  existing.trim(),
  "",
].join("\n");

const proc = Bun.spawn(
  ["gbrain", "capture", "--stdin", "--slug", slug, "--type", type, "--force", "--quiet"],
  { stdin: new TextEncoder().encode(page), stdout: "pipe", stderr: "pipe" }
);
const out = await new Response(proc.stdout).text();
const err = await new Response(proc.stderr).text();
if ((await proc.exited) !== 0) {
  console.error(err || out);
  process.exit(1);
}
console.log(out.trim() || slug);
