const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');

const TWO_PART_TLDS = new Set([
  'co', 'com', 'org', 'net', 'gov', 'edu', 'mil', 'ac', 'nom', 'biz', 'info'
]);

/**
 * Fast domain extraction directly from raw byte buffer slice
 */
function extractDomainFromBytes(buf, start, end) {
  // Trim leading whitespace & control chars
  while (start < end) {
    const c = buf[start];
    if (c === 32 || c === 9 || c === 13 || c === 10) start++;
    else break;
  }
  // Trim trailing whitespace & control chars
  while (end > start) {
    const c = buf[end - 1];
    if (c === 32 || c === 9 || c === 13 || c === 10) end--;
    else break;
  }
  if (start >= end) return null;

  // Check for protocol :// (e.g. http://, https://, android://)
  let p = start;
  for (; p < end - 2; p++) {
    if (buf[p] === 58 && buf[p + 1] === 47 && buf[p + 2] === 47) { // ://
      start = p + 3;
      break;
    }
    // Limit protocol search to first 20 chars
    if (p - start > 20 || buf[p] === 47 || buf[p] === 32) break;
  }

  // Find host end: first occurrence of '/', ':', ' ', '\t', '|'
  let hostEnd = start;
  for (; hostEnd < end; hostEnd++) {
    const c = buf[hostEnd];
    if (c === 47 || c === 58 || c === 32 || c === 9 || c === 124) {
      break;
    }
  }

  if (hostEnd <= start) return null;

  // Convert host slice to string
  let host = buf.toString('utf8', start, hostEnd).toLowerCase().trim();
  if (host.startsWith('www.')) {
    host = host.substring(4);
  }

  // Remove port if present (e.g. host:8080)
  const portIdx = host.indexOf(':');
  if (portIdx !== -1) {
    host = host.substring(0, portIdx);
  }

  // Remove HTTP auth username if present (e.g. user@host.com)
  if (host.includes('@')) {
    host = host.substring(host.lastIndexOf('@') + 1);
  }

  // IPv4 support
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return host;
  }

  // Standard domain check (contains dot and valid chars with at least 2 char TLD)
  if (host.includes('.') && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
    return host;
  }

  return null;
}

let isAborted = false;
if (parentPort) {
  parentPort.on('message', (msg) => {
    if (msg && msg.type === 'abort') {
      isAborted = true;
    }
  });
}

function run() {
  const { filePath, start, end, workerId } = workerData;
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(4 * 1024 * 1024); // 4MB read buffer
  let pos = start;
  let remainder = Buffer.alloc(0);
  const domainMap = new Map();
  let lines = 0;
  let lastProgressReport = Date.now();
  let lastReportedLines = 0;

  try {
    while (pos < end && !isAborted) {
      const toRead = Math.min(buf.length, end - pos);
      const read = fs.readSync(fd, buf, 0, toRead, pos);
      if (read === 0) break;
      pos += read;

      let chunk = buf.subarray(0, read);
      if (remainder.length > 0) {
        chunk = Buffer.concat([remainder, chunk]);
        remainder = Buffer.alloc(0);
      }

      let lineStart = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 10) { // \n
          lines++;
          let lineEnd = (i > 0 && chunk[i - 1] === 13) ? i - 1 : i;
          const d = extractDomainFromBytes(chunk, lineStart, lineEnd);
          if (d) {
            domainMap.set(d, (domainMap.get(d) || 0) + 1);
          }
          lineStart = i + 1;
        }
      }

      if (lineStart < chunk.length) {
        remainder = Buffer.from(chunk.subarray(lineStart));
      }

      const now = Date.now();
      if (now - lastProgressReport > 250) {
        const deltaLines = lines - lastReportedLines;
        lastReportedLines = lines;
        lastProgressReport = now;
        if (parentPort) {
          parentPort.postMessage({
            type: 'progress',
            workerId,
            bytesProcessed: pos - start,
            deltaLines
          });
        }
      }
    }

    // Process last line if at EOF and no trailing newline
    if (!isAborted && remainder.length > 0) {
      lines++;
      const d = extractDomainFromBytes(remainder, 0, remainder.length);
      if (d) {
        domainMap.set(d, (domainMap.get(d) || 0) + 1);
      }
    }
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }

  if (parentPort) {
    if (isAborted) {
      parentPort.postMessage({ type: 'aborted', workerId });
    } else {
      parentPort.postMessage({
        type: 'done',
        workerId,
        lines,
        domains: Array.from(domainMap.entries())
      });
    }
  }
}

run();
