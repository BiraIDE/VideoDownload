import { defineBackground } from '#imports';
import { browser, type Browser } from 'wxt/browser';
import { mainDocumentUrl, mergeFrameMeta } from '../utils/frame-meta';
import type { ExtensionConfig, RuntimeMessage, StreamCandidate, StreamKind, TabCaptureState } from '../utils/types';
import { candidatePriority } from '../utils/scoring';
import { youtubePublishedHeight } from '../utils/youtube';

const captures = new Map<number, TabCaptureState>();
const loadingStates = new Map<number, Promise<TabCaptureState>>();
const pendingHeaders = new Map<string, Pick<StreamCandidate, 'headers' | 'referer' | 'origin'>>();
const recentHeadersByUrl = new Map<string, Pick<StreamCandidate, 'headers' | 'referer' | 'origin'> & { seenAt: number }>();
const interceptingDownloadIds = new Set<number>();
const mediaPattern = /(?:\.m3u8|\.mpd|\.(?:mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|opus|wav|flac))(?:$|[?#&])|\/videoplayback(?:$|[?#])|\/manifest(?:$|[?#])/i;
const manifestTypePattern = /(?:application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)|video\/(?:mp4|webm)|audio\/(?:mpeg|mp4|aac|ogg|opus|wav|x-wav|flac))/i;
const documentTypePattern = /(?:text\/html|application\/(?:xhtml\+xml|json))/i;
const telemetryPattern = /(?:\/ping\.gif(?:$|\?)|\/analytics(?:$|[/?])|google-analytics\.com|googletagmanager\.com|\/collect(?:$|\?))/i;
const retainedHeaderPattern = /^(?:origin|referer|user-agent|accept|accept-language|sec-ch-ua(?:-mobile|-platform)?|x-[a-z0-9-]+)$/i;
const youtubeProgressiveItags = new Set([5, 6, 17, 18, 22, 34, 35, 36, 37, 38, 43, 44, 45, 46]);
let captureHeaders = true;

void browser.storage.local.get({ captureHeaders: true }).then((stored) => {
  captureHeaders = Boolean(stored.captureHeaders);
});

browser.storage.onChanged.addListener((changes) => {
  if (changes.captureHeaders) captureHeaders = Boolean(changes.captureHeaders.newValue);
});

function storageKey(tabId: number): string {
  return `capture:${tabId}`;
}

async function stateFor(tabId: number): Promise<TabCaptureState> {
  const active = captures.get(tabId);
  if (active) return active;
  const loading = loadingStates.get(tabId);
  if (loading) return loading;
  const task = browser.storage.session
    .get(storageKey(tabId))
    .then((stored) => {
      const raw = stored[storageKey(tabId)] as unknown;
      const isValidSession = (v: unknown): v is { items?: StreamCandidate[]; rejected?: string[]; meta?: TabCaptureState['meta']; updated?: number } =>
        typeof v === 'object' && v !== null;
      const value = isValidSession(raw) ? raw : undefined;
      let items: StreamCandidate[] = [];
      let rejected: string[] = [];
      if (Array.isArray(value?.items)) {
        items = value.items.filter((entry): entry is StreamCandidate => typeof entry === 'object' && entry !== null && typeof (entry as { url?: unknown }).url === 'string');
      }
      if (Array.isArray(value?.rejected)) {
        rejected = value.rejected.filter((entry): entry is string => typeof entry === 'string');
      }
      const meta = typeof value?.meta === 'object' && value?.meta !== null ? (value.meta as TabCaptureState['meta']) : {};
      const state: TabCaptureState = {
        items: new Map(items.map((item) => [candidateKey(item), item])),
        rejected: new Set(rejected),
        meta,
        updated: typeof value?.updated === 'number' && Number.isFinite(value.updated) ? value.updated : Date.now(),
      };
      captures.set(tabId, state);
      loadingStates.delete(tabId);
      return state;
    })
    .catch(() => {
      const fallback: TabCaptureState = { items: new Map(), rejected: new Set(), meta: {}, updated: Date.now() };
      captures.set(tabId, fallback);
      loadingStates.delete(tabId);
      return fallback;
    });
  loadingStates.set(tabId, task);
  return task;
}

function persistState(tabId: number, state: TabCaptureState): void {
  void browser.storage.session
    .set({
      [storageKey(tabId)]: {
        items: [...state.items.values()],
        rejected: [...state.rejected],
        meta: state.meta,
        updated: state.updated,
      },
    })
    .catch((error) => {
      console.warn('[Stream2JD] session quota', error);
      if (state.items.size > 40) {
        let toRemove = Math.floor(state.items.size / 2);
        for (const key of [...state.items.keys()]) {
          if (toRemove-- <= 0) break;
          state.items.delete(key);
        }
        state.updated = Date.now();
        void browser.storage.session
          .set({
            [storageKey(tabId)]: {
              items: [...state.items.values()],
              rejected: [...state.rejected],
              meta: state.meta,
              updated: state.updated,
            },
          })
          .catch(() => {
            void browser.storage.session.remove(storageKey(tabId)).catch(() => undefined);
          });
        updateBadge(tabId, state.items.size);
      } else {
        void browser.storage.session.remove(storageKey(tabId)).catch(() => undefined);
      }
    });
}

function kindOf(url: string, contentType = ''): StreamKind {
  const value = `${url} ${contentType}`.toLowerCase();
  if (value.includes('.m3u8') || value.includes('mpegurl')) return 'HLS';
  if (value.includes('.mpd') || value.includes('dash+xml')) return 'DASH';
  try {
    const mime = new URL(url).searchParams.get('mime')?.toLowerCase() ?? '';
    if (mime === 'video/mp4') return 'MP4';
    if (mime === 'video/webm') return 'WebM';
    if (mime.startsWith('audio/')) return 'Audio';
  } catch {
    // The URL is validated before this helper is called.
  }
  if (/\.(mp4|m4v)(?:$|[?#])|video\/mp4/.test(value)) return 'MP4';
  if (/\.webm(?:$|[?#])|video\/webm/.test(value)) return 'WebM';
  if (/\.(mp3|m4a|aac|ogg|opus|wav|flac)(?:$|[?#])|audio\//.test(value)) return 'Audio';
  return 'Media';
}

function positiveNumber(value: string | null): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function enrichCandidate(candidate: StreamCandidate): StreamCandidate {
  let parsed: URL | undefined;
  try { parsed = new URL(candidate.url); } catch { return candidate; }
  const mime = parsed.searchParams.get('mime')?.toLowerCase() ?? '';
  const pathItag = parsed.pathname.match(/\/itag\/(\d+)(?:\/|$)/i)?.[1];
  const itag = candidate.itag ?? positiveNumber(parsed.searchParams.get('itag') ?? pathItag ?? null);
  const resolution = `${parsed.pathname} ${parsed.search}`.match(/(?:^|[^\d])(144|240|270|360|480|540|720|1080|1440|2160|3072|4320)p?(?:[^\d]|$)/i);
  const dimensions = `${parsed.pathname} ${parsed.search}`.match(/(?:^|[^\d])(\d{3,4})x(\d{3,4})(?:[^\d]|$)/i);
  const isYoutube = candidate.platform === 'youtube' || /(?:^|\.)googlevideo\.com$/i.test(parsed.hostname);
  const reportedHeight = candidate.height ?? positiveNumber(parsed.searchParams.get('height')) ?? positiveNumber(dimensions?.[2] ?? resolution?.[1] ?? null);
  const height = isYoutube
    ? youtubePublishedHeight({ quality: candidate.quality ?? parsed.searchParams.get('quality_label'), itag, height: reportedHeight })
    : reportedHeight;
  const width = candidate.width ?? positiveNumber(parsed.searchParams.get('width')) ?? positiveNumber(dimensions?.[1] ?? null);
  const fps = candidate.fps ?? positiveNumber(parsed.searchParams.get('fps'));
  const container = candidate.container ?? ((mime.startsWith('video/') || mime.startsWith('audio/')) ? mime.split('/', 2)[1]?.toUpperCase() : undefined);
  const quality = candidate.quality ?? parsed.searchParams.get('quality_label') ?? (height ? `${height}p${fps && fps >= 50 ? fps : ''}` : undefined);
  return {
    ...candidate,
    platform: isYoutube ? 'youtube' : candidate.platform,
    width,
    height,
    fps,
    bitrate: candidate.bitrate ?? positiveNumber(parsed.searchParams.get('bitrate')),
    contentLength: candidate.contentLength ?? positiveNumber(parsed.searchParams.get('clen')),
    itag,
    quality,
    container,
    videoOnly: candidate.videoOnly ?? (isYoutube && itag ? !youtubeProgressiveItags.has(itag) : undefined),
  };
}

function candidateKey(candidate: StreamCandidate): string {
  const enriched = enrichCandidate(candidate);
  if (enriched.platform === 'youtube' && enriched.itag) return `youtube:${enriched.itag}`;
  return enriched.url;
}

function isMediaCandidate(candidate: StreamCandidate): boolean {
  try {
    return /^https?:$/i.test(new URL(candidate.url).protocol);
  } catch {
    return false;
  }
}

function isOpaqueSeekableMedia(requestType: string | undefined, headers: Record<string, string>): boolean {
  // Alguns players usam uma URL sem extensão e devolvem
  // application/octet-stream. Uma resposta com Content-Range é uma evidência
  // forte de mídia progressiva; a ponte ainda confirma a assinatura binária
  // antes de apresentar o item no popup.
  if (!['media', 'xmlhttprequest', 'fetch'].includes(String(requestType ?? '').toLowerCase())) return false;
  const range = headers['content-range'] ?? '';
  return /^bytes\s+\d+-\d+\/\d+/i.test(range);
}

function updateBadge(tabId: number, count: number): void {
  try {
    const api = browser as typeof browser & { browserAction?: typeof browser.action };
    const action = browser.action ?? api.browserAction;
    void action?.setBadgeText({ tabId, text: count ? String(Math.min(count, 99)) : '' })?.catch(() => undefined);
    void action?.setBadgeBackgroundColor({ tabId, color: '#2879d5' })?.catch(() => undefined);
  } catch {
    // badge API may be unavailable in some contexts
  }
}

async function addCandidate(tabId: number, candidate: StreamCandidate): Promise<void> {
  if (tabId < 0 || !candidate.url || candidate.url.startsWith('blob:')) return;
  candidate = enrichCandidate(candidate);
  if (!isMediaCandidate(candidate)) return;
  if (telemetryPattern.test(candidate.url)) return;
  const responseType = candidate.contentType ?? '';
  const explicitMediaMime = /^(?:video|audio)\//i.test(responseType);
  if (!mediaPattern.test(candidate.url) && !manifestTypePattern.test(responseType) && !explicitMediaMime && candidate.source !== 'network-media') return;

  const state = await stateFor(tabId);
  if (state.rejected.has(candidate.url)) return;
  const key = candidateKey(candidate);
  const previous = state.items.get(key) ?? {};
  state.items.set(key, {
    ...previous,
    ...candidate,
    kind: kindOf(candidate.url, candidate.contentType),
    seenAt: Date.now(),
  });
  while (state.items.size > 80) {
    const first = state.items.keys().next().value as string | undefined;
    if (first === undefined) break;
    state.items.delete(first);
  }
  state.updated = Date.now();
  persistState(tabId, state);
  updateBadge(tabId, state.items.size);
}

async function rejectDocument(tabId: number, url: string): Promise<void> {
  if (tabId < 0) return;
  const state = await stateFor(tabId);
  state.rejected.add(url);
  state.items.delete(candidateKey({ url }));
  while (state.rejected.size > 200) {
    const first = state.rejected.values().next().value as string | undefined;
    if (first === undefined) break;
    state.rejected.delete(first);
  }
  state.updated = Date.now();
  persistState(tabId, state);
  updateBadge(tabId, state.items.size);
}

function rememberRequestHeaders(url: string, context: Pick<StreamCandidate, 'headers' | 'referer' | 'origin'>): void {
  recentHeadersByUrl.set(url, { ...context, seenAt: Date.now() });
  const cutoff = Date.now() - 2 * 60 * 1000;
  for (const [key, value] of recentHeadersByUrl) {
    if (value.seenAt < cutoff || recentHeadersByUrl.size > 300) recentHeadersByUrl.delete(key);
  }
}

function requestHeadersFor(url: string): Pick<StreamCandidate, 'headers' | 'referer' | 'origin'> {
  const context = recentHeadersByUrl.get(url);
  if (!context || context.seenAt < Date.now() - 2 * 60 * 1000) return {};
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { seenAt: _seenAt, ...retained } = context;
  return retained;
}

function downloadFilename(item: Browser.downloads.DownloadItem, url: string): string {
  const browserName = item.filename.split(/[\\/]/).pop();
  if (browserName) return browserName;
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download');
  } catch {
    return 'download';
  }
}

function packageName(filename: string): string {
  return filename.replace(/\.[^.]{1,12}$/u, '') || filename || 'Download';
}

async function localBridgeAdd(payload: Record<string, unknown>, config: ExtensionConfig): Promise<boolean> {
  try {
    const native = (await browser.runtime.sendNativeMessage('stream2jd', {
      action: 'add',
      payload: { ...payload, bridgePort: config.port },
      port: config.port,
    })) as { ok?: boolean };
    return native.ok === true;
  } catch {
    // Native Messaging is preferred; keep the paired localhost bridge as a fallback.
  }

  let token = config.token;
  if (!token) {
    try {
      const pair = await fetch(`http://127.0.0.1:${config.port}/pair`, { headers: { 'X-Stream2JD-Pair': 'stream2jd@local' } });
      const paired = (await pair.json()) as { token?: string };
      token = paired.token ?? '';
      if (token) await browser.storage.local.set({ token });
    } catch {
      return false;
    }
  }
  if (!token) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stream2JD-Token': token },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return false;
    const result = (await response.json()) as { ok?: boolean };
    return result.ok === true;
  } catch {
    return false;
  }
}

async function interceptDownload(item: Browser.downloads.DownloadItem): Promise<void> {
  if (interceptingDownloadIds.has(item.id) || item.byExtensionId === browser.runtime.id) return;
  const stored = await browser.storage.local.get({
    port: 17442,
    token: '',
    includeCookies: false,
    captureHeaders: true,
    instantStart: true,
    interceptDownloads: true,
  });
  const config: ExtensionConfig = {
    port: Number(stored.port ?? 17442),
    token: String(stored.token ?? ''),
    includeCookies: Boolean(stored.includeCookies),
    captureHeaders: Boolean(stored.captureHeaders ?? true),
    instantStart: Boolean(stored.instantStart ?? true),
    interceptDownloads: Boolean(stored.interceptDownloads ?? true),
  };
  if (!config.interceptDownloads) return;

  const url = item.finalUrl || item.url;
  if (!/^https?:\/\//i.test(url) || /^https?:\/\/127\.0\.0\.1:17442\//i.test(url)) return;
  interceptingDownloadIds.add(item.id);
  let paused = false;
  try {
    try {
      await browser.downloads.pause(item.id);
      paused = true;
    } catch (error) {
      console.warn('[Stream2JD] pause failed (small file)', error);
    }

    const recent = requestHeadersFor(url);
    const referer = item.referrer || recent.referer || '';
    let cookie = '';
    if (config.includeCookies) {
      try {
        const cookies = await browser.cookies.getAll({ url });
        cookie = cookies.map((value) => `${value.name}=${value.value}`).join('; ');
      } catch (error) {
        console.warn('[Stream2JD] cookie get failed', error);
      }
    }
    const filename = downloadFilename(item, url);
    const accepted = await localBridgeAdd({
      url,
      filename,
      title: packageName(filename),
      pageUrl: referer,
      referer,
      origin: recent.origin,
      userAgent: navigator.userAgent,
      cookie,
      headers: config.captureHeaders ? recent.headers : undefined,
      kind: 'Download',
      instantStart: config.instantStart,
    }, config);
    if (!accepted) {
      if (paused) await browser.downloads.resume(item.id).catch(() => undefined);
      return;
    }

    const [current] = await browser.downloads.search({ id: item.id });
    if (current?.state === 'in_progress') {
      await browser.downloads.cancel(item.id).catch(() => undefined);
      await browser.downloads.erase({ id: item.id }).catch(() => undefined);
    }
    // A tiny file can finish before pause() takes effect. Keep that completed
    // browser copy instead of deleting user data; JD still receives the link.
  } finally {
    interceptingDownloadIds.delete(item.id);
  }
}

export default defineBackground(() => {
  browser.webRequest.onBeforeRequest.addListener(
    (details): undefined => {
      const request = details as typeof details & { documentUrl?: string; originUrl?: string; initiator?: string };
      void addCandidate(details.tabId, {
        url: details.url,
        source: 'network',
        frameId: details.frameId,
        method: details.method,
        referer: request.documentUrl ?? request.originUrl ?? request.initiator,
      });
    },
    { urls: ['<all_urls>'] },
  );

  browser.webRequest.onHeadersReceived.addListener(
    (details): undefined => {
      const request = details as typeof details & { type?: string };
      const headers = Object.fromEntries(
        (details.responseHeaders ?? []).map((header) => [header.name.toLowerCase(), header.value ?? '']),
      );
      const contentType = headers['content-type'] ?? '';
      if (documentTypePattern.test(contentType)) {
        void rejectDocument(details.tabId, details.url);
        return;
      }
      const retained = pendingHeaders.get(details.requestId) ?? {};
      void addCandidate(details.tabId, {
        url: details.url,
        source: isOpaqueSeekableMedia(request.type, headers) ? 'network-media' : 'network',
        frameId: details.frameId,
        contentType,
        contentLength: positiveNumber(headers['content-length'] ?? null),
        ...retained,
      });
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders'],
  );

  browser.webRequest.onBeforeSendHeaders.addListener(
    (details): undefined => {
      if (!captureHeaders) return;
      const captured: Record<string, string> = {};
      for (const header of details.requestHeaders ?? []) {
        if (!retainedHeaderPattern.test(header.name) || !header.value) continue;
        const value = header.value.replace(/[\r\n]/g, '').slice(0, 4096);
        if (value) captured[header.name] = value;
        if (Object.keys(captured).length >= 32) break;
      }
      const getHeader = (name: string) =>
        Object.entries(captured).find(([key]) => key.toLowerCase() === name)?.[1];
      const retained = {
        headers: captured,
        referer: getHeader('referer'),
        origin: getHeader('origin'),
      };
      if (Object.keys(captured).length) {
        pendingHeaders.set(details.requestId, retained);
        rememberRequestHeaders(details.url, retained);
      }
      void addCandidate(details.tabId, {
        url: details.url,
        source: 'network',
        frameId: details.frameId,
        ...retained,
      });
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders'],
  );

  browser.runtime.onMessage.addListener(
    async (message: RuntimeMessage, sender: Browser.runtime.MessageSender) => {
      const tabId = sender.tab?.id ?? message.tabId;
      if (tabId == null) return { ok: false };

      if (message.type === 'candidates') {
        const state = await stateFor(tabId);
        const isMainFrame = sender.frameId === 0;
        const previousMainUrl = mainDocumentUrl(state.meta);
        if (isMainFrame && message.meta.pageUrl && previousMainUrl && message.meta.pageUrl !== previousMainUrl) {
          state.items.clear();
          state.rejected.clear();
          state.meta = {};
          updateBadge(tabId, 0);
        }
        await Promise.all(message.items.map((candidate) => addCandidate(tabId, { ...candidate, frameId: sender.frameId })));
        state.meta = mergeFrameMeta(state.meta, message.meta, isMainFrame, sender.frameId);
        state.updated = Date.now();
        persistState(tabId, state);
        return { ok: true };
      }

      if (message.type === 'get') {
        const state = await stateFor(tabId);
        return {
          items: [...state.items.values()].sort(
            (left, right) => candidatePriority(right) - candidatePriority(left) || (right.seenAt ?? 0) - (left.seenAt ?? 0),
          ),
          meta: state.meta,
        };
      }

      captures.delete(tabId);
      loadingStates.delete(tabId);
      await browser.storage.session.remove(storageKey(tabId));
      updateBadge(tabId, 0);
      return { ok: true };
    },
  );

  const forgetRequest = (details: { requestId: string }) => pendingHeaders.delete(details.requestId);
  browser.webRequest.onCompleted.addListener(forgetRequest, { urls: ['<all_urls>'] });
  browser.webRequest.onErrorOccurred.addListener(forgetRequest, { urls: ['<all_urls>'] });
  try {
    browser.downloads.onCreated.addListener((item) => void interceptDownload(item));
  } catch {
    // downloads permission may be unavailable
  }
  browser.tabs.onRemoved.addListener((tabId) => {
    captures.delete(tabId);
    loadingStates.delete(tabId);
    void browser.storage.session.remove(storageKey(tabId)).catch(() => undefined);
    try {
      updateBadge(tabId, 0);
    } catch {}
  });
});
