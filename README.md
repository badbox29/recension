# Recension

A novel-writing tool that runs in a browser, keeps your manuscript on your own
machine, and syncs it through a Cloudflare Worker you control.

**[badbox29.github.io/recension](https://badbox29.github.io/recension/)**

*Recension* — a critical revision of a text; the establishing of a text by
collating sources. The name sets the terms: this is for the long, unglamorous
middle of a book, where you are keeping a lot of things straight at once.

---

## Why it exists

Scrivener has no Android version, and neither it nor its open-source
alternatives can answer the question every drafting writer eventually asks:
*which scenes is she actually in?* Full-text search misses pronouns, nicknames,
and scenes where someone is discussed but absent. The tools that do have cards,
timelines and grids ask you to maintain the connections by hand, so they're
only ever as current as your last tagging session.

Recension derives them. You write `[[Card Name|the words you meant]]` in the
prose, and that *is* the act of putting her in the scene. The grid, the map,
the appears-in list on her card — all of it falls out of text you already
wrote.

---

## What's in it

**Projects.** The working set, and the top of the tree: a project holds its
books, its cast and its history. Cards and events belong to the project rather
than to a book, so a shared universe — two novels, one set of characters —
needs no duplication. Switch with the picker where the app's name would
normally be, because once you have two, which one you're in matters more than
what the app is called. Each remembers where you were: the scene you had open,
the rail you were on, what you had collapsed.

**Drafting.** A markdown editor with typewriter scrolling, a four-level
manuscript tree — project → book → part → chapter → scene — and controls for
line width, type size and whether scene titles show while reading. Parts are
optional, because most novels don't have them.
Scenes and chapters drag to reorder, and every structural move is undoable with
<kbd>Ctrl</kbd>+<kbd>Z</kbd> — which is the part that matters. Moving chapter 19 to position 3 in a
90,000-word draft is an accident you might not notice for a week, so Ctrl-Z
reverses it and the confirmation offers a way back.

**Reading.** Scenes concatenated into a continuous read-through, at any level.
Deliberately read-only: reading a draft and revising it are different
activities, and a click in a reading view should select text, not open an
editor.

**Cards.** Characters, places, factions, objects, research. Free-form fields —
a character sheet for a spy thriller and one for a family saga share almost
nothing, so a fixed schema would be wrong for most books. Portraits and maps
attach to any card, downscaled on the way in so a phone photo doesn't become a
six-megabyte sync, stored in R2 and included in backups.

**Events.** First-class records, not scene tags. Most of a life — born,
married, divorced, died — happens offscreen and never appears in the
manuscript. Dates honour the precision you gave them: an event recorded as
`1892` renders as a band across that year, never as 1 January.

**Links.** `[[Card Name]]` in the prose, autocompleting as you type, resolving
through aliases so a callsign and a full name reach the same card. Select words
and press `[` to link them without changing a word of what you wrote.

**Four views over the same data, none maintained by hand.** A timeline with a
lane per person, honouring the precision of each date. A grid of scenes against
cards, so a character who vanishes for two hundred pages is visible at a
glance. A board by draft status — draft, revised, final — with the share of the
manuscript in each, which is the only number that answers *how far along am I*.
And a mind map of who shares a scene with whom, where a connection that exists
only offscreen is drawn differently from one the reader sees.

**Search.** <kbd>Ctrl</kbd>+<kbd>K</kbd> over scene titles, synopses and prose;
card names, aliases, fields and notes; event titles and locations; chapters and
books. Ranked — a title beats a body, a whole word beats a fragment, and ties
go to whatever you touched last — and it shows the matching line with the hit
marked, because finding the sentence is the point. It flushes before it
searches, so the paragraph you wrote thirty seconds ago is findable.

**The Snowflake method**, if you use it. Ingermanson's ten steps, with the
optional ones switchable off — everything but the sentence, the paragraph, the
scene map and the draft itself, which the rest hangs from. Step 2's paragraph splits into its five
sentences as you type, because step 4 expands sentence *n* into paragraph *n* —
the parentage is the method, not a formatting choice. Beats connect to scenes,
so the plan can be checked against the book: which beats have no scenes, which
scenes serve no beat, and which paragraph quietly became eighteen thousand
words.

**Reading on a phone.** Previous and next at the foot of every scene, in
reading order, so moving through a chapter doesn't mean opening the drawer
each time. Installable: add it to a home screen and it runs full-screen and
offline, which on iOS also exempts it from the seven-day rule that would
otherwise clear the local copy.

**Compile.** Word in standard manuscript format — Times New Roman, double
spaced, running header, the whole Shunn convention. EPUB for reading your own
draft on a phone, which catches things the editor never will. Markdown and
plain text.

---

## Writing in it

### Linking to a card

Two gestures, because there are two things you might mean.

**Type `[[`** and a list of your cards appears, narrowing as you type. Arrow
keys move, <kbd>Enter</kbd> or <kbd>Tab</kbd> accepts, <kbd>Esc</kbd>
dismisses. The card's own name goes into the prose. Name matches rank above
alias matches and whole words above fragments, so "angel" finds *Angel Six*
before it finds anything merely containing those letters — and when an alias is
what matched, the list says which one, so two similar characters can be told
apart without opening both.

**Select words and press `[`** to link text already on the page. The picker
opens headed *Link "Angel's" to…*, and choosing a card leaves your prose
untouched: you get `[[Angel Six|Angel's]]`, which still reads *Angel's* and
points where you said. That's the one to use mid-sentence, because typing `[[`
in front of a word inserts a link *beside* it rather than replacing it.

Aliases are what make this bearable as dialogue gets casual. A card's *Also
known as* field takes every form you actually write — Maggie, Mags, Morrow —
and all of them resolve to the same card. Old names belong there too: renaming
a card doesn't rewrite links already in the prose, so keeping the previous name
as an alias is what stops a rename breaking anything.

In the editor a link shows only its display text, tinted. The brackets and the
target appear when the caret moves inside it, and hide again when it leaves.
Hovering shows a small preview — name, type, portrait, the first few filled
fields — so remembering who someone is doesn't cost you your place in the
sentence. <kbd>Ctrl</kbd>-click opens the card; a plain click stays a plain
click, because that's how you put the caret somewhere.

A link that matches no card is greyed with a dotted underline rather than
hidden. That's usually a typo or somebody you meant to write up, and
<kbd>Ctrl</kbd>-clicking it offers to create the card.

Links are stripped from anything you compile — an agent gets *Angel's crew*,
not `[[Angel Six|Angel's]]` — and kept in the backup, which has to restore the
graph as well as the prose.

### Accents, dashes and symbols

Press <kbd>Ctrl</kbd>+<kbd>/</kbd> anywhere you can type — the editor, a card
field, a synopsis, an event note. Search by name or by letter: *acute* finds
every acute, *n* finds ñ, *dash* finds the dashes, *dagger* finds †. Arrow keys
move, <kbd>Enter</kbd> inserts, <kbd>Esc</kbd> closes. The characters you use
most appear first, so in practice it settles into two keystrokes and
<kbd>Enter</kbd>.

The set is general — Western European accents, typographic marks, fractions,
currency, the symbols prose actually uses. Searching by name is what keeps it
useful for a language other than the one it was built beside.

Spell check is on by default and uses the browser's own dictionary, so it works
offline and remembers what you teach it — which you will have to, because it
flags every name in the book until you right-click and add them. On a phone or
tablet, autocorrect and capital-after-a-full-stop are on too. Both switch off
in Settings → Interface, per device, because the dictionary lives in the
browser and autocorrect will cheerfully "fix" a callsign.

Separately, **Settings → Interface → Smart punctuation** substitutes as you
type:

| You type | You get | |
|---|---|---|
| `--` | – | en dash |
| `---` | — | em dash |
| `...` | … | ellipsis |
| `"` | “ or ” | curling by what precedes it |
| `'` | ‘ or ’ | an apostrophe after a letter, an opening quote after a space |

It's **off by default**, and deliberately so: everywhere else this app refuses
to rewrite what you typed, and this is the one place that does. It leaves
`[[wikilinks]]` and `code spans` alone, and a single undo takes back the
substitution rather than the whole word.

---

## How it's built

Vanilla JavaScript, CSS and HTML. No framework, no build step, no bundler, no
`npm install`. Clone it and open `index.html`.

```
index.html
sw.js                     service worker — bump SW_VERSION to deploy
manifest.webmanifest
css/styles.css
js/
  auth.js                 accounts, HMAC request signing, Google sign-in
  recordStore.js          IndexedDB: every record, the link graph, search
  sync.js                 per-record sync to Cloudflare KV
  app.js                  everything you can see
  vendor/                 EasyMDE, fflate
worker/
  worker.js               Cloudflare Worker: KV storage, R2 blobs, auth
```

Three dependencies, all vendored: **EasyMDE** for the editor, **fflate** for
zips, and **Spectral** for the prose. Everything else — the timeline, the mind
map's force simulation, the `.docx` and `.epub` writers, the sentence splitter
— is written here, because a chart library or a document generator is a large
thing to vendor for offline use when the job is a few dozen lines of geometry
or XML.

### Where your writing lives

**Sync is per record, not per document.** Each scene, card and event is its
own KV key with its own metadata, so editing one scene uploads one scene
rather than rewriting the manuscript. Because that metadata — title, word
count, status, parent — rides in the key listing, a new device renders the
entire manuscript outline from a single request, before downloading a word of
prose.

**Writes land locally first.** Every edit goes to IndexedDB and replicates
afterwards. That is why the app works offline, why a failed push costs
nothing, and why a dirty set persisted in IndexedDB means closing the tab
mid-sentence loses nothing.

It is a statement about order, though, not about authority. With more than one
device there is no single source of truth: each holds a complete copy, any can
diverge, and KV is where copies exchange changes rather than a master they
defer to. A record edited more recently on your phone overwrites the stored
copy without asking.

**Reconciliation is newest-wins, per record.** Edit *different* scenes on two
devices and both survive — that is what per-record sync buys. Edit the *same*
scene on two offline devices and the later `updatedAt` wins; the other version
is gone. No merge, no conflict copy. The granularity keeps this rare, but rare
is not never, and it is worth knowing before you rely on it.

**Losing the worker costs you sync, not the book.** Every device that has
synced holds the whole manuscript, and a pull never deletes local records that
are merely absent upstream. One exception: card images are fetched from R2 only
when you open that card, so a device may not hold images it has never looked
at. The backup zip contains them.

**It works offline.** The service worker caches the shell; writes queue and
flush when the network returns.

**It asks not to be evicted.** Browsers clear the storage of least-recently-used
sites under disk pressure, so the first time you create something Recension
requests persistent storage. Settings → Account reports whether it was granted,
and how much space you're using. It's the third line of defence — sync is the
first and the backup zip the second — but it's the one that covers the window
between writing something and it reaching the worker.

**You can see what sync is doing.** Settings → Account shows the account type,
how many changes are waiting to upload, and whether the worker actually
answers. That last line matters more than it sounds: on a managed machine
`*.workers.dev` is exactly the sort of domain a web filter blocks, and without
it the app looks perfectly healthy while nothing ever leaves the device.

### Security

Requests are signed with HMAC-SHA256 over a key derived from your token via
HKDF. The token itself never travels as a bearer credential, and the signed
message covers the method, a timestamp and a hash of the body — so replaying or
tampering with a request fails.

Storage keys are the SHA-256 of your token, never the token itself: a database
dump exposes hashes, not working credentials.

---

## Running your own

You need a Cloudflare account. The free tier is enough; the paid Workers plan
removes the daily write cap.

1. **KV namespace** — `recension-kv`
2. **R2 bucket** — `recension-blobs`, public access **disabled**
3. **Deploy `worker/worker.js`**, then bind:
   | Type | Variable | Resource |
   |---|---|---|
   | KV namespace | `RECENSION_KV` | `recension-kv` |
   | R2 bucket | `RECENSION_R2` | `recension-blobs` |
4. **Variables** — `ALLOWED_ORIGINS` (your site's origin), and
   `GOOGLE_CLIENT_ID` as a *secret* if you want Google sign-in
5. **Serve the repo** anywhere static. GitHub Pages is fine.
6. Open Settings → Account, paste the worker address, create an account.

`GET /ping` should answer `{"ok":true,"service":"Recension"}`.

> **One thing that will cost you an hour if you miss it.** The HKDF salt in
> `auth.js` and `HMAC_SALT` in `worker.js` must match exactly. They share no
> constant. A mismatch returns 401 on every storage request, with nothing to
> suggest why.

Accounts are optional. Without one, everything stays in your browser and
nothing leaves it.

---

## Deploying changes

Bump `SW_VERSION` in `sw.js`. That's the only version number; the cache name
contains it, so a new version means a fresh fetch of everything and the old
cache deleted.

---

## Getting your work out, and back in

Three different jobs, three different files, and the distinction matters:

- **Compile a manuscript** — one book as a document to read or send. Not
  importable.
- **Export this project** — one project with its cards, events and images.
  Importable.
- **Back up everything** — every project. The one to keep somewhere safe.

The backup zip contains a browsable folder of markdown *and* a JSON copy with
ids and ordering intact — `manuscript/<project>/<book>/<chapter>/01-scene.md`,
plus card images as real files. The markdown is for humans; the JSON is what a
restore reads, which is why the markdown alone can't be imported.

### Importing

**Import a file** takes either of the restorable two — the zip, or the
`recension-backup.json` from inside one. It tells you what the file holds
before anything is written, and then asks which of two things you want:

- **Add what is missing** — inserts what this device doesn't have and changes
  nothing that's here, whatever the dates say. The default.
- **Replace everything** — deletes every project on this device first. Asks
  twice.

There is deliberately no newest-wins middle option. That rule is right for
*sync*, where both sides are one account diverging and the loser survives on
the other device. An import is a single irreversible event against a file of
unknown provenance: a backup from a machine you'd been writing on could carry a
draft you abandoned on purpose, and "newer" would quietly reinstate it over
your current text — with no way to find out afterwards what it changed. If you
do want newer-wins, that's sync's job.

---

## Deliberate omissions

- **Editing switches off on narrow screens.** Below about 700px the manuscript
  becomes read-only: the rail turns into a drawer and the prose renders rather
  than opening an editor. Wider than that — a tablet, a folding phone unfolded
  — and it's the full drafting surface. A reliable reader beats an editor
  fighting a phone keyboard.
- **No AI features in the app.** No generation, no suggestions, nothing
  watching you type. Worth being straight about the irony: most of this
  codebase was written with an AI assistant. That's a tool for building the
  thing, not a thing to put inside it.

---

## Licence

MIT.
