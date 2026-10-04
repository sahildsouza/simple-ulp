/**
 * Log Analytics Module for Simple ULP
 * Provides multi-file domain frequency analysis, streaming progress,
 * virtualized domain list rendering, and instant search filtering.
 */

const AnalyticsApp = (() => {
  const ROW_HEIGHT = 40; // px per row
  const BUFFER_ROWS = 15;

  let isInitialized = false;
  let isRunning = false;
  let activeAnalyticsId = null;

  let allDomains = []; // Array of { domain: string, count: number }
  let filteredDomains = []; // Filtered by search box
  let topDomainCount = 1;

  let currentView = 'explorer'; // 'explorer' | 'analytics'
  let scrollContainer = null;
  let viewport = null;
  let visibleNodes = new Map();

  /**
   * Initialize Analytics module
   */
  function init() {
    if (isInitialized) return;
    isInitialized = true;

    scrollContainer = document.getElementById('analyticsScroll');
    viewport = document.getElementById('analyticsViewport');

    // Header nav buttons
    const navExplorer = document.getElementById('navExplorer');
    const navAnalytics = document.getElementById('navAnalytics');

    if (navExplorer) {
      navExplorer.addEventListener('click', () => switchView('explorer'));
    }
    if (navAnalytics) {
      navAnalytics.addEventListener('click', () => switchView('analytics'));
    }

    // Run / Cancel buttons
    const btnRun = document.getElementById('btnRunAnalytics');
    if (btnRun) {
      btnRun.addEventListener('click', startAnalytics);
    }
    const btnCancel = document.getElementById('btnCancelAnalytics');
    if (btnCancel) {
      btnCancel.addEventListener('click', cancelAnalytics);
    }

    // Filter input
    const filterInput = document.getElementById('analyticsFilterInput');
    const btnClearFilter = document.getElementById('btnClearAnalyticsFilter');
    if (filterInput) {
      filterInput.addEventListener('input', () => {
        const val = filterInput.value.trim();
        if (btnClearFilter) btnClearFilter.style.display = val ? 'flex' : 'none';
        applyFilter();
      });
    }
    if (btnClearFilter && filterInput) {
      btnClearFilter.addEventListener('click', () => {
        filterInput.value = '';
        btnClearFilter.style.display = 'none';
        filterInput.focus();
        applyFilter();
      });
    }

    // Copy & Export buttons
    const btnCopy = document.getElementById('btnCopyAnalyticsList');
    if (btnCopy) {
      btnCopy.addEventListener('click', copyListToClipboard);
    }
    const btnExport = document.getElementById('btnExportAnalyticsList');
    if (btnExport) {
      btnExport.addEventListener('click', exportListToFile);
    }

    // Scroll listener for virtual scroller
    if (scrollContainer) {
      scrollContainer.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll, { passive: true });
    }

    // Check URL hash for initial view
    if (window.location.hash === '#analytics') {
      switchView('analytics');
    }

    // Listen to hashchange
    window.addEventListener('hashchange', () => {
      if (window.location.hash === '#analytics' && currentView !== 'analytics') {
        switchView('analytics');
      } else if (window.location.hash !== '#analytics' && currentView !== 'explorer') {
        switchView('explorer');
      }
    });
  }

  /**
   * Switch between Log Explorer and Log Analytics views
   */
  function switchView(viewName) {
    currentView = viewName;
    const navExplorer = document.getElementById('navExplorer');
    const navAnalytics = document.getElementById('navAnalytics');
    const explorerView = document.getElementById('explorerView');
    const analyticsView = document.getElementById('analyticsView');

    if (viewName === 'analytics') {
      if (navExplorer) navExplorer.classList.remove('active');
      if (navAnalytics) navAnalytics.classList.add('active');
      if (explorerView) explorerView.style.display = 'none';
      if (analyticsView) analyticsView.style.display = 'flex';
      window.location.hash = '#analytics';
      updateFileBadge();
      requestAnimationFrame(renderVisible);
    } else {
      if (navAnalytics) navAnalytics.classList.remove('active');
      if (navExplorer) navExplorer.classList.add('active');
      if (analyticsView) analyticsView.style.display = 'none';
      if (explorerView) explorerView.style.display = 'block';
      window.location.hash = '#explorer';
      if (typeof ResultsRenderer !== 'undefined') {
        ResultsRenderer.renderVisible();
      }
    }
  }

  /**
   * Update the file count badge in analytics toolbar
   */
  function updateFileBadge() {
    const badgeText = document.getElementById('analyticsFileCountText');
    if (!badgeText) return;

    let selected = [];
    if (typeof FileManager !== 'undefined' && FileManager.getSelected) {
      selected = FileManager.getSelected();
    }

    if (selected.length === 0) {
      badgeText.textContent = 'No files selected';
    } else if (selected.length === 1) {
      badgeText.textContent = `1 file: ${selected[0]}`;
    } else {
      badgeText.textContent = `${selected.length} files selected`;
    }
  }

  /**
   * Start domain analytics run
   */
  async function startAnalytics() {
    if (isRunning) return;

    let files = [];
    if (typeof FileManager !== 'undefined' && FileManager.getSelected) {
      files = FileManager.getSelected();
    }

    if (!files || files.length === 0) {
      if (typeof showToast === 'function') {
        showToast('Please select at least one file from the sidebar', 'warning');
      } else {
        alert('Please select at least one file from the sidebar');
      }
      return;
    }

    const groupModeSelect = document.getElementById('analyticsGroupMode');
    const groupMode = groupModeSelect ? groupModeSelect.value : 'root';

    isRunning = true;
    activeAnalyticsId = 'analytics_' + Date.now();

    // UI state updates
    const btnRun = document.getElementById('btnRunAnalytics');
    const btnCancel = document.getElementById('btnCancelAnalytics');
    const emptyState = document.getElementById('analyticsEmptyState');
    const progressCard = document.getElementById('analyticsProgressCard');
    const progressText = document.getElementById('analyticsProgressText');
    const progressSub = document.getElementById('analyticsProgressSub');
    const resultsHeader = document.getElementById('analyticsResultsHeader');
    const scrollEl = document.getElementById('analyticsScroll');

    if (btnRun) btnRun.style.display = 'none';
    if (btnCancel) btnCancel.style.display = 'inline-flex';
    if (emptyState) emptyState.style.display = 'none';
    if (resultsHeader) resultsHeader.style.display = 'none';
    if (scrollEl) scrollEl.style.display = 'none';

    if (progressCard) progressCard.style.display = 'flex';
    if (progressText) progressText.textContent = 'Starting domain analysis…';
    if (progressSub) progressSub.textContent = `Reading ${files.length} file(s)…`;

    try {
      const res = await fetch('/api/analytics/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files,
          groupMode,
          analyticsId: activeAnalyticsId
        })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP error ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep remainder

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            handleAnalyticsMessage(data);
          } catch (_) {}
        }
      }

      if (buffer.trim()) {
        try {
          const data = JSON.parse(buffer);
          handleAnalyticsMessage(data);
        } catch (_) {}
      }
    } catch (err) {
      if (typeof showToast === 'function') {
        showToast(`Analytics failed: ${err.message}`, 'error');
      }
      resetRunUI();
    }
  }

  /**
   * Handle streaming messages from backend
   */
  function handleAnalyticsMessage(data) {
    if (data.type === 'progress') {
      const progressText = document.getElementById('analyticsProgressText');
      const progressSub = document.getElementById('analyticsProgressSub');
      if (progressText) {
        progressText.textContent = `Scanning: ${data.totalLines.toLocaleString()} lines processed (${data.elapsed})`;
      }
      if (progressSub) {
        progressSub.textContent = `Found ${data.uniqueDomains.toLocaleString()} unique domains in ${data.currentFile || 'logs'}`;
      }
    } else if (data.type === 'complete') {
      allDomains = data.domains || [];
      topDomainCount = allDomains.length > 0 ? (allDomains[0].count || 1) : 1;

      // Update summaries
      const sDomains = document.getElementById('summaryTotalDomains');
      const sLines = document.getElementById('summaryTotalLines');
      const sElapsed = document.getElementById('summaryElapsed');

      if (sDomains) sDomains.innerHTML = `<strong>${data.uniqueDomains.toLocaleString()}</strong> unique domains`;
      if (sLines) sLines.innerHTML = `<strong>${data.totalLines.toLocaleString()}</strong> total lines`;
      if (sElapsed) sElapsed.textContent = data.elapsed;

      resetRunUI();

      const progressCard = document.getElementById('analyticsProgressCard');
      const resultsHeader = document.getElementById('analyticsResultsHeader');
      const scrollEl = document.getElementById('analyticsScroll');

      if (progressCard) progressCard.style.display = 'none';
      if (resultsHeader) resultsHeader.style.display = 'flex';
      if (scrollEl) scrollEl.style.display = 'block';

      applyFilter();

      if (typeof showToast === 'function') {
        showToast(`Analytics complete: ${data.uniqueDomains.toLocaleString()} domains in ${data.elapsed}`, 'success');
      }
    } else if (data.type === 'aborted') {
      if (typeof showToast === 'function') {
        showToast('Analysis cancelled', 'info');
      }
      resetRunUI();
    } else if (data.type === 'error') {
      if (typeof showToast === 'function') {
        showToast(`Error: ${data.message}`, 'error');
      }
      resetRunUI();
    }
  }

  /**
   * Cancel ongoing analysis
   */
  async function cancelAnalytics() {
    if (!isRunning || !activeAnalyticsId) return;

    try {
      await fetch('/api/analytics/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analyticsId: activeAnalyticsId })
      });
    } catch (_) {}

    resetRunUI();
    if (typeof showToast === 'function') {
      showToast('Cancelling analysis…', 'info');
    }
  }

  function resetRunUI() {
    isRunning = false;
    activeAnalyticsId = null;

    const btnRun = document.getElementById('btnRunAnalytics');
    const btnCancel = document.getElementById('btnCancelAnalytics');
    const progressCard = document.getElementById('analyticsProgressCard');

    if (btnRun) btnRun.style.display = 'inline-flex';
    if (btnCancel) btnCancel.style.display = 'none';
    if (progressCard && allDomains.length > 0) progressCard.style.display = 'none';
  }

  /**
   * Filter allDomains by search input
   */
  function applyFilter() {
    const filterInput = document.getElementById('analyticsFilterInput');
    const query = filterInput ? filterInput.value.toLowerCase().trim() : '';

    if (!query) {
      filteredDomains = allDomains;
    } else {
      filteredDomains = allDomains.filter(item => item.domain.includes(query));
    }

    // Clear existing nodes
    visibleNodes.forEach(node => node.remove());
    visibleNodes.clear();

    if (viewport) {
      viewport.style.height = (filteredDomains.length * ROW_HEIGHT) + 'px';
    }
    if (scrollContainer) {
      scrollContainer.scrollTop = 0;
    }

    renderVisible();
  }

  /**
   * Virtual scroll event handler
   */
  function onScroll() {
    if (currentView !== 'analytics') return;
    requestAnimationFrame(renderVisible);
  }

  /**
   * Render visible slice of filteredDomains
   */
  function renderVisible() {
    if (!scrollContainer || !viewport || currentView !== 'analytics') return;

    const totalItems = filteredDomains.length;
    if (totalItems === 0) {
      visibleNodes.forEach(node => node.remove());
      visibleNodes.clear();
      viewport.style.height = '0px';
      return;
    }

    const scrollTop = scrollContainer.scrollTop;
    const containerHeight = scrollContainer.clientHeight || window.innerHeight;

    const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
    const endIndex = Math.min(totalItems - 1, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + BUFFER_ROWS);

    // Remove nodes that are out of bounds
    for (const [index, node] of visibleNodes.entries()) {
      if (index < startIndex || index > endIndex) {
        node.remove();
        visibleNodes.delete(index);
      }
    }

    // Render newly visible rows
    for (let i = startIndex; i <= endIndex; i++) {
      if (!visibleNodes.has(i)) {
        renderRow(i);
      }
    }
  }

  /**
   * Render a single domain row in the virtual scroller
   */
  function renderRow(index) {
    const item = filteredDomains[index];
    if (!item) return;

    const row = document.createElement('div');
    row.className = 'analytics-row';
    row.style.top = (index * ROW_HEIGHT) + 'px';
    row.style.height = ROW_HEIGHT + 'px';

    // Rank column
    const colRank = document.createElement('div');
    colRank.className = 'col-rank';
    colRank.textContent = (index + 1).toLocaleString();

    // Domain column
    const colDomain = document.createElement('div');
    colDomain.className = 'col-domain';
    const domainText = document.createElement('span');
    domainText.className = 'analytics-domain-text';
    domainText.textContent = item.domain;
    domainText.title = `Click to copy ${item.domain}`;
    domainText.addEventListener('click', (e) => {
      e.stopPropagation();
      copyTextToClipboard(item.domain, `Copied domain: ${item.domain}`);
      if (typeof CopiedMemory !== 'undefined') {
        CopiedMemory.add(item.domain);
      }
    });
    colDomain.appendChild(domainText);

    // Count column
    const colCount = document.createElement('div');
    colCount.className = 'col-count';

    // Proportion bar
    const bar = document.createElement('div');
    bar.className = 'analytics-count-bar';
    const pct = Math.max(2, Math.min(100, (item.count / topDomainCount) * 100));
    bar.style.width = `${pct}%`;

    const countText = document.createElement('span');
    countText.className = 'analytics-count-val';
    countText.textContent = item.count.toLocaleString();

    colCount.appendChild(bar);
    colCount.appendChild(countText);

    // Actions column (Search shortcut & Copy)
    const colActions = document.createElement('div');
    colActions.className = 'col-actions';

    const btnSearch = document.createElement('button');
    btnSearch.className = 'btn-icon-xs';
    btnSearch.title = `Search "${item.domain}" in Log Explorer`;
    btnSearch.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/>
        <path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `;
    btnSearch.addEventListener('click', (e) => {
      e.stopPropagation();
      openInExplorer(item.domain);
    });

    const btnCopyRow = document.createElement('button');
    btnCopyRow.className = 'btn-icon-xs';
    btnCopyRow.title = `Copy "${item.domain}: ${item.count}"`;
    btnCopyRow.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/>
        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/>
      </svg>
    `;
    btnCopyRow.addEventListener('click', (e) => {
      e.stopPropagation();
      copyTextToClipboard(`${item.domain}: ${item.count}`, `Copied ${item.domain}`);
    });

    colActions.appendChild(btnSearch);
    colActions.appendChild(btnCopyRow);

    row.appendChild(colRank);
    row.appendChild(colDomain);
    row.appendChild(colCount);
    row.appendChild(colActions);

    viewport.appendChild(row);
    visibleNodes.set(index, row);
  }

  /**
   * Search domain in Log Explorer
   */
  function openInExplorer(domain) {
    switchView('explorer');
    const searchInput = document.getElementById('searchQuery');
    if (searchInput) {
      searchInput.value = domain;
      searchInput.focus();
      // Trigger search if app Search module available
      if (typeof SearchApp !== 'undefined' && SearchApp.triggerSearch) {
        SearchApp.triggerSearch();
      } else {
        const searchForm = document.getElementById('searchForm');
        if (searchForm) searchForm.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    }
  }

  /**
   * Copy all filtered domains as TSV / text
   */
  function copyListToClipboard() {
    if (filteredDomains.length === 0) return;
    const text = filteredDomains.map(d => `${d.domain}\t${d.count}`).join('\n');
    copyTextToClipboard(text, `Copied ${filteredDomains.length.toLocaleString()} domains to clipboard`);
  }

  /**
   * Export all filtered domains as a .txt file
   */
  function exportListToFile() {
    if (filteredDomains.length === 0) return;
    const text = filteredDomains.map(d => `${d.domain}: ${d.count}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `domain_analytics_${filteredDomains.length}_domains.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (typeof showToast === 'function') {
      showToast(`Exported ${filteredDomains.length.toLocaleString()} domains to file`, 'success');
    }
  }

  function copyTextToClipboard(text, toastMsg) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        if (typeof showToast === 'function') showToast(toastMsg, 'success');
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
      if (typeof showToast === 'function') showToast(toastMsg, 'success');
    } catch (_) {}
    document.body.removeChild(ta);
  }

  return {
    init,
    switchView,
    updateFileBadge,
    startAnalytics,
    cancelAnalytics
  };
})();

document.addEventListener('DOMContentLoaded', () => {
  AnalyticsApp.init();
});
