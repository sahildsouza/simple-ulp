/**
 * File list sidebar — fetches available log files, manages selection state,
 * search filtering, sorting, range selection (Shift+Click), and single-file isolation ("Only").
 */

const FileManager = (() => {
  let files = [];
  let selectedFiles = new Set();
  let onSelectionChange = null;
  let filterQuery = '';
  let sortBy = 'default'; // 'default' | 'size-desc' | 'name-asc'
  let lastClickedFilename = null;
  const STORAGE_KEY = 'ulp_selected_files';

  function saveSelectionToStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(selectedFiles)));
    } catch (_) {}
  }

  function restoreSelectionFromStorage(availableFiles) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) return false;
      const availableNames = new Set(availableFiles.map(f => f.name));
      const valid = parsed.filter(name => availableNames.has(name));
      if (valid.length > 0) {
        selectedFiles = new Set(valid);
        return true;
      }
    } catch (_) {}
    return false;
  }

  /**
   * Escape HTML to prevent injection in file titles
   */
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Format bytes to readable string (e.g. 1.25 GB, 74.9 MB)
   */
  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  /**
   * Format large numbers with commas
   */
  function formatNumber(n) {
    if (n == null) return '—';
    return n.toLocaleString('en-US');
  }

  /**
   * Initialize file manager
   * @param {Function} onChange - Callback when selection changes
   */
  function init(onChange) {
    onSelectionChange = onChange;

    // Attach search input listeners
    const searchInput = document.getElementById('fileSearchInput');
    const searchClear = document.getElementById('fileSearchClear');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        filterQuery = searchInput.value.trim().toLowerCase();
        if (searchClear) {
          searchClear.style.display = filterQuery ? 'flex' : 'none';
        }
        renderFileList();
      });
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          searchInput.value = '';
          filterQuery = '';
          if (searchClear) searchClear.style.display = 'none';
          renderFileList();
          searchInput.blur();
        }
      });
    }

    if (searchClear) {
      searchClear.addEventListener('click', () => {
        if (searchInput) {
          searchInput.value = '';
          searchInput.focus();
        }
        filterQuery = '';
        searchClear.style.display = 'none';
        renderFileList();
      });
    }

    // Attach keyboard shortcut Alt+F to focus filter
    window.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
      }
    });

    // Attach Sort button listener
    const sortBtn = document.getElementById('sortFilesBtn');
    if (sortBtn) {
      sortBtn.addEventListener('click', toggleSort);
    }

    // Attach Invert button listener
    const invertBtn = document.getElementById('invertSelection');
    if (invertBtn) {
      invertBtn.addEventListener('click', invertSelection);
    }

    loadFiles();
  }

  /**
   * Load file list from API
   */
  async function loadFiles() {
    const listEl = document.getElementById('fileList');
    const logsDirEl = document.getElementById('logsDir');

    try {
      const response = await fetch('/api/files');
      const data = await response.json();

      files = data.files || [];

      // Update logs directory badge
      if (data.logsDir && logsDirEl) {
        logsDirEl.textContent = data.logsDir;
        logsDirEl.title = 'Logs directory: ' + data.logsDir;
      }

      if (files.length === 0) {
        if (listEl) listEl.innerHTML = '<div class="file-list-empty">No log files found</div>';
        updateSummary();
        return;
      }

      // Restore previously saved selection or default to all files
      const restored = restoreSelectionFromStorage(files);
      if (!restored) {
        files.forEach(f => selectedFiles.add(f.name));
        saveSelectionToStorage();
      }

      renderFileList();
      updateSummary();
      if (onSelectionChange) onSelectionChange(getSelected());
    } catch (err) {
      if (listEl) listEl.innerHTML = '<div class="file-list-empty">Failed to load files</div>';
    }
  }

  /**
   * Filter and sort files based on current state
   */
  function getVisibleFiles() {
    let result = files;

    if (filterQuery) {
      result = result.filter(f => f.name.toLowerCase().includes(filterQuery));
    }

    if (sortBy === 'size-desc') {
      result = [...result].sort((a, b) => (b.size || 0) - (a.size || 0));
    } else if (sortBy === 'name-asc') {
      result = [...result].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    }

    return result;
  }

  /**
   * Render the file list into DOM
   */
  function renderFileList() {
    const container = document.getElementById('fileList');
    if (!container) return;

    container.innerHTML = '';

    if (files.length === 0) {
      container.innerHTML = '<div class="file-list-empty">No log files found</div>';
      updateSummary();
      return;
    }

    const visibleFiles = getVisibleFiles();

    if (visibleFiles.length === 0) {
      container.innerHTML = `<div class="file-list-empty">No files matching "${escapeHtml(filterQuery)}"</div>`;
      updateSummary();
      return;
    }

    const frag = document.createDocumentFragment();

    visibleFiles.forEach(file => {
      const isSelected = selectedFiles.has(file.name);
      const item = document.createElement('label');
      item.className = 'file-item' + (isSelected ? ' selected' : '');
      item.dataset.filename = file.name;

      // Checkbox
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'file-checkbox';
      checkbox.checked = isSelected;

      // Shift+Click range selection handler
      checkbox.addEventListener('click', (e) => {
        handleFileClick(file.name, checkbox.checked, e.shiftKey);
      });

      // SVG file icon
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'file-icon');
      icon.setAttribute('width', '14');
      icon.setAttribute('height', '14');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('fill', 'none');
      icon.innerHTML = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><polyline points="14 2 14 8 20 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';

      // File info (name & meta)
      const info = document.createElement('div');
      info.className = 'file-info';

      const name = document.createElement('div');
      name.className = 'file-name';
      name.textContent = file.name;
      name.title = file.name;

      const meta = document.createElement('div');
      meta.className = 'file-meta';
      meta.innerHTML = `<span class="file-badge-size">${file.sizeMB} MB</span><span class="file-meta-dot">·</span><span class="file-badge-lines">${formatNumber(file.estimatedLines)} lines</span>`;

      info.appendChild(name);
      info.appendChild(meta);

      // "Only" isolate button
      const onlyBtn = document.createElement('button');
      onlyBtn.type = 'button';
      onlyBtn.className = 'btn-file-only';
      onlyBtn.textContent = 'Only';
      onlyBtn.title = `Select only ${file.name}`;
      onlyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectOnly(file.name);
      });

      item.appendChild(checkbox);
      item.appendChild(icon);
      item.appendChild(info);
      item.appendChild(onlyBtn);

      frag.appendChild(item);
    });

    container.appendChild(frag);
    updateSummary();
  }

  /**
   * Handle checkbox click with Shift+Click range selection support
   */
  function handleFileClick(clickedName, isChecked, isShift) {
    const visibleFiles = getVisibleFiles();

    if (isShift && lastClickedFilename) {
      const prevIdx = visibleFiles.findIndex(f => f.name === lastClickedFilename);
      const currIdx = visibleFiles.findIndex(f => f.name === clickedName);

      if (prevIdx !== -1 && currIdx !== -1) {
        const start = Math.min(prevIdx, currIdx);
        const end = Math.max(prevIdx, currIdx);
        for (let i = start; i <= end; i++) {
          const fn = visibleFiles[i].name;
          if (isChecked) {
            selectedFiles.add(fn);
          } else {
            selectedFiles.delete(fn);
          }
        }
      }
    } else {
      if (isChecked) {
        selectedFiles.add(clickedName);
      } else {
        selectedFiles.delete(clickedName);
      }
    }

    lastClickedFilename = clickedName;
    saveSelectionToStorage();
    updateCheckboxes();
    updateSummary();
    if (onSelectionChange) onSelectionChange(getSelected());
  }

  /**
   * Select only this single file and deselect all others
   */
  function selectOnly(filename) {
    selectedFiles.clear();
    selectedFiles.add(filename);
    lastClickedFilename = filename;
    saveSelectionToStorage();
    updateCheckboxes();
    updateSummary();
    if (onSelectionChange) onSelectionChange(getSelected());
  }

  /**
   * Update header count badge and summary bar
   */
  function updateSummary() {
    const countBadge = document.getElementById('fileCountBadge');
    if (countBadge) {
      countBadge.textContent = String(files.length);
    }

    const summaryText = document.getElementById('fileSummaryText');
    const summarySize = document.getElementById('fileSummarySize');

    const totalSelected = selectedFiles.size;
    const totalFiles = files.length;

    let selectedBytes = 0;
    files.forEach(f => {
      if (selectedFiles.has(f.name)) {
        selectedBytes += (f.size || 0);
      }
    });

    if (summaryText) {
      if (filterQuery) {
        const visibleCount = getVisibleFiles().length;
        summaryText.textContent = `${totalSelected} of ${totalFiles} sel (${visibleCount} match)`;
      } else if (totalSelected === totalFiles && totalFiles > 0) {
        summaryText.textContent = `All ${totalFiles} files selected`;
      } else if (totalSelected === 0) {
        summaryText.textContent = '0 files selected';
      } else {
        summaryText.textContent = `${totalSelected} of ${totalFiles} selected`;
      }
    }

    if (summarySize) {
      summarySize.textContent = formatBytes(selectedBytes);
    }
  }

  /**
   * Update checkbox and visual selected state without full DOM recreation
   */
  function updateCheckboxes() {
    document.querySelectorAll('.file-item').forEach(item => {
      const filename = item.dataset.filename;
      const checkbox = item.querySelector('.file-checkbox');
      const isSelected = selectedFiles.has(filename);
      if (checkbox) {
        checkbox.checked = isSelected;
      }
      item.classList.toggle('selected', isSelected);
    });
    updateSummary();
  }

  /**
   * Get selected file names
   */
  function getSelected() {
    return Array.from(selectedFiles);
  }

  /**
   * Select all files (or all visible matching files if search filter active)
   */
  function selectAll() {
    const targetFiles = filterQuery ? getVisibleFiles() : files;
    targetFiles.forEach(f => selectedFiles.add(f.name));
    saveSelectionToStorage();
    updateCheckboxes();
    if (onSelectionChange) onSelectionChange(getSelected());
  }

  /**
   * Deselect all files (or all visible matching files if search filter active)
   */
  function selectNone() {
    if (filterQuery) {
      const visible = getVisibleFiles();
      visible.forEach(f => selectedFiles.delete(f.name));
    } else {
      selectedFiles.clear();
    }
    saveSelectionToStorage();
    updateCheckboxes();
    if (onSelectionChange) onSelectionChange(getSelected());
  }

  /**
   * Invert selection of files (or visible matching files if search filter active)
   */
  function invertSelection() {
    const targetFiles = filterQuery ? getVisibleFiles() : files;
    targetFiles.forEach(f => {
      if (selectedFiles.has(f.name)) {
        selectedFiles.delete(f.name);
      } else {
        selectedFiles.add(f.name);
      }
    });
    saveSelectionToStorage();
    updateCheckboxes();
    if (onSelectionChange) onSelectionChange(getSelected());
  }

  /**
   * Toggle sort order: default -> size-desc -> name-asc -> default
   */
  function toggleSort() {
    const sortBtn = document.getElementById('sortFilesBtn');
    if (sortBy === 'default') {
      sortBy = 'size-desc';
      if (sortBtn) {
        sortBtn.classList.add('active');
        sortBtn.title = 'Sorted by Size (Largest first) — click for Name';
      }
    } else if (sortBy === 'size-desc') {
      sortBy = 'name-asc';
      if (sortBtn) {
        sortBtn.classList.add('active');
        sortBtn.title = 'Sorted by Name (A-Z) — click for Default';
      }
    } else {
      sortBy = 'default';
      if (sortBtn) {
        sortBtn.classList.remove('active');
        sortBtn.title = 'Sort files: Natural / Size / Name';
      }
    }
    renderFileList();
  }

  return {
    init,
    loadFiles,
    getSelected,
    selectAll,
    selectNone,
    invertSelection,
    toggleSort,
    selectOnly
  };
})();
