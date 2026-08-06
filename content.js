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
      currentTheme = data.viewerTheme || 'dark';
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

  function highlightMatches(escapedHtml, query) {
    if (!query) return escapedHtml;
    const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${q})`, 'gi');
    return escapedHtml.replace(regex, '<mark>$1</mark>');
  }

  function formatPayloadWithLineNumbers(text, mediaType, query) {
    const formatted = formatPayload(text, mediaType);
    const lines = formatted.split('\n');
    return lines.map((line, i) => {
      let content = escapeHtml(line);
      if (query) content = highlightMatches(content, query);
      return `<span class="oic-ev-payload-line"><span class="oic-ev-line-num">${i + 1}</span>${content}</span>`;
    }).join('');
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

  function pickPayloadExtension(mediaType, text) {
    if (mediaType) {
      if (/json/i.test(mediaType)) return 'json';
      if (/xml/i.test(mediaType)) return 'xml';
      if (/html/i.test(mediaType)) return 'html';
    }
    const t = (text || '').replace(/^\s+/, '');
    if (t.charAt(0) === '{' || t.charAt(0) === '[') return 'json';
    if (t.charAt(0) === '<') return 'xml';
    return 'txt';
  }

  function triggerDownload(text, baseName, mediaType) {
    const ext = pickPayloadExtension(mediaType, text);
    const safe = (baseName || 'payload').replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 80);
    const fname = safe.endsWith('.' + ext) ? safe : safe + '.' + ext;
    const blob = new Blob([text || ''], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname; a.style.display = 'none';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function openFullscreenPayload(text, mediaType, title, query) {
    const existing = document.getElementById('oic-ev-fullscreen');
    if (existing) existing.remove();

    const ovl = document.getElementById('oic-ev-overlay');
    const theme = ovl ? (ovl.getAttribute('data-theme') || 'dark') : 'dark';

    const fs = document.createElement('div');
    fs.id = 'oic-ev-fullscreen';
    fs.setAttribute('data-theme', theme);

    const header = document.createElement('div');
    header.className = 'oic-ev-fs-header';

    const titleEl = document.createElement('div');
    titleEl.className = 'oic-ev-fs-title';
    titleEl.textContent = title || 'Payload';
    header.appendChild(titleEl);

    const copyAct = document.createElement('button');
    copyAct.className = 'oic-ev-fs-action';
    copyAct.textContent = '📋 Copy';
    copyAct.addEventListener('click', () => {
      navigator.clipboard.writeText(text || '').then(() => {
        const orig = copyAct.textContent;
        copyAct.textContent = '✓ Copied';
        setTimeout(() => copyAct.textContent = orig, 1500);
      });
    });
    header.appendChild(copyAct);

    const dlAct = document.createElement('button');
    dlAct.className = 'oic-ev-fs-action';
    dlAct.textContent = '⬇ Download';
    dlAct.addEventListener('click', () => triggerDownload(text, title || 'payload', mediaType));
    header.appendChild(dlAct);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'oic-ev-fs-close';
    closeBtn.textContent = '✕ Close';
    const close = () => { fs.remove(); document.removeEventListener('keydown', escHandler); };
    closeBtn.addEventListener('click', close);
    header.appendChild(closeBtn);

    const body = document.createElement('pre');
    body.className = 'oic-ev-fs-body';
    body.innerHTML = formatPayloadWithLineNumbers(text || '', mediaType, query);

    fs.appendChild(header);
    fs.appendChild(body);
    document.body.appendChild(fs);

    const escHandler = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', escHandler);
  }

  // Build the iconic action toolbar (Copy, Download, Full-height toggle, Fullscreen).
  // `getText` is a function so we can build the toolbar before payload is fetched.
  function buildPayloadActions(getText, mediaType, container, baseName) {
    const actions = document.createElement('div');
    actions.className = 'oic-ev-payload-actions';

    const mkBtn = (icon, title, onClick) => {
      const b = document.createElement('button');
      b.className = 'oic-ev-icon-btn';
      b.textContent = icon;
      b.title = title;
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(b); });
      return b;
    };

    const copyBtn = mkBtn('📋', 'Copy to clipboard', (b) => {
      navigator.clipboard.writeText(getText() || '').then(() => {
        b.textContent = '✓';
        setTimeout(() => b.textContent = '📋', 1500);
      });
    });
    actions.appendChild(copyBtn);

    actions.appendChild(mkBtn('⬇', 'Download', () => triggerDownload(getText(), baseName, mediaType)));

    const expandBtn = mkBtn('⇕', 'Toggle full height', (b) => {
      container.classList.toggle('oic-ev-expanded-payload');
      b.title = container.classList.contains('oic-ev-expanded-payload') ? 'Limit height' : 'Toggle full height';
    });
    actions.appendChild(expandBtn);

    actions.appendChild(mkBtn('⛶', 'Open in fullscreen', () => openFullscreenPayload(getText(), mediaType, baseName, currentSearchQuery)));

    return actions;
  }

  function payloadBaseName(suffix) {
    const inst = (currentInstanceId || 'activity').substring(0, 30);
    return suffix ? inst + '-' + suffix : inst;
  }

  function toggleTextBlock(text, cssClass, nodeEl, mediaType) {
    const existing = nodeEl.querySelector(':scope > .' + cssClass);
    if (existing) { existing.remove(); return; }

    const container = document.createElement('div');
    container.className = 'oic-ev-payload-content ' + cssClass;

    const baseName = payloadBaseName(cssClass.replace(/^oic-ev-/, ''));
    container.appendChild(buildPayloadActions(() => text, mediaType, container, baseName));

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

    const baseName = payloadBaseName(item.identifier || item.milestone || 'payload');
    container.appendChild(buildPayloadActions(() => payloadText, item.payloadMediaType, container, baseName));

    const codeEl = document.createElement('code');
    codeEl.innerHTML = formatPayloadWithLineNumbers(payloadText, item.payloadMediaType, currentSearchQuery);
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
  let currentSearchQuery = ''; // current search term for payload highlighting
  let searchFilterMode = true; // true = hide non-matching nodes, false = just highlight

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

  function highlightSearch(container, matchIds, skipHeaderHighlight) {
    container.querySelectorAll('.oic-ev-node-header.oic-ev-highlighted').forEach(h => h.classList.remove('oic-ev-highlighted'));
    container.querySelectorAll('.oic-ev-node-header.oic-ev-current-match').forEach(h => h.classList.remove('oic-ev-current-match'));
    if (!matchIds || matchIds.size === 0) return;

    // Highlight all matches that are currently in the DOM
    container.querySelectorAll('.oic-ev-node').forEach(nodeEl => {
      const id = nodeEl.dataset.identifier;
      if (matchIds.has(id)) {
        if (!skipHeaderHighlight) {
          const header = nodeEl.querySelector(':scope > .oic-ev-node-header');
          if (header) header.classList.add('oic-ev-highlighted');
        }
        expandAncestorChain(nodeEl, container);
      }
    });
  }

  function refreshMessageHighlights(container, query) {
    container.querySelectorAll('.oic-ev-node').forEach(nodeEl => {
      const item = nodeEl._itemData;
      if (!item) return;
      const msgEl = nodeEl.querySelector(':scope > .oic-ev-node-header .oic-ev-message');
      if (!msgEl) return;

      // Rebuild message content with highlights
      let msgText = escapeHtml(item.message || '');
      if (query) msgText = highlightMatches(msgText, query);
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
      msgEl.innerHTML = msgText;
    });
  }

  // Build set of identifiers that should be visible (matches + their ancestors)
  function buildVisibleSet(items, matchIds) {
    const visible = new Set(matchIds);
    // For each match, add all ancestors
    for (const id of matchIds) {
      const path = findPathInDataTree(items, id);
      if (path) {
        for (const ancestorId of path) visible.add(ancestorId);
      }
    }
    return visible;
  }

  function applySearchFilter(container, matchIds, filterEnabled) {
    if (!filterEnabled || !matchIds || matchIds.size === 0) {
      // Show all nodes
      container.querySelectorAll('.oic-ev-node.oic-ev-filtered-out').forEach(n => {
        n.classList.remove('oic-ev-filtered-out');
      });
      return;
    }

    const visibleSet = buildVisibleSet(activityData.items, matchIds);

    container.querySelectorAll('.oic-ev-node').forEach(nodeEl => {
      const id = nodeEl.dataset.identifier;
      if (visibleSet.has(id)) {
        nodeEl.classList.remove('oic-ev-filtered-out');
      } else {
        nodeEl.classList.add('oic-ev-filtered-out');
      }
    });
  }

  function refreshOpenPayloads(container, query) {
    container.querySelectorAll('.oic-ev-payload-content code').forEach(codeEl => {
      const nodeEl = codeEl.closest('.oic-ev-node');
      if (!nodeEl || !nodeEl._itemData) return;
      const item = nodeEl._itemData;
      const payloadText = item.payload;
      if (payloadText) {
        codeEl.innerHTML = formatPayloadWithLineNumbers(payloadText, item.payloadMediaType, query);
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

  function updateSearchWarning() {
    if (!overlay) return;
    const warningEl = overlay.querySelector('#oic-ev-search-warning');
    if (!warningEl) return;
    const searchInput = overlay.querySelector('#oic-ev-search');
    const hasQuery = searchInput && searchInput.value.trim().length > 0;
    warningEl.style.display = (hasQuery && !allPayloadsLoaded) ? 'block' : 'none';
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

  function renderActivityView(instanceId, container) {
    // `container` is where the viewer renders. Defaults to the whole overlay
    // (single-run mode). In cross-run mode the detail pane is passed so the
    // sidebar/form around it survive re-renders. Search-helper globals still
    // resolve because the detail pane is a descendant of `overlay`.
    const root = container || overlay;
    currentInstanceId = instanceId;
    const totalNodes = countNodes(activityData.items);
    const totalPayloads = countPayloads(activityData.items);

    root.innerHTML = '';

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
        <span class="oic-ev-instance-group">
          <label>Instance:</label>
          <input type="text" id="oic-ev-instance-input" class="oic-ev-instance-input" value="${escapeHtml(instanceId)}" placeholder="Instance ID">
          <button id="oic-ev-instance-load" class="oic-ev-instance-load-btn" title="Load this instance">Load</button>
        </span>
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
      <label class="oic-ev-filter-toggle" title="Hide non-matching nodes">
        <input type="checkbox" id="oic-ev-filter-mode" ${searchFilterMode ? 'checked' : ''}>
        <span>Filter</span>
      </label>
    `;
    topBar.appendChild(searchBar);

    // Payload search warning
    const searchWarning = document.createElement('div');
    searchWarning.id = 'oic-ev-search-warning';
    searchWarning.className = 'oic-ev-search-warning';
    searchWarning.style.display = 'none';
    searchWarning.textContent = 'Not all payloads downloaded — search may miss payload content. Download all payloads for complete results.';
    topBar.appendChild(searchWarning);

    root.appendChild(topBar);

    // Tree
    const tree = document.createElement('div');
    tree.className = 'oic-ev-tree';
    tree.id = 'oic-ev-tree';

    for (const item of activityData.items) {
      tree.appendChild(renderNode(item, 0));
    }
    root.appendChild(tree);

    // Event handlers
    root.querySelector('#oic-ev-theme-select').addEventListener('change', (e) => {
      applyTheme(e.target.value);
    });

    // Instance ID load
    const instanceInput = root.querySelector('#oic-ev-instance-input');
    const instanceLoadBtn = root.querySelector('#oic-ev-instance-load');
    const loadNewInstance = async () => {
      const newId = instanceInput.value.trim();
      if (!newId) {
        instanceInput.focus();
        return;
      }
      instanceLoadBtn.disabled = true;
      instanceLoadBtn.textContent = 'Loading...';
      try {
        allPayloadsLoaded = false;
        currentInstanceId = newId;
        activityData = await fetchActivityStream(newId);
        chrome.storage.local.set({ lastInstanceId: newId });
        renderActivityView(newId, container);
      } catch (err) {
        instanceLoadBtn.disabled = false;
        instanceLoadBtn.textContent = 'Load';
        alert('Failed to load instance: ' + err.message);
      }
    };
    instanceLoadBtn.addEventListener('click', loadNewInstance);
    instanceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loadNewInstance();
    });

    root.querySelector('#oic-ev-refresh').addEventListener('click', async () => {
      const refreshBtn = root.querySelector('#oic-ev-refresh');
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Refreshing...';
      try {
        allPayloadsLoaded = false;
        activityData = await fetchActivityStream(instanceId);
        renderActivityView(instanceId, container);
      } catch (err) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh';
        alert('Refresh failed: ' + err.message);
      }
    });
    root.querySelector('#oic-ev-export').addEventListener('click', () => {
      exportActivityData(instanceId);
    });
    root.querySelector('#oic-ev-import').addEventListener('click', () => {
      importActivityData(openImportedData);
    });
    const closeBtn = root.querySelector('#oic-ev-close');
    // Embedded in the cross-run detail pane: the outer overlay owns closing, so hide this
    // (it would otherwise close the whole extension from within the detail view).
    if (container) closeBtn.style.display = 'none';
    else closeBtn.addEventListener('click', closeViewer);
    root.querySelector('#oic-ev-expand-all').addEventListener('click', () => {
      if (totalNodes > 5000 && !confirm(`This will render all ${totalNodes.toLocaleString()} nodes. Continue?`)) return;
      expandAll(tree);
    });
    root.querySelector('#oic-ev-collapse-all').addEventListener('click', () => collapseAll(tree));
    root.querySelector('#oic-ev-expand-1').addEventListener('click', () => expandToLevel(tree, 1));
    root.querySelector('#oic-ev-expand-2').addEventListener('click', () => expandToLevel(tree, 2));
    root.querySelector('#oic-ev-expand-3').addEventListener('click', () => expandToLevel(tree, 3));

    // Download all payloads button
    const dlBtn = root.querySelector('#oic-ev-download-all');
    if (dlBtn) {
      dlBtn.addEventListener('click', async () => {
        dlBtn.disabled = true;
        dlBtn.textContent = 'Downloading...';
        const progressEl = root.querySelector('#oic-ev-download-progress');
        await downloadAllPayloads((done, total, finished, errors) => {
          if (finished) {
            dlBtn.textContent = 'All Downloaded';
            dlBtn.classList.add('oic-ev-download-done');
            const errText = errors ? ` (${errors} failed)` : '';
            progressEl.textContent = `${done.toLocaleString()} payloads loaded${errText}`;
            // Re-run active search to include payload content
            const q = root.querySelector('#oic-ev-search').value.trim();
            if (q) {
              currentSearchQuery = q;
              searchMatches = searchDataTree(activityData.items, q);
              searchMatchSet = new Set(searchMatches);
              searchCurrentIdx = -1;
              highlightSearch(tree, searchMatchSet, searchFilterMode);
              applySearchFilter(tree, searchMatchSet, searchFilterMode);
              refreshMessageHighlights(tree, searchFilterMode ? q : '');
              refreshOpenPayloads(tree, q);
              updateSearchCounter();
            }
            updateSearchWarning();
          } else {
            progressEl.textContent = `${done.toLocaleString()} / ${total.toLocaleString()}`;
          }
        });
      });
    }

    let searchTimeout;
    const searchInput = root.querySelector('#oic-ev-search');

    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        const q = e.target.value.trim();
        currentSearchQuery = q;
        if (!q) {
          searchMatches = [];
          searchMatchSet = null;
          searchCurrentIdx = -1;
          highlightSearch(tree, null, false);
          applySearchFilter(tree, null, searchFilterMode);
          refreshMessageHighlights(tree, '');
          refreshOpenPayloads(tree, '');
          updateSearchCounter();
          updateSearchWarning();
          return;
        }
        searchMatches = searchDataTree(activityData.items, q);
        searchMatchSet = new Set(searchMatches);
        searchCurrentIdx = -1;
        highlightSearch(tree, searchMatchSet, searchFilterMode);
        applySearchFilter(tree, searchMatchSet, searchFilterMode);
        refreshMessageHighlights(tree, searchFilterMode ? q : '');
        refreshOpenPayloads(tree, q);
        updateSearchCounter();
        updateSearchWarning();
      }, 400);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        navigateToMatch(tree, e.shiftKey ? 'prev' : 'next');
      }
    });

    root.querySelector('#oic-ev-search-prev').addEventListener('click', () => {
      navigateToMatch(tree, 'prev');
    });
    root.querySelector('#oic-ev-search-next').addEventListener('click', () => {
      navigateToMatch(tree, 'next');
    });

    // Filter mode toggle
    root.querySelector('#oic-ev-filter-mode').addEventListener('change', (e) => {
      searchFilterMode = e.target.checked;
      highlightSearch(tree, searchMatchSet, searchFilterMode);
      applySearchFilter(tree, searchMatchSet, searchFilterMode);
      refreshMessageHighlights(tree, searchFilterMode ? currentSearchQuery : '');
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
    } else if (msg.type === 'openCrossRun') {
      openCrossRunViewer();
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

    // Close any existing overlay before opening new one
    closeViewer();

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

  // ════════════════════════════════════════════════════════════════════
  // Cross-Run (Multi-Instance) Search
  // Enumerate all executions of an integration (code + optional version) in a
  // time window, list them in a sidebar, fetch each run's activity stream on
  // demand (cached), and search content across the fetched runs. The existing
  // single-run viewer is reused as the right-hand detail pane.
  // ════════════════════════════════════════════════════════════════════

  const XRUN_PAGE = 50;         // requested page size (server max is 50; >50 is rejected).
                               // Actual stride is still derived from page 0's real length.
  const XRUN_MAX_OFFSET = 500;  // server rejects offset > 500 → at most 550 records reachable
  const XRUN_MAX_ENUM = 5000;   // hard cap on enumerated instances
  const XRUN_SCAN_CONCURRENCY = 5;
  const XRUN_SCAN_CONFIRM_OVER = 300; // confirm before scanning more than this

  const xrunCache = new Map();  // instanceId -> { data }   (activityStreamDetails, cached)
  let xrunInstances = [];       // enumerated metadata list (raw API items)
  let xrunSearchTerm = '';
  let xrunScanCancel = false;
  let xrunSelectedId = null;
  let xrunReportedTotal = null;  // server's totalRecordsCount (may exceed what's fetchable)
  const xrunUnavailable = new Set(); // ids whose activity stream is purged/gone (HTTP 410)
  let xrunProjectCode = '';      // selected project (scopes the code search + adds projectCode q param)

  // Field accessors — the monitoring/instances item schema varies by OIC
  // version, so read the first present of several known key names.
  const firstKey = (obj, keys) => {
    for (const k of keys) if (obj[k] != null && obj[k] !== '') return obj[k];
    return '';
  };
  const xrunInstId = (it) => firstKey(it, ['id', 'instanceId', 'iid', 'flowInstanceId']);
  const xrunStatus = (it) => firstKey(it, ['status', 'instanceStatus', 'state', 'flowStatus']);
  const xrunVersion = (it) => firstKey(it, ['version', 'integrationVersion', 'flowVersion']);
  const xrunCodeOf = (it) => firstKey(it, ['code', 'integrationCode', 'flowCode']);
  const xrunMsg = (it) => firstKey(it, ['primaryMessage', 'message', 'integrationName', 'name']);
  // True when the instance's activity stream is purged from the server (metadata survives
  // in the instances list, but activityStreamDetails is gone → HTTP 410). Read from
  // metadata if present, else inferred from a failed fetch (xrunUnavailable).
  function xrunIsPurged(it) {
    const v = firstKey(it, ['isPurged', 'purged']);
    if (v === true || v === 'true' || v === 'yes') return true;
    return xrunUnavailable.has(xrunInstId(it));
  }
  // Duration in ms; NaN if unknown / non-numeric.
  function xrunDurationMs(it) {
    const v = firstKey(it, ['duration', 'durationInMillis', 'elapsedTime', 'elapsed', 'totalTime']);
    const n = Number(v);
    return isFinite(n) ? n : NaN;
  }
  const xrunTimeRaw = (it) => firstKey(it, ['receivedDate', 'creationDate', 'createdDate', 'lastUpdatedDate', 'lastTrackedTime', 'date', 'startTime']);

  function xrunFmtTime(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number' || /^\d{10,}$/.test(String(v))) {
      const n = Number(v);
      const ms = n < 1e12 ? n * 1000 : n; // seconds vs millis
      const d = new Date(ms);
      return isNaN(d) ? String(v) : d.toLocaleString();
    }
    const d = new Date(v);
    return isNaN(d) ? String(v) : d.toLocaleString();
  }

  // Numeric timestamp (ms) for client-side range filtering; NaN if unknown.
  function xrunTimeMs(it) {
    const v = xrunTimeRaw(it);
    if (v == null || v === '') return NaN;
    if (typeof v === 'number' || /^\d{10,}$/.test(String(v))) {
      const n = Number(v);
      return n < 1e12 ? n * 1000 : n;
    }
    const d = new Date(v);
    return isNaN(d) ? NaN : d.getTime();
  }

  function detectCodeFromPage() {
    const u = new URL(location.href);
    const c = u.searchParams.get('code') || u.searchParams.get('integrationId');
    if (c) return c;
    // Native monitor often shows "Name (CODE | 01.00.0009)"
    const m = (document.body.innerText || '').match(/\(([A-Z0-9][A-Z0-9_]{3,})\s*\|\s*\d{2}\.\d{2}\.\d{4}\)/);
    return m ? m[1] : '';
  }

  // All filters are native `q` fields on GET /monitoring/instances. Values are wrapped in
  // single quotes; the caller's own quotes/brackets (for the tracking-variable exact-match
  // syntax, e.g. [exact] or "multi word") are preserved inside.
  const XRUN_Q_FIELDS = [
    'timewindow', 'projectCode', 'code', 'version', 'status', 'minDuration', 'maxDuration',
    'startdate', 'enddate', 'businessIDValue',
    'primaryValue', 'primaryName', 'secondaryValue', 'secondaryName', 'tertiaryValue', 'tertiaryName',
  ];

  function buildInstancesUrl(params) {
    const inst = getIntegrationInstance();
    const parts = [];
    for (const k of XRUN_Q_FIELDS) {
      const v = params[k];
      if (v !== undefined && v !== null && v !== '') {
        parts.push(`${k}:'${String(v).replace(/'/g, "\\'")}'`);
      }
    }
    parts.push(`includePurged:'${params.includePurged || 'no'}'`); // no | yes | onlyPurged
    const q = '{' + parts.join(', ') + '}';
    return `${location.origin}/ic/api/integration/v1/monitoring/instances`
      + `?offset=${params.offset}&limit=${XRUN_PAGE}&q=${encodeURIComponent(q)}`
      + `&orderBy=lastupdateddate&fields=detail&integrationInstance=${encodeURIComponent(inst)}`;
  }

  async function fetchInstancesPage(params) {
    const resp = await fetch(buildInstancesUrl(params));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const data = await resp.json();
    // Defensive: envelope keys vary across OIC versions.
    const items = data.items || data.instances || data.elements || (Array.isArray(data) ? data : []);
    const total = firstNum(data, ['totalRecordsCount', 'totalResults', 'totalResultCount', 'count', 'total']);
    return { items, total };
  }

  // First finite numeric value among the given keys; null if none.
  function firstNum(obj, keys) {
    for (const k of keys) {
      const n = Number(obj[k]);
      if (obj[k] != null && isFinite(n)) return n;
    }
    return null;
  }

  // Enumerate all pages of instances.
  // Order is recent→old (orderBy=lastupdateddate). Strategy:
  //   1. Fetch page 0 → learn the total record count.
  //   2. Fire the remaining pages all at once (browser caps ~6 conns/origin — no
  //      app-level throttle needed) and dedup by instanceId.
  //   3. `lastupdateddate` is a moving sort key: rows that update mid-enumeration slide
  //      toward the top, so the same id can appear on more than one page → dedup handles
  //      it. New inserts at the top also push old tail rows past our first `total`; if the
  //      max total reported by any response grew, do ONE extra pass for the difference.
  //   4. If no total is reported, fall back to sequential paging until a short page.
  // A row that slides UP past an already-read window can still be missed — inherent to
  // offset paging over a live sort key; negligible for a bounded window, not fixed here.
  async function enumerateInstances(params, onProgress, shouldCancel) {
    const out = [];
    const seen = new Set();
    const addPage = (items) => {
      for (const it of (items || [])) {
        const id = xrunInstId(it);
        if (id) { if (seen.has(id)) continue; seen.add(id); }
        out.push(it);
      }
    };

    xrunReportedTotal = null;

    // Page 0 (fatal on failure).
    const first = await fetchInstancesPage({ ...params, offset: 0 });
    addPage(first.items);
    if (onProgress) onProgress(out.length, first.items.length);
    if (!first.items.length) return out;

    // Derive the real page stride from what the server actually returned — it may cap
    // below the requested XRUN_PAGE. Using this as the offset step keeps parallel paging
    // correct regardless of the server's max limit.
    const stride = first.items.length;
    xrunReportedTotal = first.total; // may exceed what's fetchable (offset ≤ 500)

    // No total → sequential fallback (stop on short/empty page or the offset ceiling).
    if (first.total == null) {
      let offset = stride;
      while (offset <= XRUN_MAX_OFFSET && offset < XRUN_MAX_ENUM) {
        if (shouldCancel && shouldCancel()) break;
        let page;
        try { page = await fetchInstancesPage({ ...params, offset }); }
        catch (err) { break; } // keep what we have
        if (!page.items.length) break;
        addPage(page.items);
        if (onProgress) onProgress(out.length, offset + page.items.length);
        if (page.items.length < stride) break;
        offset += stride;
      }
      return out;
    }

    let maxTotal = first.total;
    // Fetch offsets [start, end) all at once, never past the offset ceiling (500).
    const fireRange = async (start, end) => {
      const offsets = [];
      for (let o = start; o < end && o <= XRUN_MAX_OFFSET; o += stride) offsets.push(o);
      if (!offsets.length) return;
      const results = await Promise.allSettled(offsets.map(o => fetchInstancesPage({ ...params, offset: o })));
      for (const r of results) {
        if (r.status !== 'fulfilled') continue; // skip failed page
        addPage(r.value.items);
        if (r.value.total != null && r.value.total > maxTotal) maxTotal = r.value.total;
      }
    };

    const lastOffset = Math.min(first.total, XRUN_MAX_ENUM);
    await fireRange(stride, lastOffset);
    xrunReportedTotal = maxTotal;
    if (onProgress) onProgress(out.length, lastOffset);

    // One growth pass: new top inserts pushed old rows past our first end.
    if (maxTotal > first.total) {
      const extraEnd = Math.min(maxTotal, XRUN_MAX_ENUM);
      await fireRange(lastOffset, extraEnd);
      if (onProgress) onProgress(out.length, extraEnd);
    }

    return out;
  }

  // ── Cross-run overlay ────────────────────────────────────────────────

  function openCrossRunViewer() {
    xrunCache.clear();
    xrunUnavailable.clear();
    xrunInstances = [];
    xrunSearchTerm = '';
    xrunSelectedId = null;
    xrunProjectCode = '';

    closeViewer();
    overlay = document.createElement('div');
    overlay.id = 'oic-ev-overlay';
    overlay.classList.add('oic-ev-xrun-overlay');
    overlay.dataset.theme = currentTheme;
    loadTheme((theme) => { overlay.dataset.theme = theme; });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', escHandler);

    const themeOptions = THEMES.map(t =>
      `<option value="${t.id}"${t.id === currentTheme ? ' selected' : ''}>${t.label}</option>`
    ).join('');

    overlay.innerHTML = `
      <div class="oic-ev-xrun">
        <div class="oic-ev-xrun-form">
          <h2>Search Across Runs</h2>
          <label class="oic-ev-xrun-acwrap">Project
            <input type="text" id="oic-ev-xrun-project" placeholder="Project (optional)" autocomplete="off" spellcheck="false">
            <ul id="oic-ev-xrun-project-dd" class="oic-ev-xrun-ac" hidden></ul>
          </label>
          <label class="oic-ev-xrun-acwrap">Code
            <input type="text" id="oic-ev-xrun-code" placeholder="Search name or code..." autocomplete="off" spellcheck="false">
            <ul id="oic-ev-xrun-code-dd" class="oic-ev-xrun-ac" hidden></ul>
          </label>
          <label>Version
            <select id="oic-ev-xrun-version"><option value="">All versions</option></select>
          </label>
          <label>Window
            <select id="oic-ev-xrun-window">
              <option value="1h" selected>1 hour</option>
              <option value="6h">6 hours</option>
              <option value="1d">1 day</option>
              <option value="2d">2 days</option>
              <option value="3d">3 days</option>
              <option value="8d">8 days</option>
              <option value="32d">32 days</option>
              <option value="RETENTIONPERIOD">Full retention</option>
            </select>
          </label>
          <label>Status
            <select id="oic-ev-xrun-status">
              <option value="">Any</option>
              <option value="COMPLETED">Completed</option>
              <option value="FAILED">Failed</option>
              <option value="ABORTED">Aborted</option>
            </select>
          </label>
          <label>From <input type="datetime-local" id="oic-ev-xrun-from" title="Custom range start (overrides Window)"></label>
          <label>To <input type="datetime-local" id="oic-ev-xrun-to"></label>
          <label>Duration ms
            <input type="number" id="oic-ev-xrun-durmin" class="oic-ev-xrun-num" min="0" placeholder="min">
            <span>–</span>
            <input type="number" id="oic-ev-xrun-durmax" class="oic-ev-xrun-num" min="0" placeholder="max">
          </label>
          <label>Purged
            <select id="oic-ev-xrun-purged">
              <option value="no" selected>Exclude</option>
              <option value="yes">Include</option>
              <option value="onlyPurged">Only purged</option>
            </select>
          </label>
          <button id="oic-ev-xrun-fetch" class="oic-ev-xrun-fetch-btn">Fetch</button>
          <select id="oic-ev-xrun-theme" class="oic-ev-theme-select" title="Color theme">${themeOptions}</select>
          <button class="oic-ev-close-btn" id="oic-ev-xrun-close">Close (Esc)</button>
          <span id="oic-ev-xrun-enum-progress" class="oic-ev-xrun-progress"></span>
          <details class="oic-ev-xrun-adv">
            <summary>Tracking variables</summary>
            <div class="oic-ev-xrun-adv-fields">
              <label>Business ID <input type="text" id="oic-ev-xrun-bizid" placeholder="any tracking value"></label>
              <label>Primary
                <input type="text" id="oic-ev-xrun-pval" placeholder="value">
                <input type="text" id="oic-ev-xrun-pname" placeholder="name (for exact)">
              </label>
              <label>Secondary
                <input type="text" id="oic-ev-xrun-sval" placeholder="value">
                <input type="text" id="oic-ev-xrun-sname" placeholder="name (for exact)">
              </label>
              <label>Tertiary
                <input type="text" id="oic-ev-xrun-tval" placeholder="value">
                <input type="text" id="oic-ev-xrun-tname" placeholder="name (for exact)">
              </label>
              <span class="oic-ev-xrun-adv-hint">Exact match: wrap in [brackets] · multi-word: "quotes"</span>
            </div>
          </details>
        </div>
        <div class="oic-ev-xrun-body">
          <div class="oic-ev-xrun-sidebar">
            <div class="oic-ev-xrun-sidebar-head">
              <input type="text" id="oic-ev-xrun-search" placeholder="Search fetched content across runs...">
              <div class="oic-ev-xrun-controls">
                <label class="oic-ev-xrun-check"><input type="checkbox" id="oic-ev-xrun-matchonly"> Matches only</label>
              </div>
              <div class="oic-ev-xrun-actions">
                <button id="oic-ev-xrun-scan" class="oic-ev-xrun-scan-btn">Scan all</button>
                <span id="oic-ev-xrun-scan-progress" class="oic-ev-xrun-progress"></span>
              </div>
              <div id="oic-ev-xrun-banner" class="oic-ev-xrun-banner"></div>
            </div>
            <div id="oic-ev-xrun-list" class="oic-ev-xrun-list">
              <div class="oic-ev-xrun-empty">Enter an integration code and click Fetch.</div>
            </div>
          </div>
          <div id="oic-ev-xrun-detail" class="oic-ev-xrun-detail">
            <div class="oic-ev-xrun-empty-detail">Select a run on the left to view its activity stream.</div>
          </div>
        </div>
      </div>
    `;

    // Prefill code/version from page
    const detected = detectCodeFromPage();
    if (detected) overlay.querySelector('#oic-ev-xrun-code').value = detected;

    overlay.querySelector('#oic-ev-xrun-theme').addEventListener('change', (e) => {
      applyTheme(e.target.value);
    });
    overlay.querySelector('#oic-ev-xrun-close').addEventListener('click', closeViewer);
    overlay.querySelector('#oic-ev-xrun-fetch').addEventListener('click', runXrunFetch);
    overlay.querySelector('#oic-ev-xrun-scan').addEventListener('click', scanXrunInstances);

    let searchDebounce;
    overlay.querySelector('#oic-ev-xrun-search').addEventListener('input', (e) => {
      clearTimeout(searchDebounce);
      const term = e.target.value.trim();
      searchDebounce = setTimeout(() => applyXrunSearch(term), 300);
    });
    overlay.querySelector('#oic-ev-xrun-matchonly').addEventListener('change', renderXrunList);
    // Status/duration/dates/tracking are server-side query params now — a Fetch applies
    // them (Enter in any form field triggers Fetch too).
    overlay.querySelectorAll('.oic-ev-xrun-form input:not(#oic-ev-xrun-code):not(#oic-ev-xrun-project), .oic-ev-xrun-form select').forEach(el => {
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runXrunFetch(); } });
    });

    attachProjectAutocomplete();
    attachCodeAutocomplete();
    // If a code was prefilled from the page, load its versions up front.
    if (detected) loadVersionsForCode(detected);
  }

  // ── Code / version autocomplete (design-time integrations endpoint) ──
  // Mirrors the OIC Integration Viewer's picker: search by code OR name in
  // parallel, header `Authorization: session` + same-origin cookies.
  const XRUN_AUTH = { 'Authorization': 'session' };

  // Integration search, optionally scoped to a project (project-scoped endpoint mirrors
  // the OIC Integration Viewer). Searches by code OR name in parallel.
  async function searchIntegrations(query, signal, projectCode) {
    const inst = getIntegrationInstance();
    const basePath = projectCode
      ? `/ic/api/integration/v1/projects/${encodeURIComponent(projectCode)}/integrations`
      : `/ic/api/integration/v1/integrations`;
    let base = `${location.origin}${basePath}?offset=0&limit=20&return=landing`;
    if (inst) base += '&integrationInstance=' + encodeURIComponent(inst);
    const safe = String(query).replace(/'/g, "\\'");
    const call = (field) =>
      fetch(`${base}&q=${encodeURIComponent(`{${field}:'${safe}'}`)}`, { headers: XRUN_AUTH, credentials: 'same-origin', signal })
        .then(r => (r.ok ? r.json() : { items: [] }))
        .catch(e => { if (e && e.name === 'AbortError') throw e; return { items: [] }; });
    const [byCode, byName] = await Promise.all([call('code'), call('name')]);
    const seen = new Set();
    const out = [];
    for (const resp of [byCode, byName]) {
      for (const it of (resp.items || [])) {
        if (!it || !it.code || !it.version) continue;
        const k = it.code + '|' + it.version;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ code: it.code, version: it.version, name: it.name || '', status: it.status || '' });
      }
    }
    return out;
  }

  // Project search by name fragment → [{code, name, status}].
  async function searchProjects(query, signal) {
    const inst = getIntegrationInstance();
    let url = `${location.origin}/ic/api/integration/v1/projects?offset=0&limit=20&orderBy=name`;
    if (inst) url += '&integrationInstance=' + encodeURIComponent(inst);
    url += `&q=${encodeURIComponent(`{name:'${String(query).replace(/'/g, "\\'")}'}`)}`;
    const r = await fetch(url, { headers: XRUN_AUTH, credentials: 'same-origin', signal }).catch(e => { if (e && e.name === 'AbortError') throw e; return null; });
    if (!r || !r.ok) return [];
    const data = await r.json();
    const seen = new Set();
    const out = [];
    for (const it of (data.items || [])) {
      if (!it || !it.code || seen.has(it.code)) continue;
      seen.add(it.code);
      out.push({ code: it.code, name: it.name || it.code, status: (it.state && it.state.status) || it.status || '' });
    }
    return out;
  }

  async function fetchVersionsForCode(code, projectCode) {
    const inst = getIntegrationInstance();
    const basePath = projectCode
      ? `/ic/api/integration/v1/projects/${encodeURIComponent(projectCode)}/integrations`
      : `/ic/api/integration/v1/integrations`;
    let url = `${location.origin}${basePath}?offset=0&limit=50&return=landing`;
    if (inst) url += '&integrationInstance=' + encodeURIComponent(inst);
    url += `&q=${encodeURIComponent(`{code:'${String(code).replace(/'/g, "\\'")}'}`)}`;
    const r = await fetch(url, { headers: XRUN_AUTH, credentials: 'same-origin' });
    if (!r.ok) return [];
    const data = await r.json();
    const vers = [...new Set((data.items || []).filter(i => i.code === code && i.version).map(i => i.version))];
    vers.sort((a, b) => String(b).localeCompare(String(a)));
    return vers;
  }

  async function loadVersionsForCode(code) {
    const sel = overlay && overlay.querySelector('#oic-ev-xrun-version');
    if (!sel || !code) return;
    try {
      const vers = await fetchVersionsForCode(code, xrunProjectCode);
      sel.innerHTML = '<option value="">All versions</option>'
        + vers.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    } catch (e) { /* leave "All versions" */ }
  }

  // Generic search-as-you-type dropdown bound to an input + <ul>.
  // opts: { search(q, signal) -> items[], rowHtml(it) -> string, onPick(it), minChars }
  function makeAutocomplete(input, dd, opts) {
    if (!input || !dd) return;
    let items = [], active = -1, abort = null, tmr = null;
    const minChars = opts.minChars || 2;
    const hide = () => { dd.hidden = true; active = -1; };
    const render = () => {
      dd.innerHTML = '';
      if (!items.length) { dd.hidden = true; return; }
      items.forEach((it, i) => {
        const li = document.createElement('li');
        li.className = 'oic-ev-xrun-ac-item' + (i === active ? ' oic-ev-xrun-ac-active' : '');
        li.innerHTML = opts.rowHtml(it);
        li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus
        li.addEventListener('click', () => choose(i));
        dd.appendChild(li);
      });
      dd.hidden = false;
    };
    const choose = (i) => { const it = items[i]; if (!it) return; hide(); opts.onPick(it); };
    const run = async () => {
      const q = input.value.trim();
      if (q.length < minChars) { hide(); return; }
      if (abort) { try { abort.abort(); } catch (e) { /* noop */ } }
      const ctrl = new AbortController();
      abort = ctrl;
      try {
        const res = await opts.search(q, ctrl.signal);
        if (abort !== ctrl) return;
        items = res || [];
        active = items.length ? 0 : -1;
        render();
      } catch (e) { if (e && e.name === 'AbortError') return; hide(); }
    };
    input.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(run, 250); });
    input.addEventListener('keydown', (e) => {
      if (dd.hidden || !items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
      else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); choose(active); } }
      else if (e.key === 'Escape') { hide(); }
    });
    document.addEventListener('mousedown', (e) => { const wrap = dd.parentElement; if (wrap && !wrap.contains(e.target)) hide(); });
    return { hide };
  }

  function attachCodeAutocomplete() {
    const input = overlay.querySelector('#oic-ev-xrun-code');
    const dd = overlay.querySelector('#oic-ev-xrun-code-dd');
    makeAutocomplete(input, dd, {
      search: async (q, signal) => {
        const res = await searchIntegrations(q, signal, xrunProjectCode);
        const seen = new Set(), out = [];
        for (const r of res) { if (seen.has(r.code)) continue; seen.add(r.code); out.push(r); } // one row per code
        return out;
      },
      rowHtml: (it) => `<span class="oic-ev-xrun-ac-name">${escapeHtml(it.name || it.code)}</span>`
        + `<span class="oic-ev-xrun-ac-meta">${escapeHtml(it.code)} · ${escapeHtml(it.version)}${it.status ? ' · ' + escapeHtml(it.status) : ''}</span>`,
      onPick: (it) => { input.value = it.code; loadVersionsForCode(it.code); },
    });
    // Free-typed code (no pick): still load its versions on blur.
    input.addEventListener('change', () => { const c = input.value.trim(); if (c) loadVersionsForCode(c); });
  }

  function attachProjectAutocomplete() {
    const input = overlay.querySelector('#oic-ev-xrun-project');
    const dd = overlay.querySelector('#oic-ev-xrun-project-dd');
    if (!input || !dd) return;
    const codeInput = overlay.querySelector('#oic-ev-xrun-code');
    const verSel = overlay.querySelector('#oic-ev-xrun-version');
    const clearIntegration = () => {
      if (codeInput) codeInput.value = '';
      if (verSel) verSel.innerHTML = '<option value="">All versions</option>';
    };
    makeAutocomplete(input, dd, {
      search: (q, signal) => searchProjects(q, signal),
      rowHtml: (it) => `<span class="oic-ev-xrun-ac-name">${escapeHtml(it.name || it.code)}</span>`
        + `<span class="oic-ev-xrun-ac-meta">${escapeHtml(it.code)}${it.status ? ' · ' + escapeHtml(it.status) : ''}</span>`,
      onPick: (it) => { input.value = it.code; xrunProjectCode = it.code; clearIntegration(); },
    });
    // Editing/clearing a picked project invalidates the current integration (mirrors the
    // OIC Integration Viewer: project change clears the integration).
    input.addEventListener('input', () => {
      if (xrunProjectCode) { xrunProjectCode = ''; clearIntegration(); }
    });
  }

  async function runXrunFetch() {
    const val = (id) => { const el = overlay.querySelector(id); return el ? el.value.trim() : ''; };
    const code = val('#oic-ev-xrun-code');
    if (!code) {
      alert('Enter an integration code.');
      return;
    }

    // Assemble server-side q params. Empty fields are dropped by buildInstancesUrl.
    const params = {
      code,
      projectCode: xrunProjectCode,
      version: val('#oic-ev-xrun-version'),
      status: val('#oic-ev-xrun-status'),
      includePurged: val('#oic-ev-xrun-purged') || 'no',
      minDuration: val('#oic-ev-xrun-durmin'),
      maxDuration: val('#oic-ev-xrun-durmax'),
      businessIDValue: val('#oic-ev-xrun-bizid'),
      primaryValue: val('#oic-ev-xrun-pval'),
      primaryName: val('#oic-ev-xrun-pname'),
      secondaryValue: val('#oic-ev-xrun-sval'),
      secondaryName: val('#oic-ev-xrun-sname'),
      tertiaryValue: val('#oic-ev-xrun-tval'),
      tertiaryName: val('#oic-ev-xrun-tname'),
    };

    // Custom date range (UTC) overrides the relative window when a From is set.
    const fromVal = val('#oic-ev-xrun-from');
    const toVal = val('#oic-ev-xrun-to');
    if (fromVal) {
      params.startdate = new Date(fromVal).toISOString();
      params.enddate = toVal ? new Date(toVal).toISOString() : new Date().toISOString();
    } else {
      params.timewindow = val('#oic-ev-xrun-window');
    }

    const fetchBtn = overlay.querySelector('#oic-ev-xrun-fetch');
    const progEl = overlay.querySelector('#oic-ev-xrun-enum-progress');
    fetchBtn.disabled = true;
    fetchBtn.textContent = 'Fetching...';
    xrunCache.clear();
    xrunUnavailable.clear();
    xrunSelectedId = null;
    overlay.querySelector('#oic-ev-xrun-detail').innerHTML =
      '<div class="oic-ev-xrun-empty-detail">Select a run on the left to view its activity stream.</div>';

    try {
      xrunInstances = await enumerateInstances(
        params,
        (kept, scanned) => { progEl.textContent = `${kept.toLocaleString()} runs (${scanned.toLocaleString()} scanned)`; },
        () => false
      );
      progEl.textContent = `${xrunInstances.length.toLocaleString()} runs`;
      if (xrunReportedTotal != null && xrunReportedTotal > xrunInstances.length) {
        progEl.textContent += ` (max fetchable, of ${xrunReportedTotal.toLocaleString()} — narrow the window)`;
      }
    } catch (err) {
      progEl.textContent = '';
      alert('Failed to fetch runs: ' + err.message);
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.textContent = 'Fetch';
    }

    renderXrunList();
    updateXrunBanner();
  }

  // Status, duration, dates and tracking-variable filters are now applied server-side
  // (see runXrunFetch / buildInstancesUrl), so the enumerated list is already filtered.
  // This just returns it (kept as a seam for any future client-only filtering).
  function xrunStatusFiltered() {
    return xrunInstances;
  }

  function xrunRowMatches(it) {
    if (!xrunSearchTerm) return { matched: true, count: 0, scanned: xrunCache.has(xrunInstId(it)) };
    const cached = xrunCache.get(xrunInstId(it));
    if (!cached) return { matched: false, count: 0, scanned: false };
    const count = searchDataTree(cached.data.items, xrunSearchTerm).length;
    return { matched: count > 0, count, scanned: true };
  }

  function renderXrunList() {
    const listEl = overlay.querySelector('#oic-ev-xrun-list');
    if (!listEl) return;
    const matchOnly = overlay.querySelector('#oic-ev-xrun-matchonly').checked;
    const rows = xrunStatusFiltered();

    if (!rows.length) {
      listEl.innerHTML = '<div class="oic-ev-xrun-empty">No runs.</div>';
      updateXrunBanner();
      return;
    }

    const frag = document.createDocumentFragment();
    let shown = 0;
    const CAP = 1000;
    for (const it of rows) {
      const info = xrunRowMatches(it);
      if (matchOnly && xrunSearchTerm && !info.matched) continue;
      if (shown >= CAP) break;
      shown++;

      const id = xrunInstId(it);
      const purged = xrunIsPurged(it);
      const row = document.createElement('div');
      row.className = 'oic-ev-xrun-row' + (purged ? ' oic-ev-xrun-row-purged' : '');
      row.dataset.instanceId = id;
      if (id === xrunSelectedId) row.classList.add('oic-ev-xrun-row-active');
      if (xrunSearchTerm && info.scanned && info.matched) row.classList.add('oic-ev-xrun-row-match');

      const status = String(xrunStatus(it) || '').toUpperCase();
      const statusClass = /FAIL|ERROR|ABORT/.test(status) ? 'oic-ev-xrun-badge-err'
        : /PROGRESS|PAUSE|RUN/.test(status) ? 'oic-ev-xrun-badge-run'
          : 'oic-ev-xrun-badge-ok';

      // Purged runs get a "no activity" tag and no hit/cache badge (nothing to fetch).
      const badge = purged
        ? '<span class="oic-ev-xrun-purged-tag" title="Activity stream purged from Oracle">no activity</span>'
        : xrunSearchTerm
          ? (info.scanned ? `<span class="oic-ev-xrun-hits">${info.count}</span>` : '<span class="oic-ev-xrun-unscanned">?</span>')
          : (xrunCache.has(id) ? '<span class="oic-ev-xrun-cached">●</span>' : '');

      row.innerHTML = `
        <div class="oic-ev-xrun-row-top">
          <span class="oic-ev-xrun-badge ${statusClass}">${escapeHtml(status || '—')}</span>
          <span class="oic-ev-xrun-ver">${escapeHtml(xrunVersion(it))}</span>
          ${badge}
        </div>
        <div class="oic-ev-xrun-row-time">${escapeHtml(xrunFmtTime(xrunTimeRaw(it)))}${(() => { const d = xrunDurationMs(it); return isNaN(d) ? '' : ` · ${d.toLocaleString()} ms`; })()}</div>
        <div class="oic-ev-xrun-row-msg">${escapeHtml(String(xrunMsg(it)).substring(0, 160))}</div>
      `;
      row.addEventListener('click', () => selectXrunInstance(id, row));
      frag.appendChild(row);
    }

    listEl.innerHTML = '';
    listEl.appendChild(frag);
    if (shown >= CAP) {
      const note = document.createElement('div');
      note.className = 'oic-ev-xrun-cap-note';
      note.textContent = `Showing first ${CAP.toLocaleString()} of ${rows.length.toLocaleString()} — narrow the window.`;
      listEl.appendChild(note);
    }
    updateXrunBanner();
  }

  function updateXrunBanner() {
    const banner = overlay && overlay.querySelector('#oic-ev-xrun-banner');
    if (!banner) return;
    const total = xrunInstances.length;
    const fetched = xrunInstances.filter(it => xrunCache.has(xrunInstId(it))).length;
    if (!total) { banner.textContent = ''; return; }
    // When the server reports more runs than we could fetch (offset ≤ 500), show both.
    const capped = xrunReportedTotal != null && xrunReportedTotal > total;
    const runsLabel = capped
      ? `${total.toLocaleString()} runs (max allowed, of ${xrunReportedTotal.toLocaleString()})`
      : `${total.toLocaleString()} runs`;
    if (xrunSearchTerm) {
      banner.textContent = `Search covers ${fetched.toLocaleString()} fetched of ${runsLabel} — Scan to include the rest.`;
    } else {
      banner.textContent = `${runsLabel} · ${fetched.toLocaleString()} fetched`;
    }
  }

  async function selectXrunInstance(id, rowEl) {
    xrunSelectedId = id;
    overlay.querySelectorAll('.oic-ev-xrun-row-active').forEach(r => r.classList.remove('oic-ev-xrun-row-active'));
    if (rowEl) rowEl.classList.add('oic-ev-xrun-row-active');

    const detail = overlay.querySelector('#oic-ev-xrun-detail');

    // Already known purged — don't refetch, just explain.
    if (xrunUnavailable.has(id)) {
      detail.innerHTML = '<div class="oic-ev-xrun-empty-detail">Activity stream not available — this run\'s data has been purged from Oracle. The instance still appears in monitoring, but its activity log is gone.</div>';
      updateXrunBanner();
      return;
    }

    let cached = xrunCache.get(id);
    if (!cached) {
      detail.innerHTML = '<div class="oic-ev-loading"><div class="oic-ev-spinner"></div><div>Loading activity stream...</div></div>';
      try {
        const data = await fetchActivityStream(id);
        cached = { data };
        xrunCache.set(id, cached);
      } catch (err) {
        // Most common cause: the activity stream has been purged (HTTP 410).
        xrunUnavailable.add(id);
        if (rowEl) renderXrunList(); // refresh the row's badge
        detail.innerHTML = '<div class="oic-ev-xrun-empty-detail">Activity stream not available — this run\'s data has likely been purged from Oracle (' + escapeHtml(err.message) + ').</div>';
        return;
      }
    }

    activityData = cached.data;
    allPayloadsLoaded = collectLargePayloadItems(cached.data.items).length === 0;
    currentInstanceId = id;
    renderActivityView(id, detail);

    // Carry the cross-run term into the detail search so the match is visible.
    if (xrunSearchTerm) {
      const si = detail.querySelector('#oic-ev-search');
      if (si) { si.value = xrunSearchTerm; si.dispatchEvent(new Event('input')); }
    }
    updateXrunBanner();
  }

  async function scanXrunInstances() {
    const scanBtn = overlay.querySelector('#oic-ev-xrun-scan');
    const progEl = overlay.querySelector('#oic-ev-xrun-scan-progress');

    // Cancel if already scanning
    if (scanBtn.dataset.scanning === '1') {
      xrunScanCancel = true;
      return;
    }

    // Skip runs already fetched or already known to be purged (no activity to get).
    const targets = xrunStatusFiltered().filter(it => {
      const id = xrunInstId(it);
      return !xrunCache.has(id) && !xrunIsPurged(it);
    });
    if (!targets.length) {
      progEl.textContent = 'All fetched';
      return;
    }
    if (targets.length > XRUN_SCAN_CONFIRM_OVER &&
      !confirm(`Scan will fetch activity streams for ${targets.length.toLocaleString()} runs. Continue?`)) {
      return;
    }

    xrunScanCancel = false;
    scanBtn.dataset.scanning = '1';
    scanBtn.textContent = 'Cancel scan';
    let done = 0;
    let unavailable = 0;
    const total = targets.length;

    for (let i = 0; i < total; i += XRUN_SCAN_CONCURRENCY) {
      if (xrunScanCancel) break;
      const batch = targets.slice(i, i + XRUN_SCAN_CONCURRENCY);
      await Promise.allSettled(batch.map(async (it) => {
        const id = xrunInstId(it);
        try {
          const data = await fetchActivityStream(id);
          xrunCache.set(id, { data });
        } catch (e) {
          // Activity stream purged/gone (HTTP 410) — record so the row is marked.
          xrunUnavailable.add(id);
          unavailable++;
        }
      }));
      done += batch.length;
      const naText = unavailable ? ` · ${unavailable.toLocaleString()} unavailable` : '';
      progEl.textContent = `${Math.min(done, total).toLocaleString()} / ${total.toLocaleString()}${naText}`;
    }

    scanBtn.dataset.scanning = '0';
    scanBtn.textContent = 'Scan all';
    const naSuffix = unavailable ? ` · ${unavailable.toLocaleString()} unavailable (purged)` : '';
    progEl.textContent = xrunScanCancel
      ? `Cancelled at ${done.toLocaleString()}${naSuffix}`
      : `Scanned ${(done - unavailable).toLocaleString()}${naSuffix}`;
    renderXrunList();
    updateXrunBanner();
  }

  function applyXrunSearch(term) {
    xrunSearchTerm = term;
    renderXrunList();
    updateXrunBanner();
  }

  // Initialize
  watchForActivityStream();
})();
