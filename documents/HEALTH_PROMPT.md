# Prompt for a fresh ColorXBridge session — health and performance

Run this from `/Users/tsevis/AI/ClaudeCode/ColorXBridge`.

---

We are going to work on the **health of the whole ColorXBridge extension** —
correctness, robustness and speed. It works today, but it was built fast under a
lot of iteration and deserves a proper pass.

**Read `README.md` first.** It documents what the extension does, why five
separate faults kept it dead for months, and — importantly — the limits of what
Adobe Bridge permits.

## What this is

A CEP panel that runs inside Adobe Bridge 2026. It analyses image colour, writes
the result into each file's XMP, and reorders Bridge's actual thumbnail grid by
renaming files with a sortable prefix. Roughly 1,500 lines across a panel
(`js/`) and an ExtendScript host layer (`jsx/ColorXBridge.jsx`).

Verified working on a real 1,559-image folder: analysis, XMP write, keyword
write, cached re-read (3.8 s), similarity ordering, renaming and undo.

## Start here — one untested fix

The last thing I did was fix a crash, and **the fix has not been run in Bridge**.

"Select in Bridge" called `app.document.select()` once per file. Each call
constructs a `Thumbnail` and forces a content-pane update; at 1,559 files Bridge
terminated. It now builds the list and assigns `app.document.selections` once,
with a 500-file cap and a confirmation. Commit `96fab3f`.

**Verify that first**, on a large folder, before anything else.

## Known weaknesses, in the order I would attack them

1. **Anything that touches Bridge's UI per item is suspect.** The crash came
   from a per-item loop that was only ever tested on six files. Audit
   `jsx/ColorXBridge.jsx` for the same shape — per-file `refresh()`, per-file
   selection, per-file `Thumbnail` construction — and batch or cap each.

2. **Analysis concurrency is fixed at 4** (`analyzeAll` in `js/app.js`) and was
   never tuned. Each worker decodes an image to a canvas and clusters it. Worth
   measuring against core count.

3. **XMP writes are one `XMPFile` open per file.** The batched *read* takes
   2.2 s for 1,559 files; writes have never been timed separately and are the
   slowest remaining step.

4. **No automated test run exists.** There are real tests
   (`test/xmp-constants.test.jsx`, and offline suites that were kept in a
   scratch directory and lost) but nothing runnable by one command. A
   `npm test` that checks the colour engine offline would have caught several
   regressions.

5. **Error paths are uneven.** Some report precisely; others swallow into a
   generic message. Two of the five original faults survived for hours because a
   fallback reported success. Grep for empty `catch` blocks and make each one
   either handle or surface.

6. **`_legacy/` is dead weight.** Superseded source kept for reference. If
   nothing references it, delete it — the history has it.

7. **Unsigned.** It loads only because `PlayerDebugMode` is enabled on this
   machine. Packaging as a signed `.zxp` is what makes it installable anywhere
   else.

## How to test — this matters

**Debugging the panel.** CEP remote debugging is the only way to see inside it:

```bash
cd Bridge-Extension && cp .debug.example .debug && node scripts/install.js
```

Reopen the panel, and it exposes a DevTools endpoint on `localhost:8088`. You
can then drive it over the DevTools protocol — evaluate expressions in the
panel, click its buttons, read its state, screenshot it. **Remove `.debug` and
reinstall when finished**; it must never ship.

`$.evalFile(new File(".../jsx/ColorXBridge.jsx"))` hot-reloads the host script
into the live engine without reopening the panel. `location.reload()` reloads
the panel's own JavaScript.

**Judging colour output.** Render the whole folder as a contact sheet and look
at it. Three separate numeric metrics misled me during development — mean
neighbour distance, colour-region changes, and a lightness-reversal count that
was measuring rounding noise in my own measurement. Each looked authoritative
and each pointed the wrong way. A single PNG of every thumbnail in order settled
every question in seconds.

**Test at real scale.** The crash, and the sort quality problems before it, only
appeared at 1,559 files. Fixtures of a dozen images verify correctness, never
behaviour.

## Ground rules

- **Never report success you have not verified against Bridge itself.** This
  project lost months to an installer that checked its own wrong path and
  printed "✓ installed successfully".
- **A fallback that hides a total failure is worse than a crash.** Two faults
  survived because every XMP write threw and silently fell back to a sidecar,
  while the panel reported success.
- **Bridge only reads `.xmp` sidecars for camera raw.** For JPEG/PNG/TIFF the
  XMP must be embedded, or the data lands where Bridge will never look.
- Do not change colour ordering behaviour without showing me a contact sheet.

## What I care about

Speed on large folders, and not losing my files. The renaming is reversible and
the original name is stored in `colorxbridge:originalName` — keep it that way.
