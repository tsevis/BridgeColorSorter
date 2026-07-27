/**
 * CacheManager.js
 * L1 (Memory) + L2 (SQLite) caching for color analysis results
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

class CacheManager {
  constructor(options = {}) {
    this.l1Cache = new Map();
    this.maxL1Size = options.maxL1Size || 100;
    this.dbPath = options.dbPath || this._getDefaultDbPath();
    this.db = null;
    this._initDatabase();
  }

  _getDefaultDbPath() {
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const cacheDir = path.join(homeDir, '.colorxbridge');
    
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    return path.join(cacheDir, 'cache.db');
  }

  _initDatabase() {
    try {
      const Database = require('better-sqlite3');
      this.db = new Database(this.dbPath);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS color_cache (
          file_hash TEXT PRIMARY KEY,
          file_path TEXT,
          file_mtime INTEGER,
          dominant_hex TEXT,
          dominant_rgb TEXT,
          dominant_hsl TEXT,
          dominance REAL,
          palette_json TEXT,
          analyzed_at INTEGER
        )
      `);

      console.log('[ColorXBridge] SQLite cache initialized at', this.dbPath);
    } catch (e) {
      console.log('[ColorXBridge] SQLite not available, using memory cache only');
      this.db = null;
    }
  }

  async get(fileHash, filePath) {
    const l1Result = this.l1Cache.get(fileHash);
    if (l1Result) {
      if (this._isCacheValid(l1Result, filePath)) {
        return l1Result;
      } else {
        this.l1Cache.delete(fileHash);
      }
    }

    if (this.db) {
      try {
        const row = this.db.prepare('SELECT * FROM color_cache WHERE file_hash = ?').get(fileHash);
        
        if (row && this._isCacheValid(row, filePath)) {
          const result = this._rowToResult(row);
          this._addToL1(fileHash, result);
          return result;
        } else if (row) {
          this.db.prepare('DELETE FROM color_cache WHERE file_hash = ?').run(fileHash);
        }
      } catch (e) {
        console.error('[ColorXBridge] Cache read error:', e);
      }
    }

    return null;
  }

  async set(fileHash, filePath, result) {
    this._addToL1(fileHash, result);

    if (this.db) {
      try {
        const stat = fs.statSync(filePath);
        
        const stmt = this.db.prepare(`
          INSERT OR REPLACE INTO color_cache 
          (file_hash, file_path, file_mtime, dominant_hex, dominant_rgb, dominant_hsl, dominance, palette_json, analyzed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
          fileHash,
          filePath,
          stat.mtimeMs,
          result.dominant.hex,
          JSON.stringify(result.dominant.rgb),
          JSON.stringify(result.dominant.hsl),
          result.dominant.dominance,
          JSON.stringify(result.palette),
          result.metadata.analyzedAt
        );
      } catch (e) {
        console.error('[ColorXBridge] Cache write error:', e);
      }
    }
  }

  _addToL1(fileHash, result) {
    if (this.l1Cache.size >= this.maxL1Size) {
      const firstKey = this.l1Cache.keys().next().value;
      this.l1Cache.delete(firstKey);
    }
    this.l1Cache.set(fileHash, result);
  }

  _isCacheValid(cacheEntry, filePath) {
    try {
      const stat = fs.statSync(filePath);
      const cacheMtime = cacheEntry.file_mtime || cacheEntry.metadata?.fileMtime;
      return cacheMtime === stat.mtimeMs;
    } catch (e) {
      return false;
    }
  }

  _rowToResult(row) {
    return {
      dominant: {
        hex: row.dominant_hex,
        rgb: JSON.parse(row.dominant_rgb),
        hsl: JSON.parse(row.dominant_hsl),
        dominance: row.dominance
      },
      palette: JSON.parse(row.palette_json),
      metadata: {
        filePath: row.file_path,
        fileHash: row.file_hash,
        analyzedAt: row.analyzed_at,
        fileMtime: row.file_mtime
      }
    };
  }

  clear() {
    this.l1Cache.clear();

    if (this.db) {
      try {
        this.db.prepare('DELETE FROM color_cache').run();
        console.log('[ColorXBridge] Cache cleared');
      } catch (e) {
        console.error('[ColorXBridge] Cache clear error:', e);
      }
    }

    return { success: true };
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = CacheManager;
