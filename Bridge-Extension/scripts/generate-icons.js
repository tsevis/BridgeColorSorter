/**
 * Simple PNG Icon Generator
 * Creates minimal PNG icons for ColorXBridge extension
 * Uses pure JavaScript - no external dependencies
 */

const fs = require('fs');
const path = require('path');

const ICONS_DIR = path.join(__dirname, '..', 'assets', 'icons');

// Ensure output directory exists
if (!fs.existsSync(ICONS_DIR)) {
  fs.mkdirSync(ICONS_DIR, { recursive: true });
}

/**
 * Create a simple PNG file from pixel data
 * This creates a minimal valid PNG with RGB data
 */
function createPNG(width, height, pixels) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  // Helper to create PNG chunk
  function createChunk(type, data) {
    const typeBuffer = Buffer.from(type);
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(data.length, 0);
    
    const chunkWithoutCrc = Buffer.concat([typeBuffer, data]);
    const crcBuffer = Buffer.alloc(4);
    crcBuffer.writeUInt32BE(crc32(chunkWithoutCrc), 0);
    
    return Buffer.concat([lengthBuffer, chunkWithoutCrc, crcBuffer]);
  }
  
  // CRC32 table
  const crcTable = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c >>> 0;
  }
  
  function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  
  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 2;  // color type (RGB)
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  
  const ihdrChunk = createChunk('IHDR', ihdrData);
  
  // IDAT chunk (image data)
  const rawData = [];
  for (let y = 0; y < height; y++) {
    rawData.push(0); // filter byte (none)
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      rawData.push(pixels[idx]);
      rawData.push(pixels[idx + 1]);
      rawData.push(pixels[idx + 2]);
    }
  }
  
  // Simple compression (zlib with default settings)
  const compressed = zlibDeflate(Buffer.from(rawData));
  const idatChunk = createChunk('IDAT', compressed);
  
  // IEND chunk
  const iendChunk = createChunk('IEND', Buffer.alloc(0));
  
  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

/**
 * Simple zlib deflate implementation (minimal)
 * For production, use the 'zlib' module
 */
function zlibDeflate(data) {
  try {
    const zlib = require('zlib');
    return zlib.deflateSync(data);
  } catch (e) {
    // Fallback: return uncompressed data with zlib header
    // This won't work in all PNG readers but allows the script to run
    console.log('[IconGen] zlib not available, using raw data');
    const result = Buffer.alloc(data.length + 4);
    result[0] = 0x78;
    result[1] = 0x9C;
    data.copy(result, 2);
    
    // Adler-32 checksum
    const adler = adler32(data);
    result[result.length - 4] = (adler >>> 24) & 0xFF;
    result[result.length - 3] = (adler >>> 16) & 0xFF;
    result[result.length - 2] = (adler >>> 8) & 0xFF;
    result[result.length - 1] = adler & 0xFF;
    
    return result;
  }
}

/**
 * Adler-32 checksum
 */
function adler32(data) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return (b << 16) | a;
}

/**
 * Generate icon pixel data
 */
function generateIconPixels(size, variant) {
  const pixels = new Array(size * size * 3).fill(0);
  const isHover = variant === 'hover';
  const isDisabled = variant === 'disabled';
  
  // Colors
  const bg = isDisabled ? [74, 74, 90] : [26, 26, 46];
  const primary = isHover ? [255, 107, 107] : [233, 69, 96];
  const wellColors = isDisabled 
    ? [[106, 106, 122], [106, 106, 122], [106, 106, 122], [106, 106, 122]]
    : (isHover
        ? [[255, 138, 138], [254, 202, 87], [78, 205, 196], [168, 230, 207]]
        : [[255, 107, 107], [254, 202, 87], [78, 205, 196], [168, 230, 207]]);
  
  const cx = size / 2;
  const cy = size / 2;
  const rx = size / 2 - 2;
  const ry = (size / 2 - 2) * 0.7;
  
  // Draw background circle
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < size / 2 - 1) {
        const idx = (y * size + x) * 3;
        pixels[idx] = bg[0];
        pixels[idx + 1] = bg[1];
        pixels[idx + 2] = bg[2];
      }
    }
  }
  
  // Draw palette (ellipse)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      
      if (dx * dx + dy * dy <= 1) {
        const idx = (y * size + x) * 3;
        
        if (isDisabled) {
          pixels[idx] = primary[0] * 0.5;
          pixels[idx + 1] = primary[1] * 0.5;
          pixels[idx + 2] = primary[2] * 0.5;
        } else {
          pixels[idx] = primary[0];
          pixels[idx + 1] = primary[1];
          pixels[idx + 2] = primary[2];
        }
      }
    }
  }
  
  // Draw color wells
  const wellPositions = [
    { x: -0.3, y: -0.1 },
    { x: 0.3, y: -0.1 },
    { x: -0.2, y: 0.2 },
    { x: 0.2, y: 0.2 }
  ];
  
  const wellRadius = Math.max(1, size * 0.08);
  
  wellPositions.forEach((pos, i) => {
    const wx = cx + pos.x * rx * 0.6;
    const wy = cy + pos.y * ry * 0.6;
    const color = wellColors[i];
    
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - wx;
        const dy = y - wy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist <= wellRadius) {
          const idx = (y * size + x) * 3;
          pixels[idx] = color[0];
          pixels[idx + 1] = color[1];
          pixels[idx + 2] = color[2];
        }
      }
    }
  });
  
  // Draw thumb hole
  const thumbX = cx + rx * 0.5;
  const thumbY = cy + ry * 0.3;
  const thumbRadius = size * 0.1;
  
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - thumbX;
      const dy = y - thumbY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist <= thumbRadius) {
        const idx = (y * size + x) * 3;
        pixels[idx] = bg[0];
        pixels[idx + 1] = bg[1];
        pixels[idx + 2] = bg[2];
      }
    }
  }
  
  // Add shine for hover variant
  if (isHover) {
    const shineX = cx - rx * 0.3;
    const shineY = cy - ry * 0.2;
    const shineRadius = size * 0.08;
    
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - shineX;
        const dy = y - shineY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist <= shineRadius) {
          const idx = (y * size + x) * 3;
          // Blend with white
          pixels[idx] = Math.min(255, pixels[idx] + 50);
          pixels[idx + 1] = Math.min(255, pixels[idx + 1] + 50);
          pixels[idx + 2] = Math.min(255, pixels[idx + 2] + 50);
        }
      }
    }
  }
  
  return pixels;
}

/**
 * Generate all icons
 */
function generateAllIcons() {
  console.log('========================================');
  console.log('  ColorXBridge Icon Generator');
  console.log('========================================\n');
  
  const icons = [
    { name: 'icon-16.png', size: 16, variant: 'normal' },
    { name: 'icon-16-hover.png', size: 16, variant: 'hover' },
    { name: 'icon-16-disabled.png', size: 16, variant: 'disabled' },
    { name: 'icon-32.png', size: 32, variant: 'normal' },
    { name: 'icon-32-hover.png', size: 32, variant: 'hover' },
    { name: 'icon-32-disabled.png', size: 32, variant: 'disabled' }
  ];
  
  let successCount = 0;
  
  icons.forEach(function(icon) {
    try {
      const pixels = generateIconPixels(icon.size, icon.variant);
      const pngData = createPNG(icon.size, icon.size, pixels);
      const outputPath = path.join(ICONS_DIR, icon.name);
      
      fs.writeFileSync(outputPath, pngData);
      console.log('  ✓ Generated:', icon.name);
      successCount++;
    } catch (e) {
      console.log('  ✗ Failed:', icon.name, '-', e.message);
    }
  });
  
  console.log('\n========================================');
  console.log('  Generated', successCount + '/' + icons.length, 'icons');
  console.log('========================================');
}

// Run
generateAllIcons();
