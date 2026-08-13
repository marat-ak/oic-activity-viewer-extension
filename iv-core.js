/* ═══════════════════════════════════════════════════════════════════
   OIC Integration Viewer — shared core (iv-core.js)
   Blueprint data layer + tree-node renderer, shared between:
     - oic-integration-viewer-extension (full overlay viewer)
     - oic-activity-viewer-extension  (right-side definition panel)
   No overlay state lives here. Everything DOM-stateful (themes,
   color overrides, search, filters) stays in the host extension and
   is passed in via the `ctx` argument of renderNode:
     ctx = { badgeColor: function(type) -> '#hex', maxXpathChars: number }
   Exposed as window.OicIvCore.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── Constants ─────────────────────────────────────────────────────── */

  var THEMES = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'high-contrast', label: 'High Contrast' },
    { id: 'solarized', label: 'Solarized' }
  ];

  // Default badge colors per theme per activity type
  var DEFAULT_COLORS = {
    light: {
      RECEIVE: '#2563eb',
      INVOKE: '#1d4ed8',
      REPLY: '#3b82f6',
      TRANSFORMER: '#7c3aed',
      ASSIGNMENT: '#6b7280',
      ROUTER: '#ea580c',
      ROUTER_ROUTE: '#f97316',
      TRY: '#d97706',
      GLOBAL_TRY: '#d97706',
      CATCH_ALL: '#dc2626',
      TRY_CATCH: '#dc2626',
      THROW: '#b91c1c',
      LABEL: '#16a34a',
      STAGEFILE: '#0d9488',
      NOTIFICATION: '#db2777',
      PUBLISHER: '#4338ca',
      NOTE: '#9ca3af',
      STITCH: '#9ca3af',
      ACTIVITY_STREAM_LOGGER: '#6b7280',
      GLOBAL_VARIABLE: '#6b7280',
      ORCHESTRATION: '#0891b2',
      FOR_EACH: '#0e7490',
      WHILE: '#0e7490',
      WAIT: '#ca8a04',
      STOP: '#6b7280'
    },
    dark: {
      RECEIVE: '#60a5fa',
      INVOKE: '#93c5fd',
      REPLY: '#7dd3fc',
      TRANSFORMER: '#c4b5fd',
      ASSIGNMENT: '#9ca3af',
      ROUTER: '#fb923c',
      ROUTER_ROUTE: '#fdba74',
      TRY: '#fbbf24',
      GLOBAL_TRY: '#fbbf24',
      CATCH_ALL: '#f87171',
      TRY_CATCH: '#f87171',
      THROW: '#fca5a5',
      LABEL: '#4ade80',
      STAGEFILE: '#2dd4bf',
      NOTIFICATION: '#f472b6',
      PUBLISHER: '#818cf8',
      NOTE: '#6b7280',
      STITCH: '#6b7280',
      ACTIVITY_STREAM_LOGGER: '#94a3b8',
      GLOBAL_VARIABLE: '#94a3b8',
      ORCHESTRATION: '#22d3ee',
      FOR_EACH: '#22d3ee',
      WHILE: '#22d3ee',
      WAIT: '#facc15',
      STOP: '#6b7280'
    },
    'high-contrast': {
      RECEIVE: '#60a5fa',
      INVOKE: '#93c5fd',
      REPLY: '#38bdf8',
      TRANSFORMER: '#d8b4fe',
      ASSIGNMENT: '#d4d4d4',
      ROUTER: '#fb923c',
      ROUTER_ROUTE: '#fed7aa',
      TRY: '#fde68a',
      GLOBAL_TRY: '#fde68a',
      CATCH_ALL: '#fca5a5',
      TRY_CATCH: '#fca5a5',
      THROW: '#fecaca',
      LABEL: '#86efac',
      STAGEFILE: '#5eead4',
      NOTIFICATION: '#f9a8d4',
      PUBLISHER: '#a5b4fc',
      NOTE: '#a3a3a3',
      STITCH: '#a3a3a3',
      ACTIVITY_STREAM_LOGGER: '#d4d4d4',
      GLOBAL_VARIABLE: '#d4d4d4',
      ORCHESTRATION: '#67e8f9',
      FOR_EACH: '#67e8f9',
      WHILE: '#67e8f9',
      WAIT: '#fde047',
      STOP: '#a3a3a3'
    },
    solarized: {
      RECEIVE: '#268bd2',
      INVOKE: '#6c71c4',
      REPLY: '#2aa198',
      TRANSFORMER: '#d33682',
      ASSIGNMENT: '#839496',
      ROUTER: '#cb4b16',
      ROUTER_ROUTE: '#cb4b16',
      TRY: '#b58900',
      GLOBAL_TRY: '#b58900',
      CATCH_ALL: '#dc322f',
      TRY_CATCH: '#dc322f',
      THROW: '#dc322f',
      LABEL: '#859900',
      STAGEFILE: '#2aa198',
      NOTIFICATION: '#d33682',
      PUBLISHER: '#6c71c4',
      NOTE: '#657b83',
      STITCH: '#657b83',
      ACTIVITY_STREAM_LOGGER: '#839496',
      GLOBAL_VARIABLE: '#839496',
      ORCHESTRATION: '#2aa198',
      FOR_EACH: '#2aa198',
      WHILE: '#2aa198',
      WAIT: '#b58900',
      STOP: '#657b83'
    }
  };

  var TYPE_DISPLAY = {
    RECEIVE: 'RECEIVE',
    INVOKE: 'INVOKE',
    TRANSFORMER: 'MAP',
    ASSIGNMENT: 'ASSIGN',
    ROUTER: 'SWITCH',
    ROUTER_ROUTE: 'ROUTE',
    TRY: 'SCOPE',
    GLOBAL_TRY: 'SCOPE',
    CATCH_ALL: 'CATCH',
    TRY_CATCH: 'CATCH',
    THROW: 'THROW',
    LABEL: 'LABEL',
    STAGEFILE: 'STAGEFILE',
    NOTIFICATION: 'NOTIFY',
    PUBLISHER: 'PUBLISH',
    REPLY: 'REPLY',
    NOTE: 'NOTE',
    STITCH: 'STITCH',
    ACTIVITY_STREAM_LOGGER: 'LOG',
    GLOBAL_VARIABLE: 'VAR',
    ORCHESTRATION: 'ORCH',
    FOR_EACH: 'FOR-EACH',
    WHILE: 'WHILE',
    WAIT: 'WAIT',
    STOP: 'STOP'
  };

  function getDisplayType(type) {
    return TYPE_DISPLAY[type] || type;
  }

  // Returns true if activity is a LABEL whose children are all ASSIGNMENTs.
  // Such labels are rendered as an "ASSIGN" group badge.
  function isAssignGroup(activity) {
    if (!activity || activity.type !== 'LABEL') return false;
    var acts = activity.activities;
    if (!acts || acts.length === 0) return false;
    for (var i = 0; i < acts.length; i++) {
      if (acts[i].type !== 'ASSIGNMENT') return false;
    }
    return true;
  }

  // Returns the effective display type for an activity, taking into account
  // the LABEL→ASSIGN collapse rule above.
  function getEffectiveType(activity) {
    if (isAssignGroup(activity)) return 'ASSIGNMENT';
    return activity.type;
  }

  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function debounce(fn, ms) {
    var timer;
    return function () {
      var args = arguments;
      var ctx = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }


  // Parse expr.properties into an object
  function parseExprProperties(text) {
    var result = {};
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var idx = lines[i].indexOf(':');
      if (idx < 0) continue;
      var key = lines[i].substring(0, idx).trim();
      var value = lines[i].substring(idx + 1).trim();
      if (key) result[key] = value;
    }
    return result;
  }

  // Detect nxsdmetadata.properties entries (JSON, despite the extension) and
  // explode embedded user-uploaded samples and derived schemas into synthetic
  // file entries so they appear in the UI like regular archive files.
  function extractNxsdSamples(detail) {
    if (!detail || !detail.files) return;
    var paths = Object.keys(detail.files);
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (!/nxsdmetadata\.properties$/i.test(p)) continue;
      var raw = detail.files[p];
      if (!raw) continue;
      var meta;
      try { meta = JSON.parse(raw); } catch (e) { continue; }
      if (!meta || typeof meta !== 'object') continue;

      var dir = p.replace(/\/[^\/]+$/, '/');
      var fileName = (meta.SELECT_SCHEMA_FILE_NAME || '').trim() || 'sample';
      var baseName = fileName.replace(/\.[^./]+$/, '');

      if (meta.SEL_SCHEMA_FILE_KEY) {
        detail.files[dir + 'uploaded-sample/' + fileName] = String(meta.SEL_SCHEMA_FILE_KEY);
      }
      if (meta.SELECT_SCHEMA_FILE_OBJECT) {
        detail.files[dir + 'derived-schema/' + baseName + '.xsd'] = String(meta.SELECT_SCHEMA_FILE_OBJECT);
      }
      // Keep the few metadata scalars on the detail for quick display
      if (!detail.nxsd) detail.nxsd = {};
      if (meta.SELECT_SCHEMA_FILE_NAME) detail.nxsd.fileName = meta.SELECT_SCHEMA_FILE_NAME;
      if (meta.SELECT_SCHEMA_ROOT_ELEMENT) detail.nxsd.rootElement = meta.SELECT_SCHEMA_ROOT_ELEMENT;
      if (meta.SCHEMA_OPTION_TYPE_KEY) detail.nxsd.schemaType = meta.SCHEMA_OPTION_TYPE_KEY;
    }
  }

  // Decode the XML/HTML entities used inside .jca attribute values.
  function decodeHtmlEntities(s) {
    if (!s) return '';
    return s
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
      .replace(/&amp;/g, '&');
  }

  // Extract one <property name="X" value="..."> value from a .jca XML blob.
  function extractJcaProperty(xmlContent, propName) {
    var re = new RegExp('<property\\s+name="' + propName + '"\\s+value="([^"]*)"');
    var m = xmlContent.match(re);
    return m ? decodeHtmlEntities(m[1]) : '';
  }

  function pickSampleExtension(mediaType, sample) {
    if (mediaType) {
      if (/json/i.test(mediaType)) return 'json';
      if (/xml/i.test(mediaType)) return 'xml';
    }
    var trimmed = (sample || '').replace(/^\s+/, '');
    if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') return 'json';
    if (trimmed.charAt(0) === '<') return 'xml';
    return 'txt';
  }

  function prettifyIfJson(text, ext) {
    if (ext !== 'json' || !text) return text;
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return text; }
  }

  // Detect inline Request/Response samples in .jca adapter configs and
  // explode them into synthetic file entries so they appear in the UI.
  function extractJcaSamples(detail) {
    if (!detail || !detail.files) return;
    var paths = Object.keys(detail.files);
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (!/\.jca$/i.test(p)) continue;
      var content = detail.files[p];
      if (!content) continue;

      var dir = p.replace(/\/[^\/]+$/, '/');
      var baseFile = (p.split('/').pop() || '').replace(/\.jca$/i, '');
      var endpointBase = baseFile.replace(/_REQUEST$/i, '').replace(/_RESPONSE$/i, '');

      var reqMedia = extractJcaProperty(content, 'RequestMediaType');
      var respMedia = extractJcaProperty(content, 'ResponseMediaType');
      var reqSample = extractJcaProperty(content, 'RequestSample');
      var respSample = extractJcaProperty(content, 'ResponseSample');

      if (reqSample) {
        var reqExt = pickSampleExtension(reqMedia, reqSample);
        detail.files[dir + 'request-sample/' + endpointBase + '_request.' + reqExt] = prettifyIfJson(reqSample, reqExt);
      }
      if (respSample) {
        var respExt = pickSampleExtension(respMedia, respSample);
        detail.files[dir + 'response-sample/' + endpointBase + '_response.' + respExt] = prettifyIfJson(respSample, respExt);
      }
    }
  }

  // Parse archive ZIP (ArrayBuffer). Returns { projectXml: string, fileMap: {relativePath: content} }
  // fileMap paths are relative to .../resources/ (e.g. "processor_211/resourcegroup_X/expr.properties")
  function parseArchive(arrayBuffer) {
    if (typeof JSZip === 'undefined') {
      return Promise.reject(new Error('JSZip library not loaded'));
    }
    return JSZip.loadAsync(arrayBuffer).then(function (zip) {
      // Find project root by locating PROJECT-INF/project.xml
      var projectInfPath = null;
      zip.forEach(function (path) {
        if (projectInfPath) return;
        if (/PROJECT-INF\/project\.xml$/.test(path)) projectInfPath = path;
      });
      if (!projectInfPath) throw new Error('project.xml not found in archive');

      // Derive resources/ path — same parent as PROJECT-INF/
      var projectRoot = projectInfPath.replace(/PROJECT-INF\/project\.xml$/, '');
      var resourcesPrefix = projectRoot + 'resources/';

      var filePromises = [];
      var fileMap = {};
      var projectXml = '';

      // Read project.xml
      filePromises.push(
        zip.file(projectInfPath).async('string').then(function (text) { projectXml = text; })
      );

      // Read all text files under resources/
      zip.forEach(function (path, file) {
        if (file.dir) return;
        if (path.indexOf(resourcesPrefix) !== 0) return;
        var rel = path.substring(resourcesPrefix.length);
        var lower = rel.toLowerCase();
        var isText = /\.(properties|json|xml|xsl|xsd|wsdl|jca|txt|xslt)$/.test(lower);
        if (!isText) return;
        filePromises.push(
          file.async('string').then(function (content) { fileMap[rel] = content; })
        );
      });

      return Promise.all(filePromises).then(function () {
        return { projectXml: projectXml, fileMap: fileMap };
      });
    });
  }

  /* ── project.xml → blueprint JSON ──────────────────────────────────── */

  // Map XML local element names to activity types
  var XML_TYPE_MAP = {
    globalTry: 'GLOBAL_TRY',
    try: 'TRY',
    catchAll: 'CATCH_ALL',
    catch: 'TRY_CATCH',
    router: 'ROUTER',
    route: 'ROUTER_ROUTE',
    label: 'LABEL',
    receive: 'RECEIVE',
    scheduleReceive: 'RECEIVE',
    invoke: 'INVOKE',
    transformer: 'TRANSFORMER',
    assignment: 'ASSIGNMENT',
    throw: 'THROW',
    note: 'NOTE',
    reply: 'REPLY',
    publish: 'PUBLISHER',
    notification: 'NOTIFICATION',
    stageFile: 'STAGEFILE',
    stageStream: 'STAGEFILE',
    stitch: 'STITCH',
    activityStreamLogger: 'ACTIVITY_STREAM_LOGGER',
    globalVariable: 'GLOBAL_VARIABLE',
    for: 'FOR_EACH',
    while: 'WHILE',
    wait: 'WAIT',
    scope: 'TRY',
    stop: 'STOP',
    ehStop: 'STOP'
  };

  function parseApplicationsXml(rootEl) {
    // Returns map: applicationName -> { connectionTypeName, connectionName, mep, role, binding, ... }
    var result = {};
    var apps = rootEl.getElementsByTagNameNS('*', 'application');
    for (var i = 0; i < apps.length; i++) {
      var app = apps[i];
      // Only direct children of icsflow (skip nested)
      if (app.parentNode && app.parentNode.localName !== 'icsflow') continue;
      var name = app.getAttribute('name');
      if (!name) continue;
      var entry = { name: name };
      // role
      var roleEl = firstChildByName(app, 'role');
      if (roleEl) entry.role = roleEl.textContent.trim();
      // adapter
      var adapterEl = firstChildByName(app, 'adapter');
      if (adapterEl) {
        var typeEl = firstChildByName(adapterEl, 'type');
        var codeEl = firstChildByName(adapterEl, 'code');
        var nameEl = firstChildByName(adapterEl, 'name');
        if (codeEl) entry.connectionTypeName = codeEl.textContent.trim();
        if (nameEl) entry.connectionName = nameEl.textContent.trim();
        if (typeEl) entry.adapterType = typeEl.textContent.trim();
      }
      // mep
      var mepEl = firstChildByName(app, 'mep');
      if (mepEl) entry.endpointMEP = mepEl.textContent.trim();
      // binding (from outbound/inbound)
      var outIn = firstChildByName(app, 'outbound') || firstChildByName(app, 'inbound');
      if (outIn) {
        var bEl = firstChildByName(outIn, 'binding');
        if (bEl) entry.binding = bEl.textContent.trim();
        var opEl = firstChildByName(outIn, 'operation');
        if (opEl) entry.endpointName = opEl.textContent.trim();
      }
      result[name] = entry;
    }
    return result;
  }

  function parseProcessorsXml(rootEl) {
    // Returns map: processorName (e.g. "processor_611") -> { processorName, type, role }
    var result = {};
    var procs = rootEl.getElementsByTagNameNS('*', 'processor');
    for (var i = 0; i < procs.length; i++) {
      var proc = procs[i];
      if (proc.parentNode && proc.parentNode.localName !== 'icsflow') continue;
      var name = proc.getAttribute('name');
      if (!name) continue;
      var entry = { name: name };
      var typeEl = firstChildByName(proc, 'type');
      if (typeEl) entry.type = typeEl.textContent.trim();
      var roleEl = firstChildByName(proc, 'role');
      if (roleEl) entry.role = roleEl.textContent.trim();
      var pnEl = firstChildByName(proc, 'processorName');
      if (pnEl) entry.processorName = pnEl.textContent.trim();
      result[name] = entry;
    }
    return result;
  }

  function firstChildByName(el, localName) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var c = el.childNodes[i];
      if (c.nodeType === 1 && c.localName === localName) return c;
    }
    return null;
  }

  function childElementsByLocalName(el) {
    var out = [];
    for (var i = 0; i < el.childNodes.length; i++) {
      var c = el.childNodes[i];
      if (c.nodeType === 1) out.push(c);
    }
    return out;
  }

  function xmlElementToActivity(el, appsMap, procsMap) {
    var local = el.localName;
    var mappedType = XML_TYPE_MAP[local];
    if (!mappedType) return null;

    var activity = {
      type: mappedType,
      id: el.getAttribute('id') || '',
      refUri: el.getAttribute('refUri') || ''
    };

    var name = el.getAttribute('name');
    if (name) activity.name = name;
    var displayName = el.getAttribute('displayName');
    if (displayName) activity.displayName = displayName;
    var description = el.getAttribute('description');
    if (description) activity.description = description;
    var trackingRefUri = el.getAttribute('trackingRefUri');
    if (trackingRefUri) activity.trackingRefUri = trackingRefUri;
    var faultName = el.getAttribute('faultName');
    if (faultName) activity.faultName = faultName;

    // Enrich from applications or processors map based on refUri prefix
    if (activity.refUri) {
      var first = activity.refUri.split('/')[0];
      if (/^application_/.test(first) && appsMap && appsMap[first]) {
        var app = appsMap[first];
        if (app.connectionTypeName) activity.connectionTypeName = app.connectionTypeName;
        if (app.connectionName && !activity.name) activity.name = app.connectionName;
        if (app.connectionName) activity.connectionName = app.connectionName;
        if (app.endpointMEP) activity.endpointMEP = app.endpointMEP;
        if (app.endpointName && !activity.endpointName) activity.endpointName = app.endpointName;
        if (app.binding) activity.binding = app.binding;
        if (app.adapterType) activity.adapterType = app.adapterType;
      } else if (/^processor_/.test(first) && procsMap && procsMap[first]) {
        var proc = procsMap[first];
        if (proc.processorName && !activity.name) activity.name = proc.processorName;
      }
    }

    // Walk children
    var childEls = childElementsByLocalName(el);
    var activities = [];
    var routes = [];
    var catches = [];
    var catchAll = null;

    for (var i = 0; i < childEls.length; i++) {
      var child = childEls[i];
      var clocal = child.localName;
      if (clocal === 'catchAll') {
        catchAll = xmlElementToActivity(child, appsMap, procsMap);
      } else if (clocal === 'catch') {
        var cc = xmlElementToActivity(child, appsMap, procsMap);
        if (cc) catches.push(cc);
      } else if (clocal === 'route') {
        var r = xmlElementToActivity(child, appsMap, procsMap);
        if (r) routes.push(r);
      } else if (XML_TYPE_MAP[clocal]) {
        var a = xmlElementToActivity(child, appsMap, procsMap);
        if (a) activities.push(a);
      }
    }

    if (activities.length > 0) activity.activities = activities;
    if (routes.length > 0) activity.routes = routes;
    if (catches.length > 0) activity.catches = catches;
    if (catchAll) activity.catchAll = catchAll;

    return activity;
  }

  function parseProjectXml(xmlText) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(xmlText, 'application/xml');
    var parserError = doc.getElementsByTagName('parsererror');
    if (parserError && parserError.length > 0) {
      throw new Error('project.xml parse error: ' + parserError[0].textContent);
    }

    var root = doc.documentElement; // <ns3:icsproject>
    var projectCode = (firstChildByName(root, 'projectCode') || {}).textContent || '';
    var projectVersion = (firstChildByName(root, 'projectVersion') || {}).textContent || '';
    var projectName = (firstChildByName(root, 'projectName') || {}).textContent || '';

    var icsflow = firstChildByName(root, 'icsflow');
    if (!icsflow) throw new Error('No icsflow element found');

    var appsMap = parseApplicationsXml(icsflow);
    var procsMap = parseProcessorsXml(icsflow);

    var orchestration = firstChildByName(icsflow, 'orchestration');
    if (!orchestration) throw new Error('No orchestration element found');

    var globalTryEl = firstChildByName(orchestration, 'globalTry');
    var globalTry;
    if (globalTryEl) {
      globalTry = xmlElementToActivity(globalTryEl, appsMap, procsMap);
    } else {
      // Some integrations omit the <globalTry> wrapper — orchestration's direct children
      // ARE the top-level activities. Synthesize a GLOBAL_TRY container.
      globalTry = synthesizeGlobalTryFromOrchestration(orchestration, appsMap, procsMap);
    }

    // Collect global variables (if any top-level globalVariable elements)
    var globalVariables = [];
    var gvEls = childElementsByLocalName(orchestration);
    for (var i = 0; i < gvEls.length; i++) {
      if (gvEls[i].localName === 'globalVariable') {
        var gv = xmlElementToActivity(gvEls[i], appsMap, procsMap);
        if (gv) globalVariables.push(gv);
      }
    }

    return {
      name: projectName.trim(),
      code: projectCode.trim(),
      version: projectVersion.trim(),
      pattern: 'Orchestration',
      orchestration: {
        type: 'ORCHESTRATION',
        globalTry: globalTry || { type: 'GLOBAL_TRY', activities: [] },
        globalVariables: globalVariables
      },
      _applications: appsMap,
      _processors: procsMap
    };
  }

  // Build a synthetic GLOBAL_TRY for project.xml flavours that omit the <globalTry> wrapper
  // and put activities directly under <orchestration>.
  function synthesizeGlobalTryFromOrchestration(orchestrationEl, appsMap, procsMap) {
    var activities = [];
    var catchAll = null;
    var children = childElementsByLocalName(orchestrationEl);
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      var local = child.localName;
      // Skip elements that are NOT activities of the orchestration tree.
      if (local === 'globalVariable' || local === 'integrationMetadata') continue;
      if (local === 'catchAll') {
        catchAll = xmlElementToActivity(child, appsMap, procsMap);
        continue;
      }
      if (XML_TYPE_MAP[local]) {
        var a = xmlElementToActivity(child, appsMap, procsMap);
        if (a) activities.push(a);
      }
    }
    var node = { type: 'GLOBAL_TRY', activities: activities };
    if (catchAll) node.catchAll = catchAll;
    return node;
  }

  // Given a refUri and activity type, return archive files belonging to that activity.
  //   application_41/outbound_42/output_49 → strip trailing output/input/fault (adapter files live one level up)
  //   processor_211/output_212              → exact subtree (ROUTE uses its own output folder)
  //   processor_211 with type=ROUTER        → only files NOT inside output_/input_/fault_ subfolders
  //                                           (those belong to child ROUTER_ROUTEs)
  //   processor_211 (other types)           → full subtree
  function getArchiveFilesForRefUri(fileMap, refUri, activityType) {
    if (!refUri) return [];
    var folder = refUri;
    if (/^application_/.test(refUri)) {
      folder = refUri.replace(/\/(output|input|fault)_\d+$/, '');
    }
    var excludeRouteSubfolders = activityType === 'ROUTER';
    var result = [];
    var keys = Object.keys(fileMap);
    for (var i = 0; i < keys.length; i++) {
      var p = keys[i];
      if (p !== folder && p.indexOf(folder + '/') !== 0) continue;
      if (excludeRouteSubfolders) {
        var rel = p.substring(folder.length + 1);
        if (/^(output|input|fault)_\d+(\/|$)/.test(rel)) continue;
      }
      result.push({ path: p, content: fileMap[p] });
    }
    return result;
  }

  // Merge archive data into all activities in the blueprint
  function mergeArchiveIntoBlueprint(bp, fileMap) {
    var count = 0;
    function walk(activity) {
      if (!activity || typeof activity !== 'object') return;

      if (activity.refUri) {
        var files = getArchiveFilesForRefUri(fileMap, activity.refUri, activity.type);
        if (files.length > 0) {
          var detail = { files: {} };
          for (var i = 0; i < files.length; i++) {
            detail.files[files[i].path] = files[i].content;
            // Parse expr.properties specially for easier display.
            // Split: PRECONDITIONexpr.properties (THROW's IF-NOT condition) vs plain expr.properties.
            // NB: regex /expr\.properties$/ alone matches both, so check the basename explicitly.
            var basename = files[i].path.split('/').pop();
            if (basename === 'PRECONDITIONexpr.properties') {
              detail.preconditionExpression = parseExprProperties(files[i].content);
            } else if (basename === 'expr.properties') {
              detail.expression = parseExprProperties(files[i].content);
            }
          }
          // Extract user-uploaded sample & derived schema from nxsdmetadata.properties
          extractNxsdSamples(detail);
          // Extract inline request/response samples from .jca files
          extractJcaSamples(detail);
          activity._archiveDetail = detail;
          // Lift useful fields onto the activity itself
          if (detail.expression) {
            if (detail.expression.VariableName && !activity.variableName) {
              activity.variableName = detail.expression.VariableName;
            }
            if (detail.expression.VariableDescription && !activity.variableDescription) {
              activity.variableDescription = detail.expression.VariableDescription;
            }
            // ROUTER_ROUTE: lift ExpressionName as the route's display name (e.g. "ValidateRegion", "Otherwise")
            if (activity.type === 'ROUTER_ROUTE' && detail.expression.ExpressionName && !activity.name) {
              activity.name = detail.expression.ExpressionName;
            }
          }
          // TRANSFORMER: parse mapTargets from XSL to get target name
          if (activity.type === 'TRANSFORMER' && !activity.mappedTarget) {
            for (var fp in detail.files) {
              if (!Object.prototype.hasOwnProperty.call(detail.files, fp)) continue;
              if (!/\/req_[^\/]*\.xsl$/.test(fp)) continue;
              var xsl = detail.files[fp];
              var tgtBlock = xsl.match(/<oracle-xsl-mapper:mapTargets[\s\S]*?<\/oracle-xsl-mapper:mapTargets>/);
              if (!tgtBlock) break;
              var locMatch = tgtBlock[0].match(/location="([^"]+)"/);
              if (!locMatch) break;
              // Try to match application_XXX in path
              var appMatch = locMatch[1].match(/application_\d+/);
              if (appMatch && bp && bp._applications && bp._applications[appMatch[0]]) {
                activity.mappedTarget = { name: bp._applications[appMatch[0]].connectionName };
              } else {
                // Fall back: use the filename prefix (e.g. "CreateOrder_REQUEST.wsdl" → "CreateOrder")
                var fnMatch = locMatch[1].match(/\/([^\/]+)_REQUEST\.(wsdl|xsd)$/);
                if (fnMatch) activity.mappedTarget = { name: fnMatch[1] };
              }
              break;
            }
          }
          count++;
        }
      }

      // Recurse into children
      var childKeys = ['activities', 'routes', 'catches'];
      for (var k = 0; k < childKeys.length; k++) {
        var arr = activity[childKeys[k]];
        if (Array.isArray(arr)) {
          for (var j = 0; j < arr.length; j++) walk(arr[j]);
        }
      }
      if (activity.catchAll) walk(activity.catchAll);
    }

    if (bp && bp.orchestration) {
      if (bp.orchestration.globalTry) walk(bp.orchestration.globalTry);
      if (bp.orchestration.globalVariables) {
        for (var i = 0; i < bp.orchestration.globalVariables.length; i++) {
          walk(bp.orchestration.globalVariables[i]);
        }
      }
    }
    return count;
  }

  /* ── Tree rendering ─────────────────────────────────────────────────── */

  function getActivityName(activity) {
    // For adapter-backed activities, prefer the adapter's connection name over the operation name
    var t = activity.type;
    if (t === 'INVOKE' || t === 'RECEIVE' || t === 'REPLY' || t === 'PUBLISHER') {
      if (activity.connectionName) return activity.connectionName;
    }
    // TRANSFORMER shows its mapped target name
    if (t === 'TRANSFORMER' && activity.mappedTarget && activity.mappedTarget.name) {
      return activity.mappedTarget.name;
    }
    return activity.endpointName ||
      activity.name ||
      activity.faultName ||
      activity.variableName ||
      activity.id ||
      '(unnamed)';
  }

  // Returns the XPath expression for an activity from its archive detail, or ''.
  // THROW activities use PRECONDITIONexpr.properties (the IF-NOT condition);
  // all others use plain expr.properties.
  function getActivityXpath(activity) {
    var ad = activity && activity._archiveDetail;
    if (!ad) return '';
    if (activity && activity.type === 'THROW' && ad.preconditionExpression) {
      return ad.preconditionExpression.XpathExpression || ad.preconditionExpression.TextExpression || '';
    }
    if (!ad.expression) return '';
    return ad.expression.XpathExpression || ad.expression.TextExpression || '';
  }

  function truncateXpath(xpath, maxChars) {
    if (!xpath) return '';
    var max = (typeof maxChars === 'number' && maxChars > 0) ? maxChars : 60;
    if (xpath.length <= max) return xpath;
    return xpath.substring(0, max) + '…';
  }

  // Breadcrumb-friendly label, includes type prefix for scopes and route condition
  function getBreadcrumbLabel(activity) {
    var t = activity._virtualType ? activity._virtualType : activity.type;
    var name = activity._virtualType ? (activity._label || t) : getActivityName(activity);
    if (t === 'TRY' || t === 'GLOBAL_TRY') {
      return 'Scope ' + name;
    }
    if (t === 'ROUTER') {
      return 'Switch ' + name;
    }
    if (t === 'ROUTER_ROUTE') {
      return 'Route ' + (activity.name || activity.id || '');
    }
    return name;
  }

  function getChildren(activity) {
    var type = activity.type || activity._virtualType || '';
    var children = [];

    if (type === 'TRY' || type === 'GLOBAL_TRY') {
      // Main container — always present (holds the scope's activities)
      children.push({
        _virtualType: 'TRY_BLOCK',
        _label: 'Main',
        activities: activity.activities || []
      });
      // Faults container — only if there are catches or a catchAll
      var hasCatches = activity.catches && activity.catches.length > 0;
      var hasCatchAll = !!activity.catchAll;
      if (hasCatches || hasCatchAll) {
        var faultChildren = [];
        if (hasCatches) {
          activity.catches.forEach(function (c) { faultChildren.push(c); });
        }
        if (hasCatchAll) {
          faultChildren.push(activity.catchAll);
        }
        children.push({
          _virtualType: 'FAULTS_BLOCK',
          _label: 'Faults',
          activities: faultChildren
        });
      }
    } else if (type === 'FOR_EACH' || type === 'WHILE') {
      // Loop containers — children are their activities
      var loopActs = activity.activities || [];
      loopActs.forEach(function (a) { children.push(a); });
    } else if (type === 'ROUTER') {
      var routes = activity.routes || activity.routerRoutes || [];
      routes.forEach(function (r) { children.push(r); });
    } else if (type === 'TRY_BLOCK' || type === 'FAULTS_BLOCK') {
      // virtual container — children are its activities
      var acts = activity.activities || [];
      acts.forEach(function (a) { children.push(a); });
    } else {
      var acts2 = activity.activities || [];
      acts2.forEach(function (a) { children.push(a); });
    }
    return children;
  }

  function buildBreadcrumb(path) {
    return path.join(' › ');
  }

  function getSearchableText(activity) {
    var parts = [
      activity.type || '',
      activity.name || '',
      activity.endpointName || '',
      activity.variableName || '',
      activity.variableDescription || '',
      activity.id || '',
      activity.refUri || '',
      activity.faultName || '',
      activity.connectionId || '',
      activity.connectionName || '',
      activity.connectionTypeName || '',
      activity.adapterType || '',
      activity.mep || '',
      activity.endpointMEP || '',
      activity.binding || '',
      activity.requestEndpoint || '',
      activity.responseEndpoint || '',
      activity.condition || '',
      activity.expression || '',
      activity.xpathExpression || '',
      activity.description || '',
      getDisplayType(activity.type || '')
    ];
    // mappedTarget.name (TRANSFORMER)
    if (activity.mappedTarget && activity.mappedTarget.name) parts.push(activity.mappedTarget.name);
    // Archive-sourced content
    if (activity._archiveDetail) {
      var ad = activity._archiveDetail;
      if (ad.expression) {
        if (ad.expression.TextExpression) parts.push(ad.expression.TextExpression);
        if (ad.expression.XpathExpression) parts.push(ad.expression.XpathExpression);
        if (ad.expression.VariableName) parts.push(ad.expression.VariableName);
        if (ad.expression.VariableType) parts.push(ad.expression.VariableType);
        if (ad.expression.VariableDescription) parts.push(ad.expression.VariableDescription);
      }
      if (ad.files) {
        var keys = Object.keys(ad.files);
        for (var i = 0; i < keys.length; i++) {
          parts.push(keys[i]);
          parts.push(ad.files[keys[i]]);
        }
      }
    }
    return parts.join(' ').toLowerCase();
  }

  function renderDetail(activity) {
    var rows = [];

    function addRow(label, value) {
      if (value == null || value === '' || value === false) return;
      rows.push(
        '<div class="iv-detail-row">' +
        '<span class="iv-detail-label">' + escapeHtml(label) + '</span>' +
        '<span class="iv-detail-value">' + escapeHtml(String(value)) + '</span>' +
        '</div>'
      );
    }

    addRow('Type', activity.type);
    addRow('ID', activity.id);
    addRow('Name', activity.name);
    addRow('Endpoint Name', activity.endpointName);
    addRow('Variable Name', activity.variableName);
    addRow('Connection ID', activity.connectionId);
    addRow('Adapter Type', activity.adapterType);
    addRow('MEP', activity.mep);
    addRow('Request Endpoint', activity.requestEndpoint);
    addRow('Response Endpoint', activity.responseEndpoint);
    addRow('Condition', activity.condition);
    addRow('Expression', activity.expression);
    addRow('XPath', activity.xpathExpression);
    addRow('Mapping', activity.mappingName || activity.mapName);
    if (activity.variableType) {
      var vt = activity.variableType;
      addRow('Variable Type', vt.elementName + (vt.variableTypeClass ? ' (' + vt.variableTypeClass + ')' : ''));
    }
    addRow('Description', activity.description);
    if (activity.configured != null) addRow('Configured', activity.configured ? 'Yes' : 'No');

    // Archive-sourced details
    if (activity._archiveDetail) {
      var ad = activity._archiveDetail;
      if (ad.preconditionExpression) {
        var pe = ad.preconditionExpression;
        if (pe.XpathExpression) addRow('Precondition XPath', pe.XpathExpression);
        else if (pe.TextExpression) addRow('Precondition', pe.TextExpression);
      }
      if (ad.expression) {
        var e = ad.expression;
        if (e.TextExpression) addRow('Expression', e.TextExpression);
        if (e.XpathExpression) addRow('XPath', e.XpathExpression);
        if (e.VariableType) addRow('Var Type', e.VariableType);
      }
      if (ad.nxsd) {
        if (ad.nxsd.fileName) addRow('Sample File', ad.nxsd.fileName);
        if (ad.nxsd.rootElement) addRow('Root Element', ad.nxsd.rootElement);
        if (ad.nxsd.schemaType) addRow('Schema Type', ad.nxsd.schemaType);
      }
      if (ad.files) {
        var paths = Object.keys(ad.files);
        for (var fi = 0; fi < paths.length; fi++) {
          var p = paths[fi];
          var content = ad.files[p];
          rows.push(
            '<div class="iv-detail-row">' +
            '<span class="iv-detail-label">File</span>' +
            '<span class="iv-detail-value">' + escapeHtml(p) + '</span>' +
            '<button class="iv-fullscreen-btn iv-file-action" title="Copy to clipboard" data-file-action="copy" data-file-path="' + escapeHtml(p) + '">📋</button>' +
            '<button class="iv-fullscreen-btn iv-file-action" title="Download file" data-file-action="download" data-file-path="' + escapeHtml(p) + '">⬇</button>' +
            '<button class="iv-fullscreen-btn" title="Fullscreen" data-file-path="' + escapeHtml(p) + '">⛶</button>' +
            '</div>' +
            '<pre class="iv-archive-file">' + escapeHtml(content) + '</pre>'
          );
        }
      }
    }

    if (rows.length === 0) return '';
    return rows.join('');
  }

  function renderNode(activity, depth, parentPath, ctx) {
    depth = depth || 0;
    parentPath = parentPath || [];
    ctx = ctx || {};

    var type = activity.type || activity._virtualType || 'UNKNOWN';
    var isvirtual = !!activity._virtualType;
    var effectiveType = isvirtual ? type : getEffectiveType(activity);
    var name = isvirtual ? (activity._label || type) : getActivityName(activity);
    var displayType = isvirtual ? (activity._label || type) : getDisplayType(effectiveType);
    var children = getChildren(activity);
    var hasChildren = children.length > 0;
    var currentPath = parentPath.concat([getBreadcrumbLabel(activity)]);
    var searchText = isvirtual ? name.toLowerCase() : getSearchableText(activity);

    var node = document.createElement('div');
    node.className = 'iv-node';
    node._activityData = activity;
    node._searchText = searchText;
    node._type = type;
    node._effectiveType = effectiveType;

    /* Header row */
    var header = document.createElement('div');
    header.className = 'iv-node-header';

    /* Toggle */
    var toggle = document.createElement('span');
    toggle.className = 'iv-toggle' + (hasChildren ? '' : ' iv-leaf');
    toggle.textContent = hasChildren ? '▶' : '·';

    /* Type badge */
    var badge = document.createElement('span');
    badge.className = 'iv-type-badge';
    badge.textContent = displayType;
    if (!isvirtual) {
      badge.style.background = ctx.badgeColor ? ctx.badgeColor(effectiveType) : '#6b7280';
    } else {
      badge.style.background = '#475569';
    }

    /* Name */
    var nameSpan = document.createElement('span');
    nameSpan.className = 'iv-node-name';
    nameSpan.textContent = name;

    /* Inline connection badge */
    var connBadge = null;
    if (activity.adapterType) {
      connBadge = document.createElement('span');
      connBadge.className = 'iv-conn-badge';
      connBadge.textContent = activity.adapterType;
    }

    /* Inline detail — type-specific */
    var detailSpan = document.createElement('span');
    detailSpan.className = 'iv-node-detail';
    var detailText = '';
    if (!isvirtual) {
      var xp = getActivityXpath(activity);
      var maxXp = ctx.maxXpathChars;
      if (activity.type === 'ASSIGNMENT') {
        if (xp) detailText = '= ' + truncateXpath(xp, maxXp);
      } else if (activity.type === 'ROUTER_ROUTE') {
        detailText = xp ? 'IF ' + truncateXpath(xp, maxXp) : 'OTHERWISE';
      } else if (activity.type === 'FOR_EACH' || activity.type === 'WHILE') {
        if (xp) detailText = truncateXpath(xp, maxXp);
      } else if (activity.type === 'THROW') {
        if (xp) detailText = 'IF NOT ' + truncateXpath(xp, maxXp);
      } else if (activity.type === 'INVOKE' || activity.type === 'RECEIVE' || activity.type === 'REPLY') {
        // Show endpoint operation name (e.g. "execute") after the connection name
        if (activity.endpointName && activity.endpointName !== name) {
          detailText = activity.endpointName;
        }
      }
    }
    if (detailText) detailSpan.textContent = detailText;

    /* Child count */
    var childCount = null;
    if (hasChildren) {
      childCount = document.createElement('span');
      childCount.style.cssText = 'font-size:10px;color:var(--iv-text-faint);flex-shrink:0;';
      childCount.textContent = '(' + children.length + ')';
    }

    header.appendChild(toggle);
    header.appendChild(badge);
    header.appendChild(nameSpan);
    if (detailText) header.appendChild(detailSpan);
    if (connBadge) header.appendChild(connBadge);
    if (childCount) header.appendChild(childCount);

    node.appendChild(header);

    /* Breadcrumb */
    if (currentPath.length > 0) {
      var bc = document.createElement('div');
      bc.className = 'iv-breadcrumb';
      bc.textContent = buildBreadcrumb(currentPath);
      node.appendChild(bc);
    }

    /* Detail body — toggled by clicking the header (except on the expand toggle) */
    var detailHtml = isvirtual ? '' : renderDetail(activity);
    var body = null;
    if (detailHtml) {
      body = document.createElement('div');
      body.className = 'iv-node-body';
      body.innerHTML = detailHtml;

      header.style.cursor = 'pointer';
      header.addEventListener('click', function (e) {
        // Don't toggle when clicking the expand/collapse arrow
        if (e.target === toggle) return;
        body.classList.toggle('iv-open');
        header.classList.toggle('iv-header-active');
      });

      node.appendChild(body);
    }

    /* Children container */
    if (hasChildren) {
      var childrenDiv = document.createElement('div');
      childrenDiv.className = 'iv-children';
      childrenDiv.style.display = 'none'; // collapsed by default

      children.forEach(function (child) {
        childrenDiv.appendChild(renderNode(child, depth + 1, currentPath, ctx));
      });

      node.appendChild(childrenDiv);

      /* Toggle expand/collapse */
      toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        var isOpen = childrenDiv.style.display !== 'none';
        childrenDiv.style.display = isOpen ? 'none' : 'block';
        toggle.textContent = isOpen ? '▶' : '▼';
      });
    }

    return node;
  }
  /* ── Plain (non-project) .iar archive download ─────────────────────── */
  // Project-scoped integrations need the temp-deployment .car flow, which
  // stays in the integration viewer extension. This covers the common case.
  function fetchPlainArchive(code, version, integrationInstance) {
    var url = '/ic/api/integration/v1/integrations/' +
      encodeURIComponent(code + '|' + version) +
      '/archive?includeRecordingFlag=false&allowLockedProject=true' +
      (integrationInstance ? '&integrationInstance=' + encodeURIComponent(integrationInstance) : '');
    return fetch(url, { headers: { 'Authorization': 'session' }, credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('Archive fetch failed: ' + r.status + ' ' + r.statusText);
        return r.arrayBuffer();
      });
  }

  window.OicIvCore = {
    THEMES: THEMES,
    DEFAULT_COLORS: DEFAULT_COLORS,
    TYPE_DISPLAY: TYPE_DISPLAY,
    XML_TYPE_MAP: XML_TYPE_MAP,
    getDisplayType: getDisplayType,
    isAssignGroup: isAssignGroup,
    getEffectiveType: getEffectiveType,
    escapeHtml: escapeHtml,
    debounce: debounce,
    parseExprProperties: parseExprProperties,
    parseArchive: parseArchive,
    parseProjectXml: parseProjectXml,
    mergeArchiveIntoBlueprint: mergeArchiveIntoBlueprint,
    getActivityName: getActivityName,
    getActivityXpath: getActivityXpath,
    truncateXpath: truncateXpath,
    getBreadcrumbLabel: getBreadcrumbLabel,
    getChildren: getChildren,
    buildBreadcrumb: buildBreadcrumb,
    getSearchableText: getSearchableText,
    renderDetail: renderDetail,
    renderNode: renderNode,
    fetchPlainArchive: fetchPlainArchive
  };
})();
