const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

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

// Track active search processes and analytics streams for abort
let activeSearches = new Map();
let activeAnalytics = new Map();

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
 * Strip promotional watermarks, telegram tags, tabs, and trailing metadata from passwords
 */
function cleanPassword(pass) {
  if (!pass) return '';
  // 1. If there is a tab, everything from the first tab is watermark/metadata
  if (pass.includes('\t')) {
    pass = pass.split('\t')[0];
  }
  // 2. Pipe separator with surrounding spaces: ' | ', ' |', '| '
  pass = pass.replace(/\s*\|\s*.*$/, '');
  // 3. Arrow separators: ' ➔ ', ' -> ', ' => ', etc.
  pass = pass.replace(/\s*[➔➜➞➝➢➣➤⇻]\s*.*$/, '');
  pass = pass.replace(/\s+(?:->|=>)\s+.*$/, '');
  // 4. Control characters (like \u001f, \x00-\x1f)
  pass = pass.replace(/[\x00-\x1f\x7f-\x9f].*$/, '');
  // 5. Multiple spaces followed by promo text (@, t.me, http, lifetime, cloud, telegram, brackets)
  pass = pass.replace(/\s{2,}(?:[@#|~]|t\.me\/|https?:\/\/|\[|\(|lifetime|cloud|priv8|private|vip|fresh|free|owner).*$/i, '');
  // 6. Trailing unicode watermark symbols
  pass = pass.replace(/[\s\u200B-\u200D\uFEFF]*[∉∘∏ᚧᚯᚥᚡ□▒┋🧨╬∁▨∈⟴🧬💀🔥👁‍🗨🖥️🔐💿ᚤ].*$/, '');
  return pass.trim();
}

/**
 * Strip promotional watermarks, telegram tags, and trailing metadata
 */
function stripAdSuffix(line) {
  if (!line) return '';
  let cleaned = line.trim();
  // 1. If line contains a tab, scrapers/clouds append watermarks after tab
  if (cleaned.includes('\t')) {
    cleaned = cleaned.split('\t')[0].trim();
  }
  // 2. Pipe delimiter followed by ads
  cleaned = cleaned.replace(/\s*\|\s*(?:life|@|t\.me|cloud|vip|priv|fresh|owner|channel|telegram|\$|\d).*$/i, '');
  // 3. Arrows followed by ads
  cleaned = cleaned.replace(/\s*[➔➜➞➝➢➣➤⇻]\s*.*$/, '');
  cleaned = cleaned.replace(/[\t\s]+(?:->|=>)\s+.*$/, '');
  // 4. Standalone t.me links at end
  cleaned = cleaned.replace(/[\t\s]+t\.me\/[a-zA-Z0-9_\-\.\/]+.*$/i, '');
  // 5. Bracketed tags
  cleaned = cleaned.replace(/[\t\s]+\[(?:Telegram|Channel|VIP|Cloud|Fresh|Owner|Date|By|Credit)[^\]]*\].*$/i, '');
  cleaned = cleaned.replace(/[\t\s]+\((?:@|t\.me)[^\)]*\).*$/i, '');
  return cleaned.trim();
}

/**
 * Classify identity string as email, phone/number, or username
 */
function classifyIdentity(user) {
  if (!user) return 'unknown';
  user = user.trim();

  // 1. Email check: contains @ with valid domain (at least 2-letter TLD)
  if (/^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]{2,}$/.test(user)) {
    return 'email';
  }
  if (user.includes('@') && user.indexOf('@') > 0 && user.indexOf('.', user.indexOf('@')) > user.indexOf('@') + 1) {
    const afterDot = user.substring(user.lastIndexOf('.') + 1);
    if (afterDot.length >= 2) return 'email';
  }

  // 2. Number / Phone check (pure numbers or formatted numbers/IDs/phones):
  // Covers: 261203, 15900723, 716.242.521-68, 042309-295974-1731, 01001486512, +1234567890
  const digits = user.replace(/\D/g, '');
  if (digits.length >= 3) {
    if (/^\+?[\d\s\-\.\(\)\/]{3,35}$/.test(user)) {
      return 'phone';
    }
    if (/^\d{3,}$/.test(user)) {
      return 'phone';
    }
  }

  // 3. Otherwise: username
  return 'username';
}

/**
 * Detect non-credential banner / advertisement lines
 */
function isBannerLine(line) {
  if (!line) return false;
  const l = line.toLowerCase().trim();
  if (/^(?:free channel|main|gateway|backup|channel|owner|contact|vip|logs by|join)\b.*(?:t\.me|telegram|https?:)/i.test(l)) {
    return true;
  }
  if (/^https?:\/\/t\.me\/[^\s:]+$/i.test(l)) {
    return true;
  }
  return false;
}

/**
 * Parse a standard ULP log line (url:user:password or user:password)
 * Prioritizes URL structure so passwords containing '@' are never mistaken for usernames.
 */
function parseLogLine(rawLine) {
  if (!rawLine || typeof rawLine !== 'string') {
    return { url: '', user: '', pass: '', identityType: 'unknown' };
  }

  const trimmed = rawLine.trim();
  if (isBannerLine(trimmed)) {
    return { url: trimmed, user: '', pass: '', identityType: 'unknown' };
  }

  const line = stripAdSuffix(trimmed);
  if (!line) {
    return { url: '', user: '', pass: '', identityType: 'unknown' };
  }

  // 1. URL with protocol (http://, https://, ftp://, android://) or www.
  // When a line starts with a protocol, URL is ALWAYS the first field!
  const protoMatch = line.match(/^(?:([a-zA-Z0-9+.-]+:\/\/)|(www\.))/i);
  if (protoMatch) {
    const proto = protoMatch[0];
    const afterProto = line.substring(proto.length);

    const slashIdx = afterProto.indexOf('/');
    let url = '';
    let rest = '';

    if (slashIdx !== -1) {
      // Find the first colon AFTER the slash: URL ends at that colon
      const colonAfterSlash = afterProto.indexOf(':', slashIdx);
      if (colonAfterSlash !== -1) {
        url = proto + afterProto.substring(0, colonAfterSlash);
        rest = afterProto.substring(colonAfterSlash + 1);
      } else {
        url = line;
        rest = '';
      }
    } else {
      // No slash in afterProto: check for port (host:port:user:pass)
      const portColonMatch = afterProto.match(/^([^\/:\s]+):(\d{1,5}):/);
      if (portColonMatch && afterProto.substring(portColonMatch[0].length).includes(':')) {
        url = proto + portColonMatch[1] + ':' + portColonMatch[2];
        rest = afterProto.substring(portColonMatch[0].length);
      } else {
        const firstColon = afterProto.indexOf(':');
        if (firstColon !== -1) {
          url = proto + afterProto.substring(0, firstColon);
          rest = afterProto.substring(firstColon + 1);
        } else {
          url = line;
          rest = '';
        }
      }
    }

    if (rest) {
      // In rest: first colon separates USER from PASS
      const nextColon = rest.indexOf(':');
      if (nextColon !== -1) {
        const u = rest.substring(0, nextColon);
        const p = rest.substring(nextColon + 1);
        return {
          url,
          user: u,
          pass: cleanPassword(p),
          identityType: classifyIdentity(u)
        };
      } else {
        return {
          url,
          user: rest,
          pass: '',
          identityType: classifyIdentity(rest)
        };
      }
    } else {
      return {
        url,
        user: '',
        pass: '',
        identityType: 'unknown'
      };
    }
  }

  // 2. Domain-based URL without protocol (e.g. login.site.com/path:user:pass or site.com:user:pass)
  const domainMatch = line.match(/^([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?::\d{1,5})?)(\/[^:]*)?:/);
  if (domainMatch) {
    const url = domainMatch[1] + (domainMatch[2] || '');
    const rest = line.substring(domainMatch[0].length);
    const nextColon = rest.indexOf(':');
    if (nextColon !== -1) {
      const u = rest.substring(0, nextColon);
      const p = rest.substring(nextColon + 1);
      return {
        url,
        user: u,
        pass: cleanPassword(p),
        identityType: classifyIdentity(u)
      };
    } else {
      return {
        url,
        user: rest,
        pass: '',
        identityType: classifyIdentity(rest)
      };
    }
  }

  // 3. Pipe or Semicolon delimited if no colons
  if (!line.includes(':')) {
    if (line.includes('|')) {
      const parts = line.split('|').map(p => p.trim());
      if (parts.length >= 3) {
        return { url: parts[0], user: parts[1], pass: cleanPassword(parts.slice(2).join('|')), identityType: classifyIdentity(parts[1]) };
      } else if (parts.length === 2) {
        return { url: '', user: parts[0], pass: cleanPassword(parts[1]), identityType: classifyIdentity(parts[0]) };
      }
    }
    if (line.includes(';')) {
      const parts = line.split(';').map(p => p.trim());
      if (parts.length >= 3) {
        return { url: parts[0], user: parts[1], pass: cleanPassword(parts.slice(2).join(';')), identityType: classifyIdentity(parts[1]) };
      } else if (parts.length === 2) {
        return { url: '', user: parts[0], pass: cleanPassword(parts[1]), identityType: classifyIdentity(parts[0]) };
      }
    }
  }

  // 4. Standard colon split (e.g. user:pass or user:pass:with:colons or email:pass)
  const firstColon = line.indexOf(':');
  if (firstColon === -1) {
    return { url: line, user: '', pass: '', identityType: 'unknown' };
  }

  const firstPart = line.substring(0, firstColon);
  const remaining = line.substring(firstColon + 1);

  // If firstPart contains path slash / or dot (and not an email in firstPart)
  if (!firstPart.includes('@') && (firstPart.includes('/') || (firstPart.includes('.') && !/^\d+$/.test(firstPart.replace(/\./g, ''))))) {
    const secondColon = remaining.indexOf(':');
    if (secondColon !== -1) {
      const u = remaining.substring(0, secondColon);
      const p = remaining.substring(secondColon + 1);
      return {
        url: firstPart,
        user: u,
        pass: cleanPassword(p),
        identityType: classifyIdentity(u)
      };
    } else {
      return {
        url: firstPart,
        user: remaining,
        pass: '',
        identityType: classifyIdentity(remaining)
      };
    }
  }

  // Otherwise: firstPart is user (e.g. user:pass, email:pass, number:pass)
  return {
    url: '',
    user: firstPart,
    pass: cleanPassword(remaining),
    identityType: classifyIdentity(firstPart)
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
        // Match query anywhere in the URL segment
        searchQuery = `^(?:[a-zA-Z0-9+.-]+:\\/\\/)?[^:\r\n]*${pattern}[^:\r\n]*:`;
        break;
      case 'username':
        // Match query in username/email/number field (handles url:user:pass, user:pass, http://)
        searchQuery = `(?:^|:)[^:\r\n]*${pattern}[^:\r\n]*:`;
        break;
      case 'password':
        // Match query in password field
        searchQuery = `:[^:\r\n]*${pattern}`;
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

// ─── Domain Extraction & Analytics ─────────────────────────

const TWO_PART_TLDS = new Set([
  'co', 'com', 'org', 'net', 'gov', 'edu', 'mil', 'ac', 'nom', 'biz', 'info'
]);

/**
 * Fast domain extraction from a log line
 */
function extractDomain(line) {
  if (!line) return null;
  let str = line.trim();
  const protoIdx = str.indexOf('://');
  if (protoIdx !== -1) {
    str = str.substring(protoIdx + 3);
  }

  let host = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '/' || ch === ':' || ch === ' ' || ch === '\t' || ch === '|') {
      host = str.substring(0, i);
      break;
    }
  }
  if (!host) {
    const colonIdx = str.indexOf(':');
    host = colonIdx !== -1 ? str.substring(0, colonIdx) : str;
  }

  host = host.toLowerCase().trim();
  if (host.startsWith('www.')) {
    host = host.substring(4);
  }

  const pIdx = host.indexOf(':');
  if (pIdx !== -1) {
    host = host.substring(0, pIdx);
  }

  if (host.includes('@')) {
    const atIdx = host.lastIndexOf('@');
    host = host.substring(atIdx + 1);
  }

  // IPv4 support
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return host;
  }

  // Standard domain check
  if (host.includes('.') && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
    return host;
  }
  return null;
}

/**
 * Convert full hostname to root domain e.g. accounts.google.com -> google.com
 */
function getRootDomain(hostname) {
  if (!hostname) return null;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return hostname;
  }
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  const secondLast = parts[parts.length - 2];
  const last = parts[parts.length - 1];
  if (parts.length >= 3 && TWO_PART_TLDS.has(secondLast) && last.length === 2) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

// ─── API: Domain Analytics (streaming) ─────────────────────

app.post('/api/analytics/domains', async (req, res) => {
  const { files = [], groupMode = 'root', analyticsId = null } = req.body;

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'No files selected for analytics' });
  }

  const filePaths = [];
  let totalBytes = 0;
  for (const f of files) {
    const p = resolveLogPath(f);
    if (!p || !fs.existsSync(p)) {
      return res.status(400).json({ error: `Invalid or missing file: ${f}` });
    }
    const stat = fs.statSync(p);
    totalBytes += stat.size;
    filePaths.push({ name: f, path: p, size: stat.size });
  }

  // Abort previous run with same ID
  if (analyticsId && activeAnalytics.has(analyticsId)) {
    const prev = activeAnalytics.get(analyticsId);
    if (prev && prev.abort) prev.abort();
    activeAnalytics.delete(analyticsId);
  }

  let aborted = false;
  const controller = {
    abort: () => { aborted = true; }
  };
  if (analyticsId) {
    activeAnalytics.set(analyticsId, controller);
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const domainMap = new Map();
  let totalLines = 0;
  let processedBytes = 0;
  const startTime = Date.now();
  let lastProgressTime = Date.now();

  try {
    for (const f of filePaths) {
      if (aborted) break;

      const fileStream = fs.createReadStream(f.path);
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (aborted) {
          rl.close();
          fileStream.destroy();
          break;
        }

        totalLines++;
        if (line) {
          const host = extractDomain(line);
          if (host) {
            const key = groupMode === 'root' ? getRootDomain(host) : host;
            if (key) {
              domainMap.set(key, (domainMap.get(key) || 0) + 1);
            }
          }
        }

        const now = Date.now();
        if (now - lastProgressTime > 400) {
          lastProgressTime = now;
          if (!res.writableEnded) {
            res.write(JSON.stringify({
              type: 'progress',
              currentFile: f.name,
              totalLines,
              uniqueDomains: domainMap.size,
              elapsed: ((now - startTime) / 1000).toFixed(1) + 's'
            }) + '\n');
          }
        }
      }

      processedBytes += f.size;
    }

    if (analyticsId) activeAnalytics.delete(analyticsId);

    if (aborted) {
      if (!res.writableEnded) {
        res.write(JSON.stringify({ type: 'aborted', message: 'Analysis cancelled' }) + '\n');
        res.end();
      }
      return;
    }

    // Sort domains from largest to smallest count
    const sortedDomains = Array.from(domainMap.entries())
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    if (!res.writableEnded) {
      res.write(JSON.stringify({
        type: 'complete',
        totalLines,
        uniqueDomains: sortedDomains.length,
        elapsed: elapsed + 's',
        domains: sortedDomains
      }) + '\n');
      res.end();
    }
  } catch (err) {
    if (analyticsId) activeAnalytics.delete(analyticsId);
    if (!res.writableEnded) {
      res.write(JSON.stringify({ type: 'error', message: err.message }) + '\n');
      res.end();
    }
  }
});

app.post('/api/analytics/abort', (req, res) => {
  const { analyticsId } = req.body;
  if (analyticsId && activeAnalytics.has(analyticsId)) {
    const controller = activeAnalytics.get(analyticsId);
    if (controller && controller.abort) controller.abort();
    activeAnalytics.delete(analyticsId);
    return res.json({ success: true, message: 'Analysis aborted' });
  }
  res.json({ success: false, message: 'No active analysis found' });
});

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
