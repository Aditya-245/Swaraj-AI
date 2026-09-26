/* Swaraj AI frontend config — split-deploy wiring (no build step).
 *
 * How it works:
 * - Same-origin monolith (npm start): leave BACKEND empty -> all /api/* use this host. Nothing changes.
 * - Split (Vercel frontend -> Render backend): set BACKEND to your API origin, e.g.
 *     <script>window.__BACKEND_URL__ = "https://swaraj-backend.onrender.com";</script>
 *     <script src="./config.js"></script>
 *   or: localStorage.setItem('swaraj.backend', 'https://...') in the browser console.
 *   or:  ?backend=https://... query param (remembered in localStorage).
 *
 * config.js wraps window.fetch so every relative /api/*, /artifact/*, /uploads/*,
 * /download/* request goes to the backend, and rewrites <a>/<img> links the app
 * injects dynamically (artefact downloads, uploaded-image previews).
 */
(function () {
  'use strict';
  var q = null;
  try { q = new URLSearchParams(location.search).get('backend'); } catch (e) {}
  if (q) { try { localStorage.setItem('swaraj.backend', q.replace(/\/$/, '')); } catch (e) {} }
  var stored = '';
  try { stored = localStorage.getItem('swaraj.backend') || ''; } catch (e) {}
  var BACKEND = (window.__BACKEND_URL__ || stored || '').replace(/\/$/, '');

  window.BACKEND_URL = BACKEND;
  window.setBackend = function (u) {
    BACKEND = String(u || '').replace(/\/$/, '');
    window.BACKEND_URL = BACKEND;
    try {
      if (BACKEND) localStorage.setItem('swaraj.backend', BACKEND);
      else localStorage.removeItem('swaraj.backend');
    } catch (e) {}
    return BACKEND;
  };

  var PREFIXES = ['/api/', '/artifact/', '/uploads/', '/download/'];
  function needsPrefix(u) {
    if (!BACKEND) return false;
    if (typeof u !== 'string') return false;
    if (/^https?:\/\//i.test(u)) return false;
    return PREFIXES.some(function (p) { return u === p.slice(0, -1) || u.indexOf(p) === 0; });
  }
  window.backendUrl = function (u) {
    if (!u) return u;
    if (/^https?:\/\//i.test(u)) return u;
    return needsPrefix(u) ? BACKEND + u : u;
  };

  // Wrap fetch once so the 20+ existing fetch('/api/...') calls need no edits.
  if (!window.__backendFetchWrapped && window.fetch) {
    window.__backendFetchWrapped = true;
    var rawFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      if (typeof input === 'string' && needsPrefix(input)) input = BACKEND + input;
      return rawFetch(input, init);
    };
  }

  // Rewrite dynamically injected download/image links (<a href="/artifact/...">, <img src="/uploads/...">).
  function rewriteLinks(root) {
    if (!BACKEND || !root || !root.querySelectorAll) return;
    root.querySelectorAll('a[href^="/artifact/"],a[href^="/download/"],a[href^="/uploads/"],img[src^="/uploads/"]').forEach(function (el) {
      var attr = el.tagName === 'IMG' ? 'src' : 'href';
      var v = el.getAttribute(attr);
      if (v && v.charAt(0) === '/' && v.indexOf(BACKEND) !== 0) el.setAttribute(attr, BACKEND + v);
    });
  }
  if (window.MutationObserver && document.documentElement) {
    var obs = new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        m.addedNodes.forEach(function (n) {
          if (n.nodeType === 1) {
            rewriteLinks(n);
            if (n.tagName === 'A' || n.tagName === 'IMG') rewriteLinks(document);
          }
        });
      });
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
