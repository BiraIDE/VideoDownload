import { browser, type Browser } from 'wxt/browser';
import type { CapturePayload, ExtensionConfig, PageMeta, RuntimeMessage, StreamCandidate, VideoQuality } from '../../utils/types';
import { candidateScore } from '../../utils/scoring';
import { fpsBucket, variantLabel, visibleCandidates, youtubeQualities, qualityHeight, formatBytes } from '../../utils/popup-filter';

const defaults: ExtensionConfig = {
  port: 17442,
  token: '',
  includeCookies: false,
  captureHeaders: true,
  instantStart: true,
  interceptDownloads: true,
};
let activeTab: Browser.tabs.Tab | undefined;
let bridgeMode: 'native' | 'http' | 'offline' = 'offline';
let lastMeta: PageMeta | undefined;
let inspectNotice = '';
let loadAttempts = 0;

function element<T extends HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Elemento ausente: ${selector}`);
  return value;
}

function renderAppVersion(): void {
  const footer = document.querySelector<HTMLElement>('#app-version');
  if (!footer) return;
  try {
    footer.textContent = `Stream2JD ${browser.runtime.getManifest().version} · WXT`;
  } catch {
    footer.textContent = 'Stream2JD · WXT';
  }
}

async function sendMessage<T>(message: RuntimeMessage): Promise<T> {
  const result: unknown = await browser.runtime.sendMessage(message);
  return result as T;
}

async function readConfig(): Promise<ExtensionConfig> {
  const stored = await browser.storage.local.get({
    port: defaults.port,
    token: defaults.token,
    includeCookies: defaults.includeCookies,
    captureHeaders: defaults.captureHeaders,
    instantStart: defaults.instantStart,
    interceptDownloads: defaults.interceptDownloads,
  });
  return {
    port: Number(stored.port ?? defaults.port),
    token: String(stored.token ?? defaults.token),
    includeCookies: Boolean(stored.includeCookies ?? defaults.includeCookies),
    captureHeaders: Boolean(stored.captureHeaders ?? defaults.captureHeaders),
    instantStart: Boolean(stored.instantStart ?? defaults.instantStart),
    interceptDownloads: Boolean(stored.interceptDownloads ?? defaults.interceptDownloads),
  };
}

function setBridgeState(className: string, label: string): void {
  const state = element('#bridge-state');
  const led = document.createElement('i');
  state.className = `bridge-state ${className}`;
  state.replaceChildren(led, document.createTextNode(label));
}

function setThumbnail(url?: string): void {
  const image = element<HTMLImageElement>('#page-thumbnail');
  const fallback = element('#thumbnail-fallback');
  image.onload = () => { image.hidden = false; fallback.hidden = true; };
  image.onerror = () => { image.hidden = true; fallback.hidden = false; };
  if (url) image.src = url;
  else { image.removeAttribute('src'); image.hidden = true; fallback.hidden = false; }
}

function sanitize(value: string): string {
  // Sanitize string before inserting into DOM (textContent/attribute).
  return value
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function escapeAttribute(value: string): string {
  return value.replace(/[&]/g, '&amp;').replace(/["]/g, '&quot;').replace(/[<]/g, '&lt;').replace(/[>]/g, '&gt;');
}

function qualityGraphic(label: string, sublabel: string): HTMLElement {
  const graphic = document.createElement('span');
  graphic.className = 'quality-resolution';
  const strong = document.createElement('strong'); strong.textContent = sanitize(label);
  const sub = document.createElement('span'); sub.textContent = sanitize(sublabel);
  graphic.append(strong, sub);
  return graphic;
}

function qualityArrow(): HTMLElement {
  const action = document.createElement('span');
  action.className = 'quality-action';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 4v11m0 0 4-4m-4 4-4-4M5 20h14');
  svg.appendChild(path);
  action.appendChild(svg);
  return action;
}

function platformLabel(platform?: string): string {
  if (!platform) return 'VÍDEO';
  const map: Record<string, string> = {
    youtube: 'YOUTUBE',
    vimeo: 'VIMEO',
    dailymotion: 'DAILYMOTION',
    twitch: 'TWITCH',
    facebook: 'FACEBOOK',
    instagram: 'INSTAGRAM',
    tiktok: 'TIKTOK',
    x: 'X/TWITTER',
    rumble: 'RUMBLE',
    odysee: 'ODYSEE',
    bilibili: 'BILIBILI',
    generic: 'VÍDEO',
  };
  return map[platform.toLowerCase()] ?? platform.toUpperCase();
}

function drmLabel(meta: PageMeta): string | undefined {
  if (meta.drm === 'widevine') return 'Protegido · Widevine — use Gravar aba';
  if (meta.drm === 'playready') return 'Protegido · PlayReady — use Gravar aba';
  if (meta.drm === 'fairplay') return 'Protegido · FairPlay — use Gravar aba';
  if (meta.drm && meta.drm !== 'none' && meta.drm !== 'aes128') return 'Protegido · DRM — use Gravar aba';
  if (meta.emeDetected) return 'Sinal de EME no player — se falhar, use Gravar aba';
  return undefined;
}

function friendlyBridgeError(message: string): string {
  const text = message.toLowerCase();
  if (text.includes('widevine') || text.includes('playready') || text.includes('fairplay') || text.includes('contentprotection') || text.includes('criptografado') || text.includes('drm') || text.includes('encrypted')) {
    return `${sanitize(message)} · use Gravar aba/WebRTC`;
  }
  if (text.includes('520') || text.includes('502') || text.includes('429') || text.includes('timeout') || text.includes('instavel') || text.includes('retomar')) {
    return `${sanitize(message)} · se parar no JDownloader, clique Retomar`;
  }
  if (text.includes('401') || text.includes('403') || text.includes('unauthori') || text.includes('forbidden') || text.includes('expir')) {
    return `${sanitize(message)} · link expirado — recarregue a página e tente novamente`;
  }
  if (text.includes('failed to fetch') || text.includes('network') || text.includes('ponte')) {
    return `${sanitize(message)} · verifique se a ponte local está rodando`;
  }
  return sanitize(message);
}

function genericQualityRow(item: StreamCandidate, meta: PageMeta): HTMLElement {
  const button = document.createElement('button');
  button.className = `quality-row${item.isBest ? ' best' : ''}`;
  button.setAttribute('role', 'listitem');
  const height = qualityHeight(item);
  const audio = item.kind === 'Audio' || item.contentType?.toLowerCase().startsWith('audio/');
  const tileLabel = height ? `${height}p` : audio ? 'ÁUDIO' : item.kind === 'HLS' || item.kind === 'DASH' ? 'AUTO' : 'ORIGINAL';
  const tileSub = item.isBest ? 'MELHOR' : item.videoOnly ? 'SEM ÁUDIO' : fpsBucket(item.fps) >= 48 ? `${fpsBucket(item.fps)} FPS` : audio ? (item.container ?? 'ÁUDIO') : item.kind ?? 'VÍDEO';
  const copy = document.createElement('span'); copy.className = 'quality-copy';
  const title = document.createElement('strong'); title.textContent = variantLabel(item, audio ? 'Arquivo de áudio' : item.kind === 'HLS' || item.kind === 'DASH' ? 'Qualidade automática' : 'Arquivo original');
  const host = (() => { try { return new URL(item.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const details: string[] = [item.container || item.kind || (audio ? 'ÁUDIO' : 'VÍDEO')];
  if (item.width && item.height) details.push(`${item.width}×${item.height}`);
  if (item.kind !== 'HLS' && item.kind !== 'DASH') {
    const size = formatBytes(item.contentLength); if (size) details.push(size);
  } else details.push('player adaptativo');
  if (host && !host.includes('127.0.0.1')) details.push(host);
  if (item.videoOnly) details.push('vídeo sem áudio — use qualidade muxada se disponível');
  if (item.isBest && !item.videoOnly) details.push('maior disponível');
  if (item.isBest && item.videoOnly) details.push('MELHOR vídeo-only — pode ficar silencioso');
  if (audio) details.push('clique para baixar esta opção');
  const small = document.createElement('small'); small.dataset.actionLabel = 'true'; small.textContent = details.join(' · ');
  button.dataset.defaultAction = small.textContent;
  copy.append(title, small);
  button.append(qualityGraphic(tileLabel, tileSub), copy, qualityArrow());
  button.setAttribute('aria-label', audio ? `Baixar ${title.textContent || 'esta opção de áudio'} no JDownloader` : `Baixar ${title.textContent || 'esta opção'} no JDownloader`);
  button.title = `${item.url} — clique para enviar ao JDownloader`;
  button.addEventListener('click', () => void sendToJDownloader(item, meta, button));
  return button;
}

function youtubeQualityRow(quality: VideoQuality, isBest: boolean, meta: PageMeta): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = `quality-row${isBest ? ' best' : ''}`;
  row.setAttribute('role', 'listitem');
  const height = qualityHeight(quality);
  const tileLabel = height ? `${height}p` : quality.label;
  const tileSub = isBest ? 'MELHOR' : fpsBucket(quality.fps) >= 48 ? `${fpsBucket(quality.fps)} FPS` : 'YOUTUBE';
  const copy = document.createElement('span'); copy.className = 'quality-copy';
  const title = document.createElement('strong'); title.textContent = variantLabel(quality);
  const details = document.createElement('small');
  details.dataset.actionLabel = 'true';
  details.textContent = `${quality.videoOnly ? 'vídeo + áudio combinados pelo JD' : 'vídeo com áudio'} · clique para escolher${isBest ? ' · maior publicada' : ''}`;
  row.dataset.defaultAction = details.textContent;
  copy.append(title, details);
  row.append(qualityGraphic(tileLabel, tileSub), copy, qualityArrow());
  row.setAttribute('aria-label', `Baixar ${variantLabel(quality)} no JDownloader`);
  row.title = `${meta.pageUrl ?? ''} — ${variantLabel(quality)} → JDownloader (variant ${quality.itag ?? quality.height ?? ''})`;
  row.addEventListener('click', () => void sendToJDownloader({
    url: meta.pageUrl ?? activeTab?.url ?? '',
    kind: 'Media',
    platform: 'youtube',
    quality: variantLabel(quality),
    width: quality.width,
    height,
    fps: quality.fps,
    bitrate: quality.bitrate,
    contentLength: quality.contentLength,
    itag: quality.itag,
    container: quality.container,
    videoOnly: quality.videoOnly,
  }, meta, row));
  return row;
}

function render(data: CapturePayload): void {
  const items = data.items ?? [];
  const meta = data.meta ?? {};
  lastMeta = meta;
  const youtube = meta.platform === 'youtube';
  const variants = youtube ? youtubeQualities(meta, items) : visibleCandidates(items);
  const youtubeBest = youtube ? (variants as VideoQuality[])[0] : undefined;
  let bestCandidate: StreamCandidate | undefined;
  if (!youtube) {
    const generic = variants as StreamCandidate[];
    // Genérico: escolhe melhor por tamanho real + score, não só altura.
    // Evita marcar como MELHOR uma qualidade quebrada (HTML) quando existe ORIGINAL maior.
    // Filtra candidatos HTML já removidos acima, mas garante fallback robusto.
    const hasMuxed = generic.some((c) => c.videoOnly === false);
    const ranked = [...generic].sort((a, b) => {
      // Genérico: evita MP4 silencioso como MELHOR (hstream, voe, etc. muxam áudio separado)
      let aScore = candidateScore(a) + Math.min(15, (a.contentLength ?? 0) / (8 * 1024 * 1024));
      let bScore = candidateScore(b) + Math.min(15, (b.contentLength ?? 0) / (8 * 1024 * 1024));
      // Se existe variant com áudio muxado, penaliza video-only para não virar MELHOR
      if (hasMuxed) {
        if (a.videoOnly) aScore -= 20;
        if (b.videoOnly) bScore -= 20;
      }
      if (bScore !== aScore) return bScore - aScore;
      return (b.contentLength ?? 0) - (a.contentLength ?? 0);
    });
    bestCandidate = ranked[0];
    if (bestCandidate) bestCandidate.isBest = true;
  }
  const title = sanitize(meta.title ?? activeTab?.title ?? 'Vídeo desta página');
  const thumbnail = meta.thumbnail ?? items.find((item) => item.thumbnail)?.thumbnail;
  const protection = drmLabel(meta);
  // Genérico HLS/DASH: se o candidato eleito como MELHOR é video-only mas existe muxado, avisa
  const muxWarning = (!youtube && bestCandidate?.videoOnly && (variants as StreamCandidate[]).some((c) => c.videoOnly === false))
    ? 'MELHOR é vídeo sem áudio — outra qualidade desta página já traz áudio muxado'
    : undefined;
  element('#page-title').textContent = title;
  element('#quality-count').textContent = `${variants.length} ${variants.length === 1 ? 'qualidade' : 'qualidades'}`;
  element('#stream-count').textContent = `${variants.length} ${variants.length === 1 ? 'encontrada' : 'encontradas'}`;
  element('#video-type').textContent = youtube ? 'YOUTUBE' : meta.platform ? platformLabel(meta.platform) : variants[0] && 'kind' in variants[0] ? (variants[0] as StreamCandidate).kind ?? 'VÍDEO' : 'VÍDEO';
  const baseMonitor = muxWarning ?? protection ?? (youtube ? 'Qualidades fornecidas pelo player' : meta.platform ? `Origem ${platformLabel(meta.platform)} · Referer preservado` : 'Somente mídia útil');
  const monitorEl = element('#monitor-label');
  monitorEl.setAttribute('aria-live', 'polite');
  monitorEl.setAttribute('aria-atomic', 'true');
  monitorEl.textContent = inspectNotice ? `${baseMonitor} · ${sanitize(inspectNotice)}` : baseMonitor;
  // URL original visível: mostra origem real (não o proxy 127.0.0.1) com link + cópia
  const _originUrl = items[0]?.masterUrl ?? items.find((x) => !x.url.includes('127.0.0.1'))?.url ?? meta.pageUrl ?? '';
  const _monitorEl = element('#monitor-label');
  if (_originUrl && !_originUrl.includes('127.0.0.1')) _monitorEl.title = _originUrl;
  try {
    const originWrap = document.querySelector<HTMLElement>('#origin-url');
    const originLink = document.querySelector<HTMLAnchorElement>('#origin-url-link');
    const originCopy = document.querySelector<HTMLButtonElement>('#origin-url-copy');
    if (originWrap && originLink) {
      const show = Boolean(_originUrl && !_originUrl.includes('127.0.0.1'));
      originWrap.hidden = !show;
      if (show) {
        originLink.href = _originUrl;
        originLink.textContent = _originUrl.length > 58 ? _originUrl.slice(0, 58) + '…' : _originUrl;
        originLink.title = _originUrl;
        if (originCopy && !originCopy.dataset.bound) {
          originCopy.dataset.bound = '1';
          originCopy.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(_originUrl); originCopy.textContent = '✓'; setTimeout(() => originCopy.textContent = '⧉', 1200); } catch {}
          });
        }
      }
    }
  } catch {}
  setThumbnail(thumbnail);
  const list = element('#list');
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', 'Qualidades disponíveis');
  list.replaceChildren(...(youtube
    ? (variants as VideoQuality[]).map((quality, index) => youtubeQualityRow(quality, index === 0, meta))
    : (variants as StreamCandidate[]).map((item) => genericQualityRow(item, meta))));
  let ownVersion = '';
  try {
    ownVersion = browser.runtime.getManifest().version ?? '';
  } catch {
    // Popup sempre tem contexto valido; defesa barata.
  }
  const staleScript = Boolean(meta.contentVersion && ownVersion && meta.contentVersion !== ownVersion);
  const emptyState = element('#status');
  emptyState.setAttribute('role', 'status');
  emptyState.setAttribute('aria-live', 'polite');
  emptyState.setAttribute('aria-atomic', 'true');
  if (youtube && variants.length === 0) {
    // A lista do YouTube depende do player; se abriu rapido demais, orienta
    // em vez de mostrar vazio. O botao azul continua funcionando (best).
    emptyState.hidden = false;
    const strong = emptyState.querySelector('strong');
    if (strong) strong.textContent = staleScript ? 'Aba com script antigo' : 'Buscando qualidades…';
    const hint = emptyState.querySelector('span');
    if (hint) {
      if (staleScript) {
        hint.textContent = `Esta aba ainda roda o script ${meta.contentVersion}. Recarregue a página para ativar o ${ownVersion}.`;
      } else {
        const diag = meta.ytDiag;
        const detail = diag
          ? `diag: playerData ${diag.responseFound ? 'sim' : 'não'} · formatos ${diag.formatsSeen ?? 0} · níveis ${diag.levelsSeen ?? 0}${diag.playbackQuality ? ` · atual ${diag.playbackQuality}` : ''}`
          : 'coletando dados do player…';
        hint.textContent = `Aguardando dados do player — Atualizar tenta novamente. (${sanitize(detail)})`;
      }
    }
  } else {
    emptyState.hidden = variants.length > 0;
    if (variants.length === 0 && !youtube) {
      const strong = emptyState.querySelector('strong');
      if (strong) strong.textContent = staleScript ? 'Aba com script antigo' : 'Aguardando o vídeo';
      const hint = emptyState.querySelector('span');
      if (hint) {
        hint.textContent = staleScript
          ? `Esta aba ainda roda o script ${meta.contentVersion}. Recarregue a página.`
          : inspectNotice || 'Dê play para detectar as opções disponíveis.';
      }
    }
  }
  const youtubeButton = element<HTMLButtonElement>('#youtube-send');
  youtubeButton.hidden = !youtube;
  youtubeButton.classList.remove('success', 'error');
  youtubeButton.disabled = false;
  const youtubeLabel = youtubeButton.querySelector<HTMLElement>('strong');
  if (youtubeLabel) {
    youtubeLabel.dataset.actionLabel = 'true';
    youtubeLabel.textContent = `Baixar melhor disponível${youtubeBest ? ` · ${variantLabel(youtubeBest)}` : ''}`;
  }
  youtubeButton.onclick = youtube
    ? () => void sendToJDownloader({ url: meta.pageUrl ?? activeTab?.url ?? '', kind: 'Media', platform: 'youtube' }, meta, youtubeButton)
    : null;
  const bestButton = element<HTMLButtonElement>('#best-send');
  bestButton.hidden = youtube || !bestCandidate;
  bestButton.classList.remove('success', 'error', 'loading');
  bestButton.disabled = false;
  const bestLabel = bestButton.querySelector<HTMLElement>('strong');
  if (bestLabel) {
    bestLabel.dataset.actionLabel = 'true';
    const audio = bestCandidate?.kind === 'Audio' || bestCandidate?.contentType?.toLowerCase().startsWith('audio/');
    bestLabel.textContent = bestCandidate
      ? `${audio ? 'Baixar este áudio' : 'Baixar melhor qualidade'} · ${variantLabel(bestCandidate, audio ? 'Áudio' : 'Automática')}`
      : 'Baixar melhor qualidade';
  }
  bestButton.onclick = bestCandidate ? () => void sendToJDownloader(bestCandidate as StreamCandidate, meta, bestButton) : null;
}

async function inspectCandidates(data: CapturePayload, config: ExtensionConfig): Promise<CapturePayload> {
  if (data.meta?.platform === 'youtube') return data;
  if (bridgeMode === 'offline') return data;
  const candidates = [...(data.items ?? [])]
    .sort((left, right) => candidateScore(right) - candidateScore(left))
    .slice(0, 20);
  if (!candidates.length) return data;
  // Lenta antes: 20 sondas em paralelo travavam a ponte (6 semáforos → fila). Agora concorrência 4 + timeout por sonda.
  const INSPECT_TIMEOUT_MS = 3500;
  const INSPECT_CONCURRENCY = 4;
  const withTimeout = async <A>(promise: Promise<A>, ms: number, signal?: AbortSignal): Promise<A> => {
    let timer: number | undefined;
    const timeoutSignal = signal ?? (typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined);
    const fallbackTimeout = !timeoutSignal
      ? new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error('inspect timeout')), ms); })
      : new Promise<never>((_, reject) => {
          if (timeoutSignal.aborted) reject(new DOMException('Timeout', 'TimeoutError'));
          else timeoutSignal.addEventListener('abort', () => reject(new DOMException('Timeout', 'TimeoutError')), { once: true });
        });
    try { return await Promise.race([promise, fallbackTimeout]); } finally { if (timer !== undefined) window.clearTimeout(timer); }
  };
  const pLimit = async <T>(items: StreamCandidate[], limit: number, fn: (it: StreamCandidate) => Promise<T[]>): Promise<T[]> => {
    const out: T[] = [];
    let idx = 0;
    const nextIndex = (): number | undefined => {
      if (idx >= items.length) return undefined;
      const cur = idx;
      idx += 1;
      return cur;
    };
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const cur = nextIndex();
        if (cur === undefined) break;
        const item = items[cur];
        if (!item) break;
        const res = await fn(item);
        out.push(...res);
      }
    });
    await Promise.all(workers);
    return out;
  };
  const expanded = (await pLimit(candidates, INSPECT_CONCURRENCY, async (item) => {
    let cookie = '';
    if (config.includeCookies) {
      const cookies = await browser.cookies.getAll({ url: item.url });
      cookie = cookies.map((value) => `${value.name}=${value.value}`).join('; ');
    }
    const payload = {
      url: item.url,
      kind: item.kind,
      referer: item.referer ?? data.meta?.referer ?? data.meta?.pageUrl,
      origin: item.origin,
      userAgent: navigator.userAgent,
      cookie,
      headers: config.captureHeaders ? item.headers : undefined,
      bridgePort: config.port,
    };
    let result: { ok?: boolean; variants?: StreamCandidate[]; protection?: string; error?: string } | undefined;
    // Tenta nativo primeiro (mais seguro), depois HTTP se bridgeMode === 'http' ou nativo falhar
    let nativeFailed = false;
    try {
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
      const sig = ac?.signal ?? (typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(INSPECT_TIMEOUT_MS) : undefined);
      result = (await withTimeout(
        browser.runtime.sendNativeMessage('stream2jd', { action: 'inspect', payload, port: config.port }) as Promise<{ ok?: boolean; variants?: StreamCandidate[]; protection?: string; error?: string }>,
        INSPECT_TIMEOUT_MS,
        sig,
      )) as { ok?: boolean; variants?: StreamCandidate[]; protection?: string; error?: string };
      if (!result.ok) {
        // Uma sonda que encontrou HTML, erro HTTP ou manifesto invalido nunca
        // deve virar um "MP4" de poucos KiB no JDownloader. O aviso fica no
        // popup, mas o candidato ruim e removido da lista.
        if (result.error) inspectNotice = friendlyBridgeError(result.error);
        else inspectNotice = 'A origem não confirmou uma mídia baixável';
        return [];
      }
      const variants = result.variants ?? [];
      if (result.protection && result.protection !== 'none' && result.protection !== 'aes128') inspectNotice = `Protecao ${result.protection}: download direto pode falhar — use Gravar aba`;
      if (!variants.length) {
        inspectNotice = 'A origem não publicou uma faixa de mídia baixável';
        return [];
      }
      return variants.map((variant) => ({ ...item, ...variant, source: item.kind === 'HLS' || item.kind === 'DASH' ? 'manifest' : 'validated' }));
    } catch (_error) {
      void _error;
      nativeFailed = true;
    }
    // Fallback HTTP para ponte sem native messaging (genérico multi-site)
    if ((nativeFailed || !result) && bridgeMode !== 'native' && config.token) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), INSPECT_TIMEOUT_MS);
        const resp = await fetch(`http://127.0.0.1:${config.port}/inspect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Stream2JD-Token': config.token },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(t);
        const httpResult = (await resp.json()) as { ok?: boolean; variants?: StreamCandidate[]; protection?: string; error?: string };
        result = httpResult;
        nativeFailed = false;
      } catch {
        // mantém nativeFailed true
      }
    }
    if (nativeFailed || !result) {
      inspectNotice = 'Ponte ocupada ou origem instável — aguarde e atualize';
      return [];
    }
    if (!result.ok) {
      if (result.error) inspectNotice = friendlyBridgeError(result.error);
      else inspectNotice = 'A origem não confirmou uma mídia baixável';
      return [];
    }
    const variants = result.variants ?? [];
    if (result.protection && result.protection !== 'none' && result.protection !== 'aes128') inspectNotice = `Protecao ${result.protection}: download direto pode falhar — use Gravar aba`;
    if (!variants.length) {
      inspectNotice = 'A origem não publicou uma faixa de mídia baixável';
      return [];
    }
    return variants.map((variant) => ({ ...item, ...variant, source: item.kind === 'HLS' || item.kind === 'DASH' ? 'manifest' : 'validated' }));
  }));
  return { ...data, items: expanded as StreamCandidate[] };
}

async function load(): Promise<void> {
  const refresh = element<HTMLButtonElement>('#refresh');
  refresh.classList.add('loading');
  try {
    [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id == null) return;
    let config = await readConfig();
    const online = await checkBridge(config);
    if (online && bridgeMode === 'http' && !config.token) config = await pairBridge(config);
    fillConfig(config);
    const captured = await sendMessage<CapturePayload>({ type: 'get', tabId: activeTab.id });
    const inspected = await inspectCandidates(captured, config);
    render(inspected);
    // YouTube depende do timing do player: se abriu antes da leitura, tenta
    // de novo sozinho algumas vezes enquanto o popup estiver aberto.
    const youtubeEmpty = inspected.meta?.platform === 'youtube'
      && !(inspected.meta?.qualities?.length) && loadAttempts < 4;
    if (youtubeEmpty) {
      loadAttempts += 1;
      // YouTube player pode demorar 2-4s para popular streamingData após navegação SPA
      window.setTimeout(() => { void load(); }, 1800);
    } else {
      loadAttempts = 0;
    }
  } finally {
    refresh.classList.remove('loading');
  }
}

function fillConfig(config: ExtensionConfig): void {
  element<HTMLInputElement>('#port').value = String(config.port);
  element<HTMLInputElement>('#token').value = config.token;
  element<HTMLInputElement>('#cookies').checked = config.includeCookies;
  element<HTMLInputElement>('#capture-headers').checked = config.captureHeaders;
  element<HTMLInputElement>('#instant-start').checked = config.instantStart;
  element<HTMLInputElement>('#intercept-downloads').checked = config.interceptDownloads;
  element('#config-hint').textContent = bridgeMode === 'native' ? 'Ponte nativa protegida' : config.token ? 'Ponte pareada' : 'Ponte ainda não pareada';
  if (bridgeMode !== 'native' && !config.token) element<HTMLDetailsElement>('#settings').open = true;
}

async function checkBridge(config: ExtensionConfig): Promise<boolean> {
  setBridgeState('checking', 'Conectando');
  try {
    const native = (await browser.runtime.sendNativeMessage('stream2jd', { action: 'health', port: config.port })) as { ok?: boolean };
    if (native.ok) {
      bridgeMode = 'native';
      setBridgeState('online', 'Ponte nativa conectada');
      return true;
    }
  } catch {
    // Compatibilidade com instalações antigas pela ponte HTTP local.
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1800);
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: controller.signal });
    if (!response.ok) throw new Error(`health ${response.status}`);
    bridgeMode = 'http'; setBridgeState('online', 'Ponte conectada'); return true;
  } catch {
    bridgeMode = 'offline'; setBridgeState('offline', 'Ponte desconectada'); return false;
  } finally { clearTimeout(timer); }
}

async function pairBridge(config: ExtensionConfig): Promise<ExtensionConfig> {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/pair`, { headers: { 'X-Stream2JD-Pair': 'stream2jd@local' }, signal: AbortSignal.timeout(2000) });
    if (!response.ok) return config;
    const data = (await response.json()) as { token?: string };
    if (!data.token) return config;
    const paired = { ...config, token: data.token };
    await browser.storage.local.set({ token: data.token });
    return paired;
  } catch { return config; }
}

function actionState(button: HTMLButtonElement, state: 'loading' | 'success' | 'error', text: string): void {
  button.classList.remove('loading', 'success', 'error');
  button.classList.add(state);
  const label = button.querySelector<HTMLElement>('[data-action-label]');
  if (label) label.textContent = text;
}

async function sendToJDownloader(item: StreamCandidate, meta: PageMeta, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  actionState(button, 'loading', 'Enviando…');
  try {
    let config = await readConfig();
    if (bridgeMode !== 'native' && !config.token) config = await pairBridge(config);
    if (bridgeMode !== 'native' && !config.token) throw new Error('Ponte local não pareada');
    const pageUrl = meta.pageUrl ?? activeTab?.url ?? '';
    const youtube = meta.platform === 'youtube' || item.platform === 'youtube';
    const targetUrl = youtube ? pageUrl : item.url;
    let cookie = '';
    if (config.includeCookies && targetUrl) {
      const cookies = await browser.cookies.getAll({ url: targetUrl });
      cookie = cookies.map((value) => `${value.name}=${value.value}`).join('; ');
    }
    const payload = {
      url: targetUrl,
      title: meta.title ?? activeTab?.title,
      pageUrl,
      platform: youtube ? 'youtube' : meta.platform ?? item.platform,
      selectedQuality: item.quality,
      selectedHeight: item.height,
      selectedFps: item.fps,
      selectedItag: item.itag,
      selectedContainer: item.container,
      selectedVideoOnly: item.videoOnly,
      variantId: item.variantId,
      referer: item.referer ?? meta.referer ?? pageUrl,
      origin: item.origin,
      userAgent: navigator.userAgent,
      cookie,
      kind: item.kind,
      headers: !youtube && config.captureHeaders && bridgeMode === 'native' ? item.headers : undefined,
      instantStart: config.instantStart,
      bridgePort: config.port,
    };
    let nativeHandled = false;
    try {
      const native = (await browser.runtime.sendNativeMessage('stream2jd', { action: 'add', payload, port: config.port })) as { ok?: boolean; error?: string };
      nativeHandled = true;
      if (!native.ok) throw new Error(friendlyBridgeError(native.error ?? 'A ponte nativa recusou o vídeo'));
      actionState(button, 'success', youtube
        ? item.height ? `✓ ${variantLabel(item)} enviado ao JDownloader` : '✓ Melhor vídeo enviado · sem arquivos extras'
        : config.instantStart ? '✓ Download iniciado' : '✓ Adicionado ao JDownloader');
      return;
    } catch (error) {
      if (nativeHandled) throw error;
    }
    const body = JSON.stringify(payload);
    const submit = (token: string) => fetch(`http://127.0.0.1:${config.port}/add`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Stream2JD-Token': token }, body,
    });
    let response = await submit(config.token);
    if (response.status === 403) {
      await browser.storage.local.remove('token');
      config = await pairBridge({ ...config, token: '' });
      if (!config.token) throw new Error('Ponte local não pareada');
      response = await submit(config.token);
    }
    const result = (await response.json()) as { error?: string };
    if (!response.ok) throw new Error(friendlyBridgeError(result.error ?? response.statusText));
    actionState(button, 'success', '✓ Adicionado ao JDownloader');
  } catch (error) {
    actionState(button, 'error', error instanceof Error ? friendlyBridgeError(error.message) : 'Falha no envio');
    button.disabled = false;
  }
}

element<HTMLButtonElement>('#save').addEventListener('click', async () => {
  const config: ExtensionConfig = {
    port: Number(element<HTMLInputElement>('#port').value),
    token: element<HTMLInputElement>('#token').value.trim(),
    includeCookies: element<HTMLInputElement>('#cookies').checked,
    captureHeaders: element<HTMLInputElement>('#capture-headers').checked,
    instantStart: element<HTMLInputElement>('#instant-start').checked,
    interceptDownloads: element<HTMLInputElement>('#intercept-downloads').checked,
  };
  await browser.storage.local.set(config);
  element('#config-hint').textContent = config.token ? 'Preferências salvas' : 'Token necessário';
  await checkBridge(config);
});
element<HTMLButtonElement>('#clear').addEventListener('click', async () => { if (activeTab?.id != null) await sendMessage({ type: 'clear', tabId: activeTab.id }); await load(); });
element<HTMLButtonElement>('#refresh').addEventListener('click', () => void load());
element<HTMLButtonElement>('#record').addEventListener('click', async () => {
  const recorderUrl = new URL(browser.runtime.getURL('/recorder.html'));
  if (activeTab?.title) recorderUrl.searchParams.set('title', activeTab.title);
  if (lastMeta?.drm) recorderUrl.searchParams.set('drm', lastMeta.drm);
  else if (lastMeta?.emeDetected) recorderUrl.searchParams.set('drm', 'eme');
  await browser.tabs.create({ url: recorderUrl.href });
  window.close();
});
renderAppVersion();
void load();
