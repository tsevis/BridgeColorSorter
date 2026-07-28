# ColorXBridge

**Search & sort images by colour, inside Adobe Bridge.**

---

## Why it did not work before

The extension had never loaded in Bridge — not once. Bridge's own log
(`~/Library/Application Support/Adobe/Bridge 2026/BridgeLog.log`) registers every
CEP extension it finds, and `com.colorxbridge.panel` appeared zero times. Three
independent faults, each fatal on its own:

| # | Fault | Effect |
|---|-------|--------|
| 1 | Manifest declared `<Host Name="BRG">` | Bridge's CEP host code is **`KBRG`**. `BRG` matches no Adobe application, so Bridge ignored the extension. |
| 2 | `manifest.xml` sat at the extension root | CEP only reads `<extension>/CSXS/manifest.xml`. The installer then verified its *own* wrong path and printed "✓ installed successfully". |
| 3 | The analyser read **compressed** file bytes as RGB | It sampled raw JPEG bytes as if they were pixels. Those bytes are entropy-coded — the resulting "colours" were meaningless. |

Two further faults were found once the panel was running and could be inspected
over CEP remote debugging. Both threw inside the XMP write, were swallowed by
the sidecar fallback, and — because **Bridge only reads `.xmp` sidecars for
camera raw** — put every PNG's colour data somewhere Bridge never looks, while
the panel reported success:

| # | Fault | Effect |
|---|-------|--------|
| 4 | `XMPConst.UNKNOWN` used as the file-format constant | It does not exist. The real one is `FILE_UNKNOWN`, so `new XMPFile(...)` threw for every file. |
| 5 | `appendArrayItem(ns, name, arrayOptions, value, itemOptions)` | `arrayOptions` comes **last**. Misplacing it raised "Explicit arrayOptions required to create new array". |

A sixth issue was documentation: the old README stated Bridge 2026+ "does not
support third-party extensions". That is not the case — Bridge 2026 (16.0.6)
ships CEP 12 (`PlugPlug 12.0.1.2`), a `CEP/extensions` folder, and two working
Adobe sample extensions. The platform was never the problem.

The installer refuses to rebuild faults 1 and 2; `test/xmp-constants.test.jsx`
guards 4 and 5; and a wholesale fallback to sidecars is now a visible error
rather than a silent success.

---

## Layout

| Path | What it is |
|------|-----------|
| `Bridge-Extension/` | The CEP panel that runs **inside** Adobe Bridge |
| `Bridge-Extension/test/` | Offline test suite — `npm test`, no dependencies |

---

## Tests

```bash
cd Bridge-Extension && npm test
```

168 tests, no dependencies — `node --test` and nothing else. They run without
Bridge, without Chromium and without network, in under a second.

They cover the colour engine (the composition claims below are executable, not
prose), the clustering output frozen against a golden fixture, similarity
ordering, hue banding, colour naming, the stored-palette format, filename
prefixing, and the structure of the worker analysis path.

Several are guards against faults that have actually happened here, and each
one has been checked to fail when its fault is reintroduced:

- The prefix pattern is duplicated between the panel and the ExtendScript host,
  which cannot share a file. The two literals are compared character for
  character; they drifted apart once already.
- `XMPConst.UNKNOWN` and the wrong `appendArrayItem` argument order — the two
  mistakes that put every file's metadata where Bridge never looks.
- ExtendScript is ES3: `const`, arrow functions, `JSON`, `Object.keys` and
  `forEach` all parse fine in Node and throw inside Bridge, so the host script
  is scanned for them.
- No `Thumbnail` may be constructed inside a loop, and nothing may assign
  `app.document.selections` (see below).
- Every host entry point must return `cxbJSON(...)` and catch its own errors,
  or the panel gets `EvalScript error.` and a dead button.
- Renaming must be scoped to the folder Bridge is showing.
- The worker cannot define its own `extractPalette`, and its pixel-sampling
  rules must match `decode()` exactly.
- **Every control `app.js` wires up must exist in `index.html`.** Element
  lookups are guarded with `if (el)`, so a control could disappear from the
  markup and nothing would complain — three had, including the ⇅ reverse
  button this README documents.

`test/xmp-constants.test.jsx` is separate: it needs the real XMP library, so it
runs inside Bridge from the panel's console via `cxbTestXmpApi()`.

---

## Install the Bridge panel

```bash
cd Bridge-Extension && node scripts/install.js
```

Then restart Bridge and open **Window → Extensions → ColorXBridge**.

Check an existing install with:

```bash
node scripts/install.js --status
```

The installer copies the panel to
`~/Library/Application Support/Adobe/CEP/extensions/ColorXBridge` and enables
`PlayerDebugMode`, which CEP requires for unsigned extensions. To distribute the
panel to other machines, sign it as a `.zxp` instead of relying on debug mode.

---

## How it works

1. The panel asks Bridge (via ExtendScript) which files you have selected.
2. Each image is decoded **by Chromium itself** — read from disk with Node,
   wrapped in a Blob URL, drawn to a canvas, and read back as real pixels.
   Camera raw, PSD, TIFF and HEIC are transcoded first with macOS `sips`.
3. Pixels are clustered with k-means++ **in OKLab** (seeded deterministically,
   so re-running gives the same palette) to get a dominant colour, a palette,
   and each colour's share of the frame. Clustering perceptually means the
   splits fall where the eye sees a boundary: a dark red and a bright red stay
   separate, while two near-identical greens merge instead of wasting a slot.
4. Results are written back into the files as XMP under the namespace
   `http://ns.adobe.com/colorxbridge/1.0/` — embedded where the format allows,
   otherwise as an `.xmp` sidecar.

### Reusing saved colour data

Analysis dominates the runtime — every image must be decoded and clustered — yet
the answer is already embedded in each file from the previous run. Before
analysing, the panel reads the stored palettes back in a **single batched call**
and only analyses what is missing. A folder that has been analysed once
re-orders in seconds instead of minutes.

The batching matters: one `evalScript` for the whole folder, not one per file.
At a thousand files the round trip would otherwise cost more than the work.

Records are rebuilt from the stored `palette` string (`#rrggbb|dominance`
pairs), with HSL and OKLCH recomputed from the hex. Verified against a real
1,559-image folder: all 1,559 reconstruct, dominance sums land within 0.999–1.002
of unity, and the resulting order is deterministic.

Only newly analysed files are written back, so reusing costs no writes at all.
**Settings → "Re-analyse, ignoring saved colour data"** forces a full pass when
the analysis settings change.

### Stored XMP properties

`dominantHex`, `dominantHue`, `dominantSaturation`, `dominantLightness`,
`dominance`, `colorName`, `palette`, `analyzedAt`, `version`.

---

## What Bridge will and will not let you sort by

**Bridge's Sort menu cannot be extended.** `app.document.sorts` holds exactly one
`{type, reverse}` object and the category must be one of Bridge's own —
`user`, `name`, `date-created`, `date-modified`, `label`, `vc-status`, `rating`,
`filesize`, `filetype`, `dimensions`, `resolution`, `colorprofile`. A
`SortCriterion` object exists, but it only carries a name and one of those
built-in types, and there is no registration entry point for a custom one. An
earlier draft of this work assumed otherwise; the panel's own diagnostics and
the Bridge JavaScript Reference both disprove it.

### Selecting, and how Bridge lies about it

Two facts about Bridge's selection API were established by measurement, and
both contradict what this code originally assumed:

- **`app.document.selections = [...]` does nothing.** It does not select and it
  does not throw — assigning three known thumbnails leaves the selection at
  zero. Any code that assigns it and reports success is reporting a success
  that never happened, which is exactly what one release of this panel did:
  "Selected 500 in Bridge" while selecting none.
- **`app.document.select(thumb)` is the only mechanism that works, and it was
  never the thing that crashed Bridge.** Driving it 1,559 times over the
  folder's own child thumbnails takes 3.6 s and Bridge is fine
  (100 → 151 ms, 600 → 993 ms, 1,000 → 1.9 s, 1,559 → 3.6 s).

What actually crashed Bridge was `new Thumbnail(new File(path))` once per file:
each construction makes Bridge build a whole thumbnail record. The panel now
constructs none — it indexes the folder's existing children by path and reuses
them.

There is a third trap on the way out. **Bridge updates
`app.document.selections` lazily**, so reading the count straight after
selecting 1,559 files still returns 0; it becomes truthful a few hundred
milliseconds later. Verifying inline would therefore report a failure that did
not happen — the mirror image of the original bug. The panel polls a separate
`cxbSelectionCount()` until it settles, and reports **that** number rather than
the number it asked for.

### Getting the order into Bridge's grid

Two routes are available, and they do different jobs:

| Route | What it does | Cost |
|---|---|---|
| **Colour keywords** (default on) | Bridge's **Filter panel** gains a `Colour` group — click *Blue* to narrow the grid | additive; nothing of yours is touched |
| **Number files for Bridge** | Encodes the colour order into a filename prefix, then switches Bridge to *Sort → By Filename*. The real thumbnail grid reorders. | renames files (reversibly) |

**Keywords cannot order.** Bridge filters by keyword but never sorts by one, so
keywords narrow the grid and leave the survivors in whatever order Bridge was
already using. Only the filename can carry an arbitrary order.

`xmp:Label` could also carry a colour, but Bridge has just **five label slots**
and a file has exactly one label — which belongs to your own triage
(Select / Approved / Review). Overwriting that destroys real work to gain lumpy
five-bucket grouping, so **the panel does not offer it.** The host script keeps
`cxbApplyLabels()` for anyone who decides the trade is worth it; there is
deliberately no button.

### Ordering by whole-palette similarity

Sorting on a single representative colour has a hard ceiling: a busy artwork is
not one colour. Two tiles can share a dominant red and look nothing alike
because one carries gold and cream while the other carries blue and white. No
tuning of the criteria fixes that — the information was discarded before the
sort began.

**Order by → Whole-palette similarity** keeps all of it, and arranges the
library the way the colour literature prescribes: **group by hue, then ramp by
lightness inside each group** (the HCL pattern). There is no perfect way to
flatten three perceptual dimensions onto one, so one has to be sacrificed
deliberately — here it is chroma, the least visible of the three.

1. Each image is reduced to a **lightness-free** colour identity: every palette
   entry becomes a direction on the hue wheel scaled by how colourful it is,
   plus a neutral axis.
2. Those identities are clustered (k-medoids) into blocks.
3. Blocks are ordered **around the hue wheel**, neutrals last.
4. Inside each block, images run in a strict **lightness ramp**, and the ramp is
   flipped when that puts its matching end against the previous block.

Three failures had to be fixed to get there, each visible in the grid before it
was understood:

| Symptom | Cause |
|---|---|
| Dark reds sitting among dark yellows | The clustering distance included lightness. OKLab compresses `a`/`b` as lightness falls, so two *dark* colours of different hue read as close — and being both dark merged them. |
| Lightness jumping about inside a colour group | A similarity path was ordering each block. It optimises colour closeness, which does not move in step with lightness. |
| Blues appearing at both ends of the library | Blocks were chained by a nearest-neighbour path, which is locally sensible but globally wrong. The hue wheel fixes it by construction. |

Names become `P0042-H028-L059_photo.jpg`: position drives the order, hue and
lightness ride along as information.

> **A note on measuring this.** Three separate numeric metrics — mean neighbour
> gap, colour-region changes, and a lightness-reversal count — each looked
> authoritative and each pointed the wrong way. Greedy path ordering *wins* on
> mean neighbour gap by construction while still reading as scattered. Rendering
> the whole library as a contact sheet settled every question in seconds. Judge
> this feature by eye, not by a number.

### Where the hue wheel is cut, and why a family must ramp only once

Hue is circular, so any linear ordering has to cut it somewhere — and the cut
decides whether the grid reads as blocks of colour or as noise.

Equal 45° arcs cut wherever the arithmetic lands. On the 1,559-image folder
that put a boundary at exactly **90°, in the middle of the golds** (80–89°: 105
images, 90–99°: 71). Smoothing then reverses every second group, so the golds
ran light→dark over eight rows and then dark→light over three: **one colour
family, two gradients.** Rotating the arcs cannot fix it — the golds span 65°
and an arc is 45°, so no rotation fits them.

**Order by → Hue groups** offers three ways to divide the wheel:

| | What it does | Measured mean lightness step |
|---|---|---|
| **Colour families** (default) | One group per perceptual family, so a family ramps once | **0.28** |
| Equal arcs | Fixed 45° divisions; predictable across folders, but cuts through dense colour | 0.34 |
| Fit to this folder | Cuts at the valleys in this folder's own hue distribution | 0.32 |

The family boundaries are **measured, not guessed**. They come from the OKLCH
hue angles of the CSS named colours — via the sibling project Nino, whose
`HueFamily` bins record them:

```
pink 15 · red 40 · orange 75 · amber 100 · yellow 122 · chartreuse 139
green 162 · emerald 180 · cyan 210 · azure 240 · blue 272 · indigo 295
violet 316 · magenta 345
```

Fourteen families is finer than the eye groups a library, so adjacent ones a
viewer would name together are merged into six: `red` (pink+red), `gold`
(orange+amber+yellow+chartreuse — everything from tan to yellow), `green`
(green+emerald), `cyan` (cyan+azure), `blue` (blue+indigo), `magenta`
(violet+magenta). On the measured folder that gives 724 / 486 / 14 / 76 / 239 /
14, and the warm run that used to split is now one ramp.

Green, cyan and blue are deliberately **not** merged. Fitting bands to the
folder's own density lumped all three into a single 152° block ordered only by
lightness, which buried the greens and cyans inside the blues — visibly worse
on a contact sheet, and the reason "fit to this folder" is not the default.

### Numbering files

Ticked criteria are applied top to bottom: the first is the primary sort, the
rest break ties. Each appears as its own labelled field in the prefix, in
priority order, so the name says what it sorted on.

```
H002-L059_photo.jpg        hue band 2, lightness 59
Z013-L013_photo.jpg        Z = achromatic band, parked at the end
```

With **Smooth transitions** on, a rank field is inserted *before* the fine
value:

```
H003-S000-L070_photo.jpg   hue band 3, first in that band, lightness 70
H003-S001-L067_photo.jpg   second in the band - lightness descends here,
                           because this group is a reversed one
```

The rank is necessary because smoothing reverses every second group, and a raw
value cannot express that: sorting alphabetically on lightness would undo the
reversal. Ordering therefore runs on the grouping fields then the rank, while
the final value rides along as information.

Separators are hyphens inside the prefix and an underscore only at the boundary
with your filename, so the original stays unambiguous to strip. It is also
written to `colorxbridge:originalName`, so **Undo rename** is exact.

Defaults are **colour-family hue groups, coarse grouping, chroma unticked,
smoothing on** — measured as the smoothest combination on a real 1,559-image
folder, and confirmed on a contact sheet.

> **Renaming is scoped to the folder Bridge is showing.** Results accumulate
> across runs, which is right for the list and catastrophic for anything that
> renames: **Number files** and **Undo rename** used to operate on every file
> analysed in the session, so analysing one folder, navigating to another and
> pressing Undo silently renamed files in both. Both now narrow to the open
> folder, the confirmation names it, and anything left out is stated. It was
> found by a test harness doing exactly that to a real folder.

### Lightness means the picture, not the swatch

The lightness criterion reads the **whole image** — the palette-weighted mean —
not the lightness of the representative colour.

They are not the same thing, and the difference is not small. On the measured
folder the representative swatch's lightness disagrees with the image's by
**14 points on average**, and by more than 20 points for a quarter of the
library. The worst case was a bright tile, mean lightness 73, whose
representative was a near-black blue accent at L 21 — so it sorted into the
dark end of the blue ramp, where it read as noise.

The eye judges a thumbnail by the whole tile, so the ramp has to be built on
the whole tile. Ordering on it cut the mean lightness step between neighbours
from **8.16 to 0.34**.

(The sibling project Nino keeps `meanLightness`, `dominantLightness` and
`representativeLightness` as three separate sort axes, which is the more
honest framing: each keeps meaning exactly what it says.)

### Which colour represents an image

- **Balanced** (default) — among clusters that are genuinely colourful and
  occupy a real share of the frame, take the best combination of area and
  chroma. A 62 % grey wall behind a 22 % red dress reads as *red*, which is what
  a person would say.
- **Dominant** — the largest cluster, even if it is a neutral background.
- **Average** — the mean of the palette. Usually the worst choice: red and green
  average to a muddy brown that appears nowhere in the picture.

### Controls

- **Sort** — applies the chosen order to the list. **⇅** reverses it (an exact
  mirror, including tied items).
- **Select these in Bridge** — selects everything currently listed, so a colour
  range picked here becomes a real selection in Bridge you can act on. Not
  truncated: 1,559 files select in about 3.5 seconds.
- **Click any row** — selects that one file in Bridge and scrolls to it. This is
  how the panel's ordering stays useful without reordering the grid: sort by
  hue, then step down the list.

When sorting by hue, greys, white and black are grouped into their own band at
the end and ordered by lightness — their hue is `0`, so they would otherwise
scatter through the reds.

Keywords are pruned before rewriting, so re-analysing a file replaces its old
`Colour: …` keyword instead of stacking another one.

---

## Verified behaviour

Offline, against fixtures with mathematically known composition
(`ColorXBridge-Test` on the Desktop):

- A 70 % blue / 30 % red image reports blue at **70.0 %**, red at 30.0 %.
- A 50/30/20 three-band image recovers **50.0 / 30.0 / 20.0 %**.
- Hue stays in `[0, 360)` across an exhaustive sweep of 140,608 colours. (A
  near-red such as `rgb(215,3,4)` used to round to 360 and sort at the opposite
  end of the spectrum from `rgb(255,0,0)` at 0.)
- Sorting by hue yields spectral order:
  Red → Orange → Yellow → Green → Cyan → Blue → Purple → Magenta.

End to end inside Adobe Bridge 2026, driven through the panel's own button:

- 12/12 fixtures analysed, **12 embedded, 0 sidecars**.
- Every file's stored `colorName` matches ground truth, and each carries a
  `Colour: <name>` keyword.
- Bridge's own metadata API reads them back —
  `dc:subject=[Colour: Red]`, `[Colour: Green]`, `[Colour: Magenta]` — which is
  the data the Filter panel indexes.
- The PNGs remain valid images after the XMP is embedded.

---

## Where the time actually goes

Measured in the panel over CEP remote debugging, on the 1,559-image folder
(20-core machine) and on a 400-image fixture folder for anything destructive.

| Step | Cost | Per file |
|---|---|---|
| Read saved colour data for 1,559 files | **4.8 s** | 3 ms |
| Analyse 1,559 from scratch, worker pool | **7.3 s** | **4.8 ms** |
| Analyse, single thread (the fallback) | ~64 s | 41 ms |
| Write XMP + keywords, 400 files | **457 ms** | **1.1 ms** |
| Number files, names already recorded | **396 ms** / 400 | 1 ms |
| Number files, first time | 1.8 s / 400 | 4.5 ms |
| Undo rename | **379 ms** / 400 | 0.9 ms |
| Select 1,559 in Bridge | 3.6 s | 2.3 ms |

Two results are worth stating plainly because they contradict what was assumed:

**The XMP write is not the slow step.** It costs about 1.1 ms per file — under
two seconds for the whole 1,559-image folder. Analysis is ~40× more expensive.

**Analysis concurrency did not matter — because nothing was concurrent.**
Levels 1, 2, 4, 8, 12, 16 and 20 all landed within noise of each other at
~41 ms per image: reading the file, building the Blob, `drawImage`,
`getImageData` and the clustering all ran on the panel's single JS thread.
Nineteen of twenty cores sat idle.

### Web Workers

Analysis now runs across a pool of workers — `hardwareConcurrency - 2`, capped
at 12, leaving room for the main thread and for Bridge, which is still drawing
its own grid. The main thread keeps only what needs Node: reading files
(asynchronously, so I/O overlaps with clustering) and transcoding camera raw
and PSD through `sips`. Bytes cross as transferable `ArrayBuffer`s, so nothing
is copied.

| | before | after |
|---|---|---|
| Full cold analysis, 1,559 images | ~64 s | **7.3 s** |
| Per image | 43.8 ms | **4.8 ms** |

**8.8×.** A fresh analysis is now barely slower than reading the cached data
from XMP (4.8 s), which makes the cache close to redundant.

The worker loads `ColorEngine.js` with `importScripts` and calls the same
`extractPalette`, so the clustering is not reimplemented — the golden fixture
guards one function, not two. A test asserts the worker cannot define its own,
and that its pixel-sampling rules (alpha cutoff, scale, rounding, channel
order) match `decode()` character for character. They must:
`extractPalette` seeds its random source from the pixel **count**, so one extra
or missing pixel silently changes an image's whole palette.

Every failure falls back to a single-threaded analysis — no `Worker` API,
workers that will not start, a worker that dies, or one file that fails inside
one.

**Palettes changed, and they got better.** A worker has no DOM, so it decodes
with `createImageBitmap` + `OffscreenCanvas` rather than `<img>` + `<canvas>`.
That is not the same picture: downscaling 1024→160 is a 6.4× reduction, and the
`<img>` path aliases badly. Measured against clustering *every pixel at full
resolution*, the worker path was closer on all four test images — by 1.5×,
4.6×, 5.6× and 13.6×. It is not colour management (every `createImageBitmap`
variant agrees; only `<img>` differs) and `imageSmoothingQuality = 'high'`
changes nothing.

So this is a fidelity improvement that happens to be 9× faster. It does mean a
library analysed by the old path should be re-analysed once, or it will hold
two subtly different kinds of palette.

### What did help

Clustering was rewritten from an array of `[L,a,b]` arrays onto flat
`Float64Array`s. A 160×160 sample is 25,600 pixels, so the old shape allocated
25,600 three-element arrays per image and chased a pointer for every distance
computation. Same arithmetic, same seed, same order — **bit-identical
palettes**, verified two ways: against a golden fixture in the test suite, and
against the palettes already embedded in the real folder by the previous
version (8/8 identical). Clustering went from 21.2 ms to 17.9 ms per image,
and the whole analysis from 48 ms to 41 ms.

Renaming a folder that has been numbered before dropped from 1.8 s to 396 ms
per 400 files, because recording the original filename now probes read-only
first. Opening a file `OPEN_FOR_UPDATE` and closing it `CLOSE_UPDATE_SAFELY`
rewrites the whole file; on a re-run the name is already stored, so every one
of those rewrites was wasted.

Numbering twice is now a no-op. It used to re-rename a third of the folder,
because ties in the sort broke on the current filename — which the first
numbering run had just changed. Ties now break on the original name, which
does not move.

---

## Requirements

- macOS (the raw/PSD path uses `sips`)
- Adobe Bridge 11 or newer for the panel; tested on **Bridge 2026 (16.0.6)**
- Node.js 18+ to run the installer

---

## Licence

MIT
