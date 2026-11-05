# The tree

The library is shaped like a tree. Context is the nutrient. It is pulled from reality, where life gets recorded, up through the trunk and out into finer and finer branches until it sits on a leaf where it can be found again.

```
                 leaves  ·  the items: a photo, a voice note, a link, a repo, a thought
              ╱  ╲  ╱  ╲
           twigs      twigs  ·  the finest grouping: "lobby lighting", "nightcap flight"
             ╲        ╱
          smaller branches  ·  "lobby", "menu", "past builds"
               ╲    ╱
          major branches  ·  Frequency Wellness Lounge · Zero Proof Lounge · True Nature Media · me
                 ║
               trunk  ·  one intake, one librarian, one search: everything passes through here
                 ║
  ═══════════════╬═══════════════  ground
            ╱    ║    ╲
         roots  roots  roots  ·  where life is already recorded: the phone's camera roll and share sheet,
                                 voice memos, notes apps, Google Docs, GitHub, Claude sessions, email
```

## Roots: where context comes from

Roots sit below ground, in the places people already record things. The system doesn't ask anyone to change where they capture; it grows a root into that place. Each root is a connector that pulls on its own: the share sheet on a phone, the camera roll, voice memos, a notes app, Google Docs, a GitHub account, Claude conversations. A root is "connected" or not; the Roots page shows which are, and what came through each one this week.

## Trunk: one way in, one way out

Everything a root pulls up passes through the trunk: the single notes box, the librarian that reads it, the one search that finds it. The trunk has no categories of its own. Its job is to make sure nothing that enters is lost (transcribed, described, dated, attributed to the root it came from) and then to send it out along the right branch.

## Branches: the shape each person and team grows

Branches are the categories, and they nest as deep as they need to. A major branch is usually a company, a space or a domain of life. It splits into smaller branches (lobby, menu, past builds), and those into twigs (lobby lighting, nightcap flight). The librarian files by walking: pick the major branch, then the branch under it, then the twig. Walking one step at a time is also what makes a small local model accurate.

Nobody is handed a finished tree. Onboarding plants a few major branches from real examples (the team's, once they exist) and the rest grows from use:

1. **Branches grow from leaves, not the other way round.** The librarian never creates a branch alone. When several leaves land close together with no branch to hold them, it proposes one. A person names it. Three leaves is the bar.
2. **People split and merge branches** in their own words. Renaming or merging moves the leaves and keeps the old names as tags, so nothing is lost.
3. **Corrections are remembered.** Move a leaf and the librarian sees that move next time it files something similar.
4. **A branch that goes quiet stays.** Nothing is pruned automatically; a person parks or merges it.

## Leaves: the items

A leaf is one thing you saved, with what you said about it, what the librarian understood, where it came from (its root), its state (idea, doing, done, parked) and when it should come back. The test for a leaf: can it be found from a plain description of it a month later? If not, it was never really saved. That's why a voice note is transcribed, a photo described, a screenshot's text read, a repo's README pulled in.

## Nutrients flow both ways

Up: context pulled from life into the tree. Out: leaves brought back when they're needed, by searching, by the reminder set at save time, by the Monday digest, or by Claude noticing that you've just said "we're building X" and going to look.

## What the librarian does and doesn't do

Does: carry each item up the trunk and out to the right twig, write 2 to 5 tags, a title and a one-line summary, describe images, read screenshots, propose branches.

Doesn't: edit your words, edit a file, delete anything, merge two leaves, move a leaf after you've placed it by hand, create a branch by itself.

## Local-only leaves

A leaf saved with **Keep local** grows on the same tree but in a vault only the app can open. It never enters the library that Claude can reach. The librarian still files and tags it, using the local model only.

## Today's implementation vs. the tree

As of 26 Oct the tree is one level deep (eight flat shelves). The move to real branches changes three things: `library/categories.json` becomes nested, item paths become branch paths (`zero-proof/menu/nightcap-flight`), and the librarian files by walking down one level at a time. Roots exist for: the app's box, links, files, Google Docs (pull), Claude sessions (importer). Not yet: share sheet, camera roll, voice memos, notes apps, GitHub.

## Living topics inside a project (decided with Max, 31 Oct 2026; built in `app/topics.ts`)

- **Two levels at most:** Project → Topic → Sub-topic. Below that, narrow with file-type chips, time and people, not more folders.
- **One home per item.** It can show up elsewhere only as a link.
- **Real time.** Topics update the moment an item is filed and whenever a project is opened.
- **Closeness:** meaning (local embeddings of title, summary, the person's sentence and tags, with the project's own name removed), plus small nudges for the same day and shared names. Saying a topic's name ("for the signage") puts the item straight there.
- **Life of a topic (Fibonacci thresholds):** loose items wait in Loose ends; 3 close loose items (0.78) become a topic, named by the librarian; an item joins a topic at 0.80, unless a forming cluster of loose items fits it better; a topic over 13 divides into two sub-topics of at least 5 when their centres are no closer than 0.88; siblings at 0.92 fuse; a topic under 3 joins its nearest sibling.
- **The person wins:** a renamed topic keeps its name and never fuses on its own; a moved item stays where it was put.
- **Open question:** topics across projects (the same "signage" in True Nature and Zero Proof). Max: "we'll have to figure that part out".
