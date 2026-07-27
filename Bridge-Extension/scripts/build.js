/**
 * ColorXBridge Build Script
 * Packages the extension for distribution
 * 
 * Usage:
 *   node scripts/build.js              - Build unsigned extension
 *   node scripts/build.js --zxp        - Create ZXP (requires ZXPSignCmd)
 *   node scripts/build.js --clean      - Clean build output
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// Configuration
const PROJECT_ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'dist');
const ZXP_OUTPUT = path.join(PROJECT_ROOT, 'ColorXBridge.zxp');
const EXTENSION_ID = 'com.colorxbridge.panel';

// Files to include in the build
const FILES_TO_COPY = [
  'manifest.xml',
  'index.html',
  'package.json'
];

const DIRS_TO_COPY = [
  'css',
  'js',
  'assets'
];

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function log(message) {
  console.log('[Build]', message);
}

function error(message) {
  console.error('[Build] ERROR:', message);
}

function clean() {
  log('Cleaning output directory...');
  if (fs.existsSync(OUTPUT_DIR)) {
    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function copyFile(src, dest) {
  const srcPath = path.join(PROJECT_ROOT, src);
  const destPath = path.join(OUTPUT_DIR, dest);
  
  if (fs.existsSync(srcPath)) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
    log(`  Copied: ${src}`);
    return true;
  } else {
    log(`  Warning: ${src} not found, skipping`);
    return false;
  }
}

function copyDir(src, dest) {
  const srcPath = path.join(PROJECT_ROOT, src);
  const destPath = path.join(OUTPUT_DIR, dest);
  
  if (!fs.existsSync(srcPath)) {
    log(`  Warning: ${src}/ not found, skipping`);
    return false;
  }
  
  if (!fs.existsSync(destPath)) {
    fs.mkdirSync(destPath, { recursive: true });
  }
  
  const entries = fs.readdirSync(srcPath, { withFileTypes: true });
  
  for (const entry of entries) {
    const entrySrc = path.join(src, entry.name);
    const entryDest = path.join(dest, entry.name);
    
    // Skip excluded files
    if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') {
      continue;
    }
    
    if (entry.isDirectory()) {
      copyDir(entrySrc, entryDest);
    } else {
      copyFile(entrySrc, entryDest);
    }
  }
  
  return true;
}

function copyFiles() {
  log('Copying files to output directory...');
  
  FILES_TO_COPY.forEach(file => copyFile(file, file));
  DIRS_TO_COPY.forEach(dir => copyDir(dir, dir));
  
  log(`Files copied to: ${OUTPUT_DIR}`);
}

function createZXP() {
  log('Creating ZXP package...');
  
  // Check for ZXPSignCmd
  let signCmd = null;
  const possiblePaths = [
    '/Applications/Adobe CEP Extensions/CEP/CEPExtras/ZXPSignCmd',
    '/Applications/Adobe Extension Manager CC/ZXPSignCmd',
    'C:\\Program Files\\Adobe\\Adobe Extension Manager CC\\ZXPSignCmd.exe',
    './ZXPSignCmd',
    './node_modules/.bin/zxp-sign-cmd'
  ];
  
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      signCmd = p;
      break;
    }
  }
  
  if (!signCmd) {
    log('ZXPSignCmd not found. Creating unsigned package.');
    log('To sign the extension:');
    log('  1. Download ZXPSignCmd from: https://github.com/Adobe-CEP/Sample-Extensions/tree/master/ZXPSignCmd');
    log('  2. Run: ZXPSignCmd -sign dist ColorXBridge.zxp -certId "YourName" -password "YourPassword"');
    
    // Create a simple zip as placeholder
    createZip();
    return false;
  }
  
  // Sign and create ZXP
  const certId = process.env.ZXP_CERT_ID || 'ColorXBridge';
  const password = process.env.ZXP_PASSWORD || '';
  
  const args = ['-sign', OUTPUT_DIR, ZXP_OUTPUT];
  
  if (password) {
    args.push('-certId', certId, '-password', password);
  }
  
  try {
    execSync(`"${signCmd}" ${args.join(' ')}`, { stdio: 'inherit' });
    log(`ZXP created: ${ZXP_OUTPUT}`);
    return true;
  } catch (e) {
    error('Failed to create ZXP:', e.message);
    return false;
  }
}

function createZip() {
  log('Creating ZIP package (unsigned)...');
  
  const zipPath = path.join(PROJECT_ROOT, 'ColorXBridge-unsigned.zip');
  
  try {
    // Use system zip command
    const cwd = OUTPUT_DIR;
    const zipName = path.basename(zipPath);
    const parentDir = path.dirname(zipPath);
    
    // Change to output dir and create zip
    execSync(`zip -r "${zipName}" .`, { cwd: cwd, stdio: 'pipe' });
    
    // Move zip to project root
    const tempZip = path.join(cwd, zipName);
    if (fs.existsSync(tempZip)) {
      fs.renameSync(tempZip, zipPath);
      log(`ZIP created: ${zipPath}`);
    }
  } catch (e) {
    // Fallback: just notify user
    log('ZIP creation requires "zip" command. Manual packaging instructions:');
    log(`  1. Navigate to: ${OUTPUT_DIR}`);
    log('  2. Zip all files into ColorXBridge.zip');
    log('  3. Rename to ColorXBridge.zxp (for testing)');
  }
}

function showInstallInstructions() {
  console.log('\n========================================');
  console.log('  Installation Instructions');
  console.log('========================================\n');
  
  console.log('Option 1: Manual Installation (Development)');
  console.log('-------------------------------------------');
  console.log('1. Enable CEP debugging:');
  console.log('   macOS:   defaults write com.adobe.CSXS.11 PlayerDebugMode 1');
  console.log('   Windows: reg add HKEY_CURRENT_USER\\Software\\Adobe\\CSXS.11 /v PlayerDebugMode /t REG_SZ /d 1');
  console.log('   Or run: node scripts/enable-cep.js\n');
  
  console.log('2. Copy extension to CEP folder:');
  console.log('   macOS:   ~/Library/Application Support/Adobe/CEP/extensions/');
  console.log('   Windows: %APPDATA%\\Adobe\\CEP\\extensions\\');
  console.log('   Or run: node scripts/install.js\n');
  
  console.log('3. Restart Adobe Bridge');
  console.log('4. Open: Window > Extensions > ColorXBridge\n');
  
  console.log('Option 2: ZXP Installation (Production)');
  console.log('---------------------------------------');
  console.log('1. Install via Adobe Exchange or Extension Manager');
  console.log('2. Or use ZXPSignCmd to sign and install\n');
  
  console.log('========================================');
}

// ============================================================================
// MAIN BUILD PROCESS
// ============================================================================

function build(options) {
  console.log('========================================');
  console.log('  ColorXBridge Build Script');
  console.log('  Version: 1.0.0');
  console.log('========================================\n');
  
  try {
    // Clean
    if (options.clean || !fs.existsSync(OUTPUT_DIR)) {
      clean();
    }
    
    // Copy files
    copyFiles();
    
    // Create ZXP/ZIP
    if (options.zxp) {
      createZXP();
    } else {
      createZip();
    }
    
    // Show instructions
    showInstallInstructions();
    
    console.log('\nBuild completed successfully!');
    console.log('Output:', OUTPUT_DIR);
    
  } catch (e) {
    error('Build failed:', e.message);
    process.exit(1);
  }
}

// ============================================================================
// CLI PARSING
// ============================================================================

const args = process.argv.slice(2);
const options = {
  zxp: args.includes('--zxp'),
  clean: args.includes('--clean')
};

build(options);
