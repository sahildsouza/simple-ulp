/**
 * Main application — wires together search, results, memory, and file modules
 */

(function () {
  'use strict';

  // ─── State ───────────────────────────────────
  let searchMode = 'literal';
  let caseSensitive = false;
  let invertMatch = false;
  let selectedFiles = [];
  let matchCount = 0;
  let isSearching = false;

  // ─── DOM refs ────────────────────────────────
  const searchInput = document.getElementById('searchInput');
  const clearBtn = document.getElementById('clearSearch');
  const searchActionBtn = document.getElementById('searchActionBtn');
  const iconSearch = document.getElementById('iconSearch');
  const iconStop = document.getElementById('iconStop');
  const searchBtnText = document.getElementById('searchBtnText');
  const modeLiteral = document.getElementById('modeLiteral');
  const modeRegex = document.getElementById('modeRegex');
  const modeWord = document.getElementById('modeWord');
  const toggleCase = document.getElementById('toggleCase');
  const toggleInvert = document.getElementById('toggleInvert');
  const fieldFilter = document.getElementById('fieldFilter');
  const statsText = document.getElementById('statsText');
  const emptyState = document.getElementById('emptyState');
  const loadingState = document.getElementById('loadingState');
  const errorState = document.getElementById('errorState');
  const errorTitle = document.getElementById('errorTitle');
  const errorDesc = document.getElementById('errorDesc');
  const resultsScroll = document.getElementById('resultsScroll');
  const resultsViewport = document.getElementById('resultsViewport');
  const sidebarToggle = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('sidebar');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  const selectAllBtn = document.getElementById('selectAll');
  const selectNoneBtn = document.getElementById('selectNone');
  const refreshBtn = document.getElementById('refreshFiles');
  const exportBtn = document.getElementById('exportResults');

  // File Breakdown Bar elements
  const fileBreakdownBar = document.getElementById('fileBreakdownBar');
  const fileBreakdownDropdownWrap = document.getElementById('fileBreakdownDropdownWrap');
  const fileBreakdownBtn = document.getElementById('fileBreakdownBtn');
  const fileBreakdownSummary = document.getElementById('fileBreakdownSummary');
  const fileBreakdownCountBadge = document.getElementById('fileBreakdownCountBadge');
  const fileBreakdownMenu = document.getElementById('fileBreakdownMenu');
  const fileBreakdownTotalBadge = document.getElementById('fileBreakdownTotalBadge');
  const fileBreakdownList = document.getElementById('fileBreakdownList');
  let isFileBreakdownOpen = false;

  // Result Mode Tabs
  const modeTabs = [
    document.getElementById('tabModeRaw'),
    document.getElementById('tabModeEmail'),
    document.getElementById('tabModeUser'),
    document.getElementById('tabModePhone')
  ].filter(Boolean);

  // ─── Initialize ──────────────────────────────

  ResultsRenderer.init(resultsScroll, resultsViewport);
  if (typeof AnalyticsApp !== 'undefined' && AnalyticsApp.init) {
    AnalyticsApp.init();
  }

  FileManager.init((files) => {
    selectedFiles = files;
    if (typeof AnalyticsApp !== 'undefined' && AnalyticsApp.updateFileBadge) {
      AnalyticsApp.updateFileBadge();
    }
  });

  // ─── Search Mode Toggles ─────────────────────

  const modeButtons = [modeLiteral, modeRegex, modeWord];

  modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      modeButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      searchMode = btn.dataset.mode;
      triggerSearch();
    });
  });

  toggleCase.addEventListener('click', () => {
    caseSensitive = !caseSensitive;
    toggleCase.classList.toggle('active', caseSensitive);
    triggerSearch();
  });

  toggleInvert.addEventListener('click', () => {
    invertMatch = !invertMatch;
    toggleInvert.classList.toggle('active', invertMatch);
    triggerSearch();
  });

  fieldFilter.addEventListener('change', () => {
    if (fieldFilter.value === 'url') {
      searchInput.placeholder = 'Search URLs only… e.g. netflix.com, /login (Enter or click Search)';
    } else if (fieldFilter.value === 'username') {
      searchInput.placeholder = 'Search usernames only… (Enter or click Search)';
    } else if (fieldFilter.value === 'password') {
      searchInput.placeholder = 'Search passwords only… (Enter or click Search)';
    } else {
      searchInput.placeholder = 'Search logs… (Enter or click Search)';
    }
  });

  // ─── Result Mode Tabs (RAW / Email:pass / User:pass / Phone:pass) ───

  modeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      modeTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const view = tab.dataset.view;
      ResultsRenderer.setViewMode(view);
      updateStatsText();
    });
  });


  // ─── File Breakdown Dropdown Toggle ──────────

  function toggleFileBreakdown(forceState) {
    if (!fileBreakdownMenu || !fileBreakdownBtn) return;
    const shouldOpen = (forceState !== undefined) ? forceState : !isFileBreakdownOpen;
    isFileBreakdownOpen = shouldOpen;
    fileBreakdownMenu.style.display = shouldOpen ? 'block' : 'none';
    fileBreakdownBtn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  }

  function closeFileBreakdown() {
    toggleFileBreakdown(false);
  }

  if (fileBreakdownBtn) {
    fileBreakdownBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFileBreakdown();
    });
  }

  document.addEventListener('click', (e) => {
    if (isFileBreakdownOpen && fileBreakdownDropdownWrap && !fileBreakdownDropdownWrap.contains(e.target)) {
      closeFileBreakdown();
    }
  });

  // ─── Search Button & Input ────────────────────

  if (searchActionBtn) {
    searchActionBtn.addEventListener('click', () => {
      if (isSearching) {
        stopSearch();
      } else {
        triggerSearch();
      }
    });
  }

  // Only toggle clear button visibility on input — do not search automatically
  searchInput.addEventListener('input', () => {
    clearBtn.classList.toggle('visible', searchInput.value.length > 0);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (isSearching) {
        stopSearch();
      }
      triggerSearch();
    }
  });

  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.classList.remove('visible');
    clearSearch();
    searchInput.focus();
  });

  // ─── Keyboard Shortcuts ──────────────────────

  document.addEventListener('keydown', (e) => {
    // Ctrl+K or Cmd+K — focus search
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }

    // Escape — close breakdown dropdown, raw dropdown, stop search, or clear search / close sidebar
    if (e.key === 'Escape') {
      if (isFileBreakdownOpen) {
        closeFileBreakdown();
        return;
      }
      if (typeof ResultsRenderer !== 'undefined' && ResultsRenderer.isDropdownOpen && ResultsRenderer.isDropdownOpen()) {
        ResultsRenderer.closeDropdown();
        return;
      }
      if (isSearching) {
        stopSearch();
      } else if (sidebar.classList.contains('open')) {
        closeSidebar();
      } else if (searchInput.value) {
        searchInput.value = '';
        clearBtn.classList.remove('visible');
        clearSearch();
      }
    }

    // Alt+C — toggle case sensitivity
    if (e.altKey && e.key === 'c') {
      e.preventDefault();
      toggleCase.click();
    }

    // Alt+U — toggle URL Only mode in field dropdown
    if (e.altKey && e.key === 'u') {
      e.preventDefault();
      fieldFilter.value = (fieldFilter.value === 'url') ? '' : 'url';
      fieldFilter.dispatchEvent(new Event('change'));
    }
  });

  // ─── Sidebar ─────────────────────────────────

  sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    sidebarOverlay.classList.toggle('visible', sidebar.classList.contains('open'));
  });

  sidebarOverlay.addEventListener('click', closeSidebar);

  function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('visible');
  }

  selectAllBtn.addEventListener('click', () => FileManager.selectAll());
  selectNoneBtn.addEventListener('click', () => FileManager.selectNone());
  refreshBtn.addEventListener('click', () => FileManager.loadFiles());

  // ─── Export ──────────────────────────────────

  exportBtn.addEventListener('click', () => {
    const viewMode = ResultsRenderer.getViewMode();
    const filtered = ResultsRenderer.getFilteredResults();

    if (filtered.length === 0) {
      showToast('No results to export in current view', 'error');
      return;
    }

    let text = '';
    if (viewMode === 'raw') {
      text = filtered.map(r => r.content).join('\n');
    } else {
      text = filtered.map(r => `${r.user}:${r.pass}`).join('\n');
    }

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ulp-${viewMode}-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);

    showToast(`Exported ${filtered.length} ${viewMode} records`, 'success');
  });

  // ─── Search Logic ────────────────────────────

  function setSearchBtnState(searching) {
    isSearching = searching;
    if (!searchActionBtn) return;
    if (searching) {
      searchActionBtn.classList.add('is-searching');
      if (searchBtnText) searchBtnText.textContent = 'Stop';
      if (iconSearch) iconSearch.style.display = 'none';
      if (iconStop) iconStop.style.display = '';
      searchActionBtn.title = 'Stop search (Esc)';
      searchActionBtn.setAttribute('aria-label', 'Stop search');
    } else {
      searchActionBtn.classList.remove('is-searching');
      if (searchBtnText) searchBtnText.textContent = 'Search';
      if (iconSearch) iconSearch.style.display = '';
      if (iconStop) iconStop.style.display = 'none';
      searchActionBtn.title = 'Search (Enter)';
      searchActionBtn.setAttribute('aria-label', 'Search');
    }
  }

  function stopSearch() {
    if (!isSearching) return;
    SearchClient.abort();
    setSearchBtnState(false);

    const totalRaw = ResultsRenderer.getResults().length;
    const viewMode = ResultsRenderer.getViewMode();
    const activeCount = ResultsRenderer.getFilteredResults().length;
    const activeFilter = ResultsRenderer.getActiveFileFilter();
    const label = viewMode === 'raw' ? 'results' : `${viewMode}:pass matches`;
    const filterSuffix = activeFilter ? ` in ${activeFilter}` : '';

    renderFileBreakdown();

    if (totalRaw > 0) {
      statsText.innerHTML = `<strong>${formatNumber(activeCount)}</strong> ${label}${filterSuffix} <span class="stats-time" style="color: var(--warning);">(stopped)</span> (${formatNumber(totalRaw)} total RAW)`;
      exportBtn.style.display = '';
      showState('results');
    } else {
      statsText.innerHTML = `<span style="color: var(--warning);">Search stopped</span>`;
      showState('empty');
    }
    showToast('Search stopped', 'info');
  }

  function triggerSearch() {
    const query = searchInput.value.trim();

    if (!query) {
      clearSearch();
      return;
    }

    if (selectedFiles.length === 0) {
      showError('No files selected', 'Select at least one file from the sidebar to search.');
      return;
    }

    executeSearch(query);
  }

  async function executeSearch(query) {
    showState('loading');
    setSearchBtnState(true);
    matchCount = 0;
    ResultsRenderer.clear();
    if (fileBreakdownBar) fileBreakdownBar.style.display = 'none';
    closeFileBreakdown();

    statsText.innerHTML = 'Searching…';
    exportBtn.style.display = 'none';

    const params = {
      query,
      files: selectedFiles,
      mode: searchMode,
      caseSensitive,
      invertMatch,
      fieldFilter: fieldFilter.value || null,
      urlOnly: fieldFilter.value === 'url'
    };

    const isMultiFile = selectedFiles.length > 1;
    ResultsRenderer.setMultiFileMode(isMultiFile);

    await SearchClient.search(
      params,
      // onMatch
      (match) => {
        matchCount++;
        if (matchCount === 1) {
          showState('results');
          requestAnimationFrame(() => ResultsRenderer.renderVisible());
        }
        ResultsRenderer.appendResult(match);

        if (matchCount % 50 === 0) {
          updateStatsText();
        }
        if (matchCount % 100 === 0) {
          renderFileBreakdown();
        }
      },
      // onStats
      (stats) => {
        setSearchBtnState(false);
        const viewMode = ResultsRenderer.getViewMode();
        const activeCount = ResultsRenderer.getFilteredResults().length;
        const activeFilter = ResultsRenderer.getActiveFileFilter();
        const label = viewMode === 'raw' ? 'results' : `${viewMode}:pass matches`;
        const filterSuffix = activeFilter ? ` in ${activeFilter}` : '';

        statsText.innerHTML = `<strong>${formatNumber(activeCount)}</strong> ${label}${filterSuffix} <span class="stats-time">in ${stats.elapsed}</span> (${formatNumber(stats.matches)} total RAW)`;

        renderFileBreakdown();

        if (stats.matches > 0) {
          exportBtn.style.display = '';
          showState('results');
          requestAnimationFrame(() => ResultsRenderer.renderVisible());
        } else {
          showState('empty-no-results');
        }
      },
      // onError
      (errorMsg) => {
        setSearchBtnState(false);
        if (matchCount > 0) {
          showToast(errorMsg, 'error');
        } else {
          showError('Search failed', errorMsg);
        }
      }
    );
  }

  function updateStatsText() {
    const viewMode = ResultsRenderer.getViewMode();
    const activeCount = ResultsRenderer.getFilteredResults().length;
    const totalRaw = ResultsRenderer.getResults().length;
    const activeFilter = ResultsRenderer.getActiveFileFilter();
    const filterSuffix = activeFilter ? ` in ${activeFilter}` : '';

    if (viewMode === 'raw') {
      statsText.innerHTML = `<strong>${formatNumber(activeCount)}</strong> RAW results${filterSuffix}${activeFilter ? ` (of ${formatNumber(totalRaw)} total)` : ''}`;
    } else {
      statsText.innerHTML = `<strong>${formatNumber(activeCount)}</strong> ${viewMode}:pass matches${filterSuffix} (of ${formatNumber(totalRaw)} total)`;
    }
  }

  // ─── Render Results Per-File Breakdown ────────

  function renderFileBreakdown() {
    if (!fileBreakdownBar || !fileBreakdownSummary || !fileBreakdownList) return;

    const fileCounts = (typeof ResultsRenderer !== 'undefined' && ResultsRenderer.getFileCounts)
      ? ResultsRenderer.getFileCounts()
      : {};
    const fileEntries = Object.entries(fileCounts).filter(([_, count]) => count > 0);

    // If no files have matches, hide breakdown bar
    if (fileEntries.length === 0) {
      fileBreakdownBar.style.display = 'none';
      closeFileBreakdown();
      return;
    }

    fileBreakdownBar.style.display = 'flex';

    // Sort descending by match count
    fileEntries.sort((a, b) => b[1] - a[1]);

    const activeFilter = (typeof ResultsRenderer !== 'undefined' && ResultsRenderer.getActiveFileFilter)
      ? ResultsRenderer.getActiveFileFilter()
      : null;

    const totalMatches = fileEntries.reduce((sum, [, c]) => sum + c, 0);
    const maxCount = fileEntries[0][1] || 1;

    // Update trigger UI
    if (activeFilter) {
      const activeCount = fileCounts[activeFilter] || 0;
      fileBreakdownBtn.classList.add('is-filtered');
      const labelEl = fileBreakdownBtn.querySelector('.file-breakdown-label');
      if (labelEl) labelEl.textContent = 'Filtered:';
      fileBreakdownSummary.textContent = `${activeFilter} (${formatNumber(activeCount)})`;
      if (fileBreakdownCountBadge) {
        fileBreakdownCountBadge.textContent = `1 of ${fileEntries.length} files`;
      }
    } else {
      fileBreakdownBtn.classList.remove('is-filtered');
      const labelEl = fileBreakdownBtn.querySelector('.file-breakdown-label');
      if (labelEl) labelEl.textContent = 'Results by file:';

      let summaryText = '';
      if (fileEntries.length === 1) {
        summaryText = `${fileEntries[0][0]} (${formatNumber(fileEntries[0][1])})`;
      } else if (fileEntries.length === 2) {
        summaryText = `${fileEntries[0][0]} (${formatNumber(fileEntries[0][1])}) · ${fileEntries[1][0]} (${formatNumber(fileEntries[1][1])})`;
      } else {
        const top2 = fileEntries.slice(0, 2).map(([f, c]) => `${f} (${formatNumber(c)})`).join(' · ');
        summaryText = `${top2} +${fileEntries.length - 2} more`;
      }
      fileBreakdownSummary.textContent = summaryText;

      if (fileBreakdownCountBadge) {
        fileBreakdownCountBadge.textContent = `${fileEntries.length} ${fileEntries.length === 1 ? 'file' : 'files'}`;
      }
    }

    if (fileBreakdownTotalBadge) {
      fileBreakdownTotalBadge.textContent = `${formatNumber(totalMatches)} matches`;
    }

    // Render list items
    let listHtml = '';

    // "All log files" row
    const isAllActive = !activeFilter;
    listHtml += `
      <div class="file-breakdown-item is-all ${isAllActive ? 'is-active' : ''}" data-file="">
        <div class="file-breakdown-item-main">
          <svg class="file-breakdown-item-icon" width="13" height="13" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="2"/>
            <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="2"/>
            <rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="2"/>
            <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="2"/>
          </svg>
          <div class="file-breakdown-info">
            <div class="file-breakdown-row-top">
              <span class="file-breakdown-name">All log files</span>
              <span class="file-breakdown-count">${formatNumber(totalMatches)}</span>
            </div>
          </div>
        </div>
        ${isAllActive ? '<span class="file-breakdown-active-dot" title="All files selected"></span>' : ''}
      </div>
    `;

    // Individual file items
    fileEntries.forEach(([fileName, count]) => {
      const isCurrentActive = activeFilter === fileName;
      const pct = totalMatches > 0 ? Math.round((count / totalMatches) * 100) : 0;
      const barPct = Math.max(4, Math.round((count / maxCount) * 100));

      listHtml += `
        <div class="file-breakdown-item ${isCurrentActive ? 'is-active' : ''}" data-file="${escapeHtml(fileName)}">
          <div class="file-breakdown-item-main">
            <svg class="file-breakdown-item-icon" width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              <polyline points="14 2 14 8 20 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <div class="file-breakdown-info">
              <div class="file-breakdown-row-top">
                <span class="file-breakdown-name" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</span>
                <span class="file-breakdown-count">${formatNumber(count)}</span>
              </div>
              <div class="file-breakdown-bar-track">
                <div class="file-breakdown-bar-fill" style="width: ${barPct}%;"></div>
              </div>
            </div>
          </div>
          <div class="file-breakdown-pct-wrap">
            <span class="file-breakdown-pct">${pct}%</span>
            ${isCurrentActive ? '<span class="file-breakdown-active-dot" title="Active selection"></span>' : ''}
          </div>
        </div>
      `;
    });

    fileBreakdownList.innerHTML = listHtml;

    // Attach click events
    fileBreakdownList.querySelectorAll('.file-breakdown-item').forEach(item => {
      item.addEventListener('click', () => {
        const file = item.dataset.file || null;
        const currentActive = ResultsRenderer.getActiveFileFilter();
        const nextFilter = (currentActive === file) ? null : file;

        ResultsRenderer.setActiveFileFilter(nextFilter);
        renderFileBreakdown();
        updateStatsText();
        closeFileBreakdown();
      });
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m]));
  }

  function clearSearch() {
    SearchClient.abort();
    setSearchBtnState(false);
    matchCount = 0;
    ResultsRenderer.clear();
    if (fileBreakdownBar) fileBreakdownBar.style.display = 'none';
    closeFileBreakdown();
    if (fileBreakdownList) fileBreakdownList.innerHTML = '';
    exportBtn.style.display = 'none';
    statsText.textContent = 'Ready — select files and start searching';
    showState('empty');
  }

  // ─── UI State Management ─────────────────────

  function showState(state) {
    emptyState.style.display = 'none';
    loadingState.style.display = 'none';
    errorState.style.display = 'none';
    resultsScroll.style.display = 'none';

    switch (state) {
      case 'empty':
        document.querySelector('.empty-title').textContent = 'Search your logs';
        document.querySelector('.empty-desc').textContent = 'Select one or more files and type a query to begin';
        emptyState.style.display = '';
        break;
      case 'empty-no-results':
        document.querySelector('.empty-title').textContent = 'No results found';
        document.querySelector('.empty-desc').textContent = 'Try a different query or adjust search options';
        emptyState.style.display = '';
        break;
      case 'loading':
        loadingState.style.display = '';
        break;
      case 'error':
        errorState.style.display = '';
        break;
      case 'results':
        resultsScroll.style.display = '';
        break;
    }
  }

  function showError(title, desc) {
    errorTitle.textContent = title;
    errorDesc.textContent = desc;
    showState('error');
  }

  function formatNumber(n) {
    if (n == null) return '0';
    return n.toLocaleString('en-US');
  }

})();

// ─── Toast Notification System ─────────────────

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-out');
    toast.addEventListener('animationend', () => toast.remove());
  }, 2500);
}
