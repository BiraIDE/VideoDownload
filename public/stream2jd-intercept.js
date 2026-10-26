// stream2jd-intercept.js — injected into page context to capture manifest URLs
// that bypass the content script's isolated-world DOM scraping.
// Sends captured URLs via window.postMessage for the content script to collect.

(function () {
  'use strict';

  var mediaPattern = /(?:\.m3u8|\.mpd|\.(?:mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|opus|wav|flac))(?:$|[?#&])|\/videoplayback(?:$|[?#])|\/manifest(?:$|[?#])/i;
  var seen = new Set();
  var channel = 'stream2jd-intercept';
  var seenPruneCounter = 0;
  // Em frames about:blank / sandboxed, location.origin é a string 'null'.
  // postMessage com targetOrigin 'null' é rejeitado pelo Chrome; usa '*' como fallback.
  var targetOrigin = (function () {
    try { return location.origin === 'null' ? '*' : location.origin; } catch { return '*'; }
  })();

  function send(url, source) {
    if (!url || typeof url !== 'string') return;
    try {
      var parsed = new URL(url, location.href);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    } catch { return; }
    if (seen.has(url)) return;
    seen.add(url);
    // W2-B: previne vazamento de memória em sessões longas (SPAs)
    if (++seenPruneCounter > 500 && seen.size > 600) { seen.clear(); seenPruneCounter = 0; }
    window.postMessage({ type: channel, url: url, source: source }, targetOrigin);
  }

  function sendCandidates(items) {
    if (!items || !items.length) return;
    window.postMessage({ type: channel, url: '__intercepted__', source: 'jwplayer', items: items }, targetOrigin);
  }

  // ── JW Player API detection (page context — window.jwplayer is available) ──
  function detectJwPlayerSources() {
    var items = [];
    try {
      var jw = window.jwplayer;
      if (typeof jw !== 'function') return items;
      var player = jw();
      if (!player || typeof player.getPlaylist !== 'function') return items;
      var playlist = player.getPlaylist();
      if (!Array.isArray(playlist)) return items;
      for (var i = 0; i < playlist.length; i++) {
        var entry = playlist[i];
        if (typeof entry !== 'object' || entry === null) continue;
        var file = entry.file;
        if (typeof file === 'string' && mediaPattern.test(file)) {
          items.push({ url: file, quality: String(entry.label || entry.quality || ''), title: entry.title || '' });
        }
        var sources = entry.sources;
        if (Array.isArray(sources)) {
          for (var j = 0; j < sources.length; j++) {
            var src = sources[j];
            if (typeof src !== 'object' || src === null) continue;
            var url = src.file || src.src || src.contentUrl;
            if (typeof url === 'string' && mediaPattern.test(url)) {
              items.push({ url: url, quality: String(src.label || src.quality || ''), title: src.title || '' });
            }
          }
        }
      }
    } catch { /* noop */ }
    return items;
  }

  // Poll for JW Player initialization (ad-protected covers delay player setup)
  var jwPollCount = 0;
  function pollJwPlayer() {
    jwPollCount++;
    try {
      var items = detectJwPlayerSources();
      if (items.length) {
        sendCandidates(items);
        return; // found — stop polling
      }
    } catch { /* noop */ }
    if (jwPollCount < 40) setTimeout(pollJwPlayer, 500); // max ~20s
  }

  // ── Fetch interception (IDM-global: cobre Request object + URL com query assinada) ──
  if (typeof window.fetch === 'function') {
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = '';
      if (typeof input === 'string') {
        url = input;
      } else if (input && typeof input.url === 'string') {
        url = input.url;
      } else {
        try { url = String(input); } catch {}
        if (!url || url === '[object Object]') {
          try { url = new URL(input, location.href).href; } catch {}
        }
      }
      // IDM-global: tenta capturar antes e depois; assinadas podem não ter extensão mas viram video/mp4
      if (typeof url === 'string' && url) {
        if (mediaPattern.test(url)) send(url, 'fetch');
        else if (/token|expires|signature|key|auth|cdn|video|stream|media|hls|dash|m3u8|mpd/i.test(url) && url.length < 2048) {
          try {
            var u = new URL(url, location.href);
            if (u.protocol === 'http:' || u.protocol === 'https:') send(url, 'fetch-maybe');
          } catch {}
        }
      }
      var p = originalFetch.apply(this, arguments);
      // Captura URL final pós-redirect via Response.url quando disponível
      try {
        p.then(function (res) {
          try {
            var rurl = res && res.url;
            if (typeof rurl === 'string' && mediaPattern.test(rurl)) send(rurl, 'fetch-res');
          } catch {}
          return res;
        }).catch(function(){});
      } catch {}
      return p;
    };
  }

  // ── XMLHttpRequest interception (IDM-global: guarda _url e captura responseURL no load) ──
  if (typeof XMLHttpRequest !== 'undefined') {
    var originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this._stream2jd_url = typeof url === 'string' ? url : String(url); } catch {}
      if (typeof url === 'string' && mediaPattern.test(url)) send(url, 'xhr-open');
      return originalOpen.apply(this, arguments);
    };
    var originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      var xhr = this;
      try {
        // quando já tem responseURL (em caso de reuso), captura
        var url = xhr.responseURL || xhr._stream2jd_url || '';
        if (url && mediaPattern.test(url)) send(url, 'xhr-send');
      } catch {}
      try {
        xhr.addEventListener('load', function () {
          try {
            var rurl = xhr.responseURL || xhr._stream2jd_url || '';
            if (typeof rurl === 'string' && rurl) {
              if (mediaPattern.test(rurl)) send(rurl, 'xhr-load');
              else {
                // Content-Type video/* sem extensão (signed URL) — valida via header
                var ct = '';
                try { ct = xhr.getResponseHeader('Content-Type') || ''; } catch {}
                if (/^(video|audio)\//i.test(ct) || /mpegurl|dash\+xml/i.test(ct)) send(rurl, 'xhr-load-ct');
              }
            }
          } catch {}
        });
      } catch {}
      return originalSend.apply(this, arguments);
    };
  }

  // ── HTMLMediaElement/src hooks (IDM-global: captura set direto via JS, tipo muitoHentai/player) ──
  try {
    var mediaProto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
    var srcDesc = mediaProto && Object.getOwnPropertyDescriptor(mediaProto, 'src');
    if (srcDesc && srcDesc.set) {
      var origMediaSet = srcDesc.set;
      Object.defineProperty(mediaProto, 'src', {
        configurable: true,
        enumerable: true,
        get: srcDesc.get,
        set: function (v) {
          try { if (typeof v === 'string' && v && mediaPattern.test(v)) send(v, 'media-src-set'); else if (typeof v === 'string' && v) { try { var u = new URL(v, location.href); if (u.protocol==='http:'||u.protocol==='https:') send(v, 'media-src-maybe'); } catch {} } } catch {}
          return origMediaSet.call(this, v);
        }
      });
    }
    var sourceProto = window.HTMLSourceElement && window.HTMLSourceElement.prototype;
    var srcDesc2 = sourceProto && Object.getOwnPropertyDescriptor(sourceProto, 'src');
    if (srcDesc2 && srcDesc2.set) {
      var origSourceSet = srcDesc2.set;
      Object.defineProperty(sourceProto, 'src', {
        configurable: true,
        enumerable: true,
        get: srcDesc2.get,
        set: function (v) {
          try { if (typeof v === 'string' && mediaPattern.test(v)) send(v, 'source-src-set'); } catch {}
          return origSourceSet.call(this, v);
        }
      });
    }
    // setAttribute('src', ...) para video/source
    var origSetAttr = window.Element && window.Element.prototype.setAttribute;
    if (origSetAttr) {
      window.Element.prototype.setAttribute = function (name, value) {
        try {
          if (typeof name === 'string' && name.toLowerCase() === 'src' && typeof value === 'string' && mediaPattern.test(value)) {
            if (this instanceof window.HTMLMediaElement || this instanceof window.HTMLSourceElement) send(value, 'setAttribute-src');
          }
        } catch {}
        return origSetAttr.apply(this, arguments);
      };
    }
  } catch {}

  // ── video.js / hls.js / plyr hooks (IDM-global: players que escondem URL em JS) ──
  try {
    // hls.js — Hls.Events.MANIFEST_PARSED usa url
    var checkHls = function () {
      try {
        var Hls = window.Hls;
        if (Hls && Hls.prototype && !Hls.prototype._s2jd_patched) {
          Hls.prototype._s2jd_patched = true;
          var origLoadSource = Hls.prototype.loadSource;
          if (typeof origLoadSource === 'function') {
            Hls.prototype.loadSource = function (url) {
              try { if (typeof url === 'string' && url) send(url, 'hls-loadSource'); } catch {}
              return origLoadSource.apply(this, arguments);
            };
          }
        }
      } catch {}
    };
    checkHls();
    setTimeout(checkHls, 1000);
    setTimeout(checkHls, 3000);
    // video.js — player.src({src: url})
    try {
      var checkVideoJs = function () {
        try {
          var vjs = window.videojs;
          if (vjs && !vjs._s2jd_patched) {
            vjs._s2jd_patched = true;
            // patch é best-effort: captura via media element já cobre
          }
        } catch {}
      };
      setTimeout(checkVideoJs, 1000);
    } catch {}
  } catch {}

  // ── URL.createObjectURL interception ──
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    var originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function (object) {
      var result = originalCreateObjectURL.apply(this, arguments);
      if (object && typeof object === 'object') {
        var tagName = Object.prototype.toString.call(object);
        if (tagName === '[object MediaSource]' || tagName === '[object SourceBuffer]') {
          try {
            var urls = object.url ? [object.url] : [];
            for (var i = 0; i < urls.length; i++) {
              if (mediaPattern.test(urls[i])) send(urls[i], 'object-url');
            }
          } catch { /* noop */ }
        }
      }
      return result;
    };
  }

  // ── MediaSource.sourceBuffer change ──
  if (typeof MediaSource !== 'undefined') {
    var originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (type) {
      var result = originalAddSourceBuffer.apply(this, arguments);
      try {
        if (typeof type === 'string' && mediaPattern.test(type)) send(type, 'sourcebuffer');
      } catch { /* noop */ }
      return result;
    };
  }

  // ── Signal to content script that interception is active ──
  window.postMessage({ type: channel, url: '__intercepted__', source: 'init' }, targetOrigin);

  // Start JW Player polling (ad covers delay player setup by seconds)
  if (typeof window.jwplayer === 'function') {
    pollJwPlayer();
  } else {
    // Poll until jwplayer is available or max attempts reached
    setTimeout(pollJwPlayer, 500);
  }
})();