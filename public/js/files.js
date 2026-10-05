/**
 * File list sidebar — fetches available log files, manages selection state
 */

const FileManager = (() => {
  let files = [];
  let selectedFiles = new Set();
  let onSelectionChange = null;
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
   * Initialize file manager
   * @param {Function} onChange - Callback when selection changes
   */
  function init(onChange) {
    onSelectionChange = onChange;
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
      if (data.logsDir) {
        logsDirEl.textContent = data.logsDir;
        logsDirEl.title = 'Logs directory: ' + data.logsDir;
      }

      if (files.length === 0) {
        listEl.innerHTML = '<div class="file-list-empty">No log files found</div>';
        return;
      }

      renderFileList(listEl);

      // Restore previously saved selection or default to all files
      const restored = restoreSelectionFromStorage(files);
      if (!restored) {
        files.forEach(f => selectedFiles.add(f.name));
        saveSelectionToStorage();
      }
      updateCheckboxes();
      if (onSelectionChange) onSelectionChange(getSelected());
    } catch (err) {
      listEl.innerHTML = '<div class="file-list-empty">Failed to load files</div>';
    }
  }

  /**
   * Render the file list
   */
  function renderFileList(container) {
    container.innerHTML = '';

    files.forEach(file => {
      const item = document.createElement('label');
      item.className = 'file-item';
      item.dataset.filename = file.name;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'file-checkbox';
      checkbox.checked = selectedFiles.has(file.name);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          selectedFiles.add(file.name);
          item.classList.add('selected');
        } else {
          selectedFiles.delete(file.name);
          item.classList.remove('selected');
        }
        saveSelectionToStorage();
        if (onSelectionChange) onSelectionChange(getSelected());
      });

      const info = document.createElement('div');
      info.className = 'file-info';

      const name = document.createElement('div');
      name.className = 'file-name';
      name.textContent = file.name;

      const meta = document.createElement('div');
      meta.className = 'file-meta';
      meta.innerHTML = `<span>${file.sizeMB} MB</span><span class="file-meta-dot">${formatNumber(file.estimatedLines)} lines</span>`;

      info.appendChild(name);
      info.appendChild(meta);

      item.appendChild(checkbox);
      item.appendChild(info);
      container.appendChild(item);

      // Apply initial selected state
      if (selectedFiles.has(file.name)) {
        item.classList.add('selected');
      }
    });
  }

  /**
   * Get selected file names
   */
  function getSelected() {
    return Array.from(selectedFiles);
  }

  /**
   * Select all files
   */
  function selectAll() {
    files.forEach(f => selectedFiles.add(f.name));
    saveSelectionToStorage();
    updateCheckboxes();
    if (onSelectionChange) onSelectionChange(getSelected());
  }

  /**
   * Deselect all files
   */
  function selectNone() {
    selectedFiles.clear();
    saveSelectionToStorage();
    updateCheckboxes();
    if (onSelectionChange) onSelectionChange(getSelected());
  }

  /**
   * Update checkbox UI to match selection state
   */
  function updateCheckboxes() {
    document.querySelectorAll('.file-item').forEach(item => {
      const filename = item.dataset.filename;
      const checkbox = item.querySelector('.file-checkbox');
      if (checkbox) {
        checkbox.checked = selectedFiles.has(filename);
      }
      item.classList.toggle('selected', selectedFiles.has(filename));
    });
  }

  /**
   * Format large numbers with commas
   */
  function formatNumber(n) {
    if (n == null) return '—';
    return n.toLocaleString('en-US');
  }

  return { init, loadFiles, getSelected, selectAll, selectNone };
})();
