# ULP Log Explorer

A fast, lightweight, high-performance web app for searching and exploring massive log files (`URL:username:password` format, ~1.25 GB, ~20M lines each) powered directly by **ripgrep**.

Designed for **Termux** on Android (tested with Snapdragon 8 Elite / 16 GB RAM) and desktop browsers. Fully responsive, clean, distraction-free interface.

---

## Architecture & Performance

- **Zero native build tools needed**: Express.js server spawns `rg` (ripgrep) directly via child process. No `node-gyp`, no Python, no C++ compilation.
- **Sub-50ms search on 1.25 GB files**: Streams search results immediately via newline-delimited JSON (NDJSON).
- **Virtual Scrolling DOM**: Recycles DOM nodes so searching through 10,000+ matches never lags or crashes mobile browsers.
- **Ultra-low RAM usage**: Node.js + Express uses ~30 MB RSS memory.

---

## Termux Setup & Run Guide (IQOO 13 / Android)

### 1. Install Dependencies in Termux

```bash
# Update package repositories
pkg update && pkg upgrade -y

# Install Node.js LTS and ripgrep
pkg install nodejs-lts ripgrep -y

# Verify installations
node -v
rg --version
```

### 2. Copy or Clone Project to Termux

Place the project in Termux home directory, e.g.:

```bash
cd ~
git clone <your-repo-url> ulp
# Or copy folder over
cd ~/ulp
```

### 3. Install NPM Dependencies

Only Express is required (zero native C++ addons):

```bash
npm install
```

### 4. Configure Logs Directory

By default, the server searches for logs in `~/logs`. You can place your log files there:

```bash
mkdir -p ~/logs
# Move your large log files into ~/logs/
mv /path/to/log.txt ~/logs/
```

Or set the `LOGS_DIR` environment variable to any custom path:

```bash
export LOGS_DIR=~/logs
```

### 5. Start the Server

```bash
node server.js
```

You'll see:
```text
  ULP Log Explorer
  ─────────────────────────────
  Server:    http://localhost:3000
  Logs dir:  /data/data/com.termux/files/home/logs
  Platform:  android
  Node:      v20.x.x
  ─────────────────────────────
```

### 6. Access in Browser

Open Chrome, Firefox, or Kiwi Browser on your phone:
- Local URL: **`http://localhost:3000`**
- If accessing from a PC on the same Wi-Fi: **`http://<phone-ip>:3000`**

---

## Search & Display Features

| Feature | Shortcut / Control | Description |
|---|---|---|
| **URL Only Mode** | Field Filter / `Alt+U` | Restricts search strictly to the URL domain & path segment |
| **Literal Search** | Toggle `Abc` | Exact string match (fastest) |
| **Regex Search** | Toggle `.*` | Full regular expression support |
| **Word Match** | Toggle `\b` | Whole word boundaries |
| **Case Sensitivity** | Toggle `Aa` or `Alt+C` | Case sensitive / insensitive |
| **Invert Match** | Toggle `✕` | Show lines that do NOT match |
| **Field Filter** | Dropdown | Filter specifically by `URL`, `Username`, or `Password` |
| **Result View Modes** | Tabs: `RAW`, `Email:pass`, `User:pass`, `Phone:pass` | Switch between full lines or structured credentials with live counters |
| **Individual Click-to-Copy** | Click Email / User / Phone / Pass | Clicking Email copies ONLY email; clicking Pass copies ONLY password |
| **Raw Line Preview** | Click Eye button `👁️` | Expands a dropdown popover showing the full unclipped RAW log line with one-click copy |
| **Copied History & Memory** | Persistent across sessions | Clicked items are visually marked with a `✓` checkmark and dimmed so you never repeat work |
| **Filtered Export** | Export button | Exports records according to current view mode (`email:pass` or RAW) as `.txt` |
| **Search / Stop Action** | Button / `Enter` / `Esc` | Explicit Search button turns into a Stop button while searching; displays all matching results |
| **Multi-File Search** | Sidebar checkboxes | Search across multiple selected log files concurrently |
| **Focus Search** | `Ctrl + K` / `Cmd + K` | Instantly jump to search bar |
| **Clear Search** | `Esc` | Clears search input and results |

---

## File Format

Optimized for 3-part colon-delimited logs:
```text
domain.com/path:username:password
```
The field filter automatically parses:
1. **URL**: Everything before the first colon
2. **Username**: Everything between the first and second colon
3. **Password**: Everything after the second colon
