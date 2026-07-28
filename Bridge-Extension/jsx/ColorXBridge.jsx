/**
 * ColorXBridge - ExtendScript host layer (runs inside Adobe Bridge)
 *
 * Everything the panel needs from Bridge itself lives here: the current
 * selection, XMP read/write, and the colour keywords that drive Bridge's
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

/** Keyword prefix, so our keywords are recognisable and removable. */
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

/** Absolute paths of the images currently selected in Bridge. */
function cxbGetSelection() {
  try {
    if (!app.document) return cxbJSON({ success: true, files: [] });

    var sel = app.document.selections;
    var files = [];

    for (var i = 0; i < sel.length; i++) {
      var p = cxbThumbPath(sel[i]);
      if (p && CXB_IMAGE_EXTS[cxbExtOf(p)]) files.push(p);
    }
    return cxbJSON({ success: true, files: files });
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

    for (var i = 0; i < kids.length; i++) {
      var p = cxbThumbPath(kids[i]);
      if (p && CXB_IMAGE_EXTS[cxbExtOf(p)]) files.push(p);
    }
    return cxbJSON({ success: true, files: files, folder: container.name });
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
  xmp.setProperty(CXB_NS, "version", "2.0");
}

/**
 * Write the colour family into the keywords Bridge indexes for its Filter
 * panel. Keywords are purely additive, so nothing of the user's is displaced.
 *
 * Previous ColorXBridge keywords are pruned first, so re-analysing a file
 * replaces its colour keyword instead of stacking another one.
 *
 * Deliberately does NOT touch xmp:Label. A file carries exactly one label and
 * it belongs to the user's own triage (Select / Approved / Review); colour is a
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
        xmp.deleteArrayItem(ns, prop, i); // colour keyword from an earlier run
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
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="ColorXBridge 2.0">\n' +
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
 * Write one record's colour data to XMP.
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
    cxbLoadXMP();

    var payload = eval("(" + cxbReadFile(jsonPath) + ")");

    // Accept either a bare array (older callers) or {records, options}.
    var records = payload instanceof Array ? payload : payload.records;
    var opts = payload instanceof Array ? {} : (payload.options || {});
    if (opts.writeKeywords === undefined) opts.writeKeywords = true;

    var written = [];
    var failed = [];

    for (var i = 0; i < records.length; i++) {
      try {
        written.push(cxbWriteOne(records[i], opts));
      } catch (e) {
        failed.push({ file: records[i].filePath, error: String(e) });
      }
    }

    return cxbJSON({
      success: true,
      written: written.length,
      failed: failed,
      modes: written
    });
  } catch (e) {
    return cxbErr(e, "cxbApplyResults");
  }
}

/**
 * Read stored colour data for many files at once.
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

    return cxbJSON({ success: true, data: data, hits: hits, misses: misses });
  } catch (e) {
    return cxbErr(e, "cxbReadColorBatch");
  }
}

/** Read previously stored colour data for one file. */
function cxbReadColor(filePath) {
  try {
    cxbLoadXMP();

    var read = function (xmp) {
      var hex = xmp.getProperty(CXB_NS, "dominantHex");
      if (!hex) return null;
      return {
        hex: String(hex),
        hue: Number(xmp.getProperty(CXB_NS, "dominantHue")) || 0,
        saturation: Number(xmp.getProperty(CXB_NS, "dominantSaturation")) || 0,
        lightness: Number(xmp.getProperty(CXB_NS, "dominantLightness")) || 0,
        dominance: Number(xmp.getProperty(CXB_NS, "dominance")) || 0,
        palette: String(xmp.getProperty(CXB_NS, "palette") || "")
      };
    };

    try {
      var xf = new XMPFile(filePath, cxbFormatFor(cxbExtOf(filePath)),
        XMPConst.OPEN_FOR_READ);
      var got = read(xf.getXMP());
      xf.closeFile(0);
      if (got) return cxbJSON({ success: true, source: "embedded", data: got });
    } catch (e1) {}

    var side = new File(cxbSidecarPathFor(filePath));
    if (side.exists) {
      var meta = new XMPMeta(cxbReadFile(side.fsName));
      var got2 = read(meta);
      if (got2) return cxbJSON({ success: true, source: "sidecar", data: got2 });
    }

    return cxbJSON({ success: true, data: null });
  } catch (e) {
    return cxbErr(e, "cxbReadColor");
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
// The only built-in field that could have carried a colour was xmp:Label, and
// writing to it would destroy the user's own triage state - a file has exactly
// one label. That trade is not worth making, so ColorXBridge does not reorder
// Bridge's grid at all. It writes colour keywords instead, which are additive
// and drive the Filter panel, and does its own ordering inside the panel.

/**
 * Select a file in Bridge's content pane and scroll it into view.
 *
 * Bridge's grid cannot be reordered by colour, so this is how the panel's
 * ordering stays useful: sort the list by hue here, then step through it and
 * Bridge follows along.
 */
function cxbRevealFile(filePath) {
  try {
    var file = new File(filePath);
    if (!file.exists) return cxbJSON({ success: false, error: "file not found" });

    var thumb = new Thumbnail(file);
    var how = null;

    // document.select() ADDS to the selection, so clear it first or every
    // click accumulates until the whole folder is selected.
    try { app.document.deselectAll(); } catch (eDeselect) {
      try { app.document.selections = []; } catch (eEmpty) {}
    }

    // Builds differ in which of these they expose.
    if (!how) {
      try { app.document.select(thumb); how = "document.select"; } catch (e) {}
    }
    if (!how) {
      try { app.document.selections = [thumb]; how = "document.selections"; } catch (e2) {}
    }
    if (!how) {
      try { app.document.thumbnail = thumb; how = "document.thumbnail"; } catch (e3) {}
    }

    if (!how) return cxbJSON({ success: false, error: "no way to select a thumbnail" });

    try { app.bringToFront(); } catch (e4) {}
    return cxbJSON({ success: true, via: how, name: thumb.name });
  } catch (e) {
    return cxbErr(e, "cxbRevealFile");
  }
}

/**
 * Select many files at once in Bridge's content pane.
 * @param {string} jsonPath temp file holding an array of absolute paths
 */
function cxbSelectFiles(jsonPath) {
  try {
    var payload = eval("(" + cxbReadFile(jsonPath) + ")");
    var paths = payload instanceof Array ? payload : payload.paths;
    var limit = (payload instanceof Array ? 0 : payload.limit) || 0;

    // Selecting one thumbnail at a time crashed Bridge outright at 1,559 files:
    // every call constructs a Thumbnail and forces the content pane to update.
    // Build the whole list first and hand it over in a single assignment.
    var thumbs = [];
    var missing = 0;

    for (var i = 0; i < paths.length; i++) {
      if (limit && thumbs.length >= limit) break;
      try {
        var f = new File(paths[i]);
        if (!f.exists) { missing++; continue; }
        thumbs.push(new Thumbnail(f));
      } catch (eMake) {
        missing++;
      }
    }

    if (thumbs.length === 0) {
      return cxbJSON({ success: false, error: "none of those files could be found" });
    }

    var how = null;
    try {
      app.document.selections = thumbs;
      how = "bulk";
    } catch (eBulk) {
      // Older builds may not accept a whole-array assignment. Fall back to the
      // incremental route, but only for a small set - it is what crashed.
      try { app.document.deselectAll(); } catch (eClear) {}
      var capped = Math.min(thumbs.length, 200);
      for (var j = 0; j < capped; j++) {
        try { app.document.select(thumbs[j]); } catch (eOne) {}
      }
      how = "incremental (capped at " + capped + ")";
    }

    try { app.bringToFront(); } catch (eFront) {}

    return cxbJSON({
      success: true,
      selected: thumbs.length,
      requested: paths.length,
      missing: missing,
      via: how
    });
  } catch (e) {
    return cxbErr(e, "cxbSelectFiles");
  }
}

/**
 * Write xmp:Label so Bridge can group the grid by colour via Sort > By Label.
 *
 * Bridge has five label slots and matches the stored string against the texts
 * configured in Preferences > Labels, so the caller supplies the exact text.
 * Files whose colour has no meaningful hue (greys, black, white) are cleared
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
    try { app.document.sorts = [{ name: "label", reverse: false }]; } catch (eSort) {}
    try { app.document.refresh(); } catch (eRef) {}

    return cxbJSON({
      success: true, written: written, cleared: cleared, failed: failed
    });
  } catch (e) {
    return cxbErr(e, "cxbApplyLabels");
  }
}

//= ============================================================================
// Numbering files so Bridge's grid follows the colour order
//= ============================================================================
//
// Bridge's Sort menu takes a fixed enum and offers no way to register a
// criterion, and its manual ("user") order cannot be set from a script. The
// filename is the only ordering Bridge exposes that can carry arbitrary data,
// so the colour order is encoded into a zero-padded prefix and Bridge is
// switched to Sort > By Filename.
//
// The original name survives intact after the prefix, and is also written to
// XMP, so Undo is exact even if the prefix format later changes.

var CXB_ORIGINAL_NAME = "originalName";

/**
 * Any prefix this panel has written - never let them stack.
 * \d{3,} rather than \d{3}: the similarity prefix uses a wider sequence field
 * (P0000), which a fixed width silently failed to match.
 */
var CXB_PREFIX_RE = /^(?:[A-Z]\d{3,}(?:-[A-Z]\d{3,})*_|\d{4,}_)/;

function cxbBaseName(path) {
  var parts = String(path).split("/");
  return parts[parts.length - 1];
}

function cxbStripPrefix(name) {
  return String(name).replace(CXB_PREFIX_RE, "");
}

/** Remember the pre-rename filename once, so Undo is exact. */
function cxbRememberOriginal(file, originalName) {
  try {
    var xf = new XMPFile(file.fsName, cxbFormatFor(cxbExtOf(file.fsName)),
      XMPConst.OPEN_FOR_UPDATE);
    var xmp = xf.getXMP();
    if (!xmp.getProperty(CXB_NS, CXB_ORIGINAL_NAME)) {
      xmp.setProperty(CXB_NS, CXB_ORIGINAL_NAME, originalName);
      if (xf.canPutXMP(xmp)) xf.putXMP(xmp);
    }
    xf.closeFile(XMPConst.CLOSE_UPDATE_SAFELY);
  } catch (e) {
    // Not fatal: cxbStripPrefix can still recover the name.
  }
}

/** Keep a sidecar's stem matched to its image, or it is orphaned. */
function cxbRenameSidecar(oldPath, newFileName) {
  try {
    var side = new File(cxbSidecarPathFor(oldPath));
    if (side.exists) side.rename(newFileName.replace(/\.[^.]+$/, "") + ".xmp");
  } catch (e) {}
}

/**
 * Apply a colour-order prefix to each file.
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

    for (var i = 0; i < items.length; i++) {
      var oldPath = items[i].filePath;
      try {
        var file = new File(oldPath);
        if (!file.exists) { failed.push({ file: oldPath, error: "missing" }); continue; }

        var current = cxbBaseName(file.fsName);
        var original = cxbStripPrefix(current);
        var target = items[i].prefix + "_" + original;

        if (current === target) { skipped++; renames[oldPath] = oldPath; continue; }

        cxbRememberOriginal(file, original);

        if (file.rename(target)) {
          cxbRenameSidecar(oldPath, target);
          renamed++;
          renames[oldPath] = file.fsName;
        } else {
          failed.push({ file: oldPath, error: "rename refused" });
        }
      } catch (e) {
        failed.push({ file: oldPath, error: String(e.message || e) });
      }
    }

    // Filename order is now colour order, so point Bridge at it.
    try { app.document.sorts = [{ name: "name", reverse: false }]; } catch (eSort) {}
    try { app.document.refresh(); } catch (eRef) {}

    return cxbJSON({
      success: true, renamed: renamed, skipped: skipped,
      failed: failed, renames: renames
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
        } catch (eRead) {}

        if (!original) original = cxbStripPrefix(current);
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
      success: true, restored: restored, failed: failed, renames: renames
    });
  } catch (e) {
    return cxbErr(e, "cxbRestoreNames");
  }
}

/** Ask Bridge to re-read metadata for the given files. */
function cxbRefresh(jsonPath) {
  try {
    if (jsonPath) {
      var paths = eval("(" + cxbReadFile(jsonPath) + ")");
      for (var i = 0; i < paths.length; i++) {
        try { new Thumbnail(new File(paths[i])).refresh(); } catch (e) {}
      }
    }
    try { app.document.refresh(); } catch (e2) {}
    return cxbJSON({ success: true });
  } catch (e) {
    return cxbErr(e, "cxbRefresh");
  }
}

//= ============================================================================
// Diagnostics
//= ============================================================================

function cxbDiagnostics() {
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

  return cxbJSON({ success: true, diagnostics: d });
}

function cxbDiagnosticsToFile(outPath) {
  var json = cxbDiagnostics();
  try { cxbWriteFile(outPath || "/tmp/cxb-diag.json", json); } catch (e) {}
  return json;
}
