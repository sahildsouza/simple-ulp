/**
 * Log Analytics Module for Simple ULP
 * Provides multi-file domain frequency analysis, live progress bar streaming,
 * live top domain previews, virtualized domain list rendering, and instant search filtering.
 */

const AnalyticsApp = (() => {
  const ROW_HEIGHT = 40; // px per row
  const BUFFER_ROWS = 15;

  let isInitialized = false;
  let isRunning = false;
  let activeAnalyticsId = null;

  let allDomains = []; // Array of { domain: string, count: number }
  let filteredDomains = []; // Filtered by search box or live preview
  let topDomainCount = 1;
  let lastAnalyzedFiles = [];

  let sortColumn = 'count'; // 'count' | 'domain'
  let sortDirection = 'desc'; // 'desc' | 'asc'

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
      btnRun.addEventListener('click', () => startAnalytics());
    }
    const btnCancel = document.getElementById('btnCancelAnalytics');
    if (btnCancel) {
      btnCancel.addEventListener('click', cancelAnalytics);
    }

    const btnInside = document.getElementById('btnTriggerRunInside');
    if (btnInside) {
      btnInside.addEventListener('click', () => startAnalytics());
    }

    const btnSelectFiles = document.getElementById('btnSelectFilesInside');
    if (btnSelectFiles) {
      btnSelectFiles.addEventListener('click', () => {
        const sidebarToggle = document.getElementById('sidebarToggle');
        if (sidebarToggle) sidebarToggle.click();
      });
    }

    // Selected files dropdown
    const filesBtn = document.getElementById('analyticsFilesBtn');
    const filesMenu = document.getElementById('analyticsFilesMenu');
    const btnManageFromDropdown = document.getElementById('btnManageFilesFromDropdown');

    if (filesBtn && filesMenu) {
      filesBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = filesMenu.style.display === 'block';
        filesMenu.style.display = isOpen ? 'none' : 'block';
        filesBtn.setAttribute('aria-expanded', !isOpen);
        if (!isOpen) {
          renderSelectedFilesDropdown();
        }
      });

      document.addEventListener('click', (e) => {
        if (!filesMenu.contains(e.target) && !filesBtn.contains(e.target)) {
          filesMenu.style.display = 'none';
          filesBtn.setAttribute('aria-expanded', 'false');
        }
      });
    }

    if (btnManageFromDropdown) {
      btnManageFromDropdown.addEventListener('click', (e) => {
        e.stopPropagation();
        if (filesMenu) filesMenu.style.display = 'none';
        if (filesBtn) filesBtn.setAttribute('aria-expanded', 'false');
        const sidebarToggle = document.getElementById('sidebarToggle');
        if (sidebarToggle) sidebarToggle.click();
      });
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

    // Sortable table headers
    const headerSortDomain = document.getElementById('headerSortDomain');
    const headerSortCount = document.getElementById('headerSortCount');

    if (headerSortDomain) {
      headerSortDomain.addEventListener('click', () => handleSort('domain'));
      headerSortDomain.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleSort('domain');
        }
      });
    }

    if (headerSortCount) {
      headerSortCount.addEventListener('click', () => handleSort('count'));
      headerSortCount.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleSort('count');
        }
      });
    }

    updateSortHeaderUI();

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

    updateFileBadge();
  }

  function getSelectedFiles() {
    if (typeof FileManager !== 'undefined' && FileManager.getSelected) {
      return FileManager.getSelected();
    }
    return [];
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

      const files = getSelectedFiles();
      if (files.length === 0) {
        showTableMessage('folder', 'No Log Files Selected', 'Select one or more log files from the left sidebar to list domains.', false, true);
      } else if (allDomains.length > 0 && filesEqual(files, lastAnalyzedFiles)) {
        // Already have analyzed results for this exact file selection
        hideTableMessage();
        requestAnimationFrame(renderVisible);
      } else {
        // Files are selected, but DO NOT auto-scan: offer the option to run with live progress bar
        const filesDesc = files.length === 1 ? files[0] : `${files.length} log files`;
        showTableMessage('analytics', 'Ready for Log Domain Analytics', `Selected: ${filesDesc}. Click "Run Analytics" to begin domain frequency extraction with live progress.`, true, false);
      }
    } else {
      if (navAnalytics) navAnalytics.classList.remove('active');
      if (navExplorer) navExplorer.classList.add('active');
      if (analyticsView) analyticsView.style.display = 'none';
      if (explorerView) explorerView.style.display = 'flex';
      window.location.hash = '#explorer';
      if (typeof ResultsRenderer !== 'undefined' && ResultsRenderer.renderVisible) {
        ResultsRenderer.renderVisible();
      }
    }
  }

  function filesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((val, idx) => val === sb[idx]);
  }

  /**
   * Update the file count badge in analytics toolbar
   */
  function updateFileBadge() {
    const badgeText = document.getElementById('analyticsFileCountText');
    if (!badgeText) return;

    const selected = getSelectedFiles();
    if (selected.length === 0) {
      badgeText.textContent = 'No files selected';
    } else if (selected.length === 1) {
      badgeText.textContent = `1 file: ${selected[0]}`;
    } else {
      badgeText.textContent = `${selected.length} files selected`;
    }

    renderSelectedFilesDropdown();

    if (currentView === 'analytics' && !isRunning) {
      if (selected.length === 0) {
        allDomains = [];
        filteredDomains = [];
        visibleNodes.forEach(node => node.remove());
        visibleNodes.clear();
        if (viewport) viewport.style.height = '0px';
        showTableMessage('folder', 'No Log Files Selected', 'Select one or more log files from the left sidebar to analyze domains.', false, true);
      } else if (!filesEqual(selected, lastAnalyzedFiles)) {
        // Files changed: prompt user to run analytics (DO NOT auto-scan)
        const desc = selected.length === 1 ? selected[0] : `${selected.length} log files`;
        showTableMessage('analytics', 'Selection Changed', `Selected: ${desc}. Click "Run Analytics" below or in toolbar to analyze domains.`, true, false);
      }
    }
  }

  /**
   * Render list of selected files into the analytics files dropdown
   */
  function renderSelectedFilesDropdown() {
    const listEl = document.getElementById('analyticsFilesList');
    if (!listEl) return;
    const selected = getSelectedFiles();
    listEl.innerHTML = '';

    if (selected.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'analytics-file-empty';
      empty.textContent = 'No files selected. Click "Manage" to choose log files.';
      listEl.appendChild(empty);
      return;
    }

    selected.forEach(fileName => {
      const item = document.createElement('div');
      item.className = 'analytics-file-item';
      item.innerHTML = `
        <svg class="analytics-file-item-icon" width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><polyline points="14 2 14 8 20 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="analytics-file-item-name" title="${fileName}">${fileName}</span>
      `;
      listEl.appendChild(item);
    });
  }

  function getMsgIconSvg(type) {
    switch (type) {
      case 'folder':
        return '<svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      case 'analytics':
      case 'chart':
        return '<svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M18 20V10M12 20V4M6 20v-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
      case 'warning':
        return '<svg width="32" height="32" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.8"/><line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      case 'error':
        return '<svg width="32" height="32" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.8"/><line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
      case 'search':
        return '<svg width="32" height="32" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/><path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
      case 'stop':
        return '<svg width="32" height="32" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.8"/><rect x="9" y="9" width="6" height="6" fill="currentColor"/></svg>';
      case 'loading':
        return '<div class="loading-spinner"></div>';
      default:
        return '<svg width="32" height="32" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.8"/></svg>';
    }
  }

  function showTableMessage(iconType, title, desc, showRunBtn = false, showFilesBtn = false) {
    const msgEl = document.getElementById('analyticsTableMessage');
    const iconEl = document.getElementById('analyticsMsgIcon');
    const titleEl = document.getElementById('analyticsMsgTitle');
    const descEl = document.getElementById('analyticsMsgDesc');
    const btnInside = document.getElementById('btnTriggerRunInside');
    const btnSelectFiles = document.getElementById('btnSelectFilesInside');

    if (!msgEl) return;
    if (iconEl) iconEl.innerHTML = getMsgIconSvg(iconType);
    if (titleEl) titleEl.textContent = title;
    if (descEl) descEl.textContent = desc;
    if (btnInside) {
      btnInside.style.display = showRunBtn ? 'inline-flex' : 'none';
      btnInside.textContent = 'Run Analytics Now';
    }
    if (btnSelectFiles) {
      btnSelectFiles.style.display = showFilesBtn ? 'inline-flex' : 'none';
    }

    msgEl.style.display = 'flex';
  }

  function hideTableMessage() {
    const msgEl = document.getElementById('analyticsTableMessage');
    if (msgEl) msgEl.style.display = 'none';
  }

  /**
   * Start domain analytics run with live progress bar
   */
  async function startAnalytics() {
    if (isRunning) return;

    const files = getSelectedFiles();
    if (!files || files.length === 0) {
      showTableMessage('warning', 'No Files Selected', 'Please select at least one file from the left sidebar.');
      if (typeof showToast === 'function') {
        showToast('Please select at least one file from the sidebar', 'warning');
      }
      return;
    }

    isRunning = true;
    lastAnalyzedFiles = [...files];
    activeAnalyticsId = 'analytics_' + Date.now();

    // Reset results state
    allDomains = [];
    filteredDomains = [];
    visibleNodes.forEach(node => node.remove());
    visibleNodes.clear();
    if (viewport) viewport.style.height = '0px';

    // Toolbar buttons
    const btnRun = document.getElementById('btnRunAnalytics');
    const btnCancel = document.getElementById('btnCancelAnalytics');
    const runText = document.getElementById('btnRunAnalyticsText');
    const statusBarText = document.getElementById('analyticsStatusText');
    const statusIdle = document.getElementById('analyticsStatusIdle');
    const summaryBar = document.getElementById('analyticsSummary');

    if (btnRun) btnRun.style.display = 'none';
    if (btnCancel) btnCancel.style.display = 'inline-flex';
    if (runText) runText.textContent = 'Scanning…';

    if (summaryBar) summaryBar.style.display = 'none';
    if (statusIdle) statusIdle.style.display = 'flex';
    if (statusBarText) {
      statusBarText.className = 'analytics-status-text scanning';
      statusBarText.textContent = `Scanning ${files.length} file(s)…`;
    }

    // Show Live Progress Banner
    const liveBanner = document.getElementById('analyticsLiveBanner');
    const liveBar = document.getElementById('analyticsProgressBar');
    const liveTitle = document.getElementById('analyticsLiveTitle');
    const liveSpeed = document.getElementById('analyticsLiveSpeed');
    const liveElapsed = document.getElementById('analyticsLiveElapsed');
    const liveDomains = document.getElementById('analyticsLiveDomains');
    const liveSub = document.getElementById('analyticsLiveSub');

    if (liveBanner) liveBanner.style.display = 'flex';
    if (liveBar) liveBar.style.width = '0%';
    if (liveTitle) liveTitle.textContent = `Starting scan on ${files.length} file(s)…`;
    if (liveSpeed) liveSpeed.textContent = '0 lines/s';
    if (liveElapsed) liveElapsed.textContent = '0.0s';
    if (liveDomains) liveDomains.textContent = '0 unique domains';
    if (liveSub) liveSub.textContent = 'Reading files…';

    showTableMessage('loading', 'Scanning in Progress…', `Reading ${files.length} selected log file(s) with live domain streaming…`);

    try {
      const res = await fetch('/api/analytics/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files,
          groupMode: 'full',
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
      const liveBanner = document.getElementById('analyticsLiveBanner');
      if (liveBanner) liveBanner.style.display = 'none';
      showTableMessage('error', 'Analysis Failed', err.message, true);
      resetRunUI();
    }
  }

  /**
   * Handle streaming messages from backend with live progress & streaming results
   */
  function handleAnalyticsMessage(data) {
    const liveBar = document.getElementById('analyticsProgressBar');
    const liveTitle = document.getElementById('analyticsLiveTitle');
    const liveSpeed = document.getElementById('analyticsLiveSpeed');
    const liveElapsed = document.getElementById('analyticsLiveElapsed');
    const liveDomains = document.getElementById('analyticsLiveDomains');
    const liveSub = document.getElementById('analyticsLiveSub');
    const statusBarText = document.getElementById('analyticsStatusText');
    const summaryBar = document.getElementById('analyticsSummary');

    if (data.type === 'progress') {
      const pct = Math.min(99, Math.max(1, data.percent || 1));
      if (liveBar) liveBar.style.width = pct + '%';
      if (liveTitle) liveTitle.textContent = `Scanning ${data.currentFile || 'logs'} (${pct}%)`;
      if (liveSpeed) liveSpeed.textContent = `${(data.linesPerSec || 0).toLocaleString()} lines/s`;
      if (liveElapsed) liveElapsed.textContent = `${data.elapsed || '0s'}`;
      if (liveDomains) liveDomains.textContent = `${(data.uniqueDomains || 0).toLocaleString()} domains`;
      if (liveSub) liveSub.textContent = `${(data.totalLines || 0).toLocaleString()} lines processed`;

      if (statusBarText) {
        statusBarText.className = 'analytics-status-text scanning';
        statusBarText.textContent = `Scanning: ${(data.totalLines || 0).toLocaleString()} lines • ${(data.uniqueDomains || 0).toLocaleString()} unique domains (${pct}%)`;
      }

      // Live stream top domain results into the table as it scans!
      if (Array.isArray(data.topDomains) && data.topDomains.length > 0) {
        const filterInput = document.getElementById('analyticsFilterInput');
        const filterVal = filterInput ? filterInput.value.trim() : '';
        // If not actively typing a filter, stream live top domains
        if (!filterVal) {
          hideTableMessage();
          filteredDomains = [...data.topDomains];
          applySort(filteredDomains);
          topDomainCount = data.topDomains[0]?.count || 1;
          if (viewport) viewport.style.height = (filteredDomains.length * ROW_HEIGHT) + 'px';
          renderVisible();
        }
      }
    } else if (data.type === 'complete') {
      const liveBanner = document.getElementById('analyticsLiveBanner');
      if (liveBanner) liveBanner.style.display = 'none';

      allDomains = data.domains || [];
      topDomainCount = allDomains.length > 0 ? (allDomains[0].count || 1) : 1;

      // Update clean 3-metric strip (Domains, Lines, Time)
      const sDomains = document.getElementById('summaryTotalDomains');
      const sLines = document.getElementById('summaryTotalLines');
      const sElapsed = document.getElementById('summaryElapsed');
      const statusIdle = document.getElementById('analyticsStatusIdle');

      if (sDomains) sDomains.textContent = (data.uniqueDomains || 0).toLocaleString();
      if (sLines) sLines.textContent = (data.totalLines || 0).toLocaleString();
      if (sElapsed) sElapsed.textContent = data.elapsed || '0s';

      if (statusIdle) statusIdle.style.display = 'none';
      if (summaryBar) summaryBar.style.display = 'grid';

      resetRunUI();

      if (allDomains.length === 0) {
        showTableMessage('search', 'No Domains Found', 'No valid domains or URLs were extracted from the selected log file(s).');
      } else {
        hideTableMessage();
        applyFilter();
      }

      if (typeof showToast === 'function') {
        showToast(`Analytics complete: ${data.uniqueDomains.toLocaleString()} domains in ${data.elapsed}`, 'success');
      }
    } else if (data.type === 'aborted') {
      const liveBanner = document.getElementById('analyticsLiveBanner');
      if (liveBanner) liveBanner.style.display = 'none';

      if (typeof showToast === 'function') {
        showToast('Analysis cancelled', 'info');
      }
      showTableMessage('stop', 'Analysis Cancelled', 'Domain extraction was stopped. Click below to run again.', true);
      resetRunUI();
    } else if (data.type === 'error') {
      const liveBanner = document.getElementById('analyticsLiveBanner');
      if (liveBanner) liveBanner.style.display = 'none';

      if (typeof showToast === 'function') {
        showToast(`Error: ${data.message}`, 'error');
      }
      showTableMessage('error', 'Error During Analysis', data.message, true);
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
    const liveBanner = document.getElementById('analyticsLiveBanner');
    if (liveBanner) liveBanner.style.display = 'none';

    if (typeof showToast === 'function') {
      showToast('Stopping analysis…', 'info');
    }
  }

  function resetRunUI() {
    isRunning = false;
    activeAnalyticsId = null;

    const btnRun = document.getElementById('btnRunAnalytics');
    const btnCancel = document.getElementById('btnCancelAnalytics');
    const runText = document.getElementById('btnRunAnalyticsText');

    if (btnRun) btnRun.style.display = 'inline-flex';
    if (btnCancel) btnCancel.style.display = 'none';
    if (runText) runText.textContent = 'Run Analytics';
  }

  /**
   * Sort column click handler
   */
  function handleSort(col) {
    if (sortColumn === col) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      sortColumn = col;
      sortDirection = col === 'domain' ? 'asc' : 'desc';
    }
    updateSortHeaderUI();
    applyFilter();
  }

  /**
   * Update visual indicator arrows on sort headers
   */
  function updateSortHeaderUI() {
    const colDomain = document.getElementById('headerSortDomain');
    const colCount = document.getElementById('headerSortCount');
    const iconDomain = document.getElementById('sortIconDomain');
    const iconCount = document.getElementById('sortIconCount');

    const sortAscSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const sortDescSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M19 12l-7 7-7-7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const sortBothSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M7 10l5-5 5 5M7 14l5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    if (colDomain && iconDomain) {
      if (sortColumn === 'domain') {
        colDomain.classList.add('sorted');
        iconDomain.innerHTML = sortDirection === 'asc' ? sortAscSvg : sortDescSvg;
        colDomain.setAttribute('aria-sort', sortDirection === 'asc' ? 'ascending' : 'descending');
      } else {
        colDomain.classList.remove('sorted');
        iconDomain.innerHTML = sortBothSvg;
        colDomain.removeAttribute('aria-sort');
      }
    }

    if (colCount && iconCount) {
      if (sortColumn === 'count') {
        colCount.classList.add('sorted');
        iconCount.innerHTML = sortDirection === 'asc' ? sortAscSvg : sortDescSvg;
        colCount.setAttribute('aria-sort', sortDirection === 'asc' ? 'ascending' : 'descending');
      } else {
        colCount.classList.remove('sorted');
        iconCount.innerHTML = sortBothSvg;
        colCount.removeAttribute('aria-sort');
      }
    }
  }

  /**
   * Sort array according to current sort column and direction
   */
  function applySort(list) {
    if (!Array.isArray(list) || list.length <= 1) return;
    const dir = sortDirection === 'asc' ? 1 : -1;
    if (sortColumn === 'count') {
      list.sort((a, b) => {
        if (a.count !== b.count) {
          return (a.count - b.count) * dir;
        }
        return a.domain.localeCompare(b.domain);
      });
    } else if (sortColumn === 'domain') {
      list.sort((a, b) => {
        const cmp = a.domain.localeCompare(b.domain, undefined, { sensitivity: 'base' });
        if (cmp !== 0) return cmp * dir;
        return b.count - a.count;
      });
    }
  }

  /**
   * Filter allDomains by search input and apply active sorting
   */
  function applyFilter() {
    const filterInput = document.getElementById('analyticsFilterInput');
    const query = filterInput ? filterInput.value.toLowerCase().trim() : '';

    if (!query) {
      filteredDomains = [...allDomains];
    } else {
      filteredDomains = allDomains.filter(item => item.domain.includes(query));
    }

    applySort(filteredDomains);

    // Clear existing nodes
    visibleNodes.forEach(node => node.remove());
    visibleNodes.clear();

    if (filteredDomains.length === 0 && allDomains.length > 0) {
      showTableMessage('search', 'No Matching Domains', `No domains matched "${query}". Try a different filter term.`);
      if (viewport) viewport.style.height = '0px';
      return;
    }

    hideTableMessage();

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
      if (typeof CopiedMemory !== 'undefined' && CopiedMemory.add) {
        CopiedMemory.add(item.domain);
      }
    });
    colDomain.appendChild(domainText);

    // Count column
    const colCount = document.createElement('div');
    colCount.className = 'col-count';
    const countText = document.createElement('span');
    countText.className = 'analytics-count-val';
    countText.textContent = item.count.toLocaleString();
    colCount.appendChild(countText);

    // Actions column (Search shortcut only)
    const colActions = document.createElement('div');
    colActions.className = 'col-actions';

    const btnSearch = document.createElement('button');
    btnSearch.className = 'btn-icon-xs';
    btnSearch.title = `Search "${item.domain}" in Log Explorer`;
    btnSearch.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
        <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/>
        <path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `;
    btnSearch.addEventListener('click', (e) => {
      e.stopPropagation();
      openInExplorer(item.domain);
    });

    colActions.appendChild(btnSearch);

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
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
      searchInput.value = domain;
      searchInput.focus();
      const searchActionBtn = document.getElementById('searchActionBtn');
      if (searchActionBtn) searchActionBtn.click();
    }
  }

  /**
   * Copy current domain list to clipboard as TSV
   */
  function copyListToClipboard() {
    const list = filteredDomains.length > 0 ? filteredDomains : allDomains;
    if (list.length === 0) {
      if (typeof showToast === 'function') showToast('No domains to copy', 'info');
      return;
    }

    const tsv = list.map(item => `${item.domain}\t${item.count}`).join('\n');
    copyTextToClipboard(tsv, `Copied ${list.length.toLocaleString()} domains to clipboard`);
  }

  /**
   * Export domain list as text file
   */
  function exportListToFile() {
    const list = filteredDomains.length > 0 ? filteredDomains : allDomains;
    if (list.length === 0) {
      if (typeof showToast === 'function') showToast('No domains to export', 'info');
      return;
    }

    const content = list.map(item => `${item.domain}: ${item.count}`).join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `domains_analytics_${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (typeof showToast === 'function') {
      showToast(`Exported ${list.length.toLocaleString()} domains`, 'success');
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

// Immediate or DOM ready initialization
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    AnalyticsApp.init();
  });
} else {
  AnalyticsApp.init();
}
