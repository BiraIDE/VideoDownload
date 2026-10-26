import type { StreamCandidate, StreamKind } from './types';

/**
 * Enhanced codec ranking for better format selection.
 * H.264/AVC > VP9 > AV1 for compatibility; MP4 > WebM > MKV containers.
 */
function codecRank(candidate: StreamCandidate): number {
  const container = (candidate.container || '').toUpperCase();
  const kind = candidate.kind ?? 'Media';
  
  // Prefer MP4 container for broadest compatibility
  if (container === 'MP4') return 3;
  if (container === 'WEBM') return 2;
  if (container === 'MKV') return 1;
  if (kind === 'MP4') return 3;
  if (kind === 'WebM') return 2;
  
  // Fallback: inspect URL for codec hints
  const url = candidate.url.toLowerCase();
  if (url.includes('avc1') || url.includes('avc3') || url.includes('h264')) return 3;
  if (url.includes('vp9') || url.includes('vp09')) return 2;
  if (url.includes('av01') || url.includes('av1')) return 1;
  return 0;
}

/**
 * Enhanced format preference scoring.
 * Higher = better quality for download/playback.
 */
export function candidateScore(candidate: StreamCandidate): number {
  const kind = candidate.kind ?? 'Media';
  const kindScore = ({
    HLS: 55,    // Adaptive streaming - highest for flexibility
    DASH: 50,   // Adaptive streaming - slightly lower than HLS
    MP4: 45,    // Direct MP4 - best compatibility
    WebM: 40,   // Direct WebM - good but less universal
    Audio: 25,  // Audio-only streams
    Media: 15,  // Generic/unknown media
  } as Record<StreamKind, number>)[kind] ?? 10;
  
  // Bonus for direct manifest URLs (HLS/DASH master playlists)
  const directManifest = /\.(?:m3u8|mpd)(?:$|[?#])/i.test(candidate.url) ? 20 : 0;
  
  // Strong preference for video with audio (single-file progressive)
  const withAudio = candidate.videoOnly === false ? 25 : 0;
  
  // Resolution bonus (capped at 15 for 4K+)
  const height = candidate.height ?? 0;
  const resolutionBonus = height >= 2160 ? 15 : height >= 1440 ? 12 : height >= 1080 ? 10 : height >= 720 ? 8 : height >= 480 ? 5 : height > 0 ? 2 : 0;
  
  // Codec/container preference
  const codecBonus = codecRank(candidate);
  
  // Bitrate bonus (capped)
  const bitrateBonus = Math.min(8, (candidate.bitrate ?? 0) / 5_000_000);
  
  // File size bonus (larger usually = better quality, capped)
  const sizeBonus = Math.min(5, (candidate.contentLength ?? 0) / 50_000_000);
  
  // Prefer itag-known formats (YouTube)
  const itagBonus = candidate.itag ? 2 : 0;
  
  return kindScore + directManifest + withAudio + resolutionBonus + codecBonus + bitrateBonus + sizeBonus + itagBonus;
}

/**
 * Priority for background internal ordering.
 * Simplified: kind-based only.
 */
export function candidatePriority(candidate: StreamCandidate): number {
  const kind = candidate.kind ?? 'Media';
  return (({
    HLS: 55,
    DASH: 50,
    MP4: 35,
    WebM: 30,
    Audio: 20,
    Media: 15,
  } as Record<StreamKind, number>)[kind] ?? 10);
}
