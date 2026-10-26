import type { StreamCandidate, VideoQuality, PageMeta } from './types';
import { candidateScore } from './scoring';
import { youtubePublishedHeight, youtubeQualityPreference } from './youtube';

export function qualityHeight(value: { height?: number; label?: string; quality?: string; itag?: number }): number | undefined {
  return youtubePublishedHeight(value);
}

export function fpsBucket(fps?: number): number {
  if (!fps) return 0;
  return fps >= 50 ? 60 : fps >= 45 ? 48 : fps >= 25 ? 30 : fps;
}

export function variantLabel(value: { height?: number; label?: string; quality?: string; fps?: number }, fallback = 'Original'): string {
  const height = qualityHeight(value);
  const fps = fpsBucket(value.fps);
  if (height) return `${height}p${fps >= 48 ? fps : ''}`;
  return value.label || value.quality || fallback;
}

const youtubeErrorLabel = /(?:http\s*error|\b(?:401|403|404|429|5\d\d)\b|unauthori[sz]ed|forbidden|timeout|failed|error)/i;

export function normalizeYoutubeQuality(value: VideoQuality): VideoQuality {
  const height = qualityHeight(value);
  const fallback = height ? `${height}p${fpsBucket(value.fps) >= 48 ? fpsBucket(value.fps) : ''}` : 'Vídeo';
  const label = String(value.label ?? '').trim();
  return {
    ...value,
    label: !label || youtubeErrorLabel.test(label) ? fallback : label,
    height: value.height ?? height,
  };
}

export function audioVariantKey(item: StreamCandidate): string {
  const format = (item.container || item.contentType || 'audio').toLowerCase();
  const bitrate = Math.round(item.bitrate ?? 0);
  const size = Math.round(item.contentLength ?? 0);
  return bitrate || size ? `audio:${format}:${bitrate}:${size}` : `audio:${format}:${item.url}`;
}

export function visibleCandidates(items: StreamCandidate[]): StreamCandidate[] {
  const selected = new Map<string, StreamCandidate>();
  const hasManifest = items.some((item) => item.kind === 'HLS' || item.kind === 'DASH');
  for (const item of items) {
    const ctLower = (item.contentType ?? '').toLowerCase();
    if (ctLower.includes('text/html') || ctLower.includes('application/xhtml')) continue;
    if (item.kind === 'Media' && !qualityHeight(item) && !item.contentLength && /\.(html|php|aspx?)(?:$|[?#])/i.test(item.url)) continue;
    if (hasManifest && item.kind !== 'HLS' && item.kind !== 'DASH' && item.kind !== 'Audio' && item.contentLength && item.contentLength < 5 * 1024 * 1024) continue;
    try {
      new URL(item.url);
    } catch {
      continue;
    }
    const height = qualityHeight(item);
    const key = height
      ? `${height}:${fpsBucket(item.fps)}`
      : item.kind === 'HLS' || item.kind === 'DASH'
        ? 'adaptive'
        : item.kind === 'Audio'
          ? audioVariantKey(item)
          : 'original';
    const previous = selected.get(key);
    if (!previous || candidateScore(item) > candidateScore(previous)) selected.set(key, item);
  }
  return [...selected.values()].sort((left, right) => {
    const leftHeight = qualityHeight(left) ?? Number.MAX_SAFE_INTEGER;
    const rightHeight = qualityHeight(right) ?? Number.MAX_SAFE_INTEGER;
    return leftHeight - rightHeight || fpsBucket(left.fps) - fpsBucket(right.fps) || candidateScore(right) - candidateScore(left);
  });
}

export function youtubeQualities(meta: PageMeta, items: StreamCandidate[]): VideoQuality[] {
  const candidates: VideoQuality[] = (meta.qualities?.length
    ? meta.qualities
    : items.map((item) => ({
        label: variantLabel(item), width: item.width, height: item.height, fps: item.fps, bitrate: item.bitrate,
        contentLength: item.contentLength, itag: item.itag, container: item.container, videoOnly: item.videoOnly,
      }))).map(normalizeYoutubeQuality);
  const selected = new Map<string, VideoQuality>();
  for (const quality of candidates) {
    const height = qualityHeight(quality);
    if (!height) continue;
    const key = `${height}:${fpsBucket(quality.fps)}`;
    const previous = selected.get(key);
    const score = youtubeQualityPreference(quality);
    const previousScore = previous ? youtubeQualityPreference(previous) : -1;
    if (!previous || score > previousScore) selected.set(key, quality);
  }
  return [...selected.values()].sort((left, right) =>
    (qualityHeight(right) ?? 0) - (qualityHeight(left) ?? 0) || fpsBucket(right.fps) - fpsBucket(left.fps));
}


export function formatBytes(bytes?: number): string | undefined {
  if (!bytes || bytes < 1024) return undefined;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}
