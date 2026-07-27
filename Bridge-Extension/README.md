# ColorXBridge - Adobe Bridge Extension

**Search & Sort by Color for Adobe Bridge**

---

## ⚠️ Compatibility

- ✅ **Bridge 2020-2025** (CC 10.0 - 15.0)
- ❌ **Bridge 2026+** (Not supported - use the macOS App instead)

---

## 🚀 Installation

### Step 1: Enable CEP Debug Mode

```bash
node scripts/enable-cep.js
```

### Step 2: Install Extension

```bash
node scripts/install.js
```

### Step 3: Restart Adobe Bridge

Quit and reopen Adobe Bridge.

### Step 4: Open Extension

In Bridge: **Window > Extensions > ColorXBridge**

---

## 🛠️ Development

### Install Dependencies

```bash
npm install
```

### Build Extension

```bash
npm run build
```

### Scripts

| Command | Description |
|---------|-------------|
| `node scripts/install.js` | Install to CEP folder |
| `node scripts/uninstall.js` | Remove extension |
| `node scripts/enable-cep.js` | Enable debug mode |
| `node scripts/build.js` | Build package |

---

## 📁 Project Structure

```
Bridge-Extension/
├── manifest.xml            # CEP extension manifest
├── index.html              # Panel HTML
├── css/
│   └── styles.css          # Panel styling
├── js/
│   ├── main.js             # Panel controller
│   ├── csinterface.js      # CEP communication
│   ├── bridge/
│   │   └── BridgeController.jsx  # ExtendScript
│   ├── analyzer/
│   │   └── ColorAnalyzer.js      # Color extraction
│   ├── cache/
│   │   └── CacheManager.js       # L1/L2 caching
│   └── xmp/
│       ├── XMPReader.js    # Read XMP metadata
│       └── XMPWriter.js    # Write XMP metadata
├── assets/
│   └── icons/              # Panel icons
└── scripts/
    ├── install.js          # Installation script
    ├── enable-cep.js       # Debug mode enabler
    └── build.js            # Build script
```

---

## 🎯 Features

- **Analyze Selected Images** - Extract colors from selection
- **Analyze Folder** - Process all images in current folder
- **Filter by Color** - Click swatches to filter
- **Sort by Color** - Hue, saturation, brightness, dominance
- **XMP Metadata** - Embedded or sidecar files
- **Smart Caching** - Fast re-analysis

---

## 🔧 Troubleshooting

### Extension Not Showing

1. Verify CEP debug mode: `node scripts/enable-cep.js --status`
2. Check installation: `node scripts/install.js --status`
3. Restart Bridge completely

### Analysis Fails

- Ensure Node.js modules are installed
- Check CEP Inspector console for errors
- Try individual file analysis first

---

## 📄 License

MIT License
