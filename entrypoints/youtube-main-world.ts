import { defineUnlistedScript } from '#imports';
import { youtubePublishedHeight, youtubeQualityPreference } from '../utils/youtube';

interface YouTubeFormat {
  itag?: number;
  quality?: string;
  qualityLabel?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  contentLength?: string;
  mimeType?: string;
  audioQuality?: string;
  audioChannels?: number;
}

interface YouTubeResponse {
  videoDetails?: {
    videoId?: string;
    title?: string;
    thumbnail?: { thumbnails?: Array<{ url?: string }> };
  };
  streamingData?: {
    formats?: YouTubeFormat[];
    adaptiveFormats?: YouTubeFormat[];
  };
}

interface YouTubePlayer extends Element {
  getAvailableQualityLevels?: () => string[];
  getPlayerResponse?: () => YouTubeResponse;
  getVideoData?: () => { video_id?: string; title?: string };
  getPlaybackQuality?: () => string;
}

const heightByLevel: Record<string, number> = {
  highres: 4320,
  hd4320: 4320,
  hd2160: 2160,
  hd1440: 1440,
  hd1080: 1080,
  hd720: 720,
  large: 480,
  medium: 360,
  small: 240,
  tiny: 144,
};

export default defineUnlistedScript(() => {
  const bridge = document.currentScript as Element | null;
  if (!bridge) return;
  // Hook para ytInitialPlayerResponse atribuído após SPA navigation (JETSKI etc.)
  const pageWindow = window as unknown as { ytInitialPlayerResponse?: YouTubeResponse; ytInitialData?: unknown } & typeof window;
  let lastPayload = '';
  // Captura atribuições tardias de ytInitialPlayerResponse (YouTube SPA)
  try {
    let _ytPr = pageWindow.ytInitialPlayerResponse;
    Object.defineProperty(pageWindow, 'ytInitialPlayerResponse', {
      configurable: true,
      get() { return _ytPr; },
      set(v: YouTubeResponse | undefined) {
        _ytPr = v;
        setTimeout(() => { try { _throttledEmit(); } catch {} }, 50);
      },
    });
  } catch {}

  // Intercepta youtubei/v1/player response via fetch/XHR para casos onde streamingData só vem por API (JETSKI EME)
  try {
    const origFetch = window.fetch.bind(window);
    (window as unknown as { fetch: typeof window.fetch }).fetch = async function(input: RequestInfo | URL, init?: RequestInit) {
      const res = await origFetch(input as RequestInfo, init);
      try {
        const url = typeof input === 'string' ? input : (input as Request)?.url ?? (input as URL)?.href ?? '';
        if (typeof url === 'string' && (url.includes('youtubei/v1/player') || url.includes('youtubei/v1/next'))) {
          res.clone().json().then((j: unknown) => {
            const jo = j as Record<string, unknown>;
            if (jo && (jo as { streamingData?: unknown }).streamingData) {
              setTimeout(() => { try { _throttledEmit(); } catch {} }, 50);
            }
          }).catch(() => {});
        }
      } catch {}
      return res;
    };
  } catch {}

  const finite = (value: unknown): number | undefined => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
  };

  const emit = (): void => {
    try {
      const player = document.querySelector<YouTubePlayer>('#movie_player');
      const response = player?.getPlayerResponse?.() ?? pageWindow.ytInitialPlayerResponse;
      const videoData = player?.getVideoData?.();
      const videoId = response?.videoDetails?.videoId || videoData?.video_id || new URL(location.href).searchParams.get('v') || '';
      if (!videoId) return;

      const byHeight = new Map<string, Record<string, unknown>>();
      const formats = [...(response?.streamingData?.formats ?? []), ...(response?.streamingData?.adaptiveFormats ?? [])];
      for (const format of formats) {
        const mimeType = typeof format.mimeType === 'string' ? format.mimeType : '';
        if (!mimeType.toLowerCase().startsWith('video/')) continue;
        const height = youtubePublishedHeight(format);
        if (!height) continue;
        const fps = finite(format.fps);
        const key = `${height}:${fps && fps >= 50 ? 60 : 30}`;
        const quality = {
          label: String(format.qualityLabel || `${height}p${fps && fps >= 50 ? fps : ''}`),
          width: finite(format.width),
          height,
          fps,
          bitrate: finite(format.bitrate),
          contentLength: finite(format.contentLength),
          itag: finite(format.itag),
          container: mimeType.split(';', 1)[0]?.split('/', 2)[1]?.toUpperCase(),
          videoOnly: !format.audioQuality && !format.audioChannels,
        };
        const previous = byHeight.get(key);
        if (!previous || youtubeQualityPreference(quality) > youtubeQualityPreference(previous)) byHeight.set(key, quality);
      }

      for (const level of player?.getAvailableQualityLevels?.() ?? []) {
        const height = heightByLevel[level.toLowerCase()];
        if (!height) continue;
        const alreadyPresent = [...byHeight.values()].some((quality) => quality.height === height);
        if (!alreadyPresent) {
          byHeight.set(`${height}:30`, { label: `${height}p`, height, videoOnly: height > 720 });
        }
      }

      // Fonte independente do objeto de resposta: o proprio player informa a
      // qualidade atual como string (ex.: "hd1080"). Garante ao menos 1 opcao
      // mesmo quando o player nao expoe formatos nem niveis (layouts/EME).
      // (video.getVideoPlaybackQuality devolve um OBJETO de estatisticas, nao
      // serve; a API certa e player.getPlaybackQuality.)
      try {
        const rawPlayback = player?.getPlaybackQuality?.();
        const height = typeof rawPlayback === 'string' ? heightByLevel[rawPlayback.toLowerCase()] : undefined;
        if (height && ![...byHeight.values()].some((quality) => quality.height === height)) {
          byHeight.set(`${height}:30`, { label: `${height}p`, height, videoOnly: height > 720 });
        }
      } catch {
        // Nem todo layout expoe essa API; as outras fontes seguem valendo.
      }

      const thumbnails = response?.videoDetails?.thumbnail?.thumbnails ?? [];
      const payload = JSON.stringify({
        videoId,
        title: response?.videoDetails?.title || videoData?.title,
        thumbnail: thumbnails.at(-1)?.url,
        qualities: [...byHeight.values()],
      });
      if (payload === lastPayload) return;
      lastPayload = payload;
      bridge.dispatchEvent(new CustomEvent('stream2jd-youtube-data', { detail: payload }));
    } catch {
      // The player is replaced during YouTube SPA navigation; the next poll retries.
    }
  };

  try { emit(); } catch {}
  // Usa interval com guard para não lançar erro global quando player não existe
  let _ytCooldown = 0;
  const _throttledEmit = (): void => {
    const now = Date.now();
    if (now - _ytCooldown < 150) return;
    _ytCooldown = now;
    try { emit(); } catch {}
  };
  const _ytInterval = window.setInterval(() => { if (document.hidden) return; _throttledEmit(); }, 1500);
  // Limpa quando o content script novo assumir (sinal via CustomEvent)
  bridge.addEventListener('stream2jd-reset', () => window.clearInterval(_ytInterval));
  window.addEventListener('yt-navigate-finish', () => window.setTimeout(emit, 100));
  document.addEventListener('loadedmetadata', emit, true);
  // Quando a reproducao de fato comeca, o player ja resolveu formatos e
  // niveis — reemite para o caso de o emit inicial ter chegado cedo demais.
  document.addEventListener('playing', () => window.setTimeout(_throttledEmit, 500), true);
  document.addEventListener('loadeddata', emit, true);
});
