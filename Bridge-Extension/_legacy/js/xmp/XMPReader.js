/**
 * XMPReader.js
 * Read ColorXBridge metadata from XMP files
 */

const fs = require('fs');
const path = require('path');

class XMPReader {
  constructor() {
    this.namespace = 'http://ns.adobe.com/colorxbridge/1.0/';
  }

  async read(filePath) {
    try {
      const xmpPath = filePath.replace(/\.[^.]+$/, '.xmp');
      
      if (!fs.existsSync(xmpPath)) {
        return { success: false, error: 'XMP file not found' };
      }

      const xmpContent = fs.readFileSync(xmpPath, 'utf8');
      return this._parseXMP(xmpContent);
    } catch (error) {
      console.error('[ColorXBridge] XMP read error:', error);
      return { success: false, error: error.message };
    }
  }

  _parseXMP(xmpContent) {
    try {
      const getValue = (pattern) => {
        const match = xmpContent.match(pattern);
        return match ? match[1] : null;
      };

      const dominantHex = getValue(/<colorxbridge:dominantHex>([^<]+)<\/colorxbridge:dominantHex>/);
      const dominantHue = parseFloat(getValue(/<colorxbridge:dominantHue>([^<]+)<\/colorxbridge:dominantHue>/)) || 0;
      const dominantSat = parseFloat(getValue(/<colorxbridge:dominantSaturation>([^<]+)<\/colorxbridge:dominantSaturation>/)) || 0;
      const dominantBri = parseFloat(getValue(/<colorxbridge:dominantBrightness>([^<]+)<\/colorxbridge:dominantBrightness>/)) || 0;
      const dominance = parseFloat(getValue(/<colorxbridge:dominance>([^<]+)<\/colorxbridge:dominance>/)) || 0;

      const paletteStr = getValue(/<colorxbridge:palette>([\s\S]*?)<\/colorxbridge:palette>/);
      let palette = [];
      
      if (paletteStr) {
        const liMatches = paletteStr.match(/<rdf:li>([^<]+)<\/rdf:li>/g);
        if (liMatches) {
          palette = liMatches.map(li => {
            const [hex, dom] = li.replace(/<[^>]+>/g, '').split('|');
            return {
              hex: hex,
              dominance: parseFloat(dom) || 0
            };
          });
        }
      }

      const dominantRgb = this._hexToRgb(dominantHex);

      return {
        success: true,
        dominant: {
          hex: dominantHex,
          rgb: dominantRgb,
          hsl: [dominantHue, dominantSat, dominantBri],
          dominance: dominance
        },
        palette: palette,
        analyzedVersion: getValue(/<colorxbridge:analyzedVersion>([^<]+)<\/colorxbridge:analyzedVersion>/),
        analyzedTimestamp: getValue(/<colorxbridge:analyzedTimestamp>([^<]+)<\/colorxbridge:analyzedTimestamp>/),
        algorithm: getValue(/<colorxbridge:algorithm>([^<]+)<\/colorxbridge:algorithm>/)
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  _hexToRgb(hex) {
    if (!hex || !hex.startsWith('#')) return [0, 0, 0];
    
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? [
      parseInt(result[1], 16),
      parseInt(result[2], 16),
      parseInt(result[3], 16)
    ] : [0, 0, 0];
  }

  async readFromSidecar(filePath) {
    return this.read(filePath);
  }

  async hasMetadata(filePath) {
    try {
      const xmpPath = filePath.replace(/\.[^.]+$/, '.xmp');
      if (!fs.existsSync(xmpPath)) return false;

      const content = fs.readFileSync(xmpPath, 'utf8');
      return content.includes('colorxbridge:dominantHex');
    } catch (e) {
      return false;
    }
  }
}

module.exports = XMPReader;
