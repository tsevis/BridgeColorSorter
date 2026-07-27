/**
 * BridgeController.jsx
 * ExtendScript Bridge Module for ColorXBridge Extension
 * 
 * Handles all Bridge-specific operations:
 * - File selection and enumeration
 * - Thumbnail management  
 * - XMP metadata operations via Bridge's XMPFile API
 * - Sort/filter operations on Bridge content
 * 
 * @version 1.0.0
 * @target bridge
 */

#target bridge

// ============================================================================
// CONFIGURATION
// ============================================================================

var CXB_NS = "http://ns.adobe.com/colorxbridge/1.0/";
var CXB_PREFIX = "colorxbridge";

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the ColorXBridge XMP namespace in Bridge
 * @returns {Object} Result object with success status
 */
function initNamespace() {
  try {
    // Load XMP libraries
    if (!ExternalObject.XMP) {
      ExternalObject.XMP = new ExternalObject("lib:AdobeXMP");
    }
    if (!ExternalObject.XMPFile) {
      ExternalObject.XMPFile = new ExternalObject("lib:AdobeXMPFiles");
    }
    
    // Register custom namespace
    XMPMeta.registerNamespace(CXB_NS, CXB_PREFIX);
    
    return { success: true, message: "XMP namespace initialized" };
  } catch (e) {
    return { 
      success: false, 
      error: "Failed to initialize XMP: " + e.message + " (Line: " + e.line + ")"
    };
  }
}

// Initialize on load
initNamespace();

// ============================================================================
// FILE OPERATIONS
// ============================================================================

/**
 * Get currently selected files in Bridge
 * @returns {Array} Array of file paths (native paths)
 */
function getSelectedFiles() {
  try {
    var files = [];
    
    // Check if we have a document
    if (!app.document) {
      return [];
    }
    
    // Get selections - Bridge stores these in different ways depending on version
    var selections = app.document.selections;
    
    if (!selections || selections.length === 0) {
      return [];
    }
    
    // Iterate through selections
    for (var i = 0; i < selections.length; i++) {
      var item = selections[i];
      if (item) {
        // Try different property names for different Bridge versions
        var filePath = item.spec ? item.spec.fsName : 
                       item.path ? item.path : 
                       item.fullName ? item.fullName : null;
        
        if (filePath) {
          // Convert to native path format
          if (filePath.indexOf("/") !== -1) {
            filePath = filePath.replace(/\//g, "\\");
          }
          files.push(filePath);
        }
      }
    }
    
    return files;
  } catch (e) {
    return [];
  }
}

/**
 * Get all image files in the current folder
 * @returns {Array} Array of file paths
 */
function getAllFiles() {
  try {
    var files = [];
    
    if (!app.document || !app.document.path) {
      return [];
    }
    
    var folderPath = app.document.path;
    var folder = new Folder(folderPath);
    
    if (!folder.exists) {
      return [];
    }
    
    // Supported image extensions
    var imageExts = [
      "jpg", "jpeg", "png", "tiff", "tif", "gif", "webp", 
      "psd", "ai", "eps", "raw", "cr2", "nef", "arw", "dng",
      "heic", "heif", "bmp", "ico", "svg"
    ];
    
    var items = folder.getFiles();
    
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      
      if (item instanceof File) {
        var ext = item.name.split(".").pop().toLowerCase();
        
        if (imageExts.indexOf(ext) !== -1) {
          files.push(item.fsName);
        }
      }
    }
    
    return files;
  } catch (e) {
    return [];
  }
}

/**
 * Get file info for a single file
 * @param {string} filePath - Path to the file
 * @returns {Object} File information
 */
function getFileInfo(filePath) {
  try {
    var file = new File(filePath);
    
    if (!file.exists) {
      return { success: false, error: "File not found" };
    }
    
    return {
      success: true,
      name: file.name,
      path: file.fsName,
      size: file.length,
      type: file.type,
      created: file.created,
      modified: file.modified
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============================================================================
// SORT OPERATIONS
// ============================================================================

/**
 * Sort files by color metadata
 * Note: Bridge doesn't support reordering thumbnails directly.
 * We return the sorted order for the panel to display.
 * 
 * @param {Object} sortData - Contains files, sortBy, and results
 * @returns {Object} Result with sorted file list
 */
function sortItems(sortData) {
  try {
    var files = sortData.files || [];
    var sortBy = sortData.sortBy || "hue";
    var results = sortData.results || {};
    
    if (files.length === 0) {
      return { success: false, error: "No files to sort" };
    }
    
    // Sort the files array based on color data
    files.sort(function(a, b) {
      var dataA = results[a];
      var dataB = results[b];
      
      if (!dataA || !dataB) return 0;
      
      var domA = dataA.dominant;
      var domB = dataB.dominant;
      
      if (!domA || !domB) return 0;
      
      switch (sortBy) {
        case "hue":
          var hueA = domA.hsl ? domA.hsl[0] : 0;
          var hueB = domB.hsl ? domB.hsl[0] : 0;
          return hueA - hueB;
          
        case "saturation":
          var satA = domA.hsl ? domA.hsl[1] : 0;
          var satB = domB.hsl ? domB.hsl[1] : 0;
          return satA - satB;
          
        case "brightness":
          var briA = domA.hsl ? domA.hsl[2] : 0;
          var briB = domB.hsl ? domB.hsl[2] : 0;
          return briA - briB;
          
        case "dominance":
          var domAP = domA.dominance || 0;
          var domBP = domB.dominance || 0;
          return domBP - domAP;
          
        default:
          return 0;
      }
    });
    
    return { 
      success: true, 
      sortedFiles: files,
      message: "Files sorted by " + sortBy
    };
  } catch (e) {
    return { 
      success: false, 
      error: "Sort failed: " + e.message + " (Line: " + e.line + ")"
    };
  }
}

// ============================================================================
// XMP METADATA OPERATIONS
// ============================================================================

/**
 * Write ColorXBridge metadata to a file's XMP
 * @param {string} filePath - Path to the image file
 * @param {Object} metadata - Color analysis metadata
 * @returns {Object} Result object
 */
function writeXMP(filePath, metadata) {
  try {
    var file = new File(filePath);
    
    if (!file.exists) {
      return { success: false, error: "File not found: " + filePath };
    }
    
    // Ensure namespace is initialized
    if (!ExternalObject.XMP) {
      initNamespace();
    }
    
    // Try to write to embedded XMP first
    try {
      var xmpFile = new XMPFile(filePath, XMPConst.UNKNOWN, XMPConst.OPEN_FOR_UPDATE);
      var xmp = xmpFile.getXMP();
      
      if (xmp) {
        // Set ColorXBridge properties
        xmp.setProperty(CXB_NS, "dominantHex", metadata.dominant.hex);
        xmp.setProperty(CXB_NS, "dominantHue", (metadata.dominant.hsl ? metadata.dominant.hsl[0] : 0).toString());
        xmp.setProperty(CXB_NS, "dominantSaturation", (metadata.dominant.hsl ? metadata.dominant.hsl[1] : 0).toString());
        xmp.setProperty(CXB_NS, "dominantBrightness", (metadata.dominant.hsl ? metadata.dominant.hsl[2] : 0).toString());
        xmp.setProperty(CXB_NS, "dominance", (metadata.dominant.dominance || 0).toString());
        xmp.setProperty(CXB_NS, "analyzedVersion", "1.0");
        xmp.setProperty(CXB_NS, "analyzedTimestamp", new Date(metadata.metadata.analyzedAt).toISOString());
        xmp.setProperty(CXB_NS, "algorithm", metadata.metadata.algorithm || "kmeans");
        
        // Write palette as serialized string
        if (metadata.palette && metadata.palette.length > 0) {
          var paletteStr = "";
          for (var i = 0; i < metadata.palette.length; i++) {
            var c = metadata.palette[i];
            if (i > 0) paletteStr += ",";
            paletteStr += c.hex + "|" + c.dominance.toFixed(2);
          }
          xmp.setProperty(CXB_NS, "palette", paletteStr);
        }
        
        // Update the file
        xmpFile.putXMP(xmp);
        xmpFile.closeFile(XMPConst.CLOSE_UPDATE_SAFELY);
        
        // Refresh Bridge thumbnail
        try {
          if (app.document && app.document.refresh) {
            app.document.refresh();
          }
        } catch (refreshErr) {
          // Ignore refresh errors
        }
        
        return { 
          success: true, 
          message: "XMP metadata written to file"
        };
      }
    } catch (xmpErr) {
      // Embedded XMP failed, fall through to sidecar
    }
    
    // Fallback: Write XMP sidecar file
    return writeXMPSidecar(filePath, metadata);
    
  } catch (e) {
    return { 
      success: false, 
      error: "Failed to write XMP: " + e.message + " (Line: " + e.line + ")"
    };
  }
}

/**
 * Write XMP sidecar file
 * @param {string} filePath - Path to the image file
 * @param {Object} metadata - Color analysis metadata
 * @returns {Object} Result object
 */
function writeXMPSidecar(filePath, metadata) {
  try {
    var xmpPath = filePath.replace(/\.[^.]+$/, '.xmp');
    var xmpFile = new File(xmpPath);
    
    // Build palette string
    var paletteStr = "";
    if (metadata.palette && metadata.palette.length > 0) {
      for (var i = 0; i < metadata.palette.length; i++) {
        var c = metadata.palette[i];
        if (i > 0) paletteStr += ",";
        paletteStr += c.hex + "|" + c.dominance.toFixed(2);
      }
    }
    
    // Build XMP content
    var xmpContent = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
'<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="ColorXBridge 1.0">\n' +
'  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
'    <rdf:Description rdf:about=""\n' +
'        xmlns:colorxbridge="' + CXB_NS + '">\n' +
'      <colorxbridge:dominantHex>' + metadata.dominant.hex + '</colorxbridge:dominantHex>\n' +
'      <colorxbridge:dominantHue>' + (metadata.dominant.hsl ? metadata.dominant.hsl[0] : 0) + '</colorxbridge:dominantHue>\n' +
'      <colorxbridge:dominantSaturation>' + (metadata.dominant.hsl ? metadata.dominant.hsl[1] : 0) + '</colorxbridge:dominantSaturation>\n' +
'      <colorxbridge:dominantBrightness>' + (metadata.dominant.hsl ? metadata.dominant.hsl[2] : 0) + '</colorxbridge:dominantBrightness>\n' +
'      <colorxbridge:dominance>' + (metadata.dominant.dominance || 0) + '</colorxbridge:dominance>\n' +
'      <colorxbridge:palette>' + paletteStr + '</colorxbridge:palette>\n' +
'      <colorxbridge:analyzedVersion>1.0</colorxbridge:analyzedVersion>\n' +
'      <colorxbridge:analyzedTimestamp>' + new Date(metadata.metadata.analyzedAt).toISOString() + '</colorxbridge:analyzedTimestamp>\n' +
'      <colorxbridge:algorithm>' + (metadata.metadata.algorithm || 'kmeans') + '</colorxbridge:algorithm>\n' +
'    </rdf:Description>\n' +
'  </rdf:RDF>\n' +
'</x:xmpmeta>\n' +
'<?xpacket end="w"?>';
    
    xmpFile.encoding = "UTF-8";
    xmpFile.open("w");
    xmpFile.write(xmpContent);
    xmpFile.close();
    
    return { 
      success: true, 
      xmpPath: xmpPath,
      message: "XMP sidecar file created"
    };
  } catch (e) {
    return { 
      success: false, 
      error: "Failed to write XMP sidecar: " + e.message + " (Line: " + e.line + ")"
    };
  }
}

/**
 * Read ColorXBridge metadata from a file
 * @param {string} filePath - Path to the image file
 * @returns {Object} Metadata object
 */
function readXMP(filePath) {
  try {
    var file = new File(filePath);
    
    if (!file.exists) {
      return { success: false, error: "File not found" };
    }
    
    // Ensure namespace is initialized
    if (!ExternalObject.XMP) {
      initNamespace();
    }
    
    // Try embedded XMP first
    try {
      var xmpFile = new XMPFile(filePath, XMPConst.UNKNOWN, XMPConst.OPEN_FOR_READ);
      var xmp = xmpFile.getXMP();
      
      if (xmp) {
        var dominantHex = xmp.getProperty(CXB_NS, "dominantHex") || "";
        var dominantHue = parseFloat(xmp.getProperty(CXB_NS, "dominantHue")) || 0;
        var dominantSat = parseFloat(xmp.getProperty(CXB_NS, "dominantSaturation")) || 0;
        var dominantBri = parseFloat(xmp.getProperty(CXB_NS, "dominantBrightness")) || 0;
        var dominance = parseFloat(xmp.getProperty(CXB_NS, "dominance")) || 0;
        var paletteStr = xmp.getProperty(CXB_NS, "palette") || "";
        
        xmpFile.closeFile();
        
        // Parse palette
        var palette = [];
        if (paletteStr) {
          var colors = paletteStr.split(",");
          for (var i = 0; i < colors.length; i++) {
            var parts = colors[i].split("|");
            if (parts.length === 2) {
              palette.push({
                hex: parts[0],
                dominance: parseFloat(parts[1])
              });
            }
          }
        }
        
        return {
          success: true,
          dominant: {
            hex: dominantHex,
            hsl: [dominantHue, dominantSat, dominantBri],
            dominance: dominance
          },
          palette: palette
        };
      }
    } catch (xmpErr) {
      // Embedded XMP failed, try sidecar
    }
    
    // Fallback: Read sidecar file
    return readXMPSidecar(filePath);
    
  } catch (e) {
    return { success: false, error: e.message + " (Line: " + e.line + ")" };
  }
}

/**
 * Read XMP sidecar file
 * @param {string} filePath - Path to the image file
 * @returns {Object} Metadata object
 */
function readXMPSidecar(filePath) {
  try {
    var xmpPath = filePath.replace(/\.[^.]+$/, '.xmp');
    var xmpFile = new File(xmpPath);
    
    if (!xmpFile.exists) {
      return { success: false, error: "XMP sidecar not found" };
    }
    
    xmpFile.encoding = "UTF-8";
    xmpFile.open("r");
    var content = xmpFile.read();
    xmpFile.close();
    
    // Simple XML parsing for ColorXBridge properties
    function extractValue(tag) {
      var regex = new RegExp("<colorxbridge:" + tag + ">([^<]+)</colorxbridge:" + tag + ">");
      var match = content.match(regex);
      return match ? match[1] : null;
    }
    
    var dominantHex = extractValue("dominantHex") || "";
    var dominantHue = parseFloat(extractValue("dominantHue")) || 0;
    var dominantSat = parseFloat(extractValue("dominantSaturation")) || 0;
    var dominantBri = parseFloat(extractValue("dominantBrightness")) || 0;
    var dominance = parseFloat(extractValue("dominance")) || 0;
    
    return {
      success: true,
      dominant: {
        hex: dominantHex,
        hsl: [dominantHue, dominantSat, dominantBri],
        dominance: dominance
      }
    };
  } catch (e) {
    return { success: false, error: e.message + " (Line: " + e.line + ")" };
  }
}

/**
 * Check if file has ColorXBridge metadata
 * @param {string} filePath - Path to the file
 * @returns {Object} Result with hasMetadata boolean
 */
function hasColorMetadata(filePath) {
  try {
    // Check for sidecar first
    var xmpPath = filePath.replace(/\.[^.]+$/, '.xmp');
    var xmpFile = new File(xmpPath);
    
    if (xmpFile.exists) {
      xmpFile.encoding = "UTF-8";
      xmpFile.open("r");
      var content = xmpFile.read();
      xmpFile.close();
      
      if (content.indexOf("colorxbridge:dominantHex") !== -1) {
        return { success: true, hasMetadata: true, source: "sidecar" };
      }
    }
    
    // Check embedded XMP
    if (ExternalObject.XMP) {
      try {
        var bridgeFile = new XMPFile(filePath, XMPConst.UNKNOWN, XMPConst.OPEN_FOR_READ);
        var xmp = bridgeFile.getXMP();
        
        if (xmp && xmp.getProperty(CXB_NS, "dominantHex")) {
          bridgeFile.closeFile();
          return { success: true, hasMetadata: true, source: "embedded" };
        }
        
        bridgeFile.closeFile();
      } catch (e) {
        // Ignore
      }
    }
    
    return { success: true, hasMetadata: false };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============================================================================
// CACHE OPERATIONS
// ============================================================================

/**
 * Clear the analysis cache
 * This is handled by the Node.js layer, but we provide a stub for compatibility
 * @returns {Object} Result object
 */
function clearCache() {
  try {
    // Cache is managed by Node.js layer
    return { success: true, message: "Cache clear request sent to Node.js layer" };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Refresh Bridge display
 * @returns {Object} Result object
 */
function refreshDisplay() {
  try {
    if (app.document && app.document.refresh) {
      app.document.refresh();
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Get Bridge version information
 * @returns {Object} Version info
 */
function getBridgeVersion() {
  try {
    return {
      success: true,
      version: app.version,
      name: app.name,
      path: app.path.fsName || app.path
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Convert path separators for cross-platform compatibility
 * @param {string} path - File path
 * @returns {string} Normalized path
 */
function normalizePath(path) {
  if (!path) return "";
  // Convert forward slashes to backslashes for Windows compatibility
  return path.replace(/\//g, "\\");
}

// ============================================================================
// NODE.JS INTEGRATION STUBS
// ============================================================================

/**
 * Stub for color analysis - actual analysis happens in Node.js layer
 * This function is called by the CEP panel when Node.js is not available
 * @param {Object} analysisData - Files and options for analysis
 * @returns {Object} Error response (analysis should happen in Node.js)
 */
function analyzeFiles(analysisData) {
  return {
    success: false,
    error: "Color analysis requires Node.js runtime. Please ensure --enable-nodejs is set in manifest.xml"
  };
}

// ============================================================================
// EXPORTS (for CEP evalScript)
// ============================================================================

// All functions are globally available to CEP via evalScript
// No explicit exports needed in ExtendScript
