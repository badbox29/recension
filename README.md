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

**Drafting.** A markdown editor with typewriter scrolling, adjustable measure
and type size, and a four-level manuscript tree: project → book → part →
chapter → scene. Parts are optional, because most novels don't have them.
Scenes and chapters drag to reorder, and every structural move is undoable —
which is the part that matters. Moving chapter 19 to position 3 in a
90,000-word draft is an accident you might not notice for a week, so Ctrl-Z
reverses it and the confirmation offers a way back.

**Reading.** Scenes concatenated into a continuous read-through, at any level.
Deliberately read-only: reading a draft and revising it are different
activities, and a click in a reading view should select text, not open an
editor.

**Cards.** Characters, places, factions, objects, research. Free-form fields —
a character sheet for a spy thriller and one for a family saga share almost
nothing, so a fixed schema would be wrong for most books. Portraits and maps
attach to any card.

**Events.** First-class records, not scene tags. Most of a life — born,
married, divorced, died — happens offscreen and never appears in the
manuscript. Dates honour the precision you gave them: an event recorded as
`1892` renders as a band across that year, never as 1 January.

**Links.** `[[Card Name]]` in the prose, autocompleting as you type, resolving
through aliases so a callsign and a full name reach the same card. Select words
and press `[` to link them without changing a word of what you wrote.

**Five views over the same data.** A timeline with a lane per person, a grid of
scenes against cards, a board by draft status, a mind map of who shares a
scene with whom, and a search that covers everything. None of them is
maintained by hand.

**The Snowflake method**, if you use it. Ingermanson's ten steps, with the
optional ones switchable off — everything but the sentence, the paragraph, the
scene map and the draft itself, which the rest hangs from. Step 2's paragraph splits into its five
sentences as you type, because step 4 expands sentence *n* into paragraph *n* —
the parentage is the method, not a formatting choice. Beats connect to scenes,
so the plan can be checked against the book: which beats have no scenes, which
scenes serve no beat, and which paragraph quietly became eighteen thousand
words.

**Compile.** Word in standard manuscript format — Times New Roman, double
spaced, running header, the whole Shunn convention. EPUB for reading your own
draft on a phone, which catches things the editor never will. Markdown and
plain text.

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

## Getting your work out

Three different jobs, three different files, and the distinction matters:

- **Compile a manuscript** — one book as a document to read or send. Not
  importable.
- **Export this project** — one project with its cards, events and images.
  Importable.
- **Back up everything** — every project. The one to keep somewhere safe.

The backup zip contains a browsable folder of markdown *and* a JSON copy with
ids and ordering intact. The markdown is for humans; the JSON is what a restore
reads. Imports default to adding only what's missing and never overwrite what's
already there.

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
