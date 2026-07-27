const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 450,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    vibrancy: 'sidebar',
    titleBarStyle: 'hiddenInset'
  });

  mainWindow.loadFile('src/index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// File selection
ipcMain.on('select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'tiff', 'gif', 'webp'] }]
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    mainWindow.webContents.send('files-selected', result.filePaths);
  }
});

ipcMain.on('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    const folder = result.filePaths[0];
    const files = fs.readdirSync(folder)
      .filter(f => /\.(jpg|jpeg|png|tiff|gif|webp)$/i.test(f))
      .map(f => path.join(folder, f));
    
    if (files.length > 0) {
      mainWindow.webContents.send('files-selected', files);
    }
  }
});

// Colour analysis.
//
// Clustering is shared with the Bridge extension so both surfaces agree on
// what an image's dominant colour is.
// Vendored from Bridge-Extension by scripts/sync-engine.js so the packaged
// .app is self-contained; run `npm run sync-engine` after changing the source.
const ColorEngine = require('./vendor/ColorEngine.js');

/**
 * Decode an image to opaque [r,g,b] pixels.
 * ensureAlpha() guarantees 4 channels, so the stride is known regardless of
 * whether the source had an alpha channel.
 */
async function readPixels(file, maxDim = 160) {
  const { data, info } = await sharp(file)
    .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = [];
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 125) continue;
    pixels.push([data[i], data[i + 1], data[i + 2]]);
  }
  return { pixels, width: info.width, height: info.height };
}

function sidecarPathFor(file) {
  return file.replace(/\.[^.\/\\]+$/, '') + '.xmp';
}

function writeSidecar(file, record) {
  const d = record.dominant;
  const hsl = d.hsl;
  const palette = record.palette
    .slice(0, 12)
    .map((c) => `${c.hex}|${Math.round(c.dominance * 1000) / 1000}`)
    .join(',');

  const xml = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="ColorXBridge 2.0">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:colorxbridge="http://ns.adobe.com/colorxbridge/1.0/"
   colorxbridge:dominantHex="${d.hex}"
   colorxbridge:dominantHue="${hsl[0]}"
   colorxbridge:dominantSaturation="${hsl[1]}"
   colorxbridge:dominantLightness="${hsl[2]}"
   colorxbridge:dominance="${Math.round(d.dominance * 1000) / 1000}"
   colorxbridge:palette="${palette}"
   colorxbridge:version="2.0"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

  fs.writeFileSync(sidecarPathFor(file), xml, 'utf8');
}

ipcMain.on('analyze', async (event, files, options) => {
  const settings = Object.assign({ colorCount: 5, writeXmp: true }, options || {});
  const results = {};
  const errors = [];

  for (const file of files) {
    try {
      const { pixels, width, height } = await readPixels(file);
      if (pixels.length === 0) throw new Error('no opaque pixels');

      const record = ColorEngine.extractPalette(pixels, settings.colorCount);
      record.metadata = { filePath: file, width, height, analyzedAt: new Date().toISOString() };

      if (settings.writeXmp) {
        try {
          writeSidecar(file, record);
        } catch (e) {
          errors.push({ file, error: 'sidecar: ' + e.message });
        }
      }

      results[file] = record;
    } catch (err) {
      errors.push({ file, error: err.message });
    }
  }

  event.reply('analysis-result', { success: true, results, errors });
});
