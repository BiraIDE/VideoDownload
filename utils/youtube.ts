export const youtubeHeightByItag: Record<number, number> = {
  5: 240, 6: 270, 17: 144, 18: 360, 22: 720, 34: 360, 35: 480, 36: 240, 37: 1080, 38: 3072,
  43: 360, 44: 480, 45: 720, 46: 1080, 133: 240, 134: 360, 135: 480, 136: 720, 137: 1080,
  138: 2160, 160: 144, 212: 480, 242: 240, 243: 360, 244: 480, 247: 720, 248: 1080, 264: 1440,
  266: 2160, 271: 1440, 272: 4320, 278: 144, 298: 720, 299: 1080, 302: 720, 303: 1080,
  308: 1440, 313: 2160, 315: 2160, 394: 144, 395: 240, 396: 360, 397: 480, 398: 720,
  399: 1080, 400: 1440, 401: 2160, 402: 4320,
};

const youtubeH264Itags = new Set([
  18, 22, 37, 38, 133, 134, 135, 136, 137, 138, 160, 212, 264, 266, 298, 299,
]);
const youtubeVp9Itags = new Set([
  242, 243, 244, 247, 248, 271, 272, 278, 302, 303, 308, 313, 315,
]);
const youtubeAv1Itags = new Set([394, 395, 396, 397, 398, 399, 400, 401, 402]);

/**
 * Mantém uma única entrada por resolução, priorizando formatos que produzem
 * arquivos mais compatíveis em players de desktop. O bitrate só desempata
 * formatos do mesmo codec.
 */
export function youtubeQualityPreference(value: {
  itag?: unknown;
  bitrate?: unknown;
  container?: unknown;
  videoOnly?: unknown;
}): number {
  const itag = Number(value.itag);
  const codec = youtubeH264Itags.has(itag) ? 3 : youtubeVp9Itags.has(itag) ? 2 : youtubeAv1Itags.has(itag) ? 1 : 0;
  const container = String(value.container ?? '').toUpperCase() === 'MP4' ? 1 : 0;
  const withAudio = value.videoOnly === false ? 1 : 0;
  const bitrate = Number(value.bitrate);
  return codec * 1_000_000_000_000 + container * 100_000_000_000 + withAudio * 10_000_000_000
    + (Number.isFinite(bitrate) ? Math.max(0, bitrate) : 0);
}

export function youtubePublishedHeight(value: {
  qualityLabel?: unknown;
  label?: unknown;
  quality?: unknown;
  itag?: unknown;
  height?: unknown;
}): number | undefined {
  const publishedLabel = `${String(value.qualityLabel ?? '')} ${String(value.label ?? '')} ${String(value.quality ?? '')}`;
  const labelHeight = Number(publishedLabel.match(/(144|240|270|360|480|540|720|1080|1440|2160|3072|4320)p/i)?.[1]);
  if (Number.isFinite(labelHeight) && labelHeight > 0) return labelHeight;

  const itag = Number(value.itag);
  if (Number.isFinite(itag)) {
    const mapped = youtubeHeightByItag[itag];
    if (mapped !== undefined) return mapped;
  }

  const height = Number(value.height);
  return Number.isFinite(height) && height > 0 ? height : undefined;
}
