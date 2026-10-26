import { defineContentScript } from '#imports';
import { browser } from 'wxt/browser';
import type { PageMeta, StreamCandidate, VideoQuality, YtDiag } from '../utils/types';
import { youtubePublishedHeight, youtubeQualityPreference } from '../utils/youtube';

// Supressor global — registra antes de defineContentScript para capturar erros do wrapper WXT em document_start
if (typeof window !== 'undefined') {
  const _s2jdIsInvalidated = (msg: string): boolean => /extension context invalidated/i.test(msg);
  window.addEventListener('error', (ev: ErrorEvent) => {
    const m = String(ev.message ?? (ev.error as Error)?.message ?? ev.error ?? '');
    if (_s2jdIsInvalidated(m)) { ev.preventDefault(); (ev as unknown as { stopImmediatePropagation?: () => void }).stopImmediatePropagation?.(); }
  }, true);
  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    const m = String((ev.reason as Error)?.message ?? (ev.reason as { message?: string })?.message ?? ev.reason ?? '');
    if (_s2jdIsInvalidated(m)) ev.preventDefault();
  });
}

const mediaPattern = /(?:\.m3u8|\.mpd|\.(?:mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|opus|wav|flac)(?:\.[a-z0-9]{1,4})?|dcp\.)(?:$|[?#&])|\/videoplayback(?:$|[?#])|\/manifest(?:$|[?#])/i;

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  matchAboutBlank: true,
  runAt: 'document_start',
  async main() {
    const seen = new Map<string, number>();
    const SEEN_TTL_MS = 15 * 60 * 1000;
    const seenHas = (url: string): boolean => {
      const at = seen.get(url);
      if (at == null) return false;
      if (Date.now() - at > SEEN_TTL_MS) { seen.delete(url); return false; }
      return true;
    };
    const seenAdd = (url: string): void => {
      seen.set(url, Date.now());
      if (seen.size > 1200) {
        const cutoff = Date.now() - SEEN_TTL_MS;
        for (const [k, v] of [...seen.entries()]) {
          if (v < cutoff) seen.delete(k);
          if (seen.size <= 500) break;
        }
        if (seen.size > 1200) {
          const keys = [...seen.keys()];
          for (let i = 0; i < keys.length && seen.size > 600; i++) seen.delete(keys[i]!);
        }
      }
    };
    let youtubeMeta: Partial<PageMeta> = {};
    let lastYoutubeVideoId = '';
    let lastPageUrl = location.href;
    let collectTimer = 0;
    let emeDetected = false;
    let contextDead = false;
    let pollId = 0;
    let mutationObserver: MutationObserver | undefined;
    const ytDiag: YtDiag = {};
    // W3 hardening: reuses lineares pré-compilados (evita recompilar a cada collect)
    const RE_YT = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/;
    const RE_VIMEO = /(^|\.)(vimeo\.com|vimeocdn\.com)$/;
    const RE_DM = /(^|\.)(dailymotion\.com|dmcdn\.net)$/;
    const RE_TWITCH = /(^|\.)(twitch\.tv|ttvnw\.net)$/;
    const RE_FB = /(^|\.)(facebook\.com|fbcdn\.net|fb\.watch)$/;
    const RE_IG = /(^|\.)(instagram\.com|cdninstagram\.com)$/;
    const RE_TT = /(^|\.)(tiktok\.com|tiktokcdn\.com|tiktokv\.com)$/;
    const RE_X = /(^|\.)(twitter\.com|x\.com|twimg\.com)$/;
    const RE_RUMBLE = /(^|\.)(rumble\.com)$/;
    const RE_ODYSEE = /(^|\.)(odysee\.com|odycdn\.com)$/;
    const RE_BILI = /(^|\.)(bilibili\.com|bilivideo\.com|hdslb\.com)$/;
const RE_NDI = /(^|\.)(niconico\.com|nicovideo\.jp)$/;
const RE_MEGA = /(^|\.)(mega\.nz|mega\.co\.nz)$/;
const RE_SOUNDCLOUD = /(^|\.)(soundcloud\.com)$/;
const RE_NDI = /(^|\.)(niconico\.com|nicovideo\.jp)$/;
const RE_MEGA = /(^|\.)(mega\.nz|mega\.co\.nz)$/;
const RE_SOUNDCLOUD = /(^|\.)(soundcloud\.com)$/;
const RE_SPOTIFY = /(^|\.)(spotify\.com)$/;
const RE_CLIPBOX = /(^|\.)(clipgrab\.com)$/;
const RE_TRIDENT = /(^|\.)(trident\.media\.ai)$/;
const RE_GEMINI = /(^|\.)(gemini\.google\.com|geminiandco\.sh)$/;
    let contentVersion = 'desconhecida';
    try {
      contentVersion = browser.runtime.getManifest().version ?? contentVersion;
    } catch {
      // Contexto morto: collect() nem chega a rodar.
    }

    // Silencia "Extension context invalidated" no painel Erros do Chrome.
    // Quando a extensão é recarregada, o content script antigo permanece na página
    // e qualquer chamada a runtime.* lança esse erro — não é bug, é lifecycle.
    try {
      window.addEventListener('error', (ev) => {
        if (ev.message?.includes('Extension context invalidated') || String(ev.error ?? '').includes('Extension context invalidated')) {
          ev.preventDefault();
          contextDead = true;
          try { mutationObserver?.disconnect(); } catch {}
          try { window.clearTimeout(collectTimer); } catch {}
          try { if (pollId) window.clearInterval(pollId); } catch {}
        }
      });
      window.addEventListener('unhandledrejection', (ev) => {
        const msg = String(ev.reason ?? ev.reason?.message ?? '');
        if (msg.includes('Extension context invalidated')) {
          ev.preventDefault();
          contextDead = true;
        }
      });
    } catch {}

    const isContextDeadError = (error: unknown): boolean =>
      error instanceof Error && /extension context invalidated/i.test(error.message);

    const isContextAlive = (): boolean => {
      try { return !!browser.runtime.id; } catch { return false; }
    };

    const safeSend = (message: unknown): void => {
      if (contextDead || !isContextAlive()) { contextDead = true; return; }
      try {
        const result = browser.runtime.sendMessage(message);
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          (result as Promise<unknown>).catch((error: unknown) => {
            if (isContextDeadError(error)) {
              contextDead = true;
              try { mutationObserver?.disconnect(); } catch { /* contexto morto */ }
              window.clearTimeout(collectTimer);
              if (pollId) window.clearInterval(pollId);
            }
          });
        }
      } catch (error) {
        if (isContextDeadError(error)) {
          contextDead = true;
          try { mutationObserver?.disconnect(); } catch { /* contexto morto */ }
          window.clearTimeout(collectTimer);
          if (pollId) window.clearInterval(pollId);
        }
      }
    };

    const detectPlatform = (): PageMeta['platform'] => {
      const host = location.hostname.toLowerCase();
      if (RE_YT.test(host)) return 'youtube';
      if (RE_VIMEO.test(host)) return 'vimeo';
      if (RE_DM.test(host)) return 'dailymotion';
      if (RE_TWITCH.test(host)) return 'twitch';
      if (RE_FB.test(host)) return 'facebook';
      if (RE_IG.test(host)) return 'instagram';
      if (RE_TT.test(host)) return 'tiktok';
      if (RE_X.test(host)) return 'x';
      if (RE_RUMBLE.test(host)) return 'rumble';
      if (RE_ODYSEE.test(host)) return 'odysee';
      if (RE_BILI.test(host)) return 'bilibili';
      return undefined;
    };

    const platformVideoId = (): string | undefined => {
      try {
        const url = new URL(location.href);
        const path = url.pathname;
        let match: RegExpMatchArray | null;
        if (detectPlatform() === 'vimeo' && (match = path.match(/\/video\/(\d+)/i))) return match[1];
        if (detectPlatform() === 'dailymotion' && (match = path.match(/\/video\/([^/?#_]+)/i))) return match[1];
        if (detectPlatform() === 'twitch' && (match = path.match(/\/(?:videos|embed\/video)\/(\d+)/i))) return match[1];
        if (detectPlatform() === 'tiktok' && (match = path.match(/\/video\/(\d+)/))) return match[1];
      } catch {
        // Mantem somente YouTube como canonico; demais plataformas usam metadados genericos.
      }
      return undefined;
    };

    document.addEventListener('encrypted', () => {
      emeDetected = true;
      scheduleCollect();
    }, true);
    // W3: sentinel adicional — requestMediaKeySystemAccess e mediaKeys em video
    try {
      const origRMKSA = Navigator.prototype.requestMediaKeySystemAccess;
      if (typeof origRMKSA === 'function' && !(origRMKSA as unknown as { _s2jd?: boolean })._s2jd) {
        (Navigator.prototype.requestMediaKeySystemAccess as unknown as { _s2jd?: boolean })._s2jd = true;
        Navigator.prototype.requestMediaKeySystemAccess = function (this: Navigator, ...args: Parameters<typeof origRMKSA>) {
          emeDetected = true;
          scheduleCollect();
          return origRMKSA.apply(this, args);
        } as typeof origRMKSA;
      }
    } catch {}
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'mediaKeys') as PropertyDescriptor | undefined;
      if (desc && !((desc.get as unknown as { _s2jd?: boolean })?._s2jd)) {
        const origGet = desc.get as (() => unknown) | undefined;
        if (origGet) {
          Object.defineProperty(HTMLMediaElement.prototype, 'mediaKeys', {
            configurable: true,
            get(this: HTMLMediaElement) {
              const v = origGet.call(this);
              if (v) { emeDetected = true; scheduleCollect(); }
              return v;
            },
          });
          (Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'mediaKeys')?.get as unknown as { _s2jd?: boolean })._s2jd = true;
        }
      }
    } catch {}

    const clean = (value?: string | null): string =>
      (value ?? '')
        .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);

    const absoluteUrl = (value?: string | null): string | undefined => {
      if (!value) return undefined;
      try {
        const url = new URL(value, location.href);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
      } catch {
        return undefined;
      }
    };

    const metaContent = (name: string): string | undefined =>
      document.querySelector<HTMLMetaElement>(`meta[property="${name}"],meta[name="${name}"]`)?.content;

    const isYouTubeHost = (): boolean =>
      /(^|\.)(?:youtube\.com|youtube-nocookie\.com)$/i.test(location.hostname);

    const youtubeVideoId = (): string | undefined => {
      if (!isYouTubeHost()) return undefined;
      try {
        const watchId = new URL(location.href).searchParams.get('v');
        if (watchId) return watchId;
        return location.pathname.match(/^\/(?:shorts|embed)\/([^/?#]+)/i)?.[1];
      } catch {
        return undefined;
      }
    };

    const pageTitle = (): string => {
      const titledPlayer = document.querySelector<HTMLElement>('[data-title], [title][class*="player" i], video[title]');
      const videoHeading = document.querySelector('h1.ytd-watch-metadata, ytd-watch-metadata h1, h1.title')?.textContent;
      return clean(
        youtubeMeta.title ||
          metaContent('og:title') ||
          metaContent('twitter:title') ||
          videoHeading ||
          document.querySelector('h1')?.textContent ||
          titledPlayer?.dataset.title ||
          titledPlayer?.title ||
          document.title ||
          location.pathname.split('/').filter(Boolean).pop() ||
          'Vídeo',
      );
    };

    const jsonLdThumbnail = (): string | undefined => {
      for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
        try {
          const value = JSON.parse(script.textContent || 'null') as Record<string, unknown>;
          const thumbnail = value?.thumbnailUrl;
          const raw = Array.isArray(thumbnail) ? thumbnail.at(-1) : thumbnail;
          if (typeof raw === 'string') return absoluteUrl(raw);
        } catch (error) {
          console.warn('[Stream2JD] jsonLD parse failed', error);
        }
      }
      return undefined;
    };

    const backgroundThumbnail = (): string | undefined => {
      const preview = document.querySelector<HTMLElement>('.jw-preview, [class*="player" i] [style*="background-image" i]');
      if (!preview) return undefined;
      const value = getComputedStyle(preview).backgroundImage;
      const match = value.match(/^url\(["']?(.*?)["']?\)$/i);
      return absoluteUrl(match?.[1]);
    };

    const pageThumbnail = (): string | undefined =>
      absoluteUrl(youtubeMeta.thumbnail) ||
      absoluteUrl(document.querySelector<HTMLVideoElement>('video[poster]')?.poster) ||
      absoluteUrl(document.querySelector<HTMLElement>('[data-poster]')?.getAttribute('data-poster')) ||
      jsonLdThumbnail() ||
      absoluteUrl(metaContent('og:image:secure_url')) ||
      absoluteUrl(metaContent('og:image')) ||
      absoluteUrl(metaContent('twitter:image')) ||
      backgroundThumbnail();

    const assignedJson = (source: string, marker: string): Record<string, unknown> | undefined => {
      const markerIndex = source.indexOf(marker);
      if (markerIndex < 0) return undefined;
      const start = source.indexOf('{', markerIndex + marker.length);
      if (start < 0) return undefined;
      // W3: depth limit + length guard evita ReDoS / OOM em HTML malformado
      const MAX_LEN = 2_000_000;
      const MAX_DEPTH = 60;
      if (source.length - start > MAX_LEN) return undefined;
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let index = start; index < source.length; index += 1) {
        const character = source[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') quoted = false;
          continue;
        }
        if (character === '"') quoted = true;
        else if (character === '{') {
          depth += 1;
          if (depth > MAX_DEPTH) return undefined;
        } else if (character === '}') {
          depth -= 1;
          if (depth === 0) {
            try {
              return JSON.parse(source.slice(start, index + 1)) as Record<string, unknown>;
            } catch {
              return undefined;
            }
          }
          if (depth < 0) return undefined;
        }
      }
      return undefined;
    };

    const mergeYouTubeQualities = (...groups: Array<VideoQuality[] | undefined>): VideoQuality[] => {
      const selected = new Map<string, VideoQuality>();
      for (const quality of groups.flatMap((group) => group ?? [])) {
        const height = youtubePublishedHeight(quality);
        if (height == null || height < 100 || height > 4320) continue;
        const fps = Number(quality.fps) || undefined;
        const key = `${height}:${fps && fps >= 50 ? 60 : 30}`;
        const normalized = { ...quality, height, fps };
        const previous = selected.get(key);
        const score = youtubeQualityPreference(normalized);
        const previousScore = previous ? youtubeQualityPreference(previous) : -1;
        if (!previous || score > previousScore) selected.set(key, normalized);
      }
      return [...selected.values()];
    };

    const readYouTubeData = (): StreamCandidate[] => {
      if (!isYouTubeHost()) return [];
      let response: Record<string, unknown> | undefined;
      let sawMarker = false;
      for (const script of Array.from(document.scripts)) {
        const source = script.textContent || '';
        if (!source.includes('ytInitialPlayerResponse')) continue;
        sawMarker = true;
        if (!source.includes('streamingData')) continue;
        response = assignedJson(source, 'ytInitialPlayerResponse');
        if (response) break;
      }
      ytDiag.responseFound = Boolean(response);
      if (!response) {
        if (sawMarker) ytDiag.formatsSeen = ytDiag.formatsSeen ?? 0;
        return [];
      }
      const details = response.videoDetails as Record<string, unknown> | undefined;
      const videoId = typeof details?.videoId === 'string' ? details.videoId : '';
      if (!videoId) return [];
      // Permite re-leitura se o vídeo é o mesmo mas ainda não temos qualidades (player tardio / SPA JETSKI)
      if (videoId === lastYoutubeVideoId && (youtubeMeta.qualities?.length ?? 0) > 0) return [];
      const thumbnails = (details?.thumbnail as { thumbnails?: Array<{ url?: string }> } | undefined)?.thumbnails ?? [];
      const streaming = response.streamingData as { formats?: unknown[]; adaptiveFormats?: unknown[] } | undefined;
      const formats = [...(streaming?.formats ?? []), ...(streaming?.adaptiveFormats ?? [])] as Array<Record<string, unknown>>;
      ytDiag.formatsSeen = formats.length;
      const qualities: VideoQuality[] = [];
      const items: StreamCandidate[] = [];
      for (const format of formats) {
        const mimeType = typeof format.mimeType === 'string' ? format.mimeType : '';
        if (!mimeType.toLowerCase().startsWith('video/')) continue;
        const height = youtubePublishedHeight(format);
        const width = Number(format.width) || undefined;
        const fps = Number(format.fps) || undefined;
        const bitrate = Number(format.bitrate) || undefined;
        const contentLength = Number(format.contentLength) || undefined;
        const itag = Number(format.itag) || undefined;
        const label = String(format.qualityLabel || (height ? `${height}p` : format.quality || 'Vídeo'));
        const container = mimeType.split(';', 1)[0]?.split('/', 2)[1]?.toUpperCase();
        const videoOnly = !format.audioQuality && !format.audioChannels;
        const quality: VideoQuality = { label, width, height, fps, bitrate, contentLength, itag, container, videoOnly };
        qualities.push(quality);
        if (typeof format.url === 'string') {
          items.push({
            url: format.url,
            source: 'player',
            platform: 'youtube',
            title: typeof details?.title === 'string' ? details.title : undefined,
            thumbnail: thumbnails.at(-1)?.url,
            width,
            height,
            fps,
            bitrate,
            contentLength,
            itag,
            quality: label,
            container,
            videoOnly,
          });
        }
      }
      // Mitigação S-05: embutidos não podem injetar qualidade de outro vídeo
      const currentId = youtubeVideoId();
      if (currentId && videoId !== currentId && location.pathname.startsWith('/watch')) {
        // Em youtube.com/watch, só aceita o vídeo da URL canônica
        ytDiag.formatsSeen = 0;
        return [];
      }
      lastYoutubeVideoId = videoId;
      youtubeMeta = {
        ...youtubeMeta,
        platform: 'youtube',
        videoId,
        title: typeof details?.title === 'string' ? clean(details.title) : youtubeMeta.title,
        thumbnail: absoluteUrl(thumbnails.at(-1)?.url) || youtubeMeta.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        qualities: mergeYouTubeQualities(youtubeMeta.qualities, qualities),
      };
      return items;
    };

    // Injeta o conteúdo do script como texto inline (textContent), evitando
    // carregar via script.src com URL chrome-extension://, que é bloqueado
    // pelo Chrome quando origens não batem (CSP / "Domains, protocols and ports must match").
    const injectScriptContent = async (path: string, modifyScript?: (script: HTMLScriptElement) => void): Promise<void> => {
      // WXT restringe o tipo de getURL a caminhos públicos conhecidos, mas em
      // tempo de execução ele aceita qualquer caminho de asset da extensão.
      const url = browser.runtime.getURL(path as Parameters<typeof browser.runtime.getURL>[0]);
      const text = await fetch(url).then((res) => res.text());
      const script = document.createElement('script');
      script.textContent = text;
      if (modifyScript) modifyScript(script);
      (document.head ?? document.documentElement).append(script);
      script.remove();
    };

    const injectYouTubeReader = async (): Promise<void> => {
      if (!isYouTubeHost()) return;
      try {
        await injectScriptContent('/youtube-main-world.js', (script) => {
          script.addEventListener('stream2jd-youtube-data', (event) => {
            if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') return;
            try {
              const value = JSON.parse(event.detail) as {
                videoId?: unknown;
                title?: unknown;
                thumbnail?: unknown;
                qualities?: unknown;
              };
              const videoId = typeof value.videoId === 'string' ? value.videoId : '';
              if (!videoId || videoId !== youtubeVideoId()) return;
              const qualities = Array.isArray(value.qualities)
                ? value.qualities.filter((quality): quality is VideoQuality => Boolean(quality) && typeof quality === 'object').slice(0, 64)
                : [];
              ytDiag.levelsSeen = qualities.length;
              youtubeMeta = {
                ...youtubeMeta,
                platform: 'youtube',
                videoId,
                title: typeof value.title === 'string' ? clean(value.title) : youtubeMeta.title,
                thumbnail: typeof value.thumbnail === 'string' ? absoluteUrl(value.thumbnail) : youtubeMeta.thumbnail,
                qualities: mergeYouTubeQualities(youtubeMeta.qualities, qualities),
              };
              scheduleCollect();
              scheduleYoutubeRetry();
            } catch {
              // Ignore malformed page-world data.
            }
          });
        });
      } catch {
        // Inline script parsing and network observation remain as fallbacks.
      }
    };

    const candidate = (rawUrl: string | null | undefined, source: string, extra: Partial<StreamCandidate> = {}): StreamCandidate | undefined => {
      if (!rawUrl) return undefined;
      const url = absoluteUrl(rawUrl);
      if (!url || !mediaPattern.test(url) || seenHas(url)) return undefined;
      if (/(?:^|&)(token|session|auth|jwt|access_token)=/i.test(url)) return undefined;
      try {
        new URL(url);
      } catch {
        return undefined;
      }
      seenAdd(url);
      // Enrich with additional metadata for better scoring
      const enriched: Partial<StreamCandidate> = {
        ...(extra),
        height: extra.height ?? resolveHeightFromUrl(url),
        width: extra.width ?? resolveWidthFromUrl(url),
        fps: extra.fps ?? resolveFpsFromUrl(url),
        bitrate: extra.bitrate ?? resolveBitrateFromUrl(url),
        drm: extra.drm ?? detectDrmScheme(url),
      };
      if (!enriched.url) { enriched.url = url; }
      return enriched satisfies StreamCandidate;
    };
    // Helper extraction from URL query params when available
    const resolveHeightFromUrl = (url: string): number | undefined => {
      try { const q = new URL(url).searchParams; const m = q.get('h') || q.get('width'); if (/\d+/.test(String(m))) return parseInt(String(m), 10); } catch {}
      return undefined;
    };
    const resolveWidthFromUrl = (url: string): number | undefined => {
      try { const q = new URL(url).searchParams; const m = q.get('w'); if (/\d+/.test(String(m))) return parseInt(String(m), 10); } catch {}
      return undefined;
    };
    const resolveFpsFromUrl = (url: string): number | undefined => {
      try { const q = new URL(url).searchParams; const m = q.get('f'); if (/\d+/.test(String(m))) return parseInt(String(m), 10); } catch {}
      return undefined;
    };
    const resolveBitrateFromUrl = (url: string): number | undefined => {
      try { const q = new URL(url).searchParams; const m = q.get('b'); if (/\d+/.test(String(m))) return parseInt(String(m), 10); } catch {}
      return undefined;
    };
    const detectDrmScheme = (url: string): DrmScheme => 'desconhecida';

    // ── JW Player API detection ──
    const detectJwPlayerSources = (): StreamCandidate[] => {
      const items: StreamCandidate[] = [];
      try {
        const jw = ((): ((id?: string) => { getPlaylist: () => unknown[] }) | undefined => {
          const w = window as unknown as Record<string, unknown>;
          const candidate = w["jwplayer"];
          return typeof candidate === "function" ? (candidate as (id?: string) => { getPlaylist: () => unknown[] }) : undefined;
        })();
        if (!jw) return items;
        const player = jw();
        if (!player || typeof player.getPlaylist !== 'function') return items;
        const playlist = player.getPlaylist();
        if (!Array.isArray(playlist)) return items;
        for (const entry of playlist) {
          const record = entry as Record<string, unknown>;
          const file = record.file;
          if (typeof file === 'string' && mediaPattern.test(file)) {
            const c = candidate(file, 'jwplayer', { title: pageTitle(), thumbnail: pageThumbnail() });
            if (c) items.push(c);
          }
          const sources = record.sources;
          if (Array.isArray(sources)) {
            for (const src of sources) {
              const s = src as Record<string, unknown>;
              const url = s.file ?? s.src ?? s.contentUrl;
              if (typeof url === 'string' && mediaPattern.test(url)) {
                const c = candidate(url, 'jwplayer', { title: pageTitle(), thumbnail: pageThumbnail(), quality: String(s.label ?? s.quality ?? '') });
                if (c) items.push(c);
              }
            }
          }
        }
      } catch {
        // JW Player pode nao estar acessivel do content script isolado.
      }
      return items;
    };

    // ── MediaSource / MSE detection ──
    const detectMediaSourceSources = (): StreamCandidate[] => {
      const items: StreamCandidate[] = [];
      try {
        // MediaSource objects are attached to video elements via srcObject.
        // When MSE is used, video.src is a blob: URL. We look for the
        // original manifest URL in the MediaSource callback or in the
        // page's JavaScript variables.
        for (const video of document.querySelectorAll<HTMLVideoElement>('video')) {
          const src = video.currentSrc || video.src;
          if (src && src.startsWith('blob:')) {
            // Try to find the manifest URL from the MediaSource sourceBuffers.
            try {
              const maybe = video as unknown as Record<string, unknown>;
              const mediaSource = (maybe["ms"] as { sourceBuffers?: unknown[] } | undefined);
              if (mediaSource?.sourceBuffers) {
                for (const sb of mediaSource.sourceBuffers) {
                  const sbRecord = sb as Record<string, unknown>;
                  const url = sbRecord.url ?? sbRecord.manifestUrl ?? sbRecord.baseUrl;
                  if (typeof url === 'string' && mediaPattern.test(url)) {
                    const c = candidate(url, 'mse', { title: pageTitle(), thumbnail: pageThumbnail() });
                    if (c) items.push(c);
                  }
                }
              }
            } catch { /* nao acessivel */ }
          }
        }
      } catch { /* nao acessivel */ }
      return items;
    };

    // ── In-page script injection for fetch/XHR/MediaSource interception ──
    const injectInterceptors = async (): Promise<void> => {
      try {
        await injectScriptContent('/stream2jd-intercept.js');
      } catch {
        // Fallback: webRequest API e DOM scraping cobrem a maioria dos casos.
      }
    };

    const collect = (): void => {
      if (contextDead) return;
      if (location.href !== lastPageUrl) {
        lastPageUrl = location.href;
        lastYoutubeVideoId = '';
        youtubeMeta = {};
      }
      const items: StreamCandidate[] = [
        ...readYouTubeData(),
        ...detectJwPlayerSources(),
        ...detectMediaSourceSources(),
      ];
      for (const element of document.querySelectorAll<HTMLMediaElement | HTMLSourceElement>('video,video source,audio,audio source')) {
        const media = element as HTMLMediaElement;
        // IDM-global: currentSrc pode ser blob: quando MSE; src pode ter sido setado via JS sem atributo visível
        const srcAttr = element.getAttribute('src');
        const srcProp = (element as unknown as { src?: string }).src;
        for (const url of [media.currentSrc, srcAttr, srcProp]) {
          const item = candidate(url, 'dom', {
            contentType: element.getAttribute('type') ?? '',
            title: pageTitle(),
            thumbnail: pageThumbnail(),
          });
          if (item) items.push(item);
        }
        // srcObject blob sem URL — tenta recuperar via media element ainda em intercept
        const srcObject = (media as unknown as { srcObject?: MediaSource | MediaStream }).srcObject;
        if (srcObject && typeof MediaSource !== 'undefined' && srcObject instanceof MediaSource) {
          try {
            // URL final já vem via intercept MediaSource; apenas marca blob como sinal
            ytDiag.formatsSeen = ytDiag.formatsSeen ?? 0;
          } catch {}
        }
      }

      try {
        for (const entry of performance.getEntriesByType('resource')) {
          const item = candidate(entry.name, 'performance');
          if (item) items.push(item);
        }
      } catch {
        // Resource Timing may be restricted in opaque frames.
      }

      for (const element of document.querySelectorAll<HTMLElement>('[data-src],[data-file],[data-url],[data-hls],[data-mpd],[data-source],[data-video],[data-stream],[src],[source]')) {
        // IDM-global: varre atributos ricos de players diversos (video.js, plyr, jw, hls.js wrappers)
        for (const attribute of ['data-src', 'data-file', 'data-url', 'data-hls', 'data-mpd', 'data-source', 'data-video', 'data-stream', 'src']) {
          const v = element.getAttribute(attribute);
          if (!v) continue;
          const item = candidate(v, 'attribute', {
            title: clean(element.dataset.title || element.title) || undefined,
            thumbnail: absoluteUrl(element.dataset.poster),
          });
          if (item) items.push(item);
        }
        // Fallback: qualquer atributo que pareça URL de mídia (heuristic multi-site)
        for (const attr of Array.from(element.attributes ?? [])) {
          const v = attr.value;
          if (!v || v.length < 8 || v.length > 2048) continue;
          if (!mediaPattern.test(v)) continue;
          // evita body html como value
          if (v.includes('<') || v.includes('>')) continue;
          const c = candidate(v, 'attribute-heuristic', { title: pageTitle(), thumbnail: pageThumbnail() });
          if (c) items.push(c);
        }
      }

      const currentYoutubeId = youtubeVideoId();
      const detected = detectPlatform();
      const platformId = platformVideoId();
      try {
        if (!emeDetected) {
          for (const video of document.querySelectorAll<HTMLVideoElement>('video')) {
            const withKeys = video as HTMLVideoElement & { mediaKeys?: unknown };
            if (withKeys.mediaKeys) { emeDetected = true; break; }
          }
        }
      } catch {
        // Checagem best-effort; o evento encrypted acima ja cobre a maioria.
      }
      if (currentYoutubeId && !ytDiag.playbackQuality) {
        try {
          const player = document.querySelector('#movie_player') as Element & { getPlaybackQuality?: unknown } | null;
          const rawPlayback = typeof player?.getPlaybackQuality === 'function'
            ? (player.getPlaybackQuality as () => unknown)()
            : undefined;
          if (typeof rawPlayback === 'string' && rawPlayback) ytDiag.playbackQuality = rawPlayback;
        } catch {
          // API do player pode nao existir em layouts novos; o diagnostico segue sem ela.
        }
      }
      const meta: PageMeta = {
        title: pageTitle(),
        thumbnail: pageThumbnail() || (currentYoutubeId ? `https://i.ytimg.com/vi/${currentYoutubeId}/hqdefault.jpg` : undefined),
        pageUrl: location.href,
        referer: location.href,
        platform: currentYoutubeId ? 'youtube' : detected,
        videoId: currentYoutubeId ?? platformId,
        emeDetected,
        contentVersion,
        ...(currentYoutubeId ? { ytDiag: { ...ytDiag } } : {}),
        ...youtubeMeta,
      };
      if (!meta.platform) delete meta.platform;
      if (!meta.videoId) delete meta.videoId;
      if (!contextDead) safeSend({ type: 'candidates', items, meta });
    };

    const scheduleCollect = (): void => {
      if (contextDead) return;
      window.clearTimeout(collectTimer);
      // W3: debounce 150ms agrupa MutationObserver sem perder primeira render YouTube SPA
      collectTimer = window.setTimeout(() => { if (!contextDead) collect(); }, 150);
    };
    // YouTube SPA: se ainda não temos qualidades, reagenda algumas vezes (JETSKI tardio)
    let ytRetryCount = 0;
    const scheduleYoutubeRetry = (): void => {
      if (contextDead) return;
      const yid = youtubeVideoId();
      if (!yid || (youtubeMeta.qualities?.length ?? 0) > 0) { ytRetryCount = 0; return; }
      if (ytRetryCount >= 8) return;
      ytRetryCount += 1;
      window.setTimeout(() => { if (!contextDead) collect(); scheduleYoutubeRetry(); }, 2500);
    };

    // Captura URLs enviadas pelo interceptor da pagina (fetch/XHR/MSE + JW Player)
    window.addEventListener('message', (event) => {
      // Validação de origem: só aceita mensagens do próprio documento (bloqueia iframes cross-origin)
      if (event.origin !== location.origin) return;
      if (event.source !== window || typeof event.data !== 'object' || event.data?.type !== 'stream2jd-intercept') return;
      const url = event.data?.url;
      const source = event.data?.source;
      const items = event.data?.items;
      // JW Player sources come as a batch of candidates
      if (source === 'jwplayer' && Array.isArray(items)) {
        const candidates = items
          .filter((e): e is { url: string; quality?: string; title?: string } => typeof e === 'object' && e !== null && typeof e.url === 'string')
          .map((e) => candidate(e.url, 'jwplayer', { title: e.title || pageTitle(), thumbnail: pageThumbnail(), quality: e.quality || '' }))
          .filter((c): c is StreamCandidate => c !== undefined);
        if (candidates.length) safeSend({ type: 'candidates', items: candidates, meta: { title: pageTitle(), pageUrl: location.href, referer: location.href } });
        return;
      }
      if (typeof url !== 'string' || url === '__intercepted__') return;
      const c = candidate(url, 'intercepted', { title: pageTitle(), thumbnail: pageThumbnail() });
      if (c) safeSend({ type: 'candidates', items: [c], meta: { title: pageTitle(), pageUrl: location.href, referer: location.href } });
    });

    mutationObserver = new MutationObserver(scheduleCollect);
    const observeDocument = (): void => {
      if (contextDead) return;
      if (!document.documentElement) {
        setTimeout(observeDocument, 20);
        return;
      }
      try {
        mutationObserver?.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['src', 'poster', 'data-src', 'data-file', 'data-url', 'data-hls', 'data-mpd', 'data-poster', 'data-source', 'data-video', 'data-stream', 'data-quality', 'data-format', 'aria-label', 'aria-valuenow', 'role'],
        });
      } catch (error) {
        if (isContextDeadError(error)) { contextDead = true; return; }
      }
      collect();
      scheduleYoutubeRetry();
    };

    observeDocument();
    try {
      await injectYouTubeReader();
    } catch (error) {
      if (isContextDeadError(error)) { contextDead = true; return; }
    }
    try {
      await injectInterceptors();
    } catch (error) {
      if (isContextDeadError(error as unknown)) { contextDead = true; return; }
      // Fallback: webRequest API e DOM scraping cobrem a maioria dos casos.
    }
    let perfObserver: PerformanceObserver | undefined;
    try {
      if (typeof PerformanceObserver !== 'undefined') {
        perfObserver = new PerformanceObserver(() => { if (!contextDead) scheduleCollect(); });
        try {
          perfObserver.observe({ type: 'resource', buffered: true });
        } catch {
          try { perfObserver.observe({ entryTypes: ['resource'] } as unknown as PerformanceObserverInit); } catch {}
        }
      }
    } catch {
      // Fallback polling below covers browsers without buffered resource observers.
    }
    pollId = window.setInterval(() => {
      if (contextDead || !isContextAlive()) {
        contextDead = true;
        if (pollId) window.clearInterval(pollId);
        try { mutationObserver?.disconnect(); } catch {}
        try { perfObserver?.disconnect(); } catch {}
        return;
      }
      if (document.hidden) return;
      collect();
    }, 3000);
  },
});