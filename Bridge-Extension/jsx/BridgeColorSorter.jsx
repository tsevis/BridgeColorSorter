/**
 * BridgeColorSorter - ExtendScript host layer (runs inside Adobe Bridge)
 *
 * Everything the panel needs from Bridge itself lives here: the current
 * selection, XMP read/write, and the color keywords that drive Bridge's
 * Filter panel.
 *
 * Communication with the CEP panel is string-based (evalScript returns a
 * string), so every entry point returns a JSON string built by cxbJSON().
 * Bulk data travels via temp files rather than evalScript arguments, which
 * avoids both escaping bugs and the practical length limit on evalScript.
 *
 * @target bridge
 */

//= ============================================================================
// Constants
//= ============================================================================

var CXB_NS = "http://ns.adobe.com/colorxbridge/1.0/";
var CXB_PREFIX = "colorxbridge";

// Standard namespaces Bridge itself indexes for filtering and sorting.
var NS_DC = "http://purl.org/dc/elements/1.1/";
var NS_LR = "http://ns.adobe.com/lightroom/1.0/";
var NS_XMP = "http://ns.adobe.com/xap/1.0/";

/**
 * Keyword prefix, so our keywords are recognisable and removable.
 *
 * Spelled the British way on purpose, and it must stay that way. This string
 * is not display text: it is written into real files as `Colour: Red`, and
 * pruneAndAppend() finds a previous run's keywords by matching this exact
 * prefix. Changing it to "Color" would stop the old ones being found, so
 * re-analysing a folder would leave every file carrying both `Colour: Red`
 * and `Color: Red`.
 *
 * Same reasoning as the XMP namespace above: once a string is inside the
 * user's files it is data, not branding.
 */
var CXB_KEYWORD_ROOT = "Colour";

var CXB_IMAGE_EXTS = {
  jpg: 1, jpeg: 1, jpe: 1, png: 1, gif: 1, webp: 1, bmp: 1, avif: 1,
  tif: 1, tiff: 1, psd: 1, heic: 1, heif: 1,
  dng: 1, cr2: 1, cr3: 1, nef: 1, arw: 1, orf: 1, raf: 1, rw2: 1, pef: 1, srw: 1
};

/** Formats where XMP must live in a sidecar rather than inside the file. */
var CXB_SIDECAR_ONLY = {
  dng: 0, cr2: 1, cr3: 1, nef: 1, arw: 1, orf: 1, raf: 1, rw2: 1, pef: 1,
  srw: 1, heic: 1, heif: 1, bmp: 1, webp: 1, avif: 1
};

//= ============================================================================
// Minimal JSON support (ExtendScript has no native JSON)
//= ============================================================================

function cxbEscape(s) {
  s = String(s);
  var out = "";
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    var code = s.charCodeAt(i);
    if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (code < 32 || code > 126) {
      var hex = code.toString(16);
      while (hex.length < 4) hex = "0" + hex;
      out += "\\u" + hex;
    } else out += c;
  }
  return out;
}

function cxbJSON(value) {
  var t = typeof value;
  if (value === null || t === "undefined") return "null";
  if (t === "number") return isFinite(value) ? String(value) : "null";
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return '"' + cxbEscape(value) + '"';

  if (value instanceof Array) {
    var items = [];
    for (var i = 0; i < value.length; i++) items.push(cxbJSON(value[i]));
    return "[" + items.join(",") + "]";
  }

  var pairs = [];
  for (var k in value) {
    if (!value.hasOwnProperty(k)) continue;
    if (typeof value[k] === "function") continue;
    pairs.push('"' + cxbEscape(k) + '":' + cxbJSON(value[k]));
  }
  return "{" + pairs.join(",") + "}";
}

function cxbErr(e, where) {
  return cxbJSON({
    success: false,
    error: (e && e.message) ? e.message : String(e),
    line: (e && e.line) ? e.line : null,
    where: where || null
  });
}

function cxbReadFile(path) {
  var f = new File(path);
  if (!f.exists) throw new Error("file not found: " + path);
  f.encoding = "UTF-8";
  f.open("r");
  var text = f.read();
  f.close();
  return text;
}

function cxbWriteFile(path, text) {
  var f = new File(path);
  f.encoding = "UTF-8";
  f.open("w");
  f.write(text);
  f.close();
  return f.fsName;
}

//= ============================================================================
// XMP bootstrap
//= ============================================================================

function cxbLoadXMP() {
  if (typeof XMPMeta === "undefined") {
    if (!ExternalObject.AdobeXMPScript) {
      ExternalObject.AdobeXMPScript = new ExternalObject("lib:AdobeXMPScript");
    }
  }
  XMPMeta.registerNamespace(CXB_NS, CXB_PREFIX);
  return true;
}

function cxbExtOf(path) {
  var dot = String(path).lastIndexOf(".");
  return dot === -1 ? "" : String(path).slice(dot + 1).toLowerCase();
}

//= ============================================================================
// Selection / folder enumeration
//= ============================================================================

function cxbThumbPath(thumb) {
  try {
    if (thumb.spec && thumb.spec.fsName) return thumb.spec.fsName;
  } catch (e) {}
  try {
    if (thumb.path) return new File(thumb.path).fsName;
  } catch (e2) {}
  return null;
}

/**
 * Absolute paths of the images currently selected in Bridge.
 *
 * Counts what it discards. A thumbnail whose path cannot be read looks exactly
 * like nothing being selected once it has been filtered out, and the panel
 * would then tell the user to "select some images first" while they are
 * staring at a full selection.
 */
function cxbGetSelection() {
  try {
    if (!app.document) return cxbJSON({ success: true, files: [], noDocument: true });

    var sel = app.document.selections;
    var files = [];
    var unreadable = 0;
    var notImages = 0;

    // Length is read once: these are live Bridge collections, so re-reading it
    // every iteration asks Bridge for the count 1,559 times.
    for (var i = 0, n = sel.length; i < n; i++) {
      var p = cxbThumbPath(sel[i]);
      if (!p) { unreadable++; continue; }
      if (!CXB_IMAGE_EXTS[cxbExtOf(p)]) { notImages++; continue; }
      files.push(p);
    }
    return cxbJSON({
      success: true, files: files, selected: sel.length,
      unreadable: unreadable, notImages: notImages
    });
  } catch (e) {
    return cxbErr(e, "cxbGetSelection");
  }
}

/** Absolute paths of every image in the folder Bridge is showing. */
function cxbGetFolderImages() {
  try {
    if (!app.document) return cxbJSON({ success: true, files: [] });

    var container = app.document.thumbnail;
    if (!container) return cxbJSON({ success: true, files: [] });

    var kids = container.children;
    var files = [];
    var unreadable = 0;
    var notImages = 0;

    for (var i = 0, n = kids.length; i < n; i++) {
      var p = cxbThumbPath(kids[i]);
      if (!p) { unreadable++; continue; }
      if (!CXB_IMAGE_EXTS[cxbExtOf(p)]) { notImages++; continue; }
      files.push(p);
    }
    return cxbJSON({
      success: true, files: files, folder: container.name,
      children: kids.length, unreadable: unreadable, notImages: notImages
    });
  } catch (e) {
    return cxbErr(e, "cxbGetFolderImages");
  }
}

//= ============================================================================
// XMP write / read
//= ============================================================================

function cxbPaletteToString(palette) {
  var parts = [];
  for (var i = 0; i < palette.length && i < 12; i++) {
    parts.push(palette[i].hex + "|" + Math.round(palette[i].dominance * 1000) / 1000);
  }
  return parts.join(",");
}

function cxbApplyProps(xmp, rec) {
  var d = rec.dominant;
  var hsl = d.hsl || [0, 0, 0];

  xmp.setProperty(CXB_NS, "dominantHex", String(d.hex));
  xmp.setProperty(CXB_NS, "dominantHue", String(hsl[0]));
  xmp.setProperty(CXB_NS, "dominantSaturation", String(hsl[1]));
  xmp.setProperty(CXB_NS, "dominantLightness", String(hsl[2]));
  xmp.setProperty(CXB_NS, "dominance", String(Math.round(d.dominance * 1000) / 1000));
  xmp.setProperty(CXB_NS, "colorName", String(rec.colorName || ""));
  xmp.setProperty(CXB_NS, "palette", cxbPaletteToString(rec.palette || []));
  xmp.setProperty(CXB_NS, "analyzedAt", String(rec.metadata ? rec.metadata.analyzedAt : ""));
  // The schema version of the stored data, NOT the version of the panel.
  // It says how to read the palette string back; bumping it with a release
  // would strand every palette already written.
  xmp.setProperty(CXB_NS, "version", "2.0");
}

/**
 * Write the color family into the keywords Bridge indexes for its Filter
 * panel. Keywords are purely additive, so nothing of the user's is displaced.
 *
 * Previous BridgeColorSorter keywords are pruned first, so re-analyzing a file
 * replaces its color keyword instead of stacking another one.
 *
 * Deliberately does NOT touch xmp:Label. A file carries exactly one label and
 * it belongs to the user's own triage (Select / Approved / Review); color is a
 * property of the image, not a decision about it, so the two must not share a
 * field.
 */
function cxbApplyNativeFields(xmp, rec, opts) {
  var name = String(rec.colorName || "");
  if (!name || !opts.writeKeywords) return;

  pruneAndAppend(NS_DC, "subject",
    CXB_KEYWORD_ROOT + ": ", CXB_KEYWORD_ROOT + ": " + name);
  pruneAndAppend(NS_LR, "hierarchicalSubject",
    CXB_KEYWORD_ROOT + "|", CXB_KEYWORD_ROOT + "|" + name);

  function pruneAndAppend(ns, prop, prefix, value) {
    var count = xmp.countArrayItems(ns, prop);
    var alreadyPresent = false;

    // Walk backwards; deleting shifts the 1-based indices of later items.
    for (var i = count; i >= 1; i--) {
      var item = String(xmp.getArrayItem(ns, prop, i));
      if (item === value) {
        alreadyPresent = true;
      } else if (item.indexOf(prefix) === 0) {
        xmp.deleteArrayItem(ns, prop, i); // color keyword from an earlier run
      }
    }

    if (!alreadyPresent) {
      // Signature is (schemaNS, arrayName, itemValue, itemOptions, arrayOptions)
      // - arrayOptions comes LAST. Putting it third makes the SDK read
      // arrayOptions as 0 and raise "Explicit arrayOptions required to create
      // new array", which is what silently pushed every file to a sidecar.
      xmp.appendArrayItem(ns, prop, value, 0, XMPConst.ARRAY_IS_UNORDERED);
    }
  }
}

/** Build a standalone sidecar .xmp document. */
function cxbSidecarXML(rec, opts) {
  var d = rec.dominant;
  var hsl = d.hsl || [0, 0, 0];
  var name = String(rec.colorName || "");

  var extra = "";
  if (opts && opts.writeKeywords && name) {
    extra +=
      '   <dc:subject><rdf:Bag><rdf:li>' + CXB_KEYWORD_ROOT + ': ' + name +
      '</rdf:li></rdf:Bag></dc:subject>\n' +
      '   <lr:hierarchicalSubject><rdf:Bag><rdf:li>' + CXB_KEYWORD_ROOT + '|' + name +
      '</rdf:li></rdf:Bag></lr:hierarchicalSubject>\n';
  }

  return '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="BridgeColorSorter 2.0">\n' +
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    '  <rdf:Description rdf:about=""\n' +
    '   xmlns:dc="' + NS_DC + '" xmlns:lr="' + NS_LR + '"\n' +
    '   xmlns:' + CXB_PREFIX + '="' + CXB_NS + '"\n' +
    '   ' + CXB_PREFIX + ':dominantHex="' + d.hex + '"\n' +
    '   ' + CXB_PREFIX + ':dominantHue="' + hsl[0] + '"\n' +
    '   ' + CXB_PREFIX + ':dominantSaturation="' + hsl[1] + '"\n' +
    '   ' + CXB_PREFIX + ':dominantLightness="' + hsl[2] + '"\n' +
    '   ' + CXB_PREFIX + ':dominance="' + (Math.round(d.dominance * 1000) / 1000) + '"\n' +
    '   ' + CXB_PREFIX + ':colorName="' + (rec.colorName || '') + '"\n' +
    '   ' + CXB_PREFIX + ':palette="' + cxbPaletteToString(rec.palette || []) + '"\n' +
    '   ' + CXB_PREFIX + ':version="2.0">\n' +
    extra +
    '  </rdf:Description>\n' +
    ' </rdf:RDF>\n' +
    '</x:xmpmeta>\n' +
    '<?xpacket end="w"?>';
}

function cxbSidecarPathFor(filePath) {
  return String(filePath).replace(/\.[^.\/\\]+$/, "") + ".xmp";
}

/**
 * Write one record's color data to XMP.
 * Embedded XMP is preferred; formats that cannot carry it get a sidecar.
 */
/**
 * Map an extension to an XMP file-format constant.
 *
 * The constant is FILE_UNKNOWN - there is no XMPConst.UNKNOWN. Passing the
 * undefined one made the XMPFile constructor throw for every file, so every
 * image silently fell back to a sidecar. Bridge only reads sidecars for camera
 * raw, so for PNG/JPEG/TIFF that put the metadata where Bridge never looks.
 */
function cxbFormatFor(ext) {
  var map = {
    jpg: "FILE_JPEG", jpeg: "FILE_JPEG", jpe: "FILE_JPEG",
    png: "FILE_PNG", gif: "FILE_GIF", tif: "FILE_TIFF", tiff: "FILE_TIFF",
    psd: "FILE_PHOTOSHOP", ai: "FILE_ILLUSTRATOR", eps: "FILE_EPS",
    pdf: "FILE_PDF", jp2: "FILE_JPEG2K"
  };
  var named = map[ext];
  if (named && XMPConst[named] !== undefined) return XMPConst[named];
  return XMPConst.FILE_UNKNOWN;
}

function cxbWriteOne(rec, opts) {
  var filePath = rec.filePath;
  var ext = cxbExtOf(filePath);
  var embedError = null;

  if (!CXB_SIDECAR_ONLY[ext]) {
    var xf = null;
    try {
      xf = new XMPFile(filePath, cxbFormatFor(ext), XMPConst.OPEN_FOR_UPDATE);
      var xmp = xf.getXMP();
      cxbApplyProps(xmp, rec);
      cxbApplyNativeFields(xmp, rec, opts);

      if (xf.canPutXMP(xmp)) {
        xf.putXMP(xmp);
        xf.closeFile(XMPConst.CLOSE_UPDATE_SAFELY);
        return { file: filePath, mode: "embedded" };
      }
      embedError = "canPutXMP() refused the packet";
      xf.closeFile(0);
    } catch (e) {
      embedError = String(e.message || e);
      if (xf) { try { xf.closeFile(0); } catch (e2) {} }
    }
  }

  cxbWriteFile(cxbSidecarPathFor(filePath), cxbSidecarXML(rec, opts));
  return {
    file: filePath,
    mode: "sidecar",
    // Surfaced so a wholesale fallback is visible instead of silent.
    embedError: embedError
  };
}

/**
 * Apply a batch of analysis results written by the panel to a temp JSON file.
 * @param {string} jsonPath path to [{filePath, dominant, palette, ...}, ...]
 */
function cxbApplyResults(jsonPath) {
  try {
    var started = new Date().getTime();
    cxbLoadXMP();

    var payload = eval("(" + cxbReadFile(jsonPath) + ")");

    // Accept either a bare array (older callers) or {records, options}.
    var records = payload instanceof Array ? payload : payload.records;
    var opts = payload instanceof Array ? {} : (payload.options || {});
    if (opts.writeKeywords === undefined) opts.writeKeywords = true;

    var written = [];
    var failed = [];
    var embedded = 0;
    var sidecar = 0;
    var embedError = null;

    for (var i = 0; i < records.length; i++) {
      try {
        var outcome = cxbWriteOne(records[i], opts);
        written.push(outcome);
        if (outcome.mode === "embedded") {
          embedded++;
        } else {
          sidecar++;
          if (!embedError && outcome.embedError) embedError = outcome.embedError;
        }
      } catch (e) {
        failed.push({ file: records[i].filePath, error: String(e) });
      }
    }

    // Summarised here rather than shipped back per file: `modes` was an array
    // of 1,559 objects, each carrying a full path, serialised through
    // evalScript's single return string only for the panel to count them.
    return cxbJSON({
      success: true,
      written: written.length,
      embedded: embedded,
      sidecar: sidecar,
      embedError: embedError,
      failed: failed,
      elapsedMs: new Date().getTime() - started
    });
  } catch (e) {
    return cxbErr(e, "cxbApplyResults");
  }
}

/**
 * Read stored color data for many files at once.
 *
 * Analysis is by far the slowest step - every image has to be decoded and
 * clustered - yet the result is already embedded in each file from the previous
 * run. Reading it back turns a multi-minute re-analysis into a few seconds.
 *
 * Batched deliberately: one evalScript for the whole folder rather than one per
 * file, because the round trip dominates at a thousand files.
 *
 * @param {string} jsonPath temp file holding an array of absolute paths
 * @returns {string} JSON { data: { path: {...} }, hits, misses }
 */
function cxbReadColorBatch(jsonPath) {
  try {
    var started = new Date().getTime();
    cxbLoadXMP();

    var paths = eval("(" + cxbReadFile(jsonPath) + ")");
    var data = {};
    var hits = 0;
    var misses = 0;

    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      var got = null;

      try {
        var xf = new XMPFile(p, cxbFormatFor(cxbExtOf(p)), XMPConst.OPEN_FOR_READ);
        var xmp = xf.getXMP();

        var hex = xmp.getProperty(CXB_NS, "dominantHex");
        var palette = xmp.getProperty(CXB_NS, "palette");
        var version = xmp.getProperty(CXB_NS, "version");

        if (hex && palette) {
          got = {
            hex: String(hex),
            palette: String(palette),
            colorName: String(xmp.getProperty(CXB_NS, "colorName") || ""),
            analyzedAt: String(xmp.getProperty(CXB_NS, "analyzedAt") || ""),
            version: String(version || "")
          };
        }
        xf.closeFile(0);
      } catch (e) {
        // Unreadable or no XMP: treat as a miss and let the panel analyse it.
      }

      if (got) { data[p] = got; hits++; } else { misses++; }
    }

    return cxbJSON({
      success: true, data: data, hits: hits, misses: misses,
      elapsedMs: new Date().getTime() - started
    });
  } catch (e) {
    return cxbErr(e, "cxbReadColorBatch");
  }
}

//= ============================================================================
// Note on native ordering
//= ============================================================================
//
// Bridge's Sort menu cannot be extended. app.document.sorts holds one entry
// whose category must be one of Bridge's own ("name", "date-created",
// "label", "rating", ...), and there is no registration API for a custom
// criterion. SortCriterion exists but only carries a name plus one of those
// built-in types.
//
// The only built-in field that could have carried a color was xmp:Label, and
// writing to it would destroy the user's own triage state - a file has exactly
// one label. That trade is not worth making, so BridgeColorSorter does not reorder
// Bridge's grid at all. It writes color keywords instead, which are additive
// and drive the Filter panel, and does its own ordering inside the panel.

/**
 * Select a file in Bridge's content pane and scroll it into view.
 *
 * Bridge's grid cannot be reordered by color, so this is how the panel's
 * ordering stays useful: sort the list by hue here, then step through it and
 * Bridge follows along.
 */
function cxbRevealFile(filePath) {
  try {
    if (!app.document) {
      return cxbJSON({ success: false, error: "Bridge has no folder open" });
    }

    var file = new File(filePath);
    if (!file.exists) return cxbJSON({ success: false, error: "file not found" });

    // Prefer the folder's own thumbnail. Constructing one makes Bridge build a
    // fresh thumbnail record, which is only worth doing when the file is not
    // in the folder Bridge is currently showing.
    var thumb = null;
    var via = "folder child";
    var kids = app.document.thumbnail.children;
    for (var i = 0, n = kids.length; i < n; i++) {
      if (cxbThumbPath(kids[i]) === file.fsName) { thumb = kids[i]; break; }
    }
    if (!thumb) { thumb = new Thumbnail(file); via = "constructed"; }

    // select() ADDS to the selection, so clear it first or every click
    // accumulates until the whole folder is selected.
    try { app.document.deselectAll(); } catch (eDeselect) {}

    // The only mechanism that works. Assigning app.document.selections is
    // silently ignored by Bridge - it neither throws nor selects - so the old
    // cascade of fallbacks could only ever report a success it had not had.
    try {
      app.document.select(thumb);
    } catch (eSelect) {
      return cxbJSON({ success: false, error: String(eSelect.message || eSelect) });
    }

    var verified = -1;
    try { verified = app.document.selections.length; } catch (eRead) {}
    if (verified === 0) {
      return cxbJSON({ success: false, error: "Bridge did not take the selection" });
    }

    try { app.bringToFront(); } catch (e4) {}
    return cxbJSON({ success: true, via: via, name: thumb.name, verified: verified });
  } catch (e) {
    return cxbErr(e, "cxbRevealFile");
  }
}

/**
 * Select many files at once in Bridge's content pane.
 *
 * Two things were established by measurement on a 1,559-image folder, and both
 * contradict what the code used to assume:
 *
 *  - `app.document.selections = [...]` DOES NOTHING. It does not throw, it
 *    does not select, and the selection stays exactly as it was. Assigning
 *    three known children left the count at zero. Any code that assigns it and
 *    reports success is reporting a success that never happened.
 *  - `app.document.select(thumb)` is the only mechanism that works, and it is
 *    not what crashed Bridge. Driving it 1,559 times over the document's own
 *    child thumbnails takes 3.6 s and Bridge survives comfortably
 *    (100 -> 151 ms, 600 -> 993 ms, 1,000 -> 1.9 s, 1,559 -> 3.6 s).
 *
 * What actually crashed was `new Thumbnail(new File(path))` once per file:
 * each construction makes Bridge build a whole thumbnail record. So no
 * Thumbnail is constructed here at all. The document's existing children are
 * indexed by path and reused, which is both safe and free.
 *
 * The count is read back from Bridge afterwards and returned separately from
 * the count we asked for, so the caller can tell the difference between doing
 * the work and believing it did.
 *
 * @param {string} jsonPath temp file holding {paths: [...], limit: n}
 */
function cxbSelectFiles(jsonPath) {
  try {
    if (!app.document) {
      return cxbJSON({ success: false, error: "Bridge has no folder open" });
    }

    var payload = eval("(" + cxbReadFile(jsonPath) + ")");
    var paths = payload instanceof Array ? payload : payload.paths;
    var limit = (payload instanceof Array ? 0 : payload.limit) || 0;

    // Index the folder's own thumbnails by path - one pass, nothing built.
    var kids = app.document.thumbnail.children;
    var byPath = {};
    for (var i = 0, n = kids.length; i < n; i++) {
      var kp = cxbThumbPath(kids[i]);
      if (kp) byPath[kp] = kids[i];
    }

    var wanted = [];
    var notInFolder = 0;
    for (var j = 0; j < paths.length; j++) {
      if (limit && wanted.length >= limit) break;
      var thumb = byPath[paths[j]];
      if (thumb) wanted.push(thumb); else notInFolder++;
    }

    if (wanted.length === 0) {
      return cxbJSON({
        success: false,
        error: notInFolder
          ? "none of those " + notInFolder + " files are in the folder Bridge is showing"
          : "nothing to select"
      });
    }

    var started = new Date().getTime();
    try { app.document.deselectAll(); } catch (eClear) {}

    var refused = 0;
    for (var s = 0; s < wanted.length; s++) {
      try { app.document.select(wanted[s]); } catch (eOne) { refused++; }
    }

    try { app.bringToFront(); } catch (eFront) {}

    // Deliberately does NOT read the selection back here. Bridge does not
    // settle app.document.selections synchronously at size: after selecting
    // 1,559 files it still reported 0 in this same call, while a read a few
    // hundred milliseconds later correctly reported 1,559. Verifying inline
    // would therefore report a failure that did not happen - the mirror image
    // of the bug this replaces. The panel polls cxbSelectionCount() instead.
    return cxbJSON({
      success: true,
      requested: paths.length,
      attempted: wanted.length,
      notInFolder: notInFolder,
      refused: refused,
      elapsedMs: new Date().getTime() - started
    });
  } catch (e) {
    return cxbErr(e, "cxbSelectFiles");
  }
}

/**
 * How many thumbnails Bridge currently has selected.
 *
 * Exists so a selection can be checked rather than assumed. It has to be a
 * separate call: Bridge updates this property lazily, so it is only truthful
 * once the caller has let some time pass since the selection was made.
 */
function cxbSelectionCount() {
  try {
    if (!app.document) return cxbJSON({ success: true, count: 0, noDocument: true });
    return cxbJSON({ success: true, count: app.document.selections.length });
  } catch (e) {
    return cxbErr(e, "cxbSelectionCount");
  }
}

/**
 * Write xmp:Label so Bridge can group the grid by color via Sort > By Label.
 *
 * Bridge has five label slots and matches the stored string against the texts
 * configured in Preferences > Labels, so the caller supplies the exact text.
 * Files whose color has no meaningful hue (grays, black, white) are cleared
 * rather than forced into a slot.
 *
 * @param {string} jsonPath temp file holding [{filePath, labelText}, ...]
 */
function cxbApplyLabels(jsonPath) {
  try {
    cxbLoadXMP();

    var items = eval("(" + cxbReadFile(jsonPath) + ")");
    var written = 0;
    var cleared = 0;
    var failed = [];

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      try {
        var f = new File(it.filePath);
        if (!f.exists) { failed.push({ file: it.filePath, error: "missing" }); continue; }

        var xf = new XMPFile(f.fsName, cxbFormatFor(cxbExtOf(f.fsName)),
          XMPConst.OPEN_FOR_UPDATE);
        var xmp = xf.getXMP();

        if (it.labelText) {
          xmp.setProperty(NS_XMP, "Label", String(it.labelText));
          written++;
        } else {
          try { xmp.deleteProperty(NS_XMP, "Label"); } catch (eDel) {}
          cleared++;
        }

        if (xf.canPutXMP(xmp)) {
          xf.putXMP(xmp);
          xf.closeFile(XMPConst.CLOSE_UPDATE_SAFELY);
        } else {
          xf.closeFile(0);
          failed.push({ file: it.filePath, error: "canPutXMP refused" });
        }
      } catch (e) {
        failed.push({ file: it.filePath, error: String(e.message || e) });
      }
    }

    // Switch Bridge to its own label sort and force a re-read.
    var sortError = null;
    try {
      app.document.sorts = [{ name: "label", reverse: false }];
    } catch (eSort) {
      sortError = String(eSort.message || eSort);
    }
    try { app.document.refresh(); } catch (eRef) {}

    return cxbJSON({
      success: true, written: written, cleared: cleared, failed: failed,
      sortError: sortError
    });
  } catch (e) {
    return cxbErr(e, "cxbApplyLabels");
  }
}

//= ============================================================================
// Numbering files so Bridge's grid follows the color order
//= ============================================================================
//
// Bridge's Sort menu takes a fixed enum and offers no way to register a
// criterion, and its manual ("user") order cannot be set from a script. The
// filename is the only ordering Bridge exposes that can carry arbitrary data,
// so the color order is encoded into a zero-padded prefix and Bridge is
// switched to Sort > By Filename.
//
// The original name survives intact after the prefix, and is also written to
// XMP, so Undo is exact even if the prefix format later changes.

var CXB_ORIGINAL_NAME = "originalName";

/**
 * Any prefix this panel has written - never let them stack.
 *
 * This MUST stay identical to PREFIX_SOURCE in js/naming.js. ExtendScript
 * cannot load the panel's modules, so the string is duplicated here and
 * test/naming.test.js compares the two character for character. They drifted
 * apart once already: the panel widened the sequence field to P0042 and this
 * copy's fixed-width \d{3} silently stopped matching, which would have stacked
 * a second prefix on the next run.
 */
var CXB_PREFIX_SOURCE = '^(?:[A-Z]\\d{3,}(?:-[A-Z]\\d{3,})*_|\\d{4,}_)';
var CXB_PREFIX_RE = new RegExp(CXB_PREFIX_SOURCE);

function cxbBaseName(path) {
  var parts = String(path).split("/");
  return parts[parts.length - 1];
}

function cxbStripPrefix(name) {
  return String(name).replace(CXB_PREFIX_RE, "");
}

/**
 * Remember the pre-rename filename once, so Undo is exact.
 *
 * Probes read-only first. Opening OPEN_FOR_UPDATE and closing with
 * CLOSE_UPDATE_SAFELY rewrites the whole file - for a 2 MB PNG that is a full
 * copy - and on any re-run over an already-numbered folder the name is already
 * stored, so every one of those rewrites was wasted. The read-only probe costs
 * a header parse and skips the rewrite entirely in the common case.
 *
 * @returns {string} "present" | "written" | "failed: <reason>"
 */
function cxbRememberOriginal(file, originalName) {
  var path = file.fsName;
  var format = cxbFormatFor(cxbExtOf(path));

  try {
    var probe = new XMPFile(path, format, XMPConst.OPEN_FOR_READ);
    var existing = probe.getXMP().getProperty(CXB_NS, CXB_ORIGINAL_NAME);
    probe.closeFile(0);
    if (existing) return "present";
  } catch (eProbe) {
    // No readable XMP yet; fall through and try to create it.
  }

  try {
    var xf = new XMPFile(path, format, XMPConst.OPEN_FOR_UPDATE);
    var xmp = xf.getXMP();
    xmp.setProperty(CXB_NS, CXB_ORIGINAL_NAME, originalName);

    if (!xf.canPutXMP(xmp)) {
      xf.closeFile(0);
      return "failed: canPutXMP refused";
    }
    xf.putXMP(xmp);
    xf.closeFile(XMPConst.CLOSE_UPDATE_SAFELY);
    return "written";
  } catch (e) {
    // Not fatal - cxbStripPrefix can still recover the name - but it is the
    // difference between an exact Undo and a regex guess, so it is counted and
    // reported rather than swallowed.
    return "failed: " + String(e.message || e);
  }
}

/**
 * Keep a sidecar's stem matched to its image, or it is orphaned.
 * @returns {boolean} false only when a sidecar exists and could not be moved
 */
function cxbRenameSidecar(oldPath, newFileName) {
  try {
    var side = new File(cxbSidecarPathFor(oldPath));
    if (!side.exists) return true;
    return !!side.rename(newFileName.replace(/\.[^.]+$/, "") + ".xmp");
  } catch (e) {
    return false;
  }
}

/**
 * Apply a color-order prefix to each file.
 * @param {string} jsonPath temp file holding [{filePath, prefix}, ...]
 */
function cxbApplyPrefixes(jsonPath) {
  try {
    cxbLoadXMP();

    var items = eval("(" + cxbReadFile(jsonPath) + ")");
    var renamed = 0;
    var skipped = 0;
    var failed = [];
    var renames = {};
    // Undo falls back to a regex strip when the original name was never
    // stored. That guess is wrong for a user file legitimately named like
    // "A123_photo.jpg", so a wholesale failure to record names must be
    // visible rather than discovered at Undo time.
    var nameUnrecorded = 0;
    var nameError = null;
    // A sidecar left behind under the old stem is orphaned: its image has
    // moved and nothing will ever read it again.
    var orphanedSidecars = 0;

    for (var i = 0; i < items.length; i++) {
      var oldPath = items[i].filePath;
      try {
        var file = new File(oldPath);
        if (!file.exists) { failed.push({ file: oldPath, error: "missing" }); continue; }

        var current = cxbBaseName(file.fsName);
        var original = cxbStripPrefix(current);
        var target = items[i].prefix + "_" + original;

        if (current === target) { skipped++; renames[oldPath] = oldPath; continue; }

        var remembered = cxbRememberOriginal(file, original);
        if (remembered.indexOf("failed") === 0) {
          nameUnrecorded++;
          if (!nameError) nameError = remembered.slice(8);
        }

        if (file.rename(target)) {
          if (!cxbRenameSidecar(oldPath, target)) orphanedSidecars++;
          renamed++;
          renames[oldPath] = file.fsName;
        } else {
          failed.push({ file: oldPath, error: "rename refused" });
        }
      } catch (e) {
        failed.push({ file: oldPath, error: String(e.message || e) });
      }
    }

    // Filename order is now color order, so point Bridge at it.
    var sortError = null;
    try {
      app.document.sorts = [{ name: "name", reverse: false }];
    } catch (eSort) {
      sortError = String(eSort.message || eSort);
    }
    try { app.document.refresh(); } catch (eRef) {}

    return cxbJSON({
      success: true, renamed: renamed, skipped: skipped,
      failed: failed, renames: renames,
      nameUnrecorded: nameUnrecorded, nameError: nameError,
      orphanedSidecars: orphanedSidecars,
      sortError: sortError
    });
  } catch (e) {
    return cxbErr(e, "cxbApplyPrefixes");
  }
}

/** Put the original filenames back. */
function cxbRestoreNames(jsonPath) {
  try {
    cxbLoadXMP();

    var paths = eval("(" + cxbReadFile(jsonPath) + ")");
    var restored = 0;
    var failed = [];
    var renames = {};
    // How many names came from the stored original versus a regex guess. The
    // guess is only exact if no filename legitimately looks like a prefix, so
    // the split is reported rather than hidden behind "restored: n".
    var fromXmp = 0;
    var fromStrip = 0;

    for (var i = 0; i < paths.length; i++) {
      var oldPath = paths[i];
      try {
        var file = new File(oldPath);
        if (!file.exists) continue;

        var current = cxbBaseName(file.fsName);
        var original = null;

        try {
          var xf = new XMPFile(file.fsName, cxbFormatFor(cxbExtOf(file.fsName)),
            XMPConst.OPEN_FOR_READ);
          var got = xf.getXMP().getProperty(CXB_NS, CXB_ORIGINAL_NAME);
          if (got) original = String(got);
          xf.closeFile(0);
        } catch (eRead) {
          // Unreadable XMP; the strip fallback below still recovers a name.
        }

        if (original) fromXmp++;
        else { original = cxbStripPrefix(current); fromStrip++; }

        if (original === current) { renames[oldPath] = oldPath; continue; }

        if (file.rename(original)) {
          cxbRenameSidecar(oldPath, original);
          restored++;
          renames[oldPath] = file.fsName;
        } else {
          failed.push({ file: oldPath, error: "rename refused" });
        }
      } catch (e) {
        failed.push({ file: oldPath, error: String(e.message || e) });
      }
    }

    try { app.document.refresh(); } catch (eRef) {}
    return cxbJSON({
      success: true, restored: restored, failed: failed, renames: renames,
      fromXmp: fromXmp, fromStrip: fromStrip
    });
  } catch (e) {
    return cxbErr(e, "cxbRestoreNames");
  }
}

/**
 * Ask Bridge to re-read metadata.
 *
 * Deliberately whole-document only. The previous version accepted a path list
 * and did `new Thumbnail(new File(p)).refresh()` per file - the exact shape
 * that terminated Bridge from cxbSelectFiles at 1,559 files, since every
 * Thumbnail construction forces a content-pane update. app.document.refresh()
 * does the same job for the whole folder in one call, so there is nothing to
 * gain from the loop and a crash to lose. The parameter is still accepted and
 * ignored, so older callers keep working.
 */
function cxbRefresh() {
  try {
    if (!app.document) return cxbJSON({ success: true, refreshed: false });
    app.document.refresh();
    return cxbJSON({ success: true, refreshed: true });
  } catch (e) {
    return cxbErr(e, "cxbRefresh");
  }
}

//= ============================================================================
// Diagnostics
//= ============================================================================

/** Every probe is individually guarded, so one missing API cannot blank the rest. */
function cxbProbeAll() {
  var d = {};

  function probe(key, fn) {
    try { d[key] = String(fn()); } catch (e) { d[key] = "ERR: " + e; }
  }

  probe("appName", function () { return BridgeTalk.appName; });
  probe("appVersion", function () { return BridgeTalk.appVersion; });
  probe("bridgeVersion", function () { return app.version; });
  probe("SortCriterion", function () { return typeof SortCriterion; });
  probe("TabbedPalette", function () { return typeof TabbedPalette; });
  probe("MenuElement", function () { return typeof MenuElement; });
  probe("app.registerInfoset", function () { return typeof app.registerInfoset; });
  probe("app.registerSort", function () { return typeof app.registerSort; });
  probe("hasDocument", function () { return app.document ? "yes" : "no"; });
  probe("selectionCount", function () { return app.document.selections.length; });
  probe("folder", function () { return app.document.thumbnail.name; });
  probe("folderChildren", function () { return app.document.thumbnail.children.length; });

  probe("sorts", function () {
    var s = app.document.sorts, n = [];
    for (var i = 0; i < s.length; i++) n.push(s[i].name);
    return n.join(" | ");
  });
  probe("sorts.push", function () { return typeof app.document.sorts.push; });
  probe("sorts.add", function () { return typeof app.document.sorts.add; });
  probe("currentSort", function () { return app.document.sort.name; });

  probe("sortEntryShape", function () {
    var entry = app.document.sorts[0];
    var bits = [];
    for (var k in entry) bits.push(k + "=" + entry[k]);
    return bits.join(", ");
  });

  probe("xmpLib", function () {
    cxbLoadXMP();
    return "XMPMeta=" + (typeof XMPMeta) + " XMPFile=" + (typeof XMPFile);
  });

  probe("thumbnailKeys", function () {
    var t = app.document.selections.length
      ? app.document.selections[0]
      : app.document.thumbnail;
    var keys = [];
    for (var k in t) keys.push(k);
    return keys.join(",");
  });

  return d;
}

function cxbDiagnostics() {
  try {
    return cxbJSON({ success: true, diagnostics: cxbProbeAll() });
  } catch (e) {
    return cxbErr(e, "cxbDiagnostics");
  }
}

/**
 * Same diagnostics, also dropped on disk so they can be read without the
 * panel. A failed write is reported rather than swallowed: silently not
 * writing the file it was asked for is how a diagnostic stops being one.
 */
function cxbDiagnosticsToFile(outPath) {
  try {
    var path = outPath || "/tmp/cxb-diag.json";
    var d = cxbProbeAll();
    var written = null;
    var writeError = null;

    try {
      written = cxbWriteFile(path, cxbJSON({ success: true, diagnostics: d }));
    } catch (eWrite) {
      writeError = String(eWrite.message || eWrite);
    }

    return cxbJSON({
      success: true, diagnostics: d, written: written, writeError: writeError
    });
  } catch (e) {
    return cxbErr(e, "cxbDiagnosticsToFile");
  }
}
