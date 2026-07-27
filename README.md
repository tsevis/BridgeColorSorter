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
| `Bridge-Extension/_legacy/` | Superseded source, kept for reference |

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
3. Pixels are clustered with k-means++ (seeded deterministically, so re-running
   gives the same palette) to get a dominant colour, a palette, and each
   colour's share of the frame.
4. Results are written back into the files as XMP under the namespace
   `http://ns.adobe.com/colorxbridge/1.0/` — embedded where the format allows,
   otherwise as an `.xmp` sidecar.

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
five-bucket grouping, so it is off by default.

### Numbering files

Ticked criteria are applied top to bottom: the first is the primary sort, the
rest break ties. Each becomes a fixed-width, zero-padded field in the prefix, so
a plain alphabetical sort — all Bridge can do — reproduces the order exactly.

```
H000-L050_01-pure-red.png     hue 0,   lightness 50
H227-L047_11-mixed-blue.png   hue 227, lightness 47
H227-L051_06-pure-blue.png    same hue, split by lightness
Z003-L003_09-black.png        Z = achromatic, parked at the end
```

A descending criterion stores its complement, so ascending text still yields
descending values. Greys use `Z` for the hue field, which sorts after every
other letter. Your original filename follows the prefix intact and is also
written to `colorxbridge:originalName`, so **Undo rename** is exact.

### Why OKLCH and not HSL

Sorting by HSL hue looks wrong even when the numbers are right, for three
reasons that all showed up in a real red-heavy folder:

| Problem | Example |
|---|---|
| Hue collapses unlike colours | A pale pink and a deep crimson are **both `H353`**, so they land side by side |
| Hue is unstable at low saturation | A near-grey reports `H348` — the middle of the reds — and drops into the run |
| HSL lightness is not perceived lightness | Pure yellow and pure blue are both `L50`, though yellow is far brighter |

OKLCH fixes all three: equal numeric steps are roughly equal perceived steps.
The same pair above becomes `C16 L87` and `C46 L41` — clearly distinct — and
the near-grey reads `C4`, correctly neutral.

### Hue bands

Sorting on raw hue lets a 1° difference outrank everything else, so the
secondary criterion never speaks and the grid looks noisy. Banding hue (24 by
default) groups near-hues so lightness orders them *within* the band, producing
the dark-to-light runs that make a colour grid read as sorted. Set it to
*Continuous* for the finest ordering, or 8–12 bands for broad colour blocks.

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
  range picked here becomes a real selection in Bridge you can act on.
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

## Requirements

- macOS (the raw/PSD path uses `sips`)
- Adobe Bridge 11 or newer for the panel; tested on **Bridge 2026 (16.0.6)**
- Node.js 18+ to run the installer

---

## Licence

MIT
