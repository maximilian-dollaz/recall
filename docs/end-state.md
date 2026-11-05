# Recall: the end state ("creating is remembering")

Max's brief for the overnight run, 2–3 Nov 2026, in his words where possible. This is the north star every agent works from. Where a line is Claude's restatement, it says so.

## The feeling

When Max wakes up he opens a beautiful, magical space where all of his ideas and inspiration live and have a home: floating in an intelligent soup that takes care of his ideas, knows what he wants, helps him imagine it, and takes the cognitive load of sorting and organizing off him. It knows where every idea needs to go, what he needs next, and where he wants to click.

- **The picture behind it:** a sacred image of nature, made by a real human, behind dimmed glass like a faded background. A **river delta**: water, trees around it, perhaps an island. It explains the architecture: information flows in and out, replenishes, and everything flows into its proper place naturally, easily, simply, completely. (Replaces the mountains.)
- **The light:** a light shining behind all the tiles, lighting them from the back, a very fine white-golden glow around the edges. Crisp, clean, clear. Not gaudy.
- **The palette:** beautiful blue hues, tans and beiges. Earth tones, but not outdoorsy: natural, elevated, magnificent to look at. It registers as truth. Sacred geometry in the design and the spacing.
- **The principle:** creation is already finished; seeing it is a *remembering*. Nothing has to be added for the light to come through: friction and pieces are removed, and the light shines through. (Pairs with the building principle: desire + non-resistance = desired outcome.)

## Sorting: the system does it, the person's intent always wins

- Every save is either auto-sorted into a project, or a new project is created when it's a new category, or it lands in a category inside an existing project, or it goes to **Clarify** to ask where it belongs. Nothing is left loose.
- Projects are created two ways: Max says so, or the system sees what needs to happen and creates it. It never overrides his will; it makes the most of what he didn't say, and asks permission (Clarify) for anything important.
- If the notes name a project, it goes there. (Bug: "Wellness Lounge Room Designs" said "Frequency Wellness Lounge" in its notes and was not sorted there.)
- **Anything Max drags into a project or a category stays there. Auto-sorting only touches what he hasn't placed himself.**

## Find

- **No "Recently saved" section.** Find is just all projects. Clicking into "Describe what you're looking for" opens a dropdown under it showing recent saves.
- Projects are ordered by most recently added to: newest at the top, untouched ones at the bottom. Easy to scan; easy to search projects.
- **"Brought back for you"** stays (Max loves it). Those notes can be dragged into projects too.
- Every tile has a **delete** button that appears on hover, on the right-hand side (e.g. three duplicate Spider-Man saves: click, click, delete).
- Clicking a project expands it to just the right size: its subcategories and buckets fill the screen, visually simple.
- Clicking a subcategory expands it: all its photos; click one to see its description. **No extra clicks to see the full description** Max added by voice or text. First click on an asset shows: what it is, which project, and his description. Metadata (saved when, what the system uses) goes in a Details tab.
- If an asset leads somewhere (a link, a Google Doc), clicking it opens that in a new tab.
- Easy to send anything. Easy to drag and drop into new categories.

## Saving, from everywhere

- **Chrome:** the extension is the way (right-click → Add to Recall; or select, click the extension, talk). Must work for the team tomorrow.
- **Pinterest and any site:** the actual picture is saved into the board, not just the link. He must see the picture.
- **Google Drive / Docs / the Google suite:** super intuitive. In Drive's Recents, drag-select four tiles, click the extension, talk, and all four are saved. Or double-click / right-click inside Google and save directly.
- **Files on the Mac:** right-click (or double-click) a file → Add to Recall, same experience as Chrome. Dragging files in already works.
- **Notes, Google Documents, anything on the computer:** easy.
- **Voice on the desktop site** needs to be better.
- **The Save page:** take the Team board off it.

## Team boards

- Max can **create a team board and share it** with his team: send it by email or add people (everyone will have a Recall account). (Claude's note: Recall drafts, Max sends. Nothing is sent on his behalf without his yes.)
- A team board works like projects, on a macro scale: a tree. **Trunk** = the team board. **Second level** = projects (Frequency Wellness, Zero Proof, True Nature Media), a mega project made of everyone's projects. Inside: **each person's project**, shown with their name and a small round picture of them in the top-right corner. Then subcategories, then assets.
- Sharing to a team board is live: a shared project *is* the project; anything added shows on the team board.
- **Moving like an iPhone home screen:** in a teammate's project → their photos, select three (or drag-select), and drag them out of the project onto the main board.
- **The generator (Visualize):** drag artifacts all the way to the right into a chat/sidebar, and explain to the agent how to use them to create the image or video. Everyone in the meeting at once: clicking, dragging, dropping into the generator, speaking into the chat box at the same time, so the result is a culmination of everyone's words in the moment and the artifacts from everyone's projects. Generated live (Higgsfield), iterated until the team says "Holy shit, yes." ("Carpets red, walls concrete, lights dimmer and more yellow" → regenerate.)

## The bar for the morning

A finished, production-ready Recall the team can use: every constraint listed in order so Max can knock them off one by one; the bugs worked out by agents testing it; every judgment call queued for Max, not guessed.

## Standing rules for the overnight run (Claude's)

- Max's exact wording rule: new on-screen copy is drafted and queued for his OK; functional labels may ship and are listed for review.
- Never send messages or email on his behalf; never enter credentials; no spending beyond the cap he set; never print secrets.
- Build and test on the twin (`bin/cl twin start`, :4344) first. Production only after the twin passes. Every deploy is a git commit, so any step can be rolled back (tag `before-overnight` = state at the start).
- Private memo content stays out of git.
