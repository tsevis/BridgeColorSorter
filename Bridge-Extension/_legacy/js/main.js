/**
 * ColorXBridge - CEP Panel Entry Point
 * Adobe Bridge Extension - Search & Sort by Color
 * 
 * @version 1.0.0
 * @description Main panel controller for ColorXBridge extension
 */

(function() {
  'use strict';

  // ============================================================================
  // COLORXBRIDGE CLASS
  // ============================================================================

  /**
   * Main panel controller
   * @constructor
   */
  function ColorXBridge() {
    this.csInterface = null;
    this.analysisResults = {};
    this.selectedFiles = [];
    this.activeFilter = null;
    this.settings = {
      algorithm: 'kmeans',
      colorCount: 5,
      tolerance: 15,
      cacheEnabled: true
    };
    this.isNodeAvailable = false;
    
    this.init();
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  /**
   * Initialize the panel
   */
  ColorXBridge.prototype.init = function() {
    var self = this;
    
    try {
      this.csInterface = new CSInterface();
      console.log('[ColorXBridge] CSInterface initialized');
    } catch (e) {
      console.error('[ColorXBridge] Failed to initialize CSInterface:', e);
      this.updateStatus('Error: CEP not available', 'error');
      return;
    }
    
    this.checkNodeAvailability();
    this.setupEventListeners();
    this.loadSettings();
    this.updateStatus('Ready - Select images in Bridge and click Analyze');
    
    console.log('[ColorXBridge] Panel initialized');
  };

  /**
   * Check if Node.js modules are available in CEP runtime
   */
  ColorXBridge.prototype.checkNodeAvailability = function() {
    var self = this;
    
    // Try to access Node.js require
    if (typeof require !== 'undefined') {
      try {
        var fs = require('fs');
        this.isNodeAvailable = true;
        console.log('[ColorXBridge] Node.js modules available');
      } catch (e) {
        this.isNodeAvailable = false;
        console.log('[ColorXBridge] Node.js modules not available, using ExtendScript');
      }
    } else {
      this.isNodeAvailable = false;
      console.log('[ColorXBridge] require() not available, using ExtendScript');
    }
  };

  // ============================================================================
  // EVENT LISTENERS
  // ============================================================================

  /**
   * Set up all event listeners
   */
  ColorXBridge.prototype.setupEventListeners = function() {
    var self = this;

    // Button listeners
    this.bindButton('analyzeBtn', function() { self.analyzeSelected(); });
    this.bindButton('analyzeAllBtn', function() { self.analyzeAll(); });
    this.bindButton('sortBtn', function() { self.sortImages(); });
    this.bindButton('clearFilterBtn', function() { self.clearFilter(); });
    this.bindButton('clearCacheBtn', function() { self.clearCache(); });

    // Tolerance slider
    var toleranceSlider = document.getElementById('toleranceSlider');
    if (toleranceSlider) {
      toleranceSlider.addEventListener('input', function(e) {
        self.settings.tolerance = parseInt(e.target.value, 10);
        var toleranceValue = document.getElementById('toleranceValue');
        if (toleranceValue) {
          toleranceValue.textContent = self.settings.tolerance + '°';
        }
      });
    }

    // Algorithm select
    var algorithmSelect = document.getElementById('algorithmSelect');
    if (algorithmSelect) {
      algorithmSelect.addEventListener('change', function(e) {
        self.settings.algorithm = e.target.value;
        self.saveSettings();
      });
    }

    // Color count input
    var colorCountInput = document.getElementById('colorCountInput');
    if (colorCountInput) {
      colorCountInput.addEventListener('change', function(e) {
        var val = parseInt(e.target.value, 10);
        self.settings.colorCount = Math.max(3, Math.min(10, val));
        self.saveSettings();
      });
    }

    // Cache checkbox
    var cacheEnabled = document.getElementById('cacheEnabled');
    if (cacheEnabled) {
      cacheEnabled.addEventListener('change', function(e) {
        self.settings.cacheEnabled = e.target.checked;
        self.saveSettings();
      });
    }
    
    // Sort select
    var sortSelect = document.getElementById('sortSelect');
    if (sortSelect) {
      sortSelect.addEventListener('change', function(e) {
        // Store selection for sort button
      });
    }
  };

  /**
   * Bind button click handler safely
   * @param {string} id - Button ID
   * @param {Function} handler - Click handler
   */
  ColorXBridge.prototype.bindButton = function(id, handler) {
    var btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener('click', handler);
    }
  };

  // ============================================================================
  // SETTINGS
  // ============================================================================

  /**
   * Load settings from localStorage
   */
  ColorXBridge.prototype.loadSettings = function() {
    try {
      if (window.localStorage) {
        var saved = window.localStorage.getItem('colorxbridge_settings');
        if (saved) {
          var parsed = JSON.parse(saved);
          this.settings = Object.assign({}, this.settings, parsed);
          
          // Update UI
          this.updateUIFromSettings();
        }
      }
    } catch (e) {
      console.warn('[ColorXBridge] Could not load settings:', e);
    }
  };

  /**
   * Save settings to localStorage
   */
  ColorXBridge.prototype.saveSettings = function() {
    try {
      if (window.localStorage) {
        window.localStorage.setItem('colorxbridge_settings', JSON.stringify(this.settings));
      }
    } catch (e) {
      console.warn('[ColorXBridge] Could not save settings:', e);
    }
  };

  /**
   * Update UI elements from current settings
   */
  ColorXBridge.prototype.updateUIFromSettings = function() {
    var algorithmSelect = document.getElementById('algorithmSelect');
    if (algorithmSelect) algorithmSelect.value = this.settings.algorithm;
    
    var colorCountInput = document.getElementById('colorCountInput');
    if (colorCountInput) colorCountInput.value = this.settings.colorCount;
    
    var cacheEnabled = document.getElementById('cacheEnabled');
    if (cacheEnabled) cacheEnabled.checked = this.settings.cacheEnabled;
    
    var toleranceSlider = document.getElementById('toleranceSlider');
    if (toleranceSlider) {
      toleranceSlider.value = this.settings.tolerance;
      var toleranceValue = document.getElementById('toleranceValue');
      if (toleranceValue) toleranceValue.textContent = this.settings.tolerance + '°';
    }
  };

  // ============================================================================
  // FILE ANALYSIS
  // ============================================================================

  /**
   * Analyze currently selected files in Bridge
   */
  ColorXBridge.prototype.analyzeSelected = function() {
    var self = this;
    this.updateStatus('Getting selected files...', 'warning');

    this.evalScript('getSelectedFiles()')
      .then(function(result) {
        if (!result || result.length === 0) {
          self.updateStatus('No files selected. Please select images in Bridge.', 'warning');
          return;
        }

        self.selectedFiles = result;
        self.runAnalysis(result);
      })
      .catch(function(error) {
        self.updateStatus('Error: ' + (error.message || 'Failed to get selected files'), 'error');
        console.error('[ColorXBridge]', error);
      });
  };

  /**
   * Analyze all files in current folder
   */
  ColorXBridge.prototype.analyzeAll = function() {
    var self = this;
    this.updateStatus('Getting folder contents...', 'warning');

    this.evalScript('getAllFiles()')
      .then(function(result) {
        if (!result || result.length === 0) {
          self.updateStatus('No files in folder', 'warning');
          return;
        }

        self.selectedFiles = result;
        self.runAnalysis(result);
      })
      .catch(function(error) {
        self.updateStatus('Error: ' + (error.message || 'Failed to get files'), 'error');
        console.error('[ColorXBridge]', error);
      });
  };

  /**
   * Run color analysis on files
   * @param {Array} files - Array of file paths
   */
  ColorXBridge.prototype.runAnalysis = function(files) {
    var self = this;
    var progressSection = document.getElementById('progressSection');
    var progressFill = document.getElementById('progressFill');
    var progressText = document.getElementById('progressText');

    if (progressSection) progressSection.style.display = 'flex';
    this.updateStatus('Analyzing ' + files.length + ' images...', 'warning');

    // Prepare analysis data
    var analysisData = {
      files: files,
      options: this.settings
    };

    // Use Node.js analyzer if available, otherwise use ExtendScript
    if (this.isNodeAvailable) {
      this.analyzeFilesInNode(files, this.settings)
        .then(function(result) {
          self.handleAnalysisResult(result, progressSection);
        })
        .catch(function(error) {
          self.handleAnalysisError(error, progressSection);
        });
    } else {
      // Fallback: Use ExtendScript with Node.js via CEP
      this.analyzeViaExtendScript(analysisData)
        .then(function(result) {
          self.handleAnalysisResult(result, progressSection);
        })
        .catch(function(error) {
          self.handleAnalysisError(error, progressSection);
        });
    }
  };

  /**
   * Analyze files using Node.js within CEP
   */
  ColorXBridge.prototype.analyzeFilesInNode = function(files, options) {
    var self = this;
    return new Promise(function(resolve, reject) {
      try {
        var ColorAnalyzer = require('./analyzer/ColorAnalyzer.js');
        var analyzer = new ColorAnalyzer(options);
        
        analyzer.batchAnalyze({ files: files, options: options })
          .then(resolve)
          .catch(reject);
      } catch (e) {
        reject(e);
      }
    });
  };

  /**
   * Analyze files via ExtendScript (fallback)
   */
  ColorXBridge.prototype.analyzeViaExtendScript = function(analysisData) {
    // This calls the Node.js layer through CEP's evalScript
    // The BridgeController.jsx will handle the Node.js invocation
    var script = 'analyzeFiles(' + JSON.stringify(analysisData) + ')';
    return this.evalScript(script);
  };

  /**
   * Handle successful analysis result
   */
  ColorXBridge.prototype.handleAnalysisResult = function(result, progressSection) {
    if (progressSection) progressSection.style.display = 'none';

    if (result && result.success) {
      this.analysisResults = result.results || {};
      this.displayResults();
      this.updateColorSwatches();
      this.writeMetadataToFiles(result.results);
      this.updateStatus('Analyzed ' + Object.keys(result.results).length + ' images', 'success');
    } else {
      this.updateStatus(result && result.error ? result.error : 'Analysis failed', 'error');
    }
  };

  /**
   * Handle analysis error
   */
  ColorXBridge.prototype.handleAnalysisError = function(error, progressSection) {
    if (progressSection) progressSection.style.display = 'none';
    this.updateStatus('Error: ' + (error.message || 'Analysis failed'), 'error');
    console.error('[ColorXBridge]', error);
  };

  /**
   * Write XMP metadata to analyzed files
   */
  ColorXBridge.prototype.writeMetadataToFiles = function(results) {
    var self = this;
    
    if (!results) return;
    
    Object.keys(results).forEach(function(filePath) {
      var result = results[filePath];
      if (result && result.dominant) {
        var escapedPath = filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        var script = 'writeXMP("' + escapedPath + '", ' + JSON.stringify(result) + ')';
        
        // Fire and forget - don't wait for completion
        self.evalScript(script).catch(function(err) {
          console.warn('[ColorXBridge] Metadata write failed for', filePath, err);
        });
      }
    });
  };

  // ============================================================================
  // UI UPDATES
  // ============================================================================

  /**
   * Display analysis results in the panel
   */
  ColorXBridge.prototype.displayResults = function() {
    var resultsList = document.getElementById('resultsList');
    if (!resultsList) return;

    var results = this.analysisResults;
    var keys = Object.keys(results);

    if (keys.length === 0) {
      resultsList.innerHTML = '<div class="results-placeholder">No results yet</div>';
      return;
    }

    var html = '';
    var self = this;
    
    keys.forEach(function(filePath) {
      var data = results[filePath];
      if (!data || !data.dominant) return;
      
      var fileName = filePath.split(/[\\/]/).pop();
      var dominant = data.dominant;
      var hslText = dominant.hsl ? 
        'H:' + Math.round(dominant.hsl[0]) + '° S:' + Math.round(dominant.hsl[1]) + '% L:' + Math.round(dominant.hsl[2]) + '%' : 
        dominant.hex;

      html += '<div class="result-item" data-file="' + self.escapeHtml(filePath) + '">' +
        '<div class="color-preview" style="background: ' + self.escapeHtml(dominant.hex) + '"></div>' +
        '<span class="file-name" title="' + self.escapeHtml(filePath) + '">' + self.escapeHtml(fileName) + '</span>' +
        '<span class="color-info">' + self.escapeHtml(hslText) + '</span>' +
      '</div>';
    });

    resultsList.innerHTML = html;
  };

  /**
   * Update color swatches from analysis results
   */
  ColorXBridge.prototype.updateColorSwatches = function() {
    var swatchesContainer = document.getElementById('colorSwatches');
    if (!swatchesContainer) return;
    
    var colors = {};
    var results = this.analysisResults;

    // Collect all colors from palettes
    Object.keys(results).forEach(function(filePath) {
      var data = results[filePath];
      if (data && data.palette) {
        data.palette.forEach(function(color) {
          var existing = colors[color.hex];
          if (!existing || existing.dominance < color.dominance) {
            colors[color.hex] = color;
          }
        });
      }
    });

    var colorList = Object.keys(colors).map(function(hex) {
      return colors[hex];
    });

    if (colorList.length === 0) {
      swatchesContainer.innerHTML = '<div class="swatch-placeholder">Analyze images to see colors</div>';
      return;
    }

    // Sort by dominance and take top 12
    colorList.sort(function(a, b) { return b.dominance - a.dominance; });
    colorList = colorList.slice(0, 12);

    // Generate swatch HTML
    var html = '';
    var self = this;
    
    colorList.forEach(function(color) {
      html += '<div class="color-swatch" ' +
        'style="background: ' + self.escapeHtml(color.hex) + '" ' +
        'data-hex="' + self.escapeHtml(color.hex) + '" ' +
        'data-hue="' + (color.hsl ? color.hsl[0] : 0) + '" ' +
        'title="' + self.escapeHtml(color.hex) + ' (' + Math.round(color.dominance * 100) + '%)">' +
        '</div>';
    });

    swatchesContainer.innerHTML = html;

    // Add click handlers
    var swatches = swatchesContainer.querySelectorAll('.color-swatch');
    for (var i = 0; i < swatches.length; i++) {
      (function(el) {
        el.addEventListener('click', function() { self.toggleFilter(el); });
      })(swatches[i]);
    }
  };

  // ============================================================================
  // FILTERING
  // ============================================================================

  /**
   * Toggle color filter on/off
   */
  ColorXBridge.prototype.toggleFilter = function(swatchEl) {
    var isActive = swatchEl.classList.contains('active');

    // Clear all active states
    var allSwatches = document.querySelectorAll('.color-swatch');
    for (var i = 0; i < allSwatches.length; i++) {
      allSwatches[i].classList.remove('active');
    }

    if (!isActive) {
      swatchEl.classList.add('active');
      this.activeFilter = {
        hex: swatchEl.dataset.hex,
        hue: parseFloat(swatchEl.dataset.hue),
        tolerance: this.settings.tolerance
      };
      this.applyFilter();
    } else {
      this.activeFilter = null;
      this.updateStatus('Filter cleared');
    }
  };

  /**
   * Apply color filter to results
   */
  ColorXBridge.prototype.applyFilter = function() {
    if (!this.activeFilter) return;

    var hue = this.activeFilter.hue;
    var tolerance = this.activeFilter.tolerance;
    var matchCount = 0;
    var results = this.analysisResults;

    Object.keys(results).forEach(function(filePath) {
      var data = results[filePath];
      if (!data || !data.dominant || !data.dominant.hsl) return;

      var imageHue = data.dominant.hsl[0];
      var hueDiff = Math.abs(imageHue - hue);
      if (hueDiff > 180) hueDiff = 360 - hueDiff;

      var item = document.querySelector('.result-item[data-file="' + CSS.escape(filePath) + '"]');
      if (item) {
        if (hueDiff <= tolerance) {
          item.style.display = 'flex';
          matchCount++;
        } else {
          item.style.display = 'none';
        }
      }
    });

    this.updateStatus('Found ' + matchCount + ' matching images', 'success');
  };

  /**
   * Clear active color filter
   */
  ColorXBridge.prototype.clearFilter = function() {
    this.activeFilter = null;
    
    var allSwatches = document.querySelectorAll('.color-swatch');
    for (var i = 0; i < allSwatches.length; i++) {
      allSwatches[i].classList.remove('active');
    }
    
    var allItems = document.querySelectorAll('.result-item');
    for (var j = 0; j < allItems.length; j++) {
      allItems[j].style.display = 'flex';
    }
    
    this.updateStatus('Filter cleared');
  };

  // ============================================================================
  // SORTING
  // ============================================================================

  /**
   * Sort images by selected criteria
   */
  ColorXBridge.prototype.sortImages = function() {
    var sortSelect = document.getElementById('sortSelect');
    if (!sortSelect) return;
    
    var sortBy = sortSelect.value;
    this.updateStatus('Sorting by ' + sortBy + '...', 'warning');

    var sortData = {
      files: Object.keys(this.analysisResults),
      sortBy: sortBy,
      results: this.analysisResults
    };

    var self = this;
    this.evalScript('sortItems(' + JSON.stringify(sortData) + ')')
      .then(function(result) {
        if (result && result.success) {
          var sortedFiles = result.sortedFiles || sortData.files;
          self.displaySortedResults(sortedFiles);
          self.updateStatus('Sorted by ' + sortBy, 'success');
        } else {
          self.updateStatus(result && result.error ? result.error : 'Sort failed', 'error');
        }
      })
      .catch(function(error) {
        self.updateStatus('Error: ' + (error.message || error), 'error');
      });
  };

  /**
   * Display results in sorted order
   */
  ColorXBridge.prototype.displaySortedResults = function(sortedFiles) {
    var resultsList = document.getElementById('resultsList');
    if (!resultsList) return;

    var html = '';
    var self = this;
    var results = this.analysisResults;
    
    sortedFiles.forEach(function(filePath) {
      var data = results[filePath];
      if (!data || !data.dominant) return;
      
      var fileName = filePath.split(/[\\/]/).pop();
      var dominant = data.dominant;
      var hslText = dominant.hsl ? 
        'H:' + Math.round(dominant.hsl[0]) + '° S:' + Math.round(dominant.hsl[1]) + '% L:' + Math.round(dominant.hsl[2]) + '%' : 
        dominant.hex;

      html += '<div class="result-item" data-file="' + self.escapeHtml(filePath) + '">' +
        '<div class="color-preview" style="background: ' + self.escapeHtml(dominant.hex) + '"></div>' +
        '<span class="file-name" title="' + self.escapeHtml(filePath) + '">' + self.escapeHtml(fileName) + '</span>' +
        '<span class="color-info">' + self.escapeHtml(hslText) + '</span>' +
      '</div>';
    });

    resultsList.innerHTML = html;
  };

  // ============================================================================
  // CACHE
  // ============================================================================

  /**
   * Clear the analysis cache
   */
  ColorXBridge.prototype.clearCache = function() {
    var self = this;
    this.updateStatus('Clearing cache...', 'warning');

    // Clear Node.js cache if available
    if (this.isNodeAvailable) {
      try {
        var ColorAnalyzer = require('./analyzer/ColorAnalyzer.js');
        var analyzer = new ColorAnalyzer();
        var result = analyzer.clearCache();
        if (result.success) {
          self.updateStatus('Cache cleared', 'success');
          return;
        }
      } catch (e) {
        console.warn('[ColorXBridge] Node.js cache clear failed:', e);
      }
    }

    // Fallback: Clear via ExtendScript
    this.evalScript('clearCache()')
      .then(function(result) {
        if (result && result.success) {
          self.updateStatus('Cache cleared', 'success');
        } else {
          self.updateStatus('Failed to clear cache', 'error');
        }
      })
      .catch(function(error) {
        self.updateStatus('Error: ' + (error.message || error), 'error');
      });
  };

  // ============================================================================
  // EXTENDSCRIPT COMMUNICATION
  // ============================================================================

  /**
   * Evaluate ExtendScript code
   * @param {string} script - Script to evaluate
   * @returns {Promise} Result
   */
  ColorXBridge.prototype.evalScript = function(script) {
    var self = this;
    return new Promise(function(resolve, reject) {
      if (!self.csInterface) {
        reject(new Error('CSInterface not initialized'));
        return;
      }
      
      self.csInterface.evalScript(script, function(result) {
        if (result === null || result === undefined || result === '') {
          reject(new Error('ExtendScript returned empty result'));
          return;
        }
        
        try {
          // Try to parse as JSON
          if (result.charAt(0) === '{' || result.charAt(0) === '[') {
            resolve(JSON.parse(result));
          } else {
            resolve(result);
          }
        } catch (e) {
          // Not JSON, return as string
          resolve(result);
        }
      });
    });
  };

  // ============================================================================
  // UTILITIES
  // ============================================================================

  /**
   * Update status text
   */
  ColorXBridge.prototype.updateStatus = function(message, type) {
    var statusEl = document.getElementById('statusText');
    if (!statusEl) return;
    
    statusEl.textContent = message;
    statusEl.className = type || '';
  };

  /**
   * Escape HTML special characters
   */
  ColorXBridge.prototype.escapeHtml = function(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      window.colorXBridge = new ColorXBridge();
    });
  } else {
    window.colorXBridge = new ColorXBridge();
  }

})();
