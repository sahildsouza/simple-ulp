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

  // Counts for each mode
  let counts = { raw: 0, email: 0, username: 0, phone: 0 };

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
    if (currentViewMode === 'raw') {
      filteredResults = allResults;
    } else if (currentViewMode === 'email') {
      filteredResults = allResults.filter(r => r.identityType === 'email');
    } else if (currentViewMode === 'username') {
      filteredResults = allResults.filter(r => r.identityType === 'username');
    } else if (currentViewMode === 'phone') {
      filteredResults = allResults.filter(r => r.identityType === 'phone');
    } else {
      filteredResults = allResults;
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
   * Set the results data and render
   */
  function setResults(data, isMultiFile) {
    allResults = data || [];
    multiFileMode = isMultiFile;

    // Recalculate counts
    counts = { raw: allResults.length, email: 0, username: 0, phone: 0 };
    for (const r of allResults) {
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
    allResults.push(result);
    counts.raw++;
    if (result.identityType === 'email') counts.email++;
    else if (result.identityType === 'username') counts.username++;
    else if (result.identityType === 'phone') counts.phone++;

    updateTabCounts();

    // Check if result matches current filter
    let matchesCurrent = false;
    if (currentViewMode === 'raw') matchesCurrent = true;
    else if (currentViewMode === 'email' && result.identityType === 'email') matchesCurrent = true;
    else if (currentViewMode === 'username' && result.identityType === 'username') matchesCurrent = true;
    else if (currentViewMode === 'phone' && result.identityType === 'phone') matchesCurrent = true;

    if (matchesCurrent) {
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
        const icon = result.identityType === 'email' ? '✉' : (result.identityType === 'phone' ? '📱' : '👤');
        uBtn.innerHTML = `<span>${icon}</span> <span>${isUCopied ? '✓' : 'User'}</span>`;
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
        pBtn.innerHTML = `<span>🔑</span> <span>${isPCopied ? '✓' : 'Pass'}</span>`;
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

    let iconText = '👤';
    let typeName = 'username';
    if (result.identityType === 'email') {
      iconText = '✉';
      typeName = 'email';
    } else if (result.identityType === 'phone') {
      iconText = '📱';
      typeName = 'phone';
    }

    identityPill.innerHTML = `<span>${iconText}</span> <span class="cred-text">${escapeHtml(result.user || '—')}</span>`;
    identityPill.title = `Click to copy ${typeName} only`;

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

    passPill.innerHTML = `<span>🔑</span> <span class="cred-text">${escapeHtml(result.pass || '—')}</span>`;
    passPill.title = 'Click to copy password only';

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

      const header = document.createElement('div');
      header.className = 'raw-dropdown-header';

      const titleBox = document.createElement('div');
      titleBox.className = 'raw-dropdown-title';
      titleBox.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span>Full RAW Line</span>
        ${result.file ? `<span class="raw-dropdown-file">${escapeHtml(result.file)}</span>` : ''}
      `;

      const actionsBox = document.createElement('div');
      actionsBox.className = 'raw-dropdown-actions';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn-copy-raw-dropdown';
      copyBtn.type = 'button';
      copyBtn.title = 'Copy full raw line';
      copyBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/>
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span>Copy</span>
      `;

      copyBtn.addEventListener('click', () => {
        copyToClipboard(result.content, 'line');
        if (typeof CopiedMemory !== 'undefined') {
          CopiedMemory.add(result.content);
          if (result.user) CopiedMemory.add(result.user);
          if (result.pass) CopiedMemory.add(result.pass);
        }
        copyBtn.innerHTML = `<span>✓</span> <span>Copied!</span>`;
        setTimeout(() => {
          copyBtn.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/>
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/>
            </svg>
            <span>Copy</span>
          `;
        }, 1500);
      });

      const closeBtn = document.createElement('button');
      closeBtn.className = 'btn-close-raw-dropdown';
      closeBtn.type = 'button';
      closeBtn.title = 'Close';
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', closeRawDropdown);

      actionsBox.appendChild(copyBtn);
      actionsBox.appendChild(closeBtn);

      header.appendChild(titleBox);
      header.appendChild(actionsBox);

      const body = document.createElement('div');
      body.className = 'raw-dropdown-body';
      body.textContent = result.content;

      dropdown.appendChild(header);
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
    isDropdownOpen: () => activeDropdown !== null
  };
})();
