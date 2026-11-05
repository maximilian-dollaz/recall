// Librarian: propose a category, GBrain page type, tags and a one-line summary for a page.
// Runs locally through Ollama; nothing leaves the Mac.
// Usage: echo '{"title":"...","notes":"...","text":"...","filename":"..."}' | bun librarian.ts
// Prints {"category","type","tags","summary"} as JSON.

export const CATEGORY_TYPE = {
  inspiration: "source",
  projects: "project",
  people: "person",
  companies: "company",
  writing: "writing",
  skills: "guide",
  reference: "note",
  personal: "diary",
} as const;

export type Category = keyof typeof CATEGORY_TYPE;
export const CATEGORIES = Object.keys(CATEGORY_TYPE) as Category[];

export interface LibrarianInput {
  title: string;
  notes?: string;
  text: string;
  filename?: string;
}

export interface LibrarianOutput {
  category: Category;
  type: (typeof CATEGORY_TYPE)[Category];
  tags: string[];
  summary: string;
}

const OLLAMA = (process.env.LIBRARIAN_OLLAMA_URL ?? "http://localhost:11434").replace(/\/v1\/?$/, "");
const MODEL = process.env.LIBRARIAN_MODEL ?? "qwen3:4b";
const MAX_TEXT = 6000;

// Who the library belongs to, in a sentence (from .env), so the model knows whose work "projects" means.
const OWNER = Bun.env.RECALL_OWNER_ABOUT ?? `${Bun.env.RECALL_OWNER_NAME ?? "The owner"} is a founder and builder.`;
const SYSTEM = `You file pages into ${Bun.env.RECALL_OWNER_NAME ?? "the owner"}'s private library. ${OWNER}

Pick exactly one category:
- inspiration: saved articles, quotes, ideas from others, references that inspire the owner's work
- projects: plans, specs, roadmaps, briefs, proposals or notes about something the owner is building or running
- people: a page mainly about one specific person (bio, contact notes, meeting notes about them)
- companies: a page mainly about one specific company or organization (profile, research, prospect notes)
- writing: things the owner wrote to be read by others: essays, scripts, posts, letters, stories, speeches
- skills: how-to guides, tutorials, checklists, processes, learning notes about doing something
- reference: factual material to look up later: lists, records, forms, templates, data, admin docs
- personal: journal entries, reflections, goals, health, family, private life

Tie-breakers:
- Transcripts or notes of someone else's video, podcast, talk or call recording (often timestamped, e.g. "0:02") are inspiration, even if the topic is sales or a business the owner works in.
- Essays, manifestos, philosophies or principles the owner wrote in his own voice are writing, not inspiration or projects.
- SOPs, templates, style guides and step-by-step processes are skills, even when they belong to a project.
- Use projects only for a concrete thing the owner is building or running (plans, roadmaps, specs, offers, strategy for that venture).
- Notes from a sales call with a prospect are companies (or people if they are about the person, not the business).

Tags: 2 to 5 short lowercase topic tags (one or two words each, hyphenated), specific to the content. No generic tags like "document", "notes" or "misc".
Summary: one plain sentence under 30 words saying what the page is.
Reply with JSON only: {"category": "...", "tags": ["..."], "summary": "..."}`;

const SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: CATEGORIES },
    tags: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5 },
    summary: { type: "string" },
  },
  required: ["category", "tags", "summary"],
};

function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    const tag = String(t)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 5);
}

function clampWords(s: string, max: number): string {
  const words = s.trim().split(/\s+/).filter(Boolean);
  if (words.length < max) return words.join(" ");
  return words.slice(0, max - 1).join(" ").replace(/[,;:]$/, "") + "…";
}

export async function classify(input: LibrarianInput): Promise<LibrarianOutput> {
  const text = (input.text ?? "").slice(0, MAX_TEXT);
  const user = [
    `Title: ${input.title || "(none)"}`,
    input.filename ? `Filename: ${input.filename}` : "",
    input.notes ? `The owner's note: ${input.notes}` : "",
    `Text:\n${text || "(empty)"}`,
  ]
    .filter(Boolean)
    .join("\n");

  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      think: false,
      stream: false,
      format: SCHEMA,
      options: { temperature: 0, num_ctx: 8192 },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { message?: { content?: string } };
  const raw = data.message?.content ?? "";
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`model returned non-JSON: ${raw.slice(0, 200)}`);
  }

  const category: Category = CATEGORIES.includes(parsed.category) ? parsed.category : "reference";
  let tags = cleanTags(parsed.tags);
  if (tags.length < 2) tags = [...tags, category].slice(0, 2);
  return {
    category,
    type: CATEGORY_TYPE[category],
    tags,
    summary: clampWords(String(parsed.summary ?? ""), 30),
  };
}

if (import.meta.main) {
  const stdin = await Bun.stdin.text();
  let input: LibrarianInput;
  try {
    input = JSON.parse(stdin);
  } catch {
    console.error('usage: echo \'{"title":"...","notes":"...","text":"..."}\' | bun librarian.ts');
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(await classify(input)));
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
}
