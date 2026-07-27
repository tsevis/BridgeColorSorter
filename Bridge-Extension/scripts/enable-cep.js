/**
 * CEP Debug Mode Enabler
 * Enables PlayerDebugMode for CEP extensions (required for development)
 * 
 * Usage:
 *   node scripts/enable-cep.js     - Enable debug mode
 *   node scripts/enable-cep.js --disable  - Disable debug mode
 *   node scripts/enable-cep.js --status   - Check current status
 */

const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const platform = os.platform();
const isMac = platform === 'darwin';
const isWin = platform === 'win32';

// CEP versions to enable (covers Bridge CC 2020-2026)
const CEP_VERSIONS = ['11', '10', '9', '8'];

function log(message) {
  console.log('[CEP]', message);
}

function error(message) {
  console.error('[CEP] ERROR:', message);
}

/**
 * Enable CEP debug mode on macOS
 */
function enableMac() {
  log('Enabling CEP debug mode on macOS...');
  
  CEP_VERSIONS.forEach(version => {
    try {
      execSync(`defaults write com.adobe.CSXS.${version} PlayerDebugMode 1`);
      log(`  ✓ CSXS.${version} enabled`);
    } catch (e) {
      log(`  - CSXS.${version} not available, skipping`);
    }
  });
  
  log('\nDebug mode enabled successfully!');
  log('Restart Adobe Bridge for changes to take effect.');
}

/**
 * Disable CEP debug mode on macOS
 */
function disableMac() {
  log('Disabling CEP debug mode on macOS...');
  
  CEP_VERSIONS.forEach(version => {
    try {
      execSync(`defaults delete com.adobe.CSXS.${version} PlayerDebugMode 2>/dev/null`);
      log(`  ✓ CSXS.${version} disabled`);
    } catch (e) {
      // Ignore errors when deleting
    }
  });
  
  log('\nDebug mode disabled.');
}

/**
 * Enable CEP debug mode on Windows
 */
function enableWin() {
  log('Enabling CEP debug mode on Windows...');
  
  CEP_VERSIONS.forEach(version => {
    try {
      execSync(`reg add "HKEY_CURRENT_USER\\Software\\Adobe\\CSXS.${version}" /v PlayerDebugMode /t REG_SZ /d 1 /f 2>nul`);
      log(`  ✓ CSXS.${version} enabled`);
    } catch (e) {
      log(`  - CSXS.${version} not available, skipping`);
    }
  });
  
  log('\nDebug mode enabled successfully!');
  log('Restart Adobe Bridge for changes to take effect.');
}

/**
 * Disable CEP debug mode on Windows
 */
function disableWin() {
  log('Disabling CEP debug mode on Windows...');
  
  CEP_VERSIONS.forEach(version => {
    try {
      execSync(`reg delete "HKEY_CURRENT_USER\\Software\\Adobe\\CSXS.${version}" /v PlayerDebugMode /f 2>nul`);
      log(`  ✓ CSXS.${version} disabled`);
    } catch (e) {
      // Ignore errors when deleting
    }
  });
  
  log('\nDebug mode disabled.');
}

/**
 * Check CEP debug mode status on macOS
 */
function checkStatusMac() {
  console.log('========================================');
  console.log('  CEP Debug Mode Status (macOS)');
  console.log('========================================\n');
  
  CEP_VERSIONS.forEach(version => {
    try {
      const result = execSync(`defaults read com.adobe.CSXS.${version} PlayerDebugMode 2>/dev/null || echo "0"`).toString().trim();
      const status = result === '1' ? '✓ Enabled' : '✗ Disabled';
      console.log(`  CSXS.${version}: ${status}`);
    } catch (e) {
      console.log(`  CSXS.${version}: ? Unknown`);
    }
  });
  
  console.log('\nNote: Debug mode must be enabled to load unsigned extensions.');
}

/**
 * Check CEP debug mode status on Windows
 */
function checkStatusWin() {
  console.log('========================================');
  console.log('  CEP Debug Mode Status (Windows)');
  console.log('========================================\n');
  
  CEP_VERSIONS.forEach(version => {
    try {
      execSync(`reg query "HKEY_CURRENT_USER\\Software\\Adobe\\CSXS.${version}" /v PlayerDebugMode 2>nul`);
      console.log(`  CSXS.${version}: ✓ Enabled`);
    } catch (e) {
      console.log(`  CSXS.${version}: ✗ Disabled`);
    }
  });
  
  console.log('\nNote: Debug mode must be enabled to load unsigned extensions.');
}

/**
 * Show usage information
 */
function showUsage() {
  console.log('CEP Debug Mode Enabler');
  console.log('======================\n');
  console.log('Usage:');
  console.log('  node scripts/enable-cep.js           Enable debug mode');
  console.log('  node scripts/enable-cep.js --disable Disable debug mode');
  console.log('  node scripts/enable-cep.js --status  Check current status');
  console.log('');
  console.log('Debug mode is required to load unsigned CEP extensions.');
  console.log('After enabling, restart Adobe Bridge.');
}

// ============================================================================
// MAIN
// ============================================================================

const args = process.argv.slice(2);

if (args.includes('--status')) {
  if (isMac) {
    checkStatusMac();
  } else if (isWin) {
    checkStatusWin();
  } else {
    error('Unsupported platform: ' + platform);
  }
} else if (args.includes('--disable')) {
  if (isMac) {
    disableMac();
  } else if (isWin) {
    disableWin();
  } else {
    error('Unsupported platform: ' + platform);
  }
} else {
  if (isMac) {
    enableMac();
  } else if (isWin) {
    enableWin();
  } else {
    error('Unsupported platform: ' + platform);
  }
}
