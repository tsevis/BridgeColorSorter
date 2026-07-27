/**
 * ColorAnalyzer.js
 * Main analyzer interface for extracting colors from images
 * 
 * Designed for CEP (Common Extensibility Platform) Node.js runtime
 * Supports both native modules (when available) and pure JS fallbacks
 * 
 * @version 1.0.0
 * @module ColorAnalyzer
 */

// ============================================================================
// DEPENDENCY LOADING WITH FALLBACKS
// ============================================================================

var sharp = null;
var ColorThief = null;
var crypto = null;
var fs = null;
var path = null;
var CacheManager = null;

// Try to load native modules (may not be available in all CEP environments)
try {
  sharp = require('sharp');
} catch (e) {
  console.log('[ColorXBridge] sharp not available, using fallback');
}

try {
  ColorThief = require('color-thief');
} catch (e) {
  console.log('[ColorXBridge] color-thief not available, using built-in algorithms');
}

try {
  crypto = require('crypto');
} catch (e) {
  console.log('[ColorXBridge] crypto not available');
}

try {
  fs = require('fs');
} catch (e) {
  console.log('[ColorXBridge] fs not available');
}

try {
  path = require('path');
} catch (e) {
  console.log('[ColorXBridge] path not available');
}

try {
  CacheManager = require('../cache/CacheManager');
} catch (e) {
  console.log('[ColorXBridge] CacheManager not available');
}

// ============================================================================
// COLOR ANALYZER CLASS
// ============================================================================

/**
 * ColorAnalyzer - Extract dominant colors and palettes from images
 * 
 * @class
 * @param {Object} options - Configuration options
 * @param {string} [options.algorithm='kmeans'] - 'kmeans' or 'median-cut'
 * @param {number} [options.colorCount=5] - Number of colors to extract (3-10)
 * @param {number} [options.quality=10] - Analysis quality (1-100)
 * @param {boolean} [options.useCache=true] - Enable caching
 */
function ColorAnalyzer(options) {
  options = options || {};
  
  this.options = {
    algorithm: options.algorithm || 'kmeans',
    colorCount: Math.max(3, Math.min(10, options.colorCount || 5)),
    quality: Math.max(1, Math.min(100, options.quality || 10)),
    useCache: options.useCache !== undefined ? options.useCache : true
  };
  
  this.cache = null;
  
  // Initialize cache if available
  if (this.options.useCache && CacheManager) {
    try {
      this.cache = new CacheManager();
    } catch (e) {
      console.log('[ColorXBridge] Cache initialization failed:', e.message);
    }
  }
}

// ============================================================================
// PUBLIC METHODS
// ============================================================================

/**
 * Analyze a single image file
 * 
 * @async
 * @param {string} filePath - Absolute path to image file
 * @param {Object} [options] - Override default options
 * @returns {Promise<Object>} Color analysis result
 */
ColorAnalyzer.prototype.analyze = function(filePath, options) {
  var self = this;
  var opts = Object.assign({}, this.options, options || {});
  
  return new Promise(function(resolve, reject) {
    // Check cache first
    if (self.cache) {
      self.cache.get(filePath).then(function(cached) {
        if (cached) {
          console.log('[ColorXBridge] Cache hit for:', path.basename(filePath));
          resolve(cached);
          return;
        }
        // Cache miss, proceed with analysis
        performAnalysis();
      }).catch(function() {
        performAnalysis();
      });
    } else {
      performAnalysis();
    }
    
    function performAnalysis() {
      self._computeFileHash(filePath)
        .then(function(fileHash) {
          return self._extractColors(filePath, opts, fileHash);
        })
        .then(function(result) {
          // Add metadata
          result.metadata = {
            filePath: filePath,
            fileHash: result.fileHash,
            analyzedAt: Date.now(),
            algorithm: opts.algorithm
          };
          
          // Cache result
          if (self.cache && result.fileHash) {
            self.cache.set(result.fileHash, filePath, result);
          }
          
          resolve(result);
        })
        .catch(function(error) {
          console.error('[ColorXBridge] Analysis failed:', error.message);
          reject(error);
        });
    }
  });
};

/**
 * Batch analyze multiple files with progress tracking
 * 
 * @async
 * @param {Object} analysisData - Analysis parameters
 * @param {Array} analysisData.files - Array of file paths
 * @param {Object} [analysisData.options] - Analysis options
 * @returns {Promise<Object>} Results object with success status and results map
 */
ColorAnalyzer.prototype.batchAnalyze = function(analysisData) {
  var self = this;
  var files = analysisData.files || [];
  var options = analysisData.options || {};
  var results = {};
  var batchSize = 10;
  
  console.log('[ColorXBridge] Batch analyzing', files.length, 'files');
  
  return new Promise(function(resolve, reject) {
    processBatch(0);
    
    function processBatch(startIndex) {
      if (startIndex >= files.length) {
        resolve({ success: true, results: results });
        return;
      }
      
      var batch = files.slice(startIndex, startIndex + batchSize);
      var batchPromises = batch.map(function(filePath) {
        return self.analyze(filePath, options)
          .then(function(result) {
            return { filePath: filePath, result: result };
          })
          .catch(function(error) {
            console.error('[ColorXBridge] Error analyzing', filePath + ':', error.message);
            return { filePath: filePath, result: null, error: error.message };
          });
      });
      
      Promise.all(batchPromises).then(function(batchResults) {
        batchResults.forEach(function(item) {
          if (item.result) {
            results[item.filePath] = item.result;
          }
        });
        
        var processed = Math.min(startIndex + batchSize, files.length);
        console.log('[ColorXBridge] Progress:', processed + '/' + files.length);
        
        // Process next batch
        processBatch(startIndex + batchSize);
      });
    }
  });
};

/**
 * Clear the analysis cache
 * 
 * @returns {Object} Result object
 */
ColorAnalyzer.prototype.clearCache = function() {
  if (this.cache) {
    return this.cache.clear();
  }
  return { success: true, message: 'No cache to clear' };
};

// ============================================================================
// PRIVATE METHODS
// ============================================================================

/**
 * Compute SHA-256 hash of file for cache key
 * 
 * @private
 * @param {string} filePath - Path to file
 * @returns {Promise<string>} File hash
 */
ColorAnalyzer.prototype._computeFileHash = function(filePath) {
  var self = this;
  
  return new Promise(function(resolve, reject) {
    if (!crypto || !fs) {
      // Fallback: use path and mtime as hash
      try {
        var stat = fs.statSync(filePath);
        resolve(filePath + '-' + stat.mtimeMs);
      } catch (e) {
        resolve(filePath);
      }
      return;
    }
    
    try {
      var hash = crypto.createHash('sha256');
      var stream = fs.createReadStream(filePath);
      
      stream.on('data', function(data) {
        hash.update(data);
      });
      
      stream.on('end', function() {
        try {
          var stat = fs.statSync(filePath);
          var combinedHash = hash.digest('hex') + '-' + stat.mtimeMs;
          resolve(combinedHash);
        } catch (e) {
          resolve(hash.digest('hex'));
        }
      });
      
      stream.on('error', function(err) {
        reject(err);
      });
    } catch (e) {
      reject(e);
    }
  });
};

/**
 * Extract colors from image file
 * 
 * @private
 * @param {string} filePath - Path to image file
 * @param {Object} opts - Analysis options
 * @param {string} fileHash - File hash for metadata
 * @returns {Promise<Object>} Color analysis result
 */
ColorAnalyzer.prototype._extractColors = function(filePath, opts, fileHash) {
  var self = this;
  
  return new Promise(function(resolve, reject) {
    // Try sharp + custom analysis first
    if (sharp) {
      self._extractPixelsSharp(filePath, opts.quality)
        .then(function(pixels) {
          return self._analyzePixels(pixels, opts);
        })
        .then(function(result) {
          result.fileHash = fileHash;
          resolve(result);
        })
        .catch(function(error) {
          // Fallback to simpler method
          self._extractColorsFallback(filePath, opts, fileHash)
            .then(resolve)
            .catch(reject);
        });
    } else {
      // Use fallback method
      self._extractColorsFallback(filePath, opts, fileHash)
        .then(resolve)
        .catch(reject);
    }
  });
};

/**
 * Fallback color extraction using pure JavaScript
 * 
 * @private
 * @param {string} filePath - Path to image file
 * @param {Object} opts - Analysis options
 * @param {string} fileHash - File hash
 * @returns {Promise<Object>} Color analysis result
 */
ColorAnalyzer.prototype._extractColorsFallback = function(filePath, opts, fileHash) {
  var self = this;
  
  return new Promise(function(resolve, reject) {
    // For CEP environments without sharp, we need to use a different approach
    // This is a simplified implementation that samples colors from the file
    
    try {
      // Read file as buffer
      var buffer = fs.readFileSync(filePath);
      
      // Try to extract colors from JPEG/PNG using simple sampling
      var pixels = self._samplePixelsFromBuffer(buffer, opts.quality);
      
      if (pixels && pixels.length > 0) {
        var result = self._analyzePixels(pixels, opts);
        result.fileHash = fileHash;
        resolve(result);
      } else {
        // Generate placeholder result for unsupported formats
        resolve({
          dominant: {
            hex: '#808080',
            rgb: [128, 128, 128],
            hsl: [0, 0, 50],
            dominance: 1.0
          },
          palette: [{
            hex: '#808080',
            rgb: [128, 128, 128],
            hsl: [0, 0, 50],
            dominance: 1.0
          }],
          fileHash: fileHash,
          warning: 'Could not extract pixels, using placeholder'
        });
      }
    } catch (e) {
      reject(new Error('Failed to read image: ' + e.message));
    }
  });
};

/**
 * Extract pixels using sharp (high quality)
 * 
 * @private
 * @param {string} filePath - Path to image
 * @param {number} quality - Quality setting (1-100)
 * @returns {Promise<Array>} Pixel array
 */
ColorAnalyzer.prototype._extractPixelsSharp = function(filePath, quality) {
  var self = this;
  
  return new Promise(function(resolve, reject) {
    try {
      // Calculate resize dimensions based on quality
      var maxDim = Math.max(100, Math.round(200 - (quality / 100) * 100));
      
      sharp(filePath)
        .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
        .raw()
        .toBuffer({ resolveWithObject: true })
        .then(function(result) {
          var pixels = [];
          var channels = result.info.channels || 3;
          
          for (var i = 0; i < result.data.length; i += channels) {
            pixels.push([
              result.data[i],
              result.data[i + 1],
              result.data[i + 2]
            ]);
          }
          
          resolve(pixels);
        })
        .catch(reject);
    } catch (e) {
      reject(e);
    }
  });
};

/**
 * Sample pixels from file buffer (fallback method)
 * 
 * @private
 * @param {Buffer} buffer - File buffer
 * @param {number} quality - Quality setting
 * @returns {Array} Sampled pixels
 */
ColorAnalyzer.prototype._samplePixelsFromBuffer = function(buffer, quality) {
  var pixels = [];
  var sampleSize = Math.max(100, Math.min(1000, quality * 10));
  
  // Simple JPEG detection and pixel sampling
  // This is a simplified approach - real implementation would use proper image decoding
  
  // Look for JPEG SOF markers and extract basic color info
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    // JPEG file - sample from the file data
    var step = Math.floor(buffer.length / sampleSize);
    
    for (var i = 0; i < buffer.length && pixels.length < sampleSize; i += step) {
      // Skip non-pixel data (markers, headers)
      if (buffer[i] === 0xFF) continue;
      
      // Sample RGB values (simplified - not accurate for compressed data)
      if (i + 2 < buffer.length) {
        pixels.push([buffer[i], buffer[i + 1], buffer[i + 2]]);
      }
    }
  }
  
  // PNG detection
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    // PNG file - would need proper decompression for accurate sampling
    // This is a placeholder
  }
  
  return pixels;
};

/**
 * Analyze pixels using specified algorithm
 * 
 * @private
 * @param {Array} pixels - Array of [R,G,B] values
 * @param {Object} opts - Options with algorithm and colorCount
 * @returns {Object} Analysis result with dominant color and palette
 */
ColorAnalyzer.prototype._analyzePixels = function(pixels, opts) {
  if (opts.algorithm === 'median-cut') {
    return this._runMedianCut(pixels, opts.colorCount);
  } else {
    return this._runKMeans(pixels, opts.colorCount);
  }
};

/**
 * K-Means clustering for color extraction
 * 
 * @private
 * @param {Array} pixels - Array of [R,G,B] values
 * @param {number} k - Number of clusters (colors)
 * @returns {Object} Analysis result
 */
ColorAnalyzer.prototype._runKMeans = function(pixels, k) {
  var self = this;
  
  // Initialize centroids using k-means++ style
  var centroids = this._initializeCentroids(pixels, k);
  var iterations = 0;
  var maxIterations = 20;
  
  // K-means iteration
  while (iterations < maxIterations) {
    // Assign pixels to nearest centroid
    var clusters = Array.from({ length: k }, function() { return []; });
    
    for (var i = 0; i < pixels.length; i++) {
      var pixel = pixels[i];
      var minDist = Infinity;
      var closestIdx = 0;
      
      for (var j = 0; j < centroids.length; j++) {
        var dist = self._colorDistance(pixel, centroids[j]);
        if (dist < minDist) {
          minDist = dist;
          closestIdx = j;
        }
      }
      
      clusters[closestIdx].push(pixel);
    }
    
    // Update centroids
    var newCentroids = clusters.map(function(cluster, idx) {
      if (cluster.length === 0) {
        return centroids[idx];
      }
      
      var sum = [0, 0, 0];
      for (var i = 0; i < cluster.length; i++) {
        sum[0] += cluster[i][0];
        sum[1] += cluster[i][1];
        sum[2] += cluster[i][2];
      }
      
      return [
        Math.round(sum[0] / cluster.length),
        Math.round(sum[1] / cluster.length),
        Math.round(sum[2] / cluster.length)
      ];
    });
    
    // Check convergence
    var converged = true;
    for (var i = 0; i < centroids.length; i++) {
      if (self._colorDistance(centroids[i], newCentroids[i]) > 1) {
        converged = false;
        break;
      }
    }
    
    centroids = newCentroids;
    
    if (converged) break;
    iterations++;
  }
  
  // Build final clusters for dominance calculation
  var finalClusters = Array.from({ length: k }, function() { return []; });
  for (var i = 0; i < pixels.length; i++) {
    var pixel = pixels[i];
    var minDist = Infinity;
    var closestIdx = 0;
    
    for (var j = 0; j < centroids.length; j++) {
      var dist = self._colorDistance(pixel, centroids[j]);
      if (dist < minDist) {
        minDist = dist;
        closestIdx = j;
      }
    }
    
    finalClusters[closestIdx].push(pixel);
  }
  
  // Build palette
  var palette = centroids.map(function(rgb, idx) {
    var hsl = self._rgbToHsl(rgb[0], rgb[1], rgb[2]);
    var dominance = finalClusters[idx].length / pixels.length;
    
    return {
      hex: self._rgbToHex(rgb[0], rgb[1], rgb[2]),
      rgb: rgb,
      hsl: hsl,
      dominance: dominance
    };
  });
  
  // Sort by dominance
  palette.sort(function(a, b) { return b.dominance - a.dominance; });
  
  return {
    dominant: palette[0],
    palette: palette
  };
};

/**
 * Median cut algorithm for color extraction
 * 
 * @private
 * @param {Array} pixels - Array of [R,G,B] values
 * @param {number} colorCount - Number of colors to extract
 * @returns {Object} Analysis result
 */
ColorAnalyzer.prototype._runMedianCut = function(pixels, colorCount) {
  var self = this;
  var buckets = [pixels.slice()];
  
  while (buckets.length < colorCount) {
    // Find bucket with largest range
    var maxRangeIdx = 0;
    var maxRange = 0;
    
    for (var i = 0; i < buckets.length; i++) {
      var range = this._getColorRange(buckets[i]);
      if (range.max > maxRange) {
        maxRange = range.max;
        maxRangeIdx = i;
      }
    }
    
    // Split the bucket
    var bucket = buckets.splice(maxRangeIdx, 1)[0];
    var range = this._getColorRange(bucket);
    
    // Sort by the channel with max range
    bucket.sort(function(a, b) { return a[range.channel] - b[range.channel]; });
    
    var mid = Math.floor(bucket.length / 2);
    buckets.push(bucket.slice(0, mid));
    buckets.push(bucket.slice(mid));
  }
  
  // Calculate average color for each bucket
  var palette = buckets.map(function(bucket) {
    var rgb = self._averageColor(bucket);
    var hsl = self._rgbToHsl(rgb[0], rgb[1], rgb[2]);
    var dominance = bucket.length / pixels.length;
    
    return {
      hex: self._rgbToHex(rgb[0], rgb[1], rgb[2]),
      rgb: rgb,
      hsl: hsl,
      dominance: dominance
    };
  });
  
  palette.sort(function(a, b) { return b.dominance - a.dominance; });
  
  return {
    dominant: palette[0],
    palette: palette
  };
};

// ============================================================================
// UTILITY METHODS
// ============================================================================

/**
 * Initialize centroids for K-means
 * 
 * @private
 * @param {Array} pixels - Pixel array
 * @param {number} k - Number of centroids
 * @returns {Array} Initial centroids
 */
ColorAnalyzer.prototype._initializeCentroids = function(pixels, k) {
  var centroids = [];
  var step = Math.floor(pixels.length / k);
  
  for (var i = 0; i < k; i++) {
    centroids.push([
      pixels[i * step][0],
      pixels[i * step][1],
      pixels[i * step][2]
    ]);
  }
  
  return centroids;
};

/**
 * Calculate Euclidean distance between two colors
 * 
 * @private
 * @param {Array} c1 - First color [R,G,B]
 * @param {Array} c2 - Second color [R,G,B]
 * @returns {number} Distance
 */
ColorAnalyzer.prototype._colorDistance = function(c1, c2) {
  return Math.sqrt(
    Math.pow(c1[0] - c2[0], 2) +
    Math.pow(c1[1] - c2[1], 2) +
    Math.pow(c1[2] - c2[2], 2)
  );
};

/**
 * Convert RGB to HSL
 * 
 * @private
 * @param {number} r - Red (0-255)
 * @param {number} g - Green (0-255)
 * @param {number} b - Blue (0-255)
 * @returns {Array} HSL values [H(0-360), S(0-100), L(0-100)]
 */
ColorAnalyzer.prototype._rgbToHsl = function(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  
  var max = Math.max(r, g, b);
  var min = Math.min(r, g, b);
  var h, s, l = (max + min) / 2;
  
  if (max === min) {
    h = s = 0;
  } else {
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
    
    h *= 360;
    s *= 100;
    l *= 100;
  }
  
  return [Math.round(h), Math.round(s), Math.round(l)];
};

/**
 * Convert RGB to Hex
 * 
 * @private
 * @param {number} r - Red (0-255)
 * @param {number} g - Green (0-255)
 * @param {number} b - Blue (0-255)
 * @returns {string} Hex color string
 */
ColorAnalyzer.prototype._rgbToHex = function(r, g, b) {
  return '#' + [r, g, b].map(function(x) {
    var hex = x.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
};

/**
 * Get color range in a bucket (for median cut)
 * 
 * @private
 * @param {Array} pixels - Pixel array
 * @returns {Object} Range info with channel and max values
 */
ColorAnalyzer.prototype._getColorRange = function(pixels) {
  if (pixels.length === 0) {
    return { channel: 0, max: 0 };
  }
  
  var rMin = 255, rMax = 0;
  var gMin = 255, gMax = 0;
  var bMin = 255, bMax = 0;
  
  for (var i = 0; i < pixels.length; i++) {
    var p = pixels[i];
    rMin = Math.min(rMin, p[0]);
    rMax = Math.max(rMax, p[0]);
    gMin = Math.min(gMin, p[1]);
    gMax = Math.max(gMax, p[1]);
    bMin = Math.min(bMin, p[2]);
    bMax = Math.max(bMax, p[2]);
  }
  
  var rRange = rMax - rMin;
  var gRange = gMax - gMin;
  var bRange = bMax - bMin;
  
  if (rRange >= gRange && rRange >= bRange) {
    return { channel: 0, max: rRange };
  } else if (gRange >= bRange) {
    return { channel: 1, max: gRange };
  } else {
    return { channel: 2, max: bRange };
  }
};

/**
 * Calculate average color of pixels
 * 
 * @private
 * @param {Array} pixels - Pixel array
 * @returns {Array} Average RGB values
 */
ColorAnalyzer.prototype._averageColor = function(pixels) {
  if (pixels.length === 0) {
    return [128, 128, 128];
  }
  
  var r = 0, g = 0, b = 0;
  
  for (var i = 0; i < pixels.length; i++) {
    r += pixels[i][0];
    g += pixels[i][1];
    b += pixels[i][2];
  }
  
  return [
    Math.round(r / pixels.length),
    Math.round(g / pixels.length),
    Math.round(b / pixels.length)
  ];
};

// ============================================================================
// EXPORT
// ============================================================================

module.exports = ColorAnalyzer;
