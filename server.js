const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// Resolve logs directory: env var > ~/logs > ./logs (for dev)
const LOGS_DIR = (() => {
  if (process.env.LOGS_DIR) {
    return path.resolve(process.env.LOGS_DIR.replace(/^~/, os.homedir()));
  }
  const homeLogsDir = path.join(os.homedir(), 'logs');
  if (fs.existsSync(homeLogsDir)) return homeLogsDir;
  // Fallback: same directory as server for development
  return path.resolve(__dirname);
})();

// ripgrep binary name
const RG_BIN = process.platform === 'win32' ? 'rg.exe' : 'rg';

// Track active search processes for abort
let activeSearches = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// Known non-log files/extensions to ignore
const IGNORED_FILES = new Set(['server.js', 'package.json', 'package-lock.json', 'README.md', '.gitignore']);
const LOG_EXTENSIONS = new Set(['.txt', '.log', '.csv', '.tsv', '.dat', '.jsonl', '.out']);

/**
 * Validate a filename — must be a simple name, no traversal
 */
function validateFilename(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  if (name.startsWith('.')) return false;
  return true;
}

/**
 * Resolve a safe absolute path within LOGS_DIR
 */
function resolveLogPath(filename) {
  if (!validateFilename(filename)) return null;
  const resolved = path.resolve(path.join(LOGS_DIR, filename));
  // Extra safety: ensure resolved path is under LOGS_DIR
  if (process.platform === 'win32') {
    if (!resolved.toLowerCase().startsWith(LOGS_DIR.toLowerCase())) return null;
  } else {
    if (!resolved.startsWith(LOGS_DIR)) return null;
  }
  return resolved;
}

/**
 * Get estimated line count from file size
 */
function estimateLineCount(sizeBytes, avgLineLen = 67) {
  return Math.round(sizeBytes / avgLineLen);
}

/**
 * Classify identity string as email, phone, or username
 */
function classifyIdentity(user) {
  if (!user) return 'unknown';
  if (user.includes('@') && user.indexOf('@') > 0 && user.indexOf('.', user.indexOf('@')) > 0) {
    return 'email';
  }
  if (/^\+?[0-9\-\.\(\)\s]{7,18}$/.test(user) && (user.match(/\d/g) || []).length >= 7) {
    return 'phone';
  }
  return 'username';
}

/**
 * Parse a standard 3-field ULP log line (url:user:password)
 */
function parseLogLine(line) {
  const lastColon = line.lastIndexOf(':');
  if (lastColon === -1) {
    return { url: line, user: '', pass: '', identityType: 'unknown' };
  }
  const secondLastColon = line.lastIndexOf(':', lastColon - 1);
  if (secondLastColon === -1) {
    const u = line.substring(0, lastColon);
    return {
      url: '',
      user: u,
      pass: line.substring(lastColon + 1),
      identityType: classifyIdentity(u)
    };
  }
  const u = line.substring(secondLastColon + 1, lastColon);
  return {
    url: line.substring(0, secondLastColon),
    user: u,
    pass: line.substring(lastColon + 1),
    identityType: classifyIdentity(u)
  };
}

// ─── API: List files ──────────────────────────────────────

app.get('/api/files', (req, res) => {
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      return res.json({ files: [], logsDir: LOGS_DIR });
    }
    const entries = fs.readdirSync(LOGS_DIR, { withFileTypes: true });
    const files = entries
      .filter(e => {
        if (!e.isFile() || e.name.startsWith('.')) return false;
        if (IGNORED_FILES.has(e.name)) return false;
        const ext = path.extname(e.name).toLowerCase();
        // If in root project dir, only show log-like files
        if (LOGS_DIR === path.resolve(__dirname)) {
          return LOG_EXTENSIONS.has(ext) || ext === '';
        }
        return true;
      })
      .map(e => {
        const fullPath = path.join(LOGS_DIR, e.name);
        const stats = fs.statSync(fullPath);
        return {
          name: e.name,
          size: stats.size,
          sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
          modified: stats.mtime.toISOString(),
          estimatedLines: estimateLineCount(stats.size)
        };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));

    res.json({ files, logsDir: LOGS_DIR });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list files', detail: err.message });
  }
});

// ─── API: File stats ──────────────────────────────────────

app.get('/api/file/:name/stats', (req, res) => {
  const filePath = resolveLogPath(req.params.name);
  if (!filePath) return res.status(400).json({ error: 'Invalid filename' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  try {
    const stats = fs.statSync(filePath);
    res.json({
      name: req.params.name,
      size: stats.size,
      sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
      modified: stats.mtime.toISOString(),
      estimatedLines: estimateLineCount(stats.size)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get stats', detail: err.message });
  }
});

// ─── API: File preview ────────────────────────────────────

app.get('/api/file/:name/preview', (req, res) => {
  const filePath = resolveLogPath(req.params.name);
  if (!filePath) return res.status(400).json({ error: 'Invalid filename' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 100));

  // Use rg to extract lines by line number range
  const startLine = offset + 1;
  const endLine = offset + limit;
  const pattern = `^`;
  const args = [
    '--no-heading', '--no-filename', '-n',
    '--line-number',
    '-m', String(endLine),
    '-e', pattern,
    filePath
  ];

  const rg = spawn(RG_BIN, args, { timeout: 15000 });
  let output = '';
  let errOutput = '';

  rg.stdout.on('data', chunk => { output += chunk.toString(); });
  rg.stderr.on('data', chunk => { errOutput += chunk.toString(); });

  rg.on('close', () => {
    const allLines = output.split('\n').filter(Boolean);
    // Filter to requested range
    const lines = allLines.slice(offset).map(line => {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) return { num: 0, content: line };
      return {
        num: parseInt(line.substring(0, colonIdx)),
        content: line.substring(colonIdx + 1)
      };
    });

    res.json({
      file: req.params.name,
      offset,
      limit,
      lines,
      hasMore: allLines.length >= limit
    });
  });

  rg.on('error', () => {
    // Fallback: use Node.js readline for preview when rg is not available
    previewWithNode(filePath, offset, limit, res, req.params.name);
  });
});

/**
 * Fallback preview using Node.js streams (when rg is not available)
 */
function previewWithNode(filePath, offset, limit, res, fileName) {
  const readline = require('readline');
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const lines = [];
  let lineNum = 0;

  rl.on('line', (line) => {
    lineNum++;
    if (lineNum > offset && lineNum <= offset + limit) {
      lines.push({ num: lineNum, content: line });
    }
    if (lineNum >= offset + limit) {
      rl.close();
      fileStream.destroy();
    }
  });

  rl.on('close', () => {
    res.json({
      file: fileName,
      offset,
      limit,
      lines,
      hasMore: lineNum >= offset + limit
    });
  });

  rl.on('error', (err) => {
    res.status(500).json({ error: 'Failed to read file', detail: err.message });
  });
}

// ─── API: Search ──────────────────────────────────────────

app.post('/api/search', (req, res) => {
  const {
    query,
    files = [],
    mode = 'literal',
    caseSensitive = false,
    maxResults = null,
    context = 0,
    invertMatch = false,
    fieldFilter = null,
    urlOnly = false,
    searchId = null
  } = req.body;

  const effectiveFieldFilter = urlOnly ? 'url' : fieldFilter;

  // Validate query
  if (!query || typeof query !== 'string' || query.length > 10000) {
    return res.status(400).json({ error: 'Invalid or missing query (max 10000 chars)' });
  }

  // Validate files
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'No files selected' });
  }

  // Resolve file paths
  const filePaths = [];
  for (const f of files) {
    const p = resolveLogPath(f);
    if (!p || !fs.existsSync(p)) {
      return res.status(400).json({ error: `Invalid or missing file: ${f}` });
    }
    filePaths.push(p);
  }

  // Kill previous search with same searchId
  if (searchId && activeSearches.has(searchId)) {
    try { activeSearches.get(searchId).kill(); } catch (_) {}
    activeSearches.delete(searchId);
  }

  // Build rg arguments
  const args = buildRgArgs(query, mode, caseSensitive, maxResults, context, invertMatch, effectiveFieldFilter);
  args.push(...filePaths);

  // Set response headers for streaming
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const startTime = Date.now();
  let matchCount = 0;

  const rg = spawn(RG_BIN, args, { timeout: 120000 });

  if (searchId) activeSearches.set(searchId, rg);

  let buffer = '';

  rg.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'match') {
          matchCount++;
          const lineText = parsed.data.lines.text.replace(/\r?\n$/, '');
          const parsedParts = parseLogLine(lineText);
          const matchData = {
            type: 'match',
            file: path.basename(parsed.data.path.text),
            line: parsed.data.line_number,
            content: lineText,
            url: parsedParts.url,
            user: parsedParts.user,
            pass: parsedParts.pass,
            identityType: parsedParts.identityType,
            submatches: (parsed.data.submatches || []).map(s => ({
              start: s.start,
              end: s.end,
              text: s.match.text
            }))
          };
          if (!res.writableEnded) {
            res.write(JSON.stringify(matchData) + '\n');
          }
        }
      } catch (_) {
        // Skip malformed JSON lines from rg
      }
    }
  });

  rg.stderr.on('data', (chunk) => {
    const errText = chunk.toString().trim();
    if (errText && !res.writableEnded) {
      res.write(JSON.stringify({ type: 'error', message: errText }) + '\n');
    }
  });

  rg.on('close', (code) => {
    if (searchId) activeSearches.delete(searchId);

    // Process remaining buffer
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer);
        if (parsed.type === 'match') {
          matchCount++;
          const lineText = parsed.data.lines.text.replace(/\r?\n$/, '');
          const parsedParts = parseLogLine(lineText);
          const matchData = {
            type: 'match',
            file: path.basename(parsed.data.path.text),
            line: parsed.data.line_number,
            content: lineText,
            url: parsedParts.url,
            user: parsedParts.user,
            pass: parsedParts.pass,
            identityType: parsedParts.identityType,
            submatches: (parsed.data.submatches || []).map(s => ({
              start: s.start,
              end: s.end,
              text: s.match.text
            }))
          };
          if (!res.writableEnded) {
            res.write(JSON.stringify(matchData) + '\n');
          }
        }
      } catch (_) {}
    }

    if (!res.writableEnded) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      res.write(JSON.stringify({
        type: 'stats',
        matches: matchCount,
        elapsed: elapsed + 's',
        filesSearched: filePaths.length,
        maxReached: (maxResults && maxResults > 0) ? matchCount >= maxResults : false
      }) + '\n');
      res.end();
    }
  });

  rg.on('error', (err) => {
    if (searchId) activeSearches.delete(searchId);
    if (!res.writableEnded) {
      res.write(JSON.stringify({
        type: 'error',
        message: `Failed to run ripgrep: ${err.message}. Is 'rg' installed?`
      }) + '\n');
      res.end();
    }
  });

  // Handle client disconnect: only kill if response was aborted prematurely
  res.on('close', () => {
    if (!res.writableEnded) {
      try { rg.kill(); } catch (_) {}
    }
    if (searchId) activeSearches.delete(searchId);
  });
});

/**
 * Build ripgrep argument array from search options
 */
function buildRgArgs(query, mode, caseSensitive, maxResults, context, invertMatch, fieldFilter) {
  const args = ['--json', '--no-heading'];

  // Search mode
  if (mode === 'literal' && !fieldFilter) {
    args.push('-F');
  } else if (mode === 'word' && !fieldFilter) {
    args.push('-w');
  }

  // Case sensitivity
  if (!caseSensitive) {
    args.push('-i');
  } else {
    args.push('-s');
  }

  // Max results: only cap if maxResults is a positive integer; otherwise unlimited
  if (maxResults && typeof maxResults === 'number' && maxResults > 0) {
    args.push('-m', String(maxResults));
  }

  // Context lines
  if (context > 0) {
    args.push('-C', String(Math.min(context, 10)));
  }

  // Invert match
  if (invertMatch) {
    args.push('-v');
  }

  // Field filter — convert to regex targeting specific colon-delimited field
  let searchQuery = query;
  if (fieldFilter) {
    const fIdx = args.indexOf('-F');
    if (fIdx !== -1) args.splice(fIdx, 1);
    const wIdx = args.indexOf('-w');
    if (wIdx !== -1) args.splice(wIdx, 1);

    const pattern = mode === 'regex' ? query : (mode === 'word' ? `\\b${escapeRegex(query)}\\b` : escapeRegex(query));

    switch (fieldFilter) {
      case 'url':
        // Match query anywhere in the URL segment (up to user:pass, handles ports)
        searchQuery = `^[^:\r\n]*(:[0-9]{1,5})?[^:\r\n]*${pattern}[^:\r\n]*:`;
        break;
      case 'username':
        // Match query in the second field
        searchQuery = `^[^:\r\n]*:[^:\r\n]*${pattern}[^:\r\n]*:`;
        break;
      case 'password':
        // Match query in the third field (after second colon)
        searchQuery = `^[^:\r\n]*:[^:\r\n]*:.*${pattern}`;
        break;
    }
  }

  args.push('-e', searchQuery);

  return args;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── API: Count matches (fast) ────────────────────────────

app.post('/api/count', (req, res) => {
  const { query, files = [], mode = 'literal', caseSensitive = false } = req.body;

  if (!query || !files.length) {
    return res.status(400).json({ error: 'Missing query or files' });
  }

  const filePaths = [];
  for (const f of files) {
    const p = resolveLogPath(f);
    if (!p || !fs.existsSync(p)) continue;
    filePaths.push(p);
  }

  const args = ['-c'];
  if (mode === 'literal') args.push('-F');
  if (!caseSensitive) args.push('-i');
  args.push('-e', query, ...filePaths);

  const rg = spawn(RG_BIN, args, { timeout: 30000 });
  let output = '';

  rg.stdout.on('data', chunk => { output += chunk.toString(); });
  rg.on('close', () => {
    const counts = {};
    output.split('\n').filter(Boolean).forEach(line => {
      const lastColon = line.lastIndexOf(':');
      if (lastColon !== -1) {
        const file = path.basename(line.substring(0, lastColon));
        counts[file] = parseInt(line.substring(lastColon + 1)) || 0;
      }
    });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    res.json({ counts, total });
  });
  rg.on('error', () => {
    res.status(500).json({ error: 'ripgrep not available' });
  });
});

// ─── Start ────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ULP Log Explorer`);
  console.log(`  ─────────────────────────────`);
  console.log(`  Server:    http://localhost:${PORT}`);
  console.log(`  Logs dir:  ${LOGS_DIR}`);
  console.log(`  Platform:  ${process.platform}`);
  console.log(`  Node:      ${process.version}`);
  console.log(`  ─────────────────────────────\n`);
});
