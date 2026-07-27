/**
 * Guards against the two XMP API mistakes that silently broke this project.
 *
 * Run from the panel's DevTools console (or any evalScript host) with:
 *   cxbTestXmpApi()
 *
 * Both bugs failed the same way: an exception inside cxbWriteOne(), swallowed
 * by the sidecar fallback. Since Bridge only reads .xmp sidecars for camera
 * raw, every JPEG/PNG/TIFF ended up with its colour data somewhere Bridge
 * never looks - while the panel reported success.
 *
 * @target bridge
 */

function cxbTestXmpApi() {
  cxbLoadXMP();

  var DC = "http://purl.org/dc/elements/1.1/";
  var results = [];
  var failures = 0;

  function check(label, condition, detail) {
    results.push((condition ? "ok   " : "FAIL ") + label +
      (condition ? "" : "   <- " + detail));
    if (!condition) failures++;
  }

  // 1. The file-format constant is FILE_UNKNOWN. There is no XMPConst.UNKNOWN;
  //    passing the undefined one makes the XMPFile constructor throw.
  check("XMPConst.FILE_UNKNOWN is defined",
    XMPConst.FILE_UNKNOWN !== undefined, "constant missing");
  check("XMPConst.UNKNOWN does NOT exist (do not use it)",
    XMPConst.UNKNOWN === undefined, "unexpectedly defined");
  check("XMPConst.FILE_PNG is defined",
    XMPConst.FILE_PNG !== undefined, "constant missing");

  // 2. appendArrayItem takes arrayOptions LAST:
  //       (schemaNS, arrayName, itemValue, itemOptions, arrayOptions)
  //    Putting it third makes the SDK read arrayOptions as 0 and raise
  //    "Explicit arrayOptions required to create new array".
  var correct = new XMPMeta();
  var threw = null;
  try {
    correct.appendArrayItem(DC, "subject", "Colour: Test", 0,
      XMPConst.ARRAY_IS_UNORDERED);
  } catch (e) {
    threw = e.message;
  }
  check("appendArrayItem(ns, name, value, itemOpts, arrayOpts) succeeds",
    threw === null, threw);
  check("the item is readable back",
    threw === null && String(correct.getArrayItem(DC, "subject", 1)) === "Colour: Test",
    "round-trip failed");
  check("it serialises as an rdf:Bag",
    threw === null && correct.serialize().indexOf("<rdf:Bag>") !== -1,
    "not an unordered array");

  // The wrong order must still be rejected - if this ever starts passing, the
  // guard above has become meaningless and should be revisited.
  var wrongRejected = false;
  try {
    new XMPMeta().appendArrayItem(DC, "subject", XMPConst.ARRAY_IS_UNORDERED,
      "Colour: Test", 0);
  } catch (e2) {
    wrongRejected = true;
  }
  check("the old (wrong) argument order still fails", wrongRejected,
    "wrong order no longer throws");

  results.push(failures === 0 ? "\nALL XMP API GUARDS PASSED"
    : "\n" + failures + " GUARD(S) FAILED");
  return results.join("\n");
}
