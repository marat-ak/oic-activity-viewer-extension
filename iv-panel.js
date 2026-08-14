/* ═══════════════════════════════════════════════════════════════════
   Integration Definition Panel (iv-panel.js)
   Right-side panel inside the Enhanced Activity Stream viewer that
   renders the integration blueprint tree (via window.OicIvCore, the
   module shared with the OIC Integration Viewer extension) and can
   navigate from an activity-stream item to its definition node.
   Exposed as window.OicIvPanel:
     open(opts)        opts = { code, version, theme, onLayout }
     toggle(opts)
     close()
     navigateTo(item, opts)   item = activity-stream item; opts as open()
                              plus optional fallbackMilestones: [string]
     setTheme(themeId)
     isOpen()
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var Core = window.OicIvCore;

  var panel = null;
  var currentTheme = 'dark';
  var loadedKey = null;      // 'CODE|VERSION' currently rendered
  var loadingKey = null;     // key being fetched right now
  var blueprint = null;
  var bpCache = {};          // 'CODE|VERSION' -> parsed blueprint
  var nodeEls = [];          // flat list of rendered .iv-node elements (non-virtual)
  var pendingNav = null;     // nav request queued while archive loads
  var onLayout = null;       // host callback: (widthPx) => void, 0 = closed
  var panelWidth = 0;        // px; 0 = use default

  var MIN_W = 320;
  var FLASH_MS = 2500;

  /* ── Small helpers ─────────────────────────────────────────────────── */

  function badgeColor(type) {
    var th = Core.DEFAULT_COLORS[currentTheme] || Core.DEFAULT_COLORS.light;
    return th[type] || '#6b7280';
  }

  function renderCtx() {
    return { badgeColor: badgeColor, maxXpathChars: 60 };
  }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function setStatus(msg, isError) {
    if (!panel) return;
    var s = panel.querySelector('#oic-ev-ivp-status');
    if (s) {
      s.textContent = msg || '';
      s.classList.toggle('oic-ev-ivp-status-error', !!isError);
    }
  }

  function notifyLayout() {
    if (onLayout) onLayout(panel ? panel.getBoundingClientRect().width : 0);
  }

  /* ── Panel DOM ─────────────────────────────────────────────────────── */

  function ensurePanel() {
    if (panel) return;

    panel = el('div');
    panel.id = 'oic-ev-ivp';
    panel.setAttribute('data-theme', currentTheme);
    var defaultW = Math.min(Math.max(Math.round(window.innerWidth * 0.45), MIN_W), window.innerWidth - 200);
    panel.style.width = (panelWidth || defaultW) + 'px';

    /* Drag handle (left edge) */
    var handle = el('div', 'oic-ev-ivp-handle');
    handle.title = 'Drag to resize';
    handle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var onMove = function (me) {
        var w = Math.min(Math.max(window.innerWidth - me.clientX, MIN_W), Math.round(window.innerWidth * 0.85));
        panelWidth = w;
        panel.style.width = w + 'px';
        notifyLayout();
      };
      var onUp = function () {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        try { chrome.storage.local.set({ ivpWidth: panelWidth }); } catch (err) { }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    panel.appendChild(handle);

    var inner = el('div', 'oic-ev-ivp-inner');
    panel.appendChild(inner);

    /* Header */
    var header = el('div', 'oic-ev-ivp-header');
    header.appendChild(el('span', 'oic-ev-ivp-title', 'Integration'));
    var meta = el('span', 'oic-ev-ivp-meta');
    meta.id = 'oic-ev-ivp-meta';
    header.appendChild(meta);
    var reloadBtn = el('button', 'oic-ev-ivp-btn', '⟳');
    reloadBtn.title = 'Reload integration definition';
    reloadBtn.addEventListener('click', function () {
      var key = loadedKey || loadingKey;
      if (!key) return;
      var parts = key.split('|');
      loadedKey = null;
      blueprint = null;
      load(parts[0], parts.slice(1).join('|'));
    });
    header.appendChild(reloadBtn);
    var closeBtn = el('button', 'oic-ev-ivp-close', '✕');
    closeBtn.title = 'Close panel';
    closeBtn.addEventListener('click', close);
    header.appendChild(closeBtn);
    inner.appendChild(header);

    /* Toolbar: search + expand/collapse */
    var toolbar = el('div', 'oic-ev-ivp-toolbar');
    var search = document.createElement('input');
    search.type = 'search';
    search.id = 'oic-ev-ivp-search';
    search.placeholder = 'Filter activities…';
    search.addEventListener('input', Core.debounce(applyFilter, 200));
    toolbar.appendChild(search);
    var matchCount = el('span', 'oic-ev-ivp-count');
    matchCount.id = 'oic-ev-ivp-count';
    toolbar.appendChild(matchCount);
    var expandBtn = el('button', 'oic-ev-ivp-btn', '⊞');
    expandBtn.title = 'Expand all';
    expandBtn.addEventListener('click', function () { expandCollapseAll(true); });
    toolbar.appendChild(expandBtn);
    var collapseBtn = el('button', 'oic-ev-ivp-btn', '⊟');
    collapseBtn.title = 'Collapse all';
    collapseBtn.addEventListener('click', function () { expandCollapseAll(false); });
    toolbar.appendChild(collapseBtn);
    inner.appendChild(toolbar);

    /* Status line */
    var status = el('div', 'oic-ev-ivp-status');
    status.id = 'oic-ev-ivp-status';
    inner.appendChild(status);

    /* Tree container */
    var tree = el('div', 'oic-ev-ivp-tree');
    tree.id = 'oic-ev-ivp-tree';
    inner.appendChild(tree);

    /* File action buttons inside detail bodies (copy / download / fullscreen) */
    panel.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest && e.target.closest('.iv-fullscreen-btn');
      if (!btn) return;
      e.stopPropagation();
      var row = btn.closest('.iv-detail-row');
      var pre = row && row.nextElementSibling;
      if (!pre || !pre.classList.contains('iv-archive-file')) return;
      var path = btn.getAttribute('data-file-path') || 'file';
      var content = pre.textContent;
      var action = btn.getAttribute('data-file-action');
      if (action === 'copy') {
        copyText(content, btn);
      } else if (action === 'download') {
        downloadText(content, path);
      } else {
        openFullscreen(path, content);
      }
    });

    document.body.appendChild(panel);

    // Close panel on Escape BEFORE the activity viewer's own Esc handler
    // closes the whole overlay (capture phase fires first).
    document.addEventListener('keydown', escCapture, true);

    try {
      chrome.storage.local.get(['ivpWidth'], function (res) {
        if (res && typeof res.ivpWidth === 'number' && res.ivpWidth >= MIN_W && panel) {
          panelWidth = res.ivpWidth;
          panel.style.width = panelWidth + 'px';
          notifyLayout();
        }
      });
    } catch (e) { }

    notifyLayout();
  }

  function escCapture(e) {
    if (e.key === 'Escape' && panel) {
      var fs = document.getElementById('oic-ev-ivp-fs');
      if (fs) { fs.remove(); }
      else { close(); }
      e.stopPropagation();
      e.preventDefault();
    }
  }

  function close() {
    if (panel) {
      panel.remove();
      panel = null;
    }
    document.removeEventListener('keydown', escCapture, true);
    pendingNav = null;
    nodeEls = [];
    loadedKey = null;   // DOM is gone; force re-render on next open
    if (onLayout) onLayout(0);
  }

  function isOpen() { return !!panel; }

  function setTheme(themeId) {
    currentTheme = themeId || currentTheme;
    if (panel) {
      panel.setAttribute('data-theme', currentTheme);
      // Badge colors are inline styles — re-render to recolor
      if (blueprint) renderTree();
    }
  }

  /* ── Archive loading ───────────────────────────────────────────────── */

  function load(code, version) {
    if (!code || !version) {
      setStatus('No integration code/version on this run.', true);
      return;
    }
    var key = code + '|' + version;
    if (key === loadedKey && blueprint) { runPendingNav(); return; }
    if (key === loadingKey) return; // already in flight
    var metaEl = panel.querySelector('#oic-ev-ivp-meta');
    if (metaEl) metaEl.textContent = code + ' | v' + version;
    if (bpCache[key]) {
      blueprint = bpCache[key];
      loadedKey = key;
      if (metaEl && blueprint.name) metaEl.textContent = blueprint.name + ' · ' + code + ' | v' + version;
      setStatus('');
      renderTree();
      runPendingNav();
      return;
    }
    loadingKey = key;
    setStatus('Downloading archive…');
    var treeC = panel.querySelector('#oic-ev-ivp-tree');
    if (treeC) treeC.innerHTML = '';

    Core.fetchArchive(code, version, null)
      .catch(function (err) {
        // Plain endpoint failed — the integration is probably project-scoped.
        // Discover its project and retry via the temp-deployment .car flow
        // (shows the shared consent modal on first use).
        if (err && err.cancelled) throw err;
        setStatus('Not found directly — checking projects…');
        return Core.lookupProjectCode(code, version).then(function (pc) {
          if (!pc) throw err;
          setStatus('Project ' + pc + ' — building archive…');
          return Core.fetchArchive(code, version, pc, function (msg) { setStatus(msg); });
        });
      })
      .then(function (buf) {
        setStatus('Parsing archive…');
        return Core.parseArchive(buf);
      })
      .then(function (parsed) {
        var bp = Core.parseProjectXml(parsed.projectXml);
        Core.mergeArchiveIntoBlueprint(bp, parsed.fileMap);
        blueprint = bp;
        bpCache[key] = bp;
        loadedKey = key;
        loadingKey = null;
        var m = panel && panel.querySelector('#oic-ev-ivp-meta');
        if (m && bp.name) m.textContent = bp.name + ' · ' + code + ' | v' + version;
        setStatus('');
        renderTree();
        runPendingNav();
      })
      .catch(function (err) {
        loadingKey = null;
        if (err && err.cancelled) {
          setStatus('Cancelled.');
          return;
        }
        setStatus('Load failed: ' + (err && err.message ? err.message : String(err)), true);
      });
  }

  function renderTree() {
    if (!panel || !blueprint) return;
    var treeC = panel.querySelector('#oic-ev-ivp-tree');
    if (!treeC) return;
    treeC.innerHTML = '';
    var orch = blueprint.orchestration;
    if (!orch) { setStatus('No orchestration in blueprint.', true); return; }

    var roots = [];
    if (orch.globalVariables && orch.globalVariables.length > 0) {
      orch.globalVariables.forEach(function (gv) {
        if (!gv.type) gv.type = 'GLOBAL_VARIABLE';
        roots.push(gv);
      });
    }
    if (orch.globalTry) roots.push(orch.globalTry);

    var ctx = renderCtx();
    roots.forEach(function (a) {
      treeC.appendChild(Core.renderNode(a, 0, [], ctx));
    });

    nodeEls = [];
    var all = treeC.querySelectorAll('.iv-node');
    for (var i = 0; i < all.length; i++) {
      var a = all[i]._activityData;
      if (a && !a._virtualType) nodeEls.push(all[i]);
    }

    // Open the first level so the panel doesn't come up as a single row
    var rootNodes = treeC.children;
    for (var r = 0; r < rootNodes.length; r++) expandNodeEl(rootNodes[r]);
    applyFilter();
  }

  /* ── Expand / collapse ─────────────────────────────────────────────── */

  function setNodeExpanded(nodeEl, expand) {
    var childrenC = nodeEl.querySelector(':scope > .iv-children');
    if (!childrenC) return;
    childrenC.style.display = expand ? 'block' : 'none';
    var t = nodeEl.querySelector(':scope > .iv-node-header > .iv-toggle');
    if (t && !t.classList.contains('iv-leaf')) t.textContent = expand ? '▼' : '▶';
  }

  function expandNodeEl(nodeEl) { setNodeExpanded(nodeEl, true); }

  function expandCollapseAll(expand) {
    if (!panel) return;
    var treeC = panel.querySelector('#oic-ev-ivp-tree');
    var all = treeC.querySelectorAll('.iv-node');
    for (var i = 0; i < all.length; i++) setNodeExpanded(all[i], expand);
  }

  function expandAncestors(nodeEl, treeC) {
    var p = nodeEl.parentElement;
    while (p && p !== treeC) {
      if (p.classList.contains('iv-children')) {
        p.style.display = 'block';
        var owner = p.parentElement;
        var t = owner && owner.querySelector(':scope > .iv-node-header > .iv-toggle');
        if (t && !t.classList.contains('iv-leaf')) t.textContent = '▼';
      }
      p = p.parentElement;
    }
  }

  /* ── Filter ────────────────────────────────────────────────────────── */

  function applyFilter() {
    if (!panel) return;
    var treeC = panel.querySelector('#oic-ev-ivp-tree');
    var input = panel.querySelector('#oic-ev-ivp-search');
    var countEl = panel.querySelector('#oic-ev-ivp-count');
    var q = (input && input.value || '').trim().toLowerCase();
    var count = 0;

    function visit(nodeEl) {
      var selfMatch = !q || (nodeEl._searchText && nodeEl._searchText.indexOf(q) !== -1);
      var childrenC = nodeEl.querySelector(':scope > .iv-children');
      var anyChild = false;
      if (childrenC) {
        for (var i = 0; i < childrenC.children.length; i++) {
          var c = childrenC.children[i];
          if (c.classList.contains('iv-node') && visit(c)) anyChild = true;
        }
      }
      var visible = selfMatch || anyChild;
      nodeEl.style.display = visible ? '' : 'none';
      var headerEl = nodeEl.querySelector(':scope > .iv-node-header');
      if (headerEl) headerEl.classList.toggle('oic-ev-ivp-match', !!q && selfMatch);
      if (q && selfMatch) count++;
      if (q && anyChild && childrenC) {
        childrenC.style.display = 'block';
        var t = nodeEl.querySelector(':scope > .iv-node-header > .iv-toggle');
        if (t && !t.classList.contains('iv-leaf')) t.textContent = '▼';
      }
      return visible;
    }

    for (var i = 0; i < treeC.children.length; i++) {
      var c = treeC.children[i];
      if (c.classList.contains('iv-node')) visit(c);
    }
    if (countEl) countEl.textContent = q ? (count + ' matches') : '';
  }

  /* ── Navigation: activity-stream item → definition node ────────────── */

  // Activity-stream milestones are the blueprint activity id plus a phase
  // suffix: "i2Pre-dummy" / "i2Pre" / "i2Post" / "sr0#m" all belong to the
  // definition node with id "i2" / "sr0". (Confirmed against a real run:
  // 38/39 milestones resolve this way; "scx" is the synthetic
  // "Scheduled Run started executing" milestone → schedule RECEIVE node.)
  function stripMilestone(m) {
    var s = String(m || '').split('#')[0];
    return s.replace(/(Pre-dummy|Pre|Post)$/, '');
  }

  function findByDefinitionId(id) {
    if (!id) return null;
    for (var i = 0; i < nodeEls.length; i++) {
      if (nodeEls[i]._activityData.id === id) return nodeEls[i];
    }
    var low = String(id).toLowerCase();
    for (var j = 0; j < nodeEls.length; j++) {
      if (String(nodeEls[j]._activityData.id || '').toLowerCase() === low) return nodeEls[j];
    }
    return null;
  }

  function firstOfType(type) {
    for (var i = 0; i < nodeEls.length; i++) {
      if (nodeEls[i]._activityData.type === type) return nodeEls[i];
    }
    return null;
  }

  function norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function activityKeys(a) {
    var keys = [a.name, a.displayName, a.id, a.endpointName, a.connectionName,
      a.variableName, a.faultName, a.mappedTarget && a.mappedTarget.name];
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      if (keys[i]) out.push(String(keys[i]));
    }
    return out;
  }

  // Score how well a single milestone string matches one activity.
  function scoreActivity(milestone, activity) {
    var keys = activityKeys(activity);
    var mNorm = norm(milestone);
    if (!mNorm) return 0;
    var best = 0;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === milestone) { best = Math.max(best, 100); continue; }
      var kNorm = norm(k);
      if (!kNorm) continue;
      if (kNorm === mNorm) { best = Math.max(best, 90); continue; }
      if (mNorm.length >= 3 && kNorm.length >= 3 &&
        (kNorm.indexOf(mNorm) !== -1 || mNorm.indexOf(kNorm) !== -1)) {
        best = Math.max(best, 60);
      }
    }
    return best;
  }

  function findBestNode(milestone) {
    var bestEl = null, bestScore = 0;
    for (var i = 0; i < nodeEls.length; i++) {
      var s = scoreActivity(milestone, nodeEls[i]._activityData);
      if (s > bestScore) { bestScore = s; bestEl = nodeEls[i]; }
      if (bestScore >= 100) break;
    }
    return bestScore >= 60 ? bestEl : null;
  }

  function findNodeForMilestone(milestone) {
    // 1. Authoritative: strip phase suffix, match blueprint activity id
    var el = findByDefinitionId(stripMilestone(milestone));
    if (el) return el;
    // 2. Synthetic scheduler milestone → the schedule receive node
    if (milestone === 'scx') return firstOfType('RECEIVE');
    // 3. Heuristics on names (older OIC formats / renamed milestones)
    return findBestNode(milestone);
  }

  function focusNode(nodeEl) {
    var treeC = panel.querySelector('#oic-ev-ivp-tree');
    // Clear filter so the target is not display:none'd
    var input = panel.querySelector('#oic-ev-ivp-search');
    if (input && input.value) { input.value = ''; applyFilter(); }
    expandAncestors(nodeEl, treeC);
    var header = nodeEl.querySelector(':scope > .iv-node-header');
    var body = nodeEl.querySelector(':scope > .iv-node-body');
    if (body) {
      body.classList.add('iv-open');
      if (header) header.classList.add('iv-header-active');
    }
    nodeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (header) {
      header.classList.add('oic-ev-ivp-flash');
      setTimeout(function () {
        if (header) header.classList.remove('oic-ev-ivp-flash');
      }, FLASH_MS);
    }
  }

  function runNav(nav) {
    if (!panel) return;
    // Try the item's own milestone first, then ancestors' (deepest first).
    var tried = [];
    var milestones = [nav.milestone].concat(nav.fallbackMilestones || []);
    for (var i = 0; i < milestones.length; i++) {
      var m = milestones[i];
      if (!m || tried.indexOf(m) !== -1) continue;
      tried.push(m);
      var elMatch = findNodeForMilestone(m);
      if (elMatch) {
        focusNode(elMatch);
        if (i > 0) setStatus('No exact node for "' + milestones[0] + '" — showing parent "' + m + '".');
        else setStatus('');
        return;
      }
    }
    // Last resort: drop the (stripped) milestone into the filter box
    var q = stripMilestone(milestones[0]) || milestones[0] || '';
    if (q) {
      var input = panel.querySelector('#oic-ev-ivp-search');
      if (input) { input.value = q; applyFilter(); }
      setStatus('No definition node matched "' + q + '" — filtered tree instead.', true);
    } else {
      setStatus('This activity has no milestone to match on.', true);
    }
  }

  function runPendingNav() {
    if (!pendingNav) return;
    var nav = pendingNav;
    pendingNav = null;
    runNav(nav);
  }

  /* ── File actions (copy / download / fullscreen) ───────────────────── */

  function copyText(text, btn) {
    var flash = function (ok) {
      if (!btn) return;
      var orig = btn.textContent;
      btn.textContent = ok ? '✓' : '✕';
      setTimeout(function () { btn.textContent = orig; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { flash(true); }, function () { flash(false); });
    } else { flash(false); }
  }

  function downloadText(text, path) {
    var parts = String(path || 'file').split('/');
    var name = (parts[parts.length - 1] || 'file').replace(/[^a-zA-Z0-9_.-]/g, '_');
    var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  function openFullscreen(path, content) {
    var existing = document.getElementById('oic-ev-ivp-fs');
    if (existing) existing.remove();
    var fs = el('div');
    fs.id = 'oic-ev-ivp-fs';
    fs.setAttribute('data-theme', currentTheme);
    var header = el('div', 'oic-ev-ivp-fs-header');
    header.appendChild(el('span', 'oic-ev-ivp-fs-title', path));
    var closeBtn = el('button', 'oic-ev-ivp-close', '✕');
    closeBtn.addEventListener('click', function () { fs.remove(); });
    header.appendChild(closeBtn);
    fs.appendChild(header);
    var body = el('pre', 'oic-ev-ivp-fs-body');
    body.textContent = content;
    fs.appendChild(body);
    document.body.appendChild(fs);
  }

  /* ── Public API ────────────────────────────────────────────────────── */

  function open(opts) {
    opts = opts || {};
    if (opts.onLayout) onLayout = opts.onLayout;
    if (opts.theme) currentTheme = opts.theme;
    ensurePanel();
    panel.setAttribute('data-theme', currentTheme);
    load(opts.code, opts.version);
  }

  function toggle(opts) {
    if (panel) close();
    else open(opts);
  }

  function navigateTo(item, opts) {
    opts = opts || {};
    pendingNav = {
      milestone: item && item.milestone,
      fallbackMilestones: opts.fallbackMilestones || []
    };
    if (!panel || loadedKey !== ((opts.code || '') + '|' + (opts.version || ''))) {
      open(opts);   // runPendingNav fires after load (or immediately if cached)
    } else {
      runPendingNav();
    }
  }

  window.OicIvPanel = {
    open: open,
    toggle: toggle,
    close: close,
    navigateTo: navigateTo,
    setTheme: setTheme,
    isOpen: isOpen
  };
})();
