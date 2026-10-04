/**
 * Virtual scroll renderer for search results
 * Supports RAW, Email:pass, Username:pass, Phone:pass display modes
 * Individual click-to-copy for email, username, phone, password, and combos
 * Persistent memory tracking for already-clicked credentials
 */

const ResultsRenderer = (() => {
  const ROW_HEIGHT = 42; // px per row (must match CSS)
  const BUFFER_ROWS = 15; // Extra rows above/below viewport

  let scrollContainer = null;
  let viewport = null;
  let allResults = [];
  let filteredResults = [];
  let visibleNodes = new Map(); // index -> DOM node
  let multiFileMode = false;
  let currentViewMode = 'raw'; // 'raw' | 'email' | 'username' | 'phone'
  let activeDropdown = null;
  let activeDropdownIndex = null;
  let fileMatchCounts = {};
  let activeFileFilter = null;
  let isDedupeActive = false;
  let streamingDedupeSeen = new Set();

  // Counts for each mode
  let counts = { raw: 0, email: 0, username: 0, phone: 0 };

  /**
   * Normalize deduplication key from URL, User (email/username/number), and Password
   */
  function normalizeDedupeKey(r) {
    if (!r) return '';
    const url = (r.url || '').trim().toLowerCase().replace(/\/+$/, '');
    let user = (r.user || '').trim();
    const pass = (r.pass || '').trim();

    if (r.identityType === 'email' || user.includes('@')) {
      user = user.toLowerCase();
    } else if (r.identityType === 'phone') {
      user = user.replace(/[+\s\-\.\(\)\/]/g, '');
    } else {
      user = user.toLowerCase();
    }

    if (url || user || pass) {
      return `${url}\x1f${user}\x1f${pass}`;
    }

    // Fallback if no structured fields were parsed
    return (r.content || '').trim();
  }

  /**
   * Close any open RAW dropdown
   */
  function closeRawDropdown() {
    if (activeDropdown) {
      if (activeDropdown.parentElement) {
        const eye = activeDropdown.parentElement.querySelector('.btn-eye-preview');
        if (eye) eye.classList.remove('is-open');
      }
      activeDropdown.remove();
      activeDropdown = null;
      activeDropdownIndex = null;
    }
  }

  /**
   * Initialize renderer with DOM elements
   */
  function init(scrollEl, viewportEl) {
    scrollContainer = scrollEl;
    viewport = viewportEl;
    removeTabCountBadges();

    scrollContainer.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });

    // Close dropdown on click outside
    document.addEventListener('click', (e) => {
      if (activeDropdown && !activeDropdown.contains(e.target) && !e.target.closest('.btn-eye-preview')) {
        closeRawDropdown();
      }
    });

    // Listen to memory updates to refresh visual indicators
    if (typeof CopiedMemory !== 'undefined') {
      CopiedMemory.onChange(() => {
        updateMemoryBadge();
        renderVisible();
      });
      updateMemoryBadge();
    }
  }

  /**
   * Set multi-file mode
   */
  function setMultiFileMode(isMultiFile) {
    multiFileMode = isMultiFile;
  }

  /**
   * Switch the active view mode (RAW / Email:pass / User:pass / Phone:pass)
   */
  function setViewMode(mode) {
    if (currentViewMode === mode) return;
    currentViewMode = mode;
    applyFilter();
  }

  function getViewMode() {
    return currentViewMode;
  }

  /**
   * Filter allResults into filteredResults based on currentViewMode
   */
  function applyFilter() {
    let base = allResults;
    if (activeFileFilter) {
      base = base.filter(r => r.file === activeFileFilter);
    }

    if (currentViewMode === 'raw') {
      filteredResults = base;
    } else if (currentViewMode === 'email') {
      filteredResults = base.filter(r => r.identityType === 'email');
    } else if (currentViewMode === 'username') {
      filteredResults = base.filter(r => r.identityType === 'username');
    } else if (currentViewMode === 'phone') {
      filteredResults = base.filter(r => r.identityType === 'phone');
    } else {
      filteredResults = base;
    }

    streamingDedupeSeen.clear();
    if (isDedupeActive && filteredResults.length > 0) {
      filteredResults = filteredResults.filter(r => {
        const key = normalizeDedupeKey(r);
        if (streamingDedupeSeen.has(key)) return false;
        streamingDedupeSeen.add(key);
        return true;
      });
    }

    // Clear existing nodes and any open dropdown
    closeRawDropdown();
    visibleNodes.forEach(node => node.remove());
    visibleNodes.clear();

    // Set viewport height
    viewport.style.height = (filteredResults.length * ROW_HEIGHT) + 'px';
    scrollContainer.scrollTop = 0;

    renderVisible();
  }

  /**
   * Strip promotional watermarks, telegram tags, tabs, and metadata from password
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
    if (cleaned.includes('\t')) {
      cleaned = cleaned.split('\t')[0].trim();
    }
    cleaned = cleaned.replace(/\s*\|\s*(?:life|@|t\.me|cloud|vip|priv|fresh|owner|channel|telegram|\$|\d).*$/i, '');
    cleaned = cleaned.replace(/\s*[➔➜➞➝➢➣➤⇻]\s*.*$/, '');
    cleaned = cleaned.replace(/[\t\s]+(?:->|=>)\s+.*$/, '');
    cleaned = cleaned.replace(/[\t\s]+t\.me\/[a-zA-Z0-9_\-\.\/]+.*$/i, '');
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

    // 2. Number / Phone check (pure numbers or formatted numbers/IDs/phones)
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

  /**
   * Set the results data and render
   */
  function setResults(data, isMultiFile) {
    allResults = data || [];
    multiFileMode = isMultiFile;
    fileMatchCounts = {};

    // Re-parse and recalculate counts
    counts = { raw: allResults.length, email: 0, username: 0, phone: 0 };
    for (const r of allResults) {
      if (r.file) {
        fileMatchCounts[r.file] = (fileMatchCounts[r.file] || 0) + 1;
      }
      if (r.content) {
        const parsed = parseLogLine(r.content);
        r.url = parsed.url;
        r.user = parsed.user;
        r.pass = parsed.pass;
        r.identityType = parsed.identityType;
      } else if (r.pass) {
        r.pass = cleanPassword(r.pass);
      }
      if (r.identityType === 'email') counts.email++;
      else if (r.identityType === 'username') counts.username++;
      else if (r.identityType === 'phone') counts.phone++;
    }
    updateTabCounts();
    applyFilter();
  }

  /**
   * Append results incrementally during streaming
   */
  function appendResult(result) {
    if (result.file) {
      fileMatchCounts[result.file] = (fileMatchCounts[result.file] || 0) + 1;
    }
    if (result.content) {
      const parsed = parseLogLine(result.content);
      result.url = parsed.url;
      result.user = parsed.user;
      result.pass = parsed.pass;
      result.identityType = parsed.identityType;
    } else if (result.pass) {
      result.pass = cleanPassword(result.pass);
    }
    allResults.push(result);
    counts.raw++;
    if (result.identityType === 'email') counts.email++;
    else if (result.identityType === 'username') counts.username++;
    else if (result.identityType === 'phone') counts.phone++;

    updateTabCounts();

    // Check if result matches current filter
    let matchesCurrent = true;
    if (activeFileFilter && result.file !== activeFileFilter) matchesCurrent = false;
    else if (currentViewMode === 'email' && result.identityType !== 'email') matchesCurrent = false;
    else if (currentViewMode === 'username' && result.identityType !== 'username') matchesCurrent = false;
    else if (currentViewMode === 'phone' && result.identityType !== 'phone') matchesCurrent = false;

    if (matchesCurrent) {
      if (isDedupeActive) {
        const dedupeKey = normalizeDedupeKey(result);
        if (streamingDedupeSeen.has(dedupeKey)) {
          return;
        }
        streamingDedupeSeen.add(dedupeKey);
      }
      filteredResults.push(result);
      const newLen = filteredResults.length;
      viewport.style.height = (newLen * ROW_HEIGHT) + 'px';

      const scrollTop = scrollContainer.scrollTop;
      const containerHeight = scrollContainer.clientHeight || window.innerHeight;
      const itemTop = (newLen - 1) * ROW_HEIGHT;

      if (itemTop <= scrollTop + containerHeight + BUFFER_ROWS * ROW_HEIGHT) {
        renderRow(newLen - 1);
      }
    }
  }

  /**
   * Clear all results
   */
  function clear() {
    closeRawDropdown();
    allResults = [];
    filteredResults = [];
    fileMatchCounts = {};
    activeFileFilter = null;
    streamingDedupeSeen.clear();
    counts = { raw: 0, email: 0, username: 0, phone: 0 };
    visibleNodes.forEach(node => node.remove());
    visibleNodes.clear();
    viewport.style.height = '0px';
    updateTabCounts();
  }

  /**
   * Get all results
   */
  function getResults() {
    return allResults;
  }

  function getFilteredResults() {
    return filteredResults;
  }

  function getCounts() {
    return counts;
  }

  /**
   * Mode tabs no longer display individual counts.
   * Strip any stale badge elements from DOM if present (e.g. from cached HTML).
   */
  function removeTabCountBadges() {
    document.querySelectorAll('.mode-tab-count, #countRaw, #countEmail, #countUser, #countPhone').forEach(el => el.remove());
  }

  function updateTabCounts() {
    removeTabCountBadges();
  }

  /**
   * Update memory count badge
   */
  function updateMemoryBadge() {
    const memEl = document.getElementById('memoryCount');
    if (!memEl || typeof CopiedMemory === 'undefined') return;
    const n = CopiedMemory.count();
    memEl.textContent = `${n} copied`;
  }

  /**
   * Scroll handler — renders/removes rows as needed
   */
  function onScroll() {
    requestAnimationFrame(renderVisible);
  }

  /**
   * Calculate visible range and render/cleanup rows
   */
  function renderVisible() {
    if (!scrollContainer || filteredResults.length === 0) return;

    const scrollTop = scrollContainer.scrollTop;
    const containerHeight = scrollContainer.clientHeight || window.innerHeight;

    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
    const endIdx = Math.min(
      filteredResults.length - 1,
      Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + BUFFER_ROWS
    );

    // If active dropdown is outside visible range, close it
    if (activeDropdownIndex !== null && (activeDropdownIndex < startIdx || activeDropdownIndex > endIdx)) {
      closeRawDropdown();
    }

    // Remove nodes outside visible range
    visibleNodes.forEach((node, idx) => {
      if (idx < startIdx || idx > endIdx) {
        node.remove();
        visibleNodes.delete(idx);
      }
    });

    // Add nodes within visible range
    for (let i = startIdx; i <= endIdx; i++) {
      if (!visibleNodes.has(i)) {
        renderRow(i);
      }
    }
  }

  /**
   * Render a single row (either RAW or structured)
   */
  function renderRow(index) {
    const result = filteredResults[index];
    if (!result) return;

    if (currentViewMode === 'raw') {
      renderRawRow(index, result);
    } else {
      renderCredRow(index, result);
    }
  }

  /**
   * Render RAW full line row (no line numbers)
   */
  function renderRawRow(index, result) {
    const row = document.createElement('div');
    row.className = 'result-row';
    row.style.top = (index * ROW_HEIGHT) + 'px';
    row.style.height = ROW_HEIGHT + 'px';
    row.dataset.index = index;

    // Check if line is already copied in memory
    const isCopied = typeof CopiedMemory !== 'undefined' && CopiedMemory.has(result.content);
    if (isCopied) row.classList.add('is-copied');

    // Multi-file tag if applicable
    if (multiFileMode && result.file) {
      const fileTag = document.createElement('span');
      fileTag.className = 'result-file-tag';
      fileTag.textContent = result.file;
      row.appendChild(fileTag);
    }

    // Content column (starts directly from the left)
    const content = document.createElement('div');
    content.className = 'result-content';

    if (result.submatches && result.submatches.length > 0) {
      content.innerHTML = highlightMatches(result.content, result.submatches);
    } else {
      content.textContent = result.content;
    }

    row.appendChild(content);

    // Quick copy action buttons on hover if user/pass is parsed
    if (result.user || result.pass) {
      const actions = document.createElement('div');
      actions.className = 'raw-actions';

      if (result.user) {
        const uBtn = document.createElement('button');
        uBtn.className = 'btn-raw-copy';
        const isUCopied = typeof CopiedMemory !== 'undefined' && CopiedMemory.has(result.user);
        if (isUCopied) uBtn.classList.add('is-copied');
        let iconSvg = '';
        if (result.identityType === 'email') {
          iconSvg = '<svg class="cred-icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" stroke="currentColor" stroke-width="2"/><polyline points="22,6 12,13 2,6" stroke="currentColor" stroke-width="2"/></svg>';
        } else if (result.identityType === 'phone') {
          iconSvg = '<svg class="cred-icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="5" y="2" width="14" height="20" rx="2" stroke="currentColor" stroke-width="2"/><line x1="12" y1="18" x2="12.01" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
        } else {
          iconSvg = '<svg class="cred-icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="2"/></svg>';
        }
        uBtn.innerHTML = `<span class="cred-icon-wrap">${iconSvg}</span> <span>${isUCopied ? '✓' : 'User'}</span>`;
        uBtn.title = `Copy ${result.identityType || 'user'} only: ${result.user}`;
        uBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          copyToClipboard(result.user, result.identityType || 'username');
          if (typeof CopiedMemory !== 'undefined') CopiedMemory.add(result.user);
          uBtn.classList.add('is-copied');
          const lastSpan = uBtn.querySelector('span:last-child');
          if (lastSpan) lastSpan.textContent = '✓';
        });
        actions.appendChild(uBtn);
      }

      if (result.pass) {
        const pBtn = document.createElement('button');
        pBtn.className = 'btn-raw-copy';
        const isPCopied = typeof CopiedMemory !== 'undefined' && CopiedMemory.has(result.pass);
        if (isPCopied) pBtn.classList.add('is-copied');
        const passSvg = '<svg class="cred-icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" stroke-width="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" stroke-width="2"/></svg>';
        pBtn.innerHTML = `<span class="cred-icon-wrap">${passSvg}</span> <span>${isPCopied ? '✓' : 'Pass'}</span>`;
        pBtn.title = 'Copy password only';
        pBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          copyToClipboard(result.pass, 'password');
          if (typeof CopiedMemory !== 'undefined') CopiedMemory.add(result.pass);
          pBtn.classList.add('is-copied');
          const lastSpan = pBtn.querySelector('span:last-child');
          if (lastSpan) lastSpan.textContent = '✓';
        });
        actions.appendChild(pBtn);
      }

      row.appendChild(actions);
    }

    row.title = isCopied ? 'Copied — Click to copy again' : 'Click to copy full line';

    // Click to copy full line
    row.addEventListener('click', () => {
      copyToClipboard(result.content, 'line');
      if (typeof CopiedMemory !== 'undefined') {
        CopiedMemory.add(result.content);
        if (result.user) CopiedMemory.add(result.user);
        if (result.pass) CopiedMemory.add(result.pass);
      }
      row.classList.add('is-copied');
    });

    viewport.appendChild(row);
    visibleNodes.set(index, row);
  }

  /**
   * Render structured credential row (Email:pass, User:pass, Phone:pass)
   * with individual click-to-copy for identity and password,
   * plus an Eye button that toggles full RAW line in a dropdown
   */
  function renderCredRow(index, result) {
    const row = document.createElement('div');
    row.className = 'cred-row';
    row.style.top = (index * ROW_HEIGHT) + 'px';
    row.style.height = ROW_HEIGHT + 'px';
    row.dataset.index = index;

    // Multi-file tag if applicable
    if (multiFileMode && result.file) {
      const fileTag = document.createElement('span');
      fileTag.className = 'result-file-tag';
      fileTag.textContent = result.file;
      row.appendChild(fileTag);
    }

    // Pills wrapper
    const pillsWrapper = document.createElement('div');
    pillsWrapper.className = 'cred-pills';

    // Identity pill (Email / Username / Phone)
    const identityPill = document.createElement('button');
    identityPill.className = 'cred-pill cred-pill-user';
    const isUserCopied = typeof CopiedMemory !== 'undefined' && CopiedMemory.has(result.user);
    if (isUserCopied) identityPill.classList.add('is-copied');

    let iconSvg = '';
    let typeName = 'username';
    if (result.identityType === 'email') {
      iconSvg = '<svg class="cred-icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" stroke="currentColor" stroke-width="2"/><polyline points="22,6 12,13 2,6" stroke="currentColor" stroke-width="2"/></svg>';
      typeName = 'email';
    } else if (result.identityType === 'phone') {
      iconSvg = '<svg class="cred-icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="5" y="2" width="14" height="20" rx="2" stroke="currentColor" stroke-width="2"/><line x1="12" y1="18" x2="12.01" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      typeName = 'phone';
    } else {
      iconSvg = '<svg class="cred-icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="2"/></svg>';
    }

    identityPill.innerHTML = `<span class="cred-icon-wrap">${iconSvg}</span> <span class="cred-text">${escapeHtml(result.user || '—')}</span>`;
    identityPill.title = `Click to copy ${typeName}: ${result.user || '—'}`;

    // Click on identity -> copies identity only
    identityPill.addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(result.user, typeName);
      if (typeof CopiedMemory !== 'undefined') {
        CopiedMemory.add(result.user);
      }
      identityPill.classList.add('is-copied');
    });

    // Colon separator
    const sep = document.createElement('span');
    sep.className = 'cred-sep';
    sep.textContent = ':';

    // Password pill
    const passPill = document.createElement('button');
    passPill.className = 'cred-pill cred-pill-pass';
    const isPassCopied = typeof CopiedMemory !== 'undefined' && CopiedMemory.has(result.pass);
    if (isPassCopied) passPill.classList.add('is-copied');

    const passIconSvg = '<svg class="cred-icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" stroke-width="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" stroke-width="2"/></svg>';
    passPill.innerHTML = `<span class="cred-icon-wrap">${passIconSvg}</span> <span class="cred-text">${escapeHtml(result.pass || '—')}</span>`;
    passPill.title = `Click to copy password: ${result.pass || '—'}`;

    // Click on pass -> copies password only
    passPill.addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(result.pass, 'password');
      if (typeof CopiedMemory !== 'undefined') {
        CopiedMemory.add(result.pass);
      }
      passPill.classList.add('is-copied');
    });

    pillsWrapper.appendChild(identityPill);
    pillsWrapper.appendChild(sep);
    pillsWrapper.appendChild(passPill);

    // Actions on right (Eye button to view raw line in dropdown + optional URL tag)
    const actions = document.createElement('div');
    actions.className = 'cred-actions';

    // Eye button — toggles full raw line dropdown
    const eyeBtn = document.createElement('button');
    eyeBtn.className = 'btn-eye-preview';
    eyeBtn.type = 'button';
    eyeBtn.title = 'View full RAW line (dropdown)';
    eyeBtn.setAttribute('aria-label', 'View full RAW line');
    eyeBtn.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/>
      </svg>
    `;

    if (activeDropdownIndex === index) {
      eyeBtn.classList.add('is-open');
    }

    eyeBtn.addEventListener('click', (e) => {
      e.stopPropagation();

      if (activeDropdownIndex === index) {
        closeRawDropdown();
        return;
      }

      closeRawDropdown();

      const dropdown = document.createElement('div');
      dropdown.className = 'raw-dropdown';
      dropdown.addEventListener('click', (ev) => ev.stopPropagation());

      if (result.file) {
        const header = document.createElement('div');
        header.className = 'raw-dropdown-header';
        header.innerHTML = `<span class="raw-dropdown-file">${escapeHtml(result.file)}</span>`;
        dropdown.appendChild(header);
      }

      const body = document.createElement('div');
      body.className = 'raw-dropdown-body';
      body.textContent = result.content;

      dropdown.appendChild(body);

      row.appendChild(dropdown);
      eyeBtn.classList.add('is-open');

      activeDropdown = dropdown;
      activeDropdownIndex = index;
    });

    actions.appendChild(eyeBtn);

    // URL tag if available
    if (result.url) {
      const urlTag = document.createElement('span');
      urlTag.className = 'cred-url-tag';
      urlTag.textContent = result.url;
      urlTag.title = `Source URL: ${result.url} (click to copy URL)`;
      urlTag.addEventListener('click', (e) => {
        e.stopPropagation();
        copyToClipboard(result.url, 'url');
        if (typeof CopiedMemory !== 'undefined') {
          CopiedMemory.add(result.url);
        }
      });
      actions.appendChild(urlTag);
    }

    row.appendChild(pillsWrapper);
    row.appendChild(actions);

    viewport.appendChild(row);
    visibleNodes.set(index, row);
  }

  /**
   * Highlight matched substrings
   */
  function highlightMatches(text, submatches) {
    if (!submatches || submatches.length === 0) return escapeHtml(text);

    const sorted = [...submatches].sort((a, b) => a.start - b.start);
    let html = '';
    let lastEnd = 0;

    for (const sm of sorted) {
      if (sm.start > lastEnd) {
        html += escapeHtml(text.substring(lastEnd, sm.start));
      }
      html += '<mark>' + escapeHtml(text.substring(sm.start, sm.end)) + '</mark>';
      lastEnd = sm.end;
    }

    if (lastEnd < text.length) {
      html += escapeHtml(text.substring(lastEnd));
    }

    return html;
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Copy text to clipboard with targeted toast feedback
   */
  function copyToClipboard(text, type = 'text') {
    if (!text) return;

    let toastMsg = 'Copied to clipboard';
    if (type === 'email') toastMsg = `Copied email: ${text}`;
    else if (type === 'username') toastMsg = `Copied username: ${text}`;
    else if (type === 'phone') toastMsg = `Copied phone: ${text}`;
    else if (type === 'password') toastMsg = 'Copied password';
    else if (type === 'combo') toastMsg = `Copied combo: ${text.substring(0, 30)}…`;
    else if (type === 'url') toastMsg = `Copied URL: ${text.substring(0, 35)}…`;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        showToast(toastMsg, 'success');
      }).catch(() => fallbackCopy(text, toastMsg));
    } else {
      fallbackCopy(text, toastMsg);
    }
  }

  function fallbackCopy(text, toastMsg) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      showToast(toastMsg, 'success');
    } catch (_) {
      showToast('Could not copy', 'error');
    }
    document.body.removeChild(ta);
  }

  return {
    init,
    setResults,
    appendResult,
    clear,
    getResults,
    getFilteredResults,
    getCounts,
    renderVisible,
    setMultiFileMode,
    setViewMode,
    getViewMode,
    updateMemoryBadge,
    closeDropdown: closeRawDropdown,
    isDropdownOpen: () => activeDropdown !== null,
    getFileCounts: () => ({ ...fileMatchCounts }),
    getActiveFileFilter: () => activeFileFilter,
    setActiveFileFilter: (fileName) => {
      activeFileFilter = fileName;
      applyFilter();
    },
    setDedupeMode: (enabled) => {
      isDedupeActive = Boolean(enabled);
      applyFilter();
    },
    getDedupeMode: () => isDedupeActive,
    toggleDedupeMode: () => {
      isDedupeActive = !isDedupeActive;
      applyFilter();
      return isDedupeActive;
    }
  };
})();
