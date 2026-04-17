(function () {
  'use strict';

  let btn = null;
  let overlay = null;
  let activityData = null;
  let currentTheme = 'light';
  let allPayloadsLoaded = false;
  let currentInstanceId = null;

  const THEMES = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'high-contrast', label: 'High Contrast' },
    { id: 'solarized', label: 'Solarized' }
  ];

  function applyTheme(themeId) {
    currentTheme = themeId;
    if (overlay) overlay.dataset.theme = themeId;
    chrome.storage.local.set({ viewerTheme: themeId });
  }

  function loadTheme(callback) {
    chrome.storage.local.get(['viewerTheme'], (data) => {
      currentTheme = data.viewerTheme || 'light';
      if (callback) callback(currentTheme);
    });
  }

  function getIntegrationInstance() {
    const u = new URL(location.href);
    return u.searchParams.get('integrationInstance') || '';
  }

  function detectInstanceIdFromPage() {
    // 1. Look for "Instance ID: xxx" in the Activity Stream panel header
    const allText = document.body.innerText;
    const m = allText.match(/Instance ID:\s*([A-Za-z0-9_-]{10,})/);
    if (m) return m[1];

    // 2. Look for copy-instance-id button and read adjacent text
    const copyBtns = document.querySelectorAll('[aria-label*="Copy instance"], [title*="Copy instance"]');
    for (const cb of copyBtns) {
      const prev = cb.previousElementSibling;
      if (prev && prev.textContent.trim().length > 8)
        return prev.textContent.trim().replace(/^Instance ID:\s*/, '');
    }

    // 3. Look in URL hash/params for instance ID patterns
    const urlMatch = location.href.match(/[?&#]id=([A-Za-z0-9_-]{10,})/);
    if (urlMatch) return urlMatch[1];

    // 4. Look for selected row in instances table with an ID cell
    const cells = document.querySelectorAll('td[role="gridcell"], [role="cell"]');
    for (const cell of cells) {
      const text = cell.textContent.trim();
      if (/^[A-Za-z0-9_-]{20,}$/.test(text)) return text;
    }

    // 5. Last resort: ask the user
    const input = prompt('Could not auto-detect Instance ID.\nPaste the Instance ID here:');
    return input ? input.trim() : null;
  }

  function injectButton() {
    if (btn) return;
    btn = document.createElement('button');
    btn.id = 'oic-enhanced-viewer-btn';
    btn.textContent = 'Enhanced Activity View';
    btn.addEventListener('click', openEnhancedViewer);
    document.body.appendChild(btn);
  }

  function showButton() {
    if (!btn) injectButton();
    btn.style.display = 'block';
  }

  function hideButton() {
    if (btn) btn.style.display = 'none';
  }

  function watchForActivityStream() {
    // Load settings: auto-detect button + theme
    chrome.storage.local.get(['autoDetect', 'viewerTheme'], (data) => {
      if (data.autoDetect) enableAutoDetectButton();
      if (data.viewerTheme) currentTheme = data.viewerTheme;
    });
  }

  function enableAutoDetectButton() {
    const tryShow = () => {
      if (document.body) showButton();
      else setTimeout(tryShow, 500);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryShow);
    } else {
      tryShow();
    }
  }

  async function fetchActivityStream(instanceId) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const inst = getIntegrationInstance();
    const url = `${location.origin}/ic/api/integration/v1/monitoring/instances/${encodeURIComponent(instanceId)}/activityStreamDetails?timezone=${encodeURIComponent(tz)}&integrationInstance=${encodeURIComponent(inst)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    return resp.json();
  }

  async function fetchPayload(payloadHref) {
    const resp = await fetch(payloadHref);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.text();
  }

  function countNodes(items) {
    let c = items.length;
    for (const item of items) {
      if (item.children) c += countNodes(item.children);
    }
    return c;
  }

  function countPayloads(items) {
    let c = 0;
    for (const item of items) {
      if (item.payloadExists) c++;
      if (item.children) c += countPayloads(item.children);
    }
    return c;
  }

  // Collect all items that have large payloads (need fetching)
  function collectLargePayloadItems(items) {
    const result = [];
    function walk(list) {
      for (const item of list) {
        if (item.payloadExists && !item.payload && item.links) {
          const link = item.links.find(l => l.rel === 'payload');
          if (link) result.push({ item, href: link.href });
        }
        if (item.children) walk(item.children);
      }
    }
    walk(items);
    return result;
  }

  async function downloadAllPayloads(progressCallback) {
    const toFetch = collectLargePayloadItems(activityData.items);
    const total = toFetch.length;
    if (total === 0) {
      allPayloadsLoaded = true;
      if (progressCallback) progressCallback(0, 0, true);
      return;
    }

    let done = 0;
    let errors = 0;
    const CONCURRENCY = 6;

    // Process in batches
    for (let i = 0; i < total; i += CONCURRENCY) {
      const batch = toFetch.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async ({ item, href }) => {
          const text = await fetchPayload(href);
          item.payload = text;
        })
      );
      for (const r of results) {
        done++;
        if (r.status === 'rejected') errors++;
      }
      if (progressCallback) progressCallback(done, total, false, errors);
    }

    allPayloadsLoaded = true;
    if (progressCallback) progressCallback(done, total, true, errors);
  }

  function formatPayload(text, mediaType) {
    if (!text) return '';
    if (mediaType && mediaType.includes('json')) {
      try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return text; }
    }
    if (mediaType && mediaType.includes('xml')) {
      return formatXml(text);
    }
    return text;
  }

  function formatXml(xml) {
    let formatted = '';
    let indent = 0;
    const parts = xml.replace(/(>)\s*(<)/g, '$1\n$2').split('\n');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('</')) indent--;
      formatted += '  '.repeat(Math.max(0, indent)) + trimmed + '\n';
      if (trimmed.startsWith('<') && !trimmed.startsWith('</') && !trimmed.endsWith('/>') && !trimmed.includes('</')) indent++;
    }
    return formatted.trim();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatPayloadWithLineNumbers(text, mediaType) {
    const formatted = formatPayload(text, mediaType);
    const lines = formatted.split('\n');
    return lines.map((line, i) =>
      `<span class="oic-ev-payload-line"><span class="oic-ev-line-num">${i + 1}</span>${escapeHtml(line)}</span>`
    ).join('');
  }

  // ── Lazy tree rendering ──────────────────────────────────────────────
  // Children DOM elements are only created the first time a node is expanded.
  // This keeps initial render fast even for 16K+ node trees.

  function renderNode(item, depth) {
    const hasChildren = item.children && item.children.length > 0;
    const isError = item.isErrorMilestone;
    const startExpanded = depth < 2;

    const node = document.createElement('div');
    node.className = 'oic-ev-node';
    node.dataset.identifier = item.identifier || '';
    node.dataset.milestone = item.milestone || '';
    // Store data reference for lazy rendering & search
    node._itemData = item;
    node._depth = depth;
    node._childrenRendered = false;

    // Header row
    const header = document.createElement('div');
    header.className = 'oic-ev-node-header' + (isError ? ' oic-ev-error' : '');
    header.style.paddingLeft = (depth * 4) + 'px';

    // Toggle
    const toggle = document.createElement('span');
    toggle.className = 'oic-ev-toggle' + (hasChildren ? '' : ' oic-ev-leaf');
    toggle.textContent = hasChildren ? (startExpanded ? '\u25BC' : '\u25B6') : '';
    header.appendChild(toggle);

    // Status icon
    const statusIcon = document.createElement('span');
    statusIcon.className = 'oic-ev-status-icon ' + (isError ? 'oic-ev-err' : 'oic-ev-ok');
    statusIcon.textContent = isError ? '\u2716' : '\u2714';
    header.appendChild(statusIcon);

    // Time
    if (item.modifiedTimestamp) {
      const time = document.createElement('span');
      time.className = 'oic-ev-time';
      time.textContent = item.modifiedTimestamp;
      header.appendChild(time);
    }

    // Elapsed
    if (item.elapsedTime) {
      const elapsed = document.createElement('span');
      elapsed.className = 'oic-ev-elapsed';
      elapsed.textContent = item.elapsedTime;
      header.appendChild(elapsed);
    }

    // Message
    const msg = document.createElement('span');
    msg.className = 'oic-ev-message';
    let msgText = escapeHtml(item.message || '');
    if (item.totalIterations) {
      msgText += ` <span class="oic-ev-iter-badge">${escapeHtml(item.totalIterations)} iterations</span>`;
    }
    if (item.loopIterations && !(item.message || '').startsWith('Iteration:')) {
      msgText += ` <span class="oic-ev-iter-badge">iter ${escapeHtml(item.loopIterations)}</span>`;
    }
    if (item.adapter) {
      msgText += ` <span class="oic-ev-adapter-badge">${escapeHtml(item.adapter)}</span>`;
    }
    if (item.invokedBy) {
      msgText += ` <span style="color:#64748b;font-size:11px"> by ${escapeHtml(item.invokedBy)}</span>`;
    }
    msg.innerHTML = msgText;
    header.appendChild(msg);

    // Payload button — show if payloadExists OR if inline payload content is present
    if (item.payloadExists || item.payload) {
      const payBtn = document.createElement('button');
      const isLargePayload = item.payloadExists && !item.payload;
      payBtn.className = 'oic-ev-payload-btn' + (isLargePayload ? ' oic-ev-download' : '');
      if (isLargePayload) {
        const sizeKb = item.payloadSize ? (parseInt(item.payloadSize) / 1024).toFixed(1) : '?';
        payBtn.textContent = `Download (${sizeKb} KB)`;
      } else {
        payBtn.textContent = 'Payload';
      }
      payBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePayload(item, node);
      });
      header.appendChild(payBtn);
    }

    // Error Details button
    if (item.errorDetails) {
      const errBtn = document.createElement('button');
      errBtn.className = 'oic-ev-payload-btn oic-ev-error-detail-btn';
      errBtn.textContent = 'Error Details';
      errBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleTextBlock(item.errorDetails, 'oic-ev-error-details', node, item.payloadMediaType);
      });
      header.appendChild(errBtn);
    }

    // Error Summary button (only if different from errorDetails)
    if (item.errorSummary && item.errorSummary !== item.errorDetails) {
      const sumBtn = document.createElement('button');
      sumBtn.className = 'oic-ev-payload-btn oic-ev-error-detail-btn';
      sumBtn.textContent = 'Error Summary';
      sumBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleTextBlock(item.errorSummary, 'oic-ev-error-summary', node, item.payloadMediaType);
      });
      header.appendChild(sumBtn);
    }

    node.appendChild(header);

    // Children container – lazy: only populate on first expand
    if (hasChildren) {
      const childContainer = document.createElement('div');
      childContainer.className = 'oic-ev-children' + (startExpanded ? '' : ' oic-ev-collapsed');
      node.appendChild(childContainer);

      if (startExpanded) {
        // Render children immediately for top levels
        materializeChildren(node);
      }

      const toggleFn = (e) => {
        e.stopPropagation();
        const isCollapsed = childContainer.classList.contains('oic-ev-collapsed');
        if (isCollapsed) {
          materializeChildren(node); // lazy render on first expand
          childContainer.classList.remove('oic-ev-collapsed');
          toggle.textContent = '\u25BC';
        } else {
          childContainer.classList.add('oic-ev-collapsed');
          toggle.textContent = '\u25B6';
        }
      };
      toggle.addEventListener('click', toggleFn);
      header.addEventListener('click', toggleFn);
    }

    return node;
  }

  function materializeChildren(nodeEl) {
    if (nodeEl._childrenRendered) return;
    nodeEl._childrenRendered = true;
    const item = nodeEl._itemData;
    const depth = nodeEl._depth;
    const childContainer = nodeEl.querySelector(':scope > .oic-ev-children');
    if (!childContainer || !item.children) return;
    const frag = document.createDocumentFragment();
    for (const child of item.children) {
      frag.appendChild(renderNode(child, depth + 1));
    }
    childContainer.appendChild(frag);
  }

  function toggleTextBlock(text, cssClass, nodeEl, mediaType) {
    const existing = nodeEl.querySelector(':scope > .' + cssClass);
    if (existing) { existing.remove(); return; }

    const container = document.createElement('div');
    container.className = 'oic-ev-payload-content ' + cssClass;

    const actions = document.createElement('div');
    actions.className = 'oic-ev-payload-actions';
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => copyBtn.textContent = 'Copy', 1500);
      });
    });
    actions.appendChild(copyBtn);
    const expandBtn = document.createElement('button');
    expandBtn.textContent = 'Full height';
    expandBtn.addEventListener('click', () => {
      container.classList.toggle('oic-ev-expanded-payload');
      expandBtn.textContent = container.classList.contains('oic-ev-expanded-payload') ? 'Limit height' : 'Full height';
    });
    actions.appendChild(expandBtn);
    container.appendChild(actions);

    const codeEl = document.createElement('code');
    codeEl.innerHTML = formatPayloadWithLineNumbers(text, mediaType);
    container.appendChild(codeEl);

    const afterEl = nodeEl.querySelector('.oic-ev-node-header');
    afterEl.after(container);
  }

  async function togglePayload(item, nodeEl) {
    const existing = nodeEl.querySelector(':scope > .oic-ev-payload-content');
    const existingHeaders = nodeEl.querySelector(':scope > .oic-ev-payload-headers');
    if (existing) {
      existing.remove();
      if (existingHeaders) existingHeaders.remove();
      return;
    }

    let payloadText = item.payload || null;

    // Large payload – fetch via link
    if (!payloadText && item.links) {
      const payloadLink = item.links.find(l => l.rel === 'payload');
      if (payloadLink) {
        const loader = document.createElement('div');
        loader.className = 'oic-ev-payload-content';
        loader.textContent = 'Loading payload...';
        nodeEl.querySelector('.oic-ev-node-header').after(loader);
        try {
          payloadText = await fetchPayload(payloadLink.href);
        } catch (err) {
          loader.textContent = 'Error loading payload: ' + err.message;
          return;
        }
        loader.remove();
      }
    }

    if (!payloadText) return;

    // HTTP headers
    if (item.payloadHeaders) {
      const headersEl = document.createElement('div');
      headersEl.className = 'oic-ev-payload-headers';
      headersEl.textContent = item.payloadHeaders;
      nodeEl.querySelector('.oic-ev-node-header').after(headersEl);
    }

    const container = document.createElement('div');
    container.className = 'oic-ev-payload-content';

    const actions = document.createElement('div');
    actions.className = 'oic-ev-payload-actions';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(payloadText).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => copyBtn.textContent = 'Copy', 1500);
      });
    });
    actions.appendChild(copyBtn);

    const expandBtn = document.createElement('button');
    expandBtn.textContent = 'Full height';
    expandBtn.addEventListener('click', () => {
      container.classList.toggle('oic-ev-expanded-payload');
      expandBtn.textContent = container.classList.contains('oic-ev-expanded-payload') ? 'Limit height' : 'Full height';
    });
    actions.appendChild(expandBtn);

    container.appendChild(actions);

    const codeEl = document.createElement('code');
    codeEl.innerHTML = formatPayloadWithLineNumbers(payloadText, item.payloadMediaType);
    container.appendChild(codeEl);

    const afterEl = nodeEl.querySelector(':scope > .oic-ev-payload-headers') || nodeEl.querySelector('.oic-ev-node-header');
    afterEl.after(container);
  }

  // ── Expand / Collapse helpers ────────────────────────────────────────

  function expandAll(container) {
    // Materialize + expand everything (can be slow for huge trees, but user asked for it)
    container.querySelectorAll('.oic-ev-node').forEach(n => {
      if (n._itemData && n._itemData.children && n._itemData.children.length > 0) {
        materializeChildren(n);
        const cc = n.querySelector(':scope > .oic-ev-children');
        if (cc) cc.classList.remove('oic-ev-collapsed');
        const t = n.querySelector(':scope > .oic-ev-node-header > .oic-ev-toggle');
        if (t && !t.classList.contains('oic-ev-leaf')) t.textContent = '\u25BC';
      }
    });
  }

  function collapseAll(container) {
    container.querySelectorAll('.oic-ev-children').forEach(el => {
      el.classList.add('oic-ev-collapsed');
    });
    container.querySelectorAll('.oic-ev-toggle').forEach(el => {
      if (!el.classList.contains('oic-ev-leaf')) el.textContent = '\u25B6';
    });
  }

  function expandToLevel(container, level) {
    container.querySelectorAll('.oic-ev-node').forEach(nodeEl => {
      if (!nodeEl._itemData || !nodeEl._itemData.children || !nodeEl._itemData.children.length) return;
      const depth = nodeEl._depth || 0;
      const cc = nodeEl.querySelector(':scope > .oic-ev-children');
      const toggle = nodeEl.querySelector(':scope > .oic-ev-node-header > .oic-ev-toggle');
      if (!cc || !toggle) return;
      if (depth < level) {
        materializeChildren(nodeEl);
        cc.classList.remove('oic-ev-collapsed');
        toggle.textContent = '\u25BC';
      } else {
        cc.classList.add('oic-ev-collapsed');
        toggle.textContent = '\u25B6';
      }
    });
  }

  // ── Search ───────────────────────────────────────────────────────────
  // Searches the raw data tree (not DOM) so it works even for un-rendered nodes.

  let searchMatches = [];     // ordered array of matching identifiers
  let searchMatchSet = null;  // Set for quick lookup
  let searchCurrentIdx = -1;  // current navigation index

  function searchDataTree(items, query) {
    const q = query.toLowerCase();
    const matches = [];
    function walk(list) {
      for (const item of list) {
        let text = (item.message || '') + ' ' + (item.modifiedTimestamp || '') + ' ' + (item.modifiedTimestampDesc || '');
        if (item.payload) text += ' ' + item.payload;
        if (item.errorDetails) text += ' ' + item.errorDetails;
        if (item.errorSummary) text += ' ' + item.errorSummary;
        if (text.toLowerCase().includes(q)) matches.push(item.identifier);
        if (item.children) walk(item.children);
      }
    }
    walk(items);
    return matches;
  }

  // Find the ancestor path (list of identifiers from root to parent of target)
  function findPathInDataTree(items, targetId) {
    function walk(list, path) {
      for (const item of list) {
        if (item.identifier === targetId) return path;
        if (item.children) {
          const result = walk(item.children, [...path, item.identifier]);
          if (result) return result;
        }
      }
      return null;
    }
    return walk(items, []);
  }

  // Ensure a node is materialized and visible in the DOM by expanding its ancestor chain
  function ensureNodeVisible(tree, identifier) {
    let nodeEl = tree.querySelector(`.oic-ev-node[data-identifier="${CSS.escape(identifier)}"]`);
    if (nodeEl) {
      expandAncestorChain(nodeEl, tree);
      return nodeEl;
    }

    // Node not in DOM — materialize its ancestor path
    const path = findPathInDataTree(activityData.items, identifier);
    if (!path) return null;

    for (const pathId of path) {
      const pathNode = tree.querySelector(`.oic-ev-node[data-identifier="${CSS.escape(pathId)}"]`);
      if (pathNode) {
        materializeChildren(pathNode);
        const cc = pathNode.querySelector(':scope > .oic-ev-children');
        if (cc) {
          cc.classList.remove('oic-ev-collapsed');
          const t = pathNode.querySelector(':scope > .oic-ev-node-header > .oic-ev-toggle');
          if (t && !t.classList.contains('oic-ev-leaf')) t.textContent = '\u25BC';
        }
      }
    }

    nodeEl = tree.querySelector(`.oic-ev-node[data-identifier="${CSS.escape(identifier)}"]`);
    if (nodeEl) expandAncestorChain(nodeEl, tree);
    return nodeEl;
  }

  function expandAncestorChain(nodeEl, container) {
    let parent = nodeEl.parentElement;
    while (parent && parent !== container) {
      if (parent.classList.contains('oic-ev-children') && parent.classList.contains('oic-ev-collapsed')) {
        parent.classList.remove('oic-ev-collapsed');
        const pNode = parent.parentElement;
        if (pNode) {
          materializeChildren(pNode);
          const t = pNode.querySelector(':scope > .oic-ev-node-header > .oic-ev-toggle');
          if (t) t.textContent = '\u25BC';
        }
      }
      parent = parent.parentElement;
    }
  }

  function highlightSearch(container, matchIds) {
    container.querySelectorAll('.oic-ev-node-header.oic-ev-highlighted').forEach(h => h.classList.remove('oic-ev-highlighted'));
    container.querySelectorAll('.oic-ev-node-header.oic-ev-current-match').forEach(h => h.classList.remove('oic-ev-current-match'));
    if (!matchIds || matchIds.size === 0) return;

    // Highlight all matches that are currently in the DOM
    container.querySelectorAll('.oic-ev-node').forEach(nodeEl => {
      const id = nodeEl.dataset.identifier;
      if (matchIds.has(id)) {
        const header = nodeEl.querySelector(':scope > .oic-ev-node-header');
        if (header) header.classList.add('oic-ev-highlighted');
        expandAncestorChain(nodeEl, container);
      }
    });
  }

  function navigateToMatch(tree, direction) {
    if (searchMatches.length === 0) return;

    // Remove current match highlight
    const prev = tree.querySelector('.oic-ev-node-header.oic-ev-current-match');
    if (prev) prev.classList.remove('oic-ev-current-match');

    // Move index
    if (direction === 'next') {
      searchCurrentIdx = (searchCurrentIdx + 1) % searchMatches.length;
    } else {
      searchCurrentIdx = (searchCurrentIdx - 1 + searchMatches.length) % searchMatches.length;
    }

    const targetId = searchMatches[searchCurrentIdx];
    const nodeEl = ensureNodeVisible(tree, targetId);
    if (nodeEl) {
      const header = nodeEl.querySelector(':scope > .oic-ev-node-header');
      if (header) {
        header.classList.add('oic-ev-current-match');
        header.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    updateSearchCounter();
  }

  function updateSearchCounter() {
    if (!overlay) return;
    const countEl = overlay.querySelector('#oic-ev-search-count');
    if (!countEl) return;
    if (searchMatches.length === 0) {
      countEl.textContent = '';
    } else if (searchCurrentIdx >= 0) {
      countEl.textContent = `${searchCurrentIdx + 1} / ${searchMatches.length.toLocaleString()}`;
    } else {
      countEl.textContent = `${searchMatches.length.toLocaleString()} matches`;
    }
  }

  // ── Export / Import ─────────────────────────────────────────────────

  async function exportActivityData(instanceId) {
    if (!activityData) return;

    const largeRemaining = collectLargePayloadItems(activityData.items);
    if (largeRemaining.length > 0) {
      const download = confirm(
        `${largeRemaining.length.toLocaleString()} payloads have not been downloaded yet.\n\n` +
        `Click OK to download them before exporting (recommended).\n` +
        `Click Cancel to export without them (links only).`
      );
      if (download) {
        const progressEl = overlay && overlay.querySelector('#oic-ev-download-progress');
        const dlBtn = overlay && overlay.querySelector('#oic-ev-download-all');
        if (dlBtn) {
          dlBtn.disabled = true;
          dlBtn.textContent = 'Downloading...';
        }
        await downloadAllPayloads((done, total, finished, errors) => {
          if (progressEl) {
            if (finished) {
              const errText = errors ? ` (${errors} failed)` : '';
              progressEl.textContent = `${done.toLocaleString()} payloads loaded${errText}`;
              if (dlBtn) {
                dlBtn.textContent = 'All Downloaded';
                dlBtn.classList.add('oic-ev-download-done');
              }
            } else {
              progressEl.textContent = `${done.toLocaleString()} / ${total.toLocaleString()}`;
            }
          }
        });
      }
    }

    // Build JSON in chunks to avoid V8 string length limit with large payloads
    const meta = {
      exportDate: new Date().toISOString(),
      instanceId: instanceId || activityData.id || '',
      flowCode: activityData.flowCode || '',
      flowVersion: activityData.flowVersion || '',
      exportVersion: '1.0'
    };

    const parts = ['{"_exportMeta":', JSON.stringify(meta)];

    // Serialize all top-level keys except "items"
    for (const key of Object.keys(activityData)) {
      if (key === 'items') continue;
      parts.push(',' + JSON.stringify(key) + ':');
      parts.push(JSON.stringify(activityData[key]));
    }

    // Serialize items one by one to keep each string small
    parts.push(',"items":[');
    for (let i = 0; i < activityData.items.length; i++) {
      if (i > 0) parts.push(',');
      parts.push(JSON.stringify(activityData.items[i]));
    }
    parts.push(']}');

    const blob = new Blob(parts, { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const filename = `oic-activity-${(instanceId || 'export').substring(0, 30)}-${new Date().toISOString().slice(0, 10)}.json`;
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importActivityData(callback) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (!data.items || !Array.isArray(data.items)) {
            alert('Invalid export file: missing items array.');
            return;
          }
          callback(data);
        } catch (e) {
          alert('Failed to parse JSON file: ' + e.message);
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  function openImportedData(data) {
    const meta = data._exportMeta || {};
    const instanceId = meta.instanceId || 'imported';

    // Clean up meta field from activityData
    activityData = { ...data };
    delete activityData._exportMeta;

    allPayloadsLoaded = collectLargePayloadItems(activityData.items).length === 0;

    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'oic-ev-overlay';
      overlay.dataset.theme = currentTheme;
      document.body.appendChild(overlay);
      document.addEventListener('keydown', escHandler);
    }

    renderActivityView(instanceId);
  }

  // ── Main viewer ──────────────────────────────────────────────────────

  async function openEnhancedViewer() {
    // Called from floating button – uses auto-detect
    const instanceId = detectInstanceIdFromPage();
    if (!instanceId) return;
    await openEnhancedViewerWithId(instanceId);
  }

  function renderActivityView(instanceId) {
    currentInstanceId = instanceId;
    const totalNodes = countNodes(activityData.items);
    const totalPayloads = countPayloads(activityData.items);

    overlay.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'oic-ev-header';
    const themeOptions = THEMES.map(t =>
      `<option value="${t.id}"${t.id === currentTheme ? ' selected' : ''}>${t.label}</option>`
    ).join('');

    header.innerHTML = `
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px">
        <h2>Enhanced Activity Stream</h2>
        <span class="oic-ev-header-info">${escapeHtml(activityData.flowCode || '')} | ${escapeHtml(activityData.flowVersion || '')}</span>
        <span class="oic-ev-header-info">Instance: ${escapeHtml(instanceId)}</span>
        <span class="oic-ev-header-info">Tracing: ${escapeHtml(activityData.tracingLevel || 'N/A')}</span>
      </div>
      <div class="oic-ev-header-actions">
        <select id="oic-ev-theme-select" class="oic-ev-theme-select" title="Color theme">${themeOptions}</select>
        <button id="oic-ev-refresh" title="Re-fetch activity stream from server">Refresh</button>
        <button id="oic-ev-export" title="Export activity data as JSON">Export</button>
        <button id="oic-ev-import" title="Import previously exported JSON">Import</button>
        <span class="oic-ev-header-sep"></span>
        <button id="oic-ev-expand-all">Expand All</button>
        <button id="oic-ev-collapse-all">Collapse All</button>
        <button id="oic-ev-expand-1">Level 1</button>
        <button id="oic-ev-expand-2">Level 2</button>
        <button id="oic-ev-expand-3">Level 3</button>
        <button class="oic-ev-close-btn" id="oic-ev-close">Close (Esc)</button>
      </div>
    `;
    // Sticky top bar: header + errors + status + search
    const topBar = document.createElement('div');
    topBar.className = 'oic-ev-top-bar';

    topBar.appendChild(header);

    // Error banner
    if (activityData.errorItems && activityData.errorItems.length > 0) {
      for (const err of activityData.errorItems) {
        const banner = document.createElement('div');
        banner.className = 'oic-ev-error-banner';
        banner.innerHTML = `<span class="oic-ev-error-icon">\u26D4</span> ${escapeHtml(err.message)}`;
        topBar.appendChild(banner);
      }
    }

    // Status bar
    const largePayloads = collectLargePayloadItems(activityData.items);
    const statusBar = document.createElement('div');
    statusBar.className = 'oic-ev-status-bar';
    statusBar.innerHTML = `
      <span>Total activities: <strong>${totalNodes.toLocaleString()}</strong></span>
      <span>Payloads: <strong>${totalPayloads.toLocaleString()}</strong></span>
      <span>Top-level items: <strong>${activityData.items.length}</strong></span>
      ${largePayloads.length > 0 ? `<button id="oic-ev-download-all" class="oic-ev-download-all-btn">Download All Payloads (${largePayloads.length.toLocaleString()})</button>` : '<span style="color:var(--ev-ok-text)">All payloads inline</span>'}
      <span id="oic-ev-download-progress" class="oic-ev-download-progress"></span>
    `;
    topBar.appendChild(statusBar);

    // Search bar
    const searchBar = document.createElement('div');
    searchBar.className = 'oic-ev-search-bar';
    searchBar.innerHTML = `
      <input type="text" id="oic-ev-search" placeholder="Search messages, variables, timestamps...">
      <button class="oic-ev-search-nav" id="oic-ev-search-prev" title="Previous match (Shift+Enter)">\u25B2</button>
      <button class="oic-ev-search-nav" id="oic-ev-search-next" title="Next match (Enter)">\u25BC</button>
      <span class="oic-ev-search-count" id="oic-ev-search-count"></span>
    `;
    topBar.appendChild(searchBar);

    overlay.appendChild(topBar);

    // Tree
    const tree = document.createElement('div');
    tree.className = 'oic-ev-tree';
    tree.id = 'oic-ev-tree';

    for (const item of activityData.items) {
      tree.appendChild(renderNode(item, 0));
    }
    overlay.appendChild(tree);

    // Event handlers
    overlay.querySelector('#oic-ev-theme-select').addEventListener('change', (e) => {
      applyTheme(e.target.value);
    });
    overlay.querySelector('#oic-ev-refresh').addEventListener('click', async () => {
      const refreshBtn = overlay.querySelector('#oic-ev-refresh');
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Refreshing...';
      try {
        allPayloadsLoaded = false;
        activityData = await fetchActivityStream(instanceId);
        renderActivityView(instanceId);
      } catch (err) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh';
        alert('Refresh failed: ' + err.message);
      }
    });
    overlay.querySelector('#oic-ev-export').addEventListener('click', () => {
      exportActivityData(instanceId);
    });
    overlay.querySelector('#oic-ev-import').addEventListener('click', () => {
      importActivityData(openImportedData);
    });
    overlay.querySelector('#oic-ev-close').addEventListener('click', closeViewer);
    overlay.querySelector('#oic-ev-expand-all').addEventListener('click', () => {
      if (totalNodes > 5000 && !confirm(`This will render all ${totalNodes.toLocaleString()} nodes. Continue?`)) return;
      expandAll(tree);
    });
    overlay.querySelector('#oic-ev-collapse-all').addEventListener('click', () => collapseAll(tree));
    overlay.querySelector('#oic-ev-expand-1').addEventListener('click', () => expandToLevel(tree, 1));
    overlay.querySelector('#oic-ev-expand-2').addEventListener('click', () => expandToLevel(tree, 2));
    overlay.querySelector('#oic-ev-expand-3').addEventListener('click', () => expandToLevel(tree, 3));

    // Download all payloads button
    const dlBtn = overlay.querySelector('#oic-ev-download-all');
    if (dlBtn) {
      dlBtn.addEventListener('click', async () => {
        dlBtn.disabled = true;
        dlBtn.textContent = 'Downloading...';
        const progressEl = overlay.querySelector('#oic-ev-download-progress');
        await downloadAllPayloads((done, total, finished, errors) => {
          if (finished) {
            dlBtn.textContent = 'All Downloaded';
            dlBtn.classList.add('oic-ev-download-done');
            const errText = errors ? ` (${errors} failed)` : '';
            progressEl.textContent = `${done.toLocaleString()} payloads loaded${errText}`;
            // Re-run active search to include payload content
            const q = overlay.querySelector('#oic-ev-search').value.trim();
            if (q) {
              searchMatches = searchDataTree(activityData.items, q);
              searchMatchSet = new Set(searchMatches);
              searchCurrentIdx = -1;
              highlightSearch(tree, searchMatchSet);
              updateSearchCounter();
            }
          } else {
            progressEl.textContent = `${done.toLocaleString()} / ${total.toLocaleString()}`;
          }
        });
      });
    }

    let searchTimeout;
    const searchInput = overlay.querySelector('#oic-ev-search');

    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        const q = e.target.value.trim();
        if (!q) {
          searchMatches = [];
          searchMatchSet = null;
          searchCurrentIdx = -1;
          highlightSearch(tree, null);
          updateSearchCounter();
          return;
        }
        searchMatches = searchDataTree(activityData.items, q);
        searchMatchSet = new Set(searchMatches);
        searchCurrentIdx = -1;
        highlightSearch(tree, searchMatchSet);
        updateSearchCounter();
      }, 400);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        navigateToMatch(tree, e.shiftKey ? 'prev' : 'next');
      }
    });

    overlay.querySelector('#oic-ev-search-prev').addEventListener('click', () => {
      navigateToMatch(tree, 'prev');
    });
    overlay.querySelector('#oic-ev-search-next').addEventListener('click', () => {
      navigateToMatch(tree, 'next');
    });
  }

  function escHandler(e) {
    if (e.key === 'Escape') closeViewer();
  }

  function closeViewer() {
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    document.removeEventListener('keydown', escHandler);
  }

  // ── Message listener (for popup communication) ────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'openViewer') {
      openEnhancedViewerWithId(msg.instanceId);
      sendResponse({ ok: true });
      return true;
    } else if (msg.type === 'settingsChanged') {
      if (msg.autoDetect) {
        enableAutoDetectButton();
      } else {
        hideButton();
      }
    } else if (msg.type === 'themeChanged') {
      applyTheme(msg.theme);
      const sel = overlay && overlay.querySelector('#oic-ev-theme-select');
      if (sel) sel.value = msg.theme;
    } else if (msg.type === 'importData') {
      openImportedData(msg.data);
      sendResponse({ ok: true });
      return true;
    } else if (msg.type === 'triggerImport') {
      importActivityData(openImportedData);
      sendResponse({ ok: true });
      return true;
    } else if (msg.type === 'ping') {
      sendResponse({ ok: true });
    }
  });

  async function openEnhancedViewerWithId(instanceId) {
    if (!instanceId) {
      instanceId = detectInstanceIdFromPage();
    }
    if (!instanceId) {
      alert('No Instance ID provided.');
      return;
    }

    allPayloadsLoaded = false;

    overlay = document.createElement('div');
    overlay.id = 'oic-ev-overlay';
    overlay.dataset.theme = currentTheme;

    // Also refresh from storage in case it changed
    loadTheme((theme) => {
      overlay.dataset.theme = theme;
    });

    overlay.innerHTML = `
      <div class="oic-ev-header">
        <div style="display:flex;align-items:center">
          <h2>Enhanced Activity Stream</h2>
          <span class="oic-ev-header-info">Instance: ${escapeHtml(instanceId)}</span>
        </div>
        <div class="oic-ev-header-actions">
          <button class="oic-ev-close-btn" id="oic-ev-close">Close (Esc)</button>
        </div>
      </div>
      <div class="oic-ev-loading">
        <div class="oic-ev-spinner"></div>
        <div>Loading activity stream data...</div>
        <div style="font-size:12px;margin-top:8px;color:var(--ev-text-faint)">This may take a moment for large flows</div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#oic-ev-close').addEventListener('click', closeViewer);
    document.addEventListener('keydown', escHandler);

    try {
      activityData = await fetchActivityStream(instanceId);
    } catch (err) {
      overlay.querySelector('.oic-ev-loading').innerHTML = `
        <div style="color:#dc2626;font-size:16px">Failed to load activity stream</div>
        <div style="margin-top:8px">${escapeHtml(err.message)}</div>
      `;
      return;
    }

    renderActivityView(instanceId);
  }

  // Initialize
  watchForActivityStream();
})();
