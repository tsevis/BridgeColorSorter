/**
 * XMPWriter.js
 * Write ColorXBridge metadata to XMP files
 */

const fs = require('fs');
const path = require('path');

class XMPWriter {
  constructor() {
    this.namespace = 'http://ns.adobe.com/colorxbridge/1.0/';
    this.prefix = 'colorxbridge';
  }

  async write(filePath, analysisResult) {
    try {
      const xmpContent = this._generateXMP(analysisResult);
      
      const xmpSidecarPath = filePath.replace(/\.[^.]+$/, '.xmp');
      fs.writeFileSync(xmpSidecarPath, xmpContent, 'utf8');

      return { success: true, xmpPath: xmpSidecarPath };
    } catch (error) {
      console.error('[ColorXBridge] XMP write error:', error);
      return { success: false, error: error.message };
    }
  }

  _generateXMP(analysisResult) {
    const { dominant, palette, metadata } = analysisResult;
    
    let paletteStr = '';
    if (palette && palette.length > 0) {
      paletteStr = `
          <colorxbridge:palette>
            <rdf:Seq>
              ${palette.map(c => `<rdf:li>${c.hex}|${c.dominance.toFixed(2)}</rdf:li>`).join('\n              ')}
            </rdf:Seq>
          </colorxbridge:palette>`;
    }

    return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="ColorXBridge 1.0">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:colorxbridge="${this.namespace}">
      <colorxbridge:dominantHex>${dominant.hex}</colorxbridge:dominantHex>
      <colorxbridge:dominantHue>${dominant.hsl ? dominant.hsl[0] : 0}</colorxbridge:dominantHue>
      <colorxbridge:dominantSaturation>${dominant.hsl ? dominant.hsl[1] : 0}</colorxbridge:dominantSaturation>
      <colorxbridge:dominantBrightness>${dominant.hsl ? dominant.hsl[2] : 0}</colorxbridge:dominantBrightness>
      <colorxbridge:dominance>${dominant.dominance.toFixed(2)}</colorxbridge:dominance>${paletteStr}
      <colorxbridge:analyzedVersion>1.0</colorxbridge:analyzedVersion>
      <colorxbridge:analyzedTimestamp>${new Date(metadata.analyzedAt).toISOString()}</colorxbridge:analyzedTimestamp>
      <colorxbridge:algorithm>${metadata.algorithm || 'kmeans'}</colorxbridge:algorithm>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  }

  async writeBackup(filePath, analysisResult) {
    try {
      const backupPath = filePath + '.xmp.bak';
      const result = await this.write(filePath, analysisResult);
      
      if (result.success) {
        const currentXmp = filePath.replace(/\.[^.]+$/, '.xmp');
        if (fs.existsSync(currentXmp)) {
          fs.copyFileSync(currentXmp, backupPath);
        }
      }

      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = XMPWriter;
