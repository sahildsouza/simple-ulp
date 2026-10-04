/**
 * Search API client — handles streaming NDJSON responses from /api/search
 */

const SearchClient = (() => {
  let activeController = null;

  /**
   * Execute a search with streaming results
   * @param {Object} params - Search parameters
   * @param {Function} onMatch - Called for each match result
   * @param {Function} onStats - Called when search completes with stats
   * @param {Function} onError - Called on error
   * @returns {Function} Abort function
   */
  async function search(params, onMatch, onStats, onError) {
    // Abort any active search
    abort();

    const controller = new AbortController();
    activeController = controller;

    const searchId = 'search-' + Date.now();

    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, searchId }),
        signal: controller.signal
      });

      if (!response.ok) {
        const err = await response.json();
        onError(err.error || 'Search failed');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.type === 'match') {
              onMatch(data);
            } else if (data.type === 'stats') {
              onStats(data);
            } else if (data.type === 'error') {
              onError(data.message);
            }
          } catch (_) {
            // Skip malformed lines
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const data = JSON.parse(buffer);
          if (data.type === 'match') onMatch(data);
          else if (data.type === 'stats') onStats(data);
          else if (data.type === 'error') onError(data.message);
        } catch (_) {}
      }
    } catch (err) {
      if (err.name === 'AbortError') return; // Expected
      onError(err.message || 'Search failed');
    } finally {
      if (activeController === controller) {
        activeController = null;
      }
    }
  }

  /**
   * Abort the active search
   */
  function abort() {
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
  }

  /**
   * Quick count without fetching all results
   */
  async function count(params) {
    const response = await fetch('/api/count', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    if (!response.ok) throw new Error('Count failed');
    return response.json();
  }

  /**
   * Check if a search is active
   */
  function isSearching() {
    return activeController !== null;
  }

  return { search, abort, count, isSearching };
})();
