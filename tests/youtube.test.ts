import { describe, it, expect } from 'vitest';
import { youtubeHeightByItag, youtubeQualityPreference, youtubePublishedHeight } from '../utils/youtube';

describe('youtubeHeightByItag', () => {
  it('maps known itags', () => {
    expect(youtubeHeightByItag[137]).toBe(1080);
    expect(youtubeHeightByItag[248]).toBe(1080);
    expect(youtubeHeightByItag[399]).toBe(1080);
    expect(youtubeHeightByItag[160]).toBe(144);
  });
  it('maps progressive itags', () => {
    expect(youtubeHeightByItag[22]).toBe(720);
    expect(youtubeHeightByItag[18]).toBe(360);
  });
});

describe('youtubeQualityPreference', () => {
  it('prefers h264 over vp9 over av1', () => {
    const h264 = youtubeQualityPreference({ itag: 137, container: 'MP4', videoOnly: true });
    const vp9 = youtubeQualityPreference({ itag: 248, container: 'WEBM', videoOnly: true });
    const av1 = youtubeQualityPreference({ itag: 399, container: 'MP4', videoOnly: true });
    expect(h264).toBeGreaterThan(vp9);
    expect(vp9).toBeGreaterThan(av1);
  });
  it('prefers MP4 container and audio', () => {
    const mp4 = youtubeQualityPreference({ itag: 137, container: 'MP4', videoOnly: false });
    const webm = youtubeQualityPreference({ itag: 137, container: 'WEBM', videoOnly: true });
    expect(mp4).toBeGreaterThan(webm);
  });
  it('uses bitrate as tiebreaker within same codec', () => {
    const low = youtubeQualityPreference({ itag: 137, bitrate: 1000000 });
    const high = youtubeQualityPreference({ itag: 137, bitrate: 3000000 });
    expect(high).toBeGreaterThan(low);
  });
  it('handles missing itag gracefully', () => {
    const val = youtubeQualityPreference({ itag: 9999, container: 'MP4' });
    expect(typeof val).toBe('number');
    expect(Number.isFinite(val)).toBe(true);
  });
});

describe('youtubePublishedHeight', () => {
  it('parses label height', () => {
    expect(youtubePublishedHeight({ qualityLabel: '1080p' })).toBe(1080);
    expect(youtubePublishedHeight({ label: '720p60' })).toBe(720);
    expect(youtubePublishedHeight({ quality: '480p' })).toBe(480);
  });
  it('falls back to itag map', () => {
    expect(youtubePublishedHeight({ itag: 137 })).toBe(1080);
    expect(youtubePublishedHeight({ itag: 160 })).toBe(144);
  });
  it('falls back to explicit height', () => {
    expect(youtubePublishedHeight({ height: 720 })).toBe(720);
    expect(youtubePublishedHeight({ height: 0 })).toBeUndefined();
  });
  it('returns undefined for unknown', () => {
    expect(youtubePublishedHeight({})).toBeUndefined();
    expect(youtubePublishedHeight({ itag: 99999 })).toBeUndefined();
  });
});
