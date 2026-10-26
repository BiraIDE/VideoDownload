import { describe, it, expect } from 'vitest';
import { candidateScore, candidatePriority } from '../utils/scoring';

describe('candidateScore', () => {
  it('ranks HLS > DASH > MP4 > WebM > Audio > Media', () => {
    const hls = candidateScore({ url: 'https://cdn/a.m3u8', kind: 'HLS' });
    const dash = candidateScore({ url: 'https://cdn/a.mpd', kind: 'DASH' });
    const mp4 = candidateScore({ url: 'https://cdn/a.mp4', kind: 'MP4' });
    const webm = candidateScore({ url: 'https://cdn/a.webm', kind: 'WebM' });
    const audio = candidateScore({ url: 'https://cdn/a.mp3', kind: 'Audio' });
    const media = candidateScore({ url: 'https://cdn/a.bin', kind: 'Media' });
    expect(hls).toBeGreaterThan(dash);
    expect(dash).toBeGreaterThan(mp4);
    expect(mp4).toBeGreaterThan(webm);
    expect(webm).toBeGreaterThan(audio);
    expect(audio).toBeGreaterThan(media);
  });
  it('adds bonus for direct manifest URL', () => {
    const withManifest = candidateScore({ url: 'https://cdn/playlist.m3u8', kind: 'HLS' });
    const without = candidateScore({ url: 'https://cdn/videoplayback?mime=video/mp4', kind: 'HLS' });
    expect(withManifest).toBeGreaterThan(without);
  });
  it('adds bonus for withAudio and caps bitrate bonus', () => {
    const base = candidateScore({ url: 'https://cdn/a.mp4', kind: 'MP4', videoOnly: true });
    const withAudio = candidateScore({ url: 'https://cdn/a.mp4', kind: 'MP4', videoOnly: false });
    expect(withAudio).toBeGreaterThan(base);
    // Math.min(10, bitrate/2M): 20M->10 and 50M->10 must be capped igualmente
    const veryHigh = candidateScore({ url: 'https://cdn/a.mp4', kind: 'MP4', bitrate: 50_000_000 });
    const capped = candidateScore({ url: 'https://cdn/a.mp4', kind: 'MP4', bitrate: 20_000_000 });
    expect(veryHigh).toBe(capped);
  });
});

describe('candidatePriority', () => {
  it('consistent ordering without manifest/bitrate bonus', () => {
    expect(candidatePriority({ url: 'x', kind: 'HLS' })).toBe(50);
    expect(candidatePriority({ url: 'x', kind: 'DASH' })).toBe(45);
    expect(candidatePriority({ url: 'x', kind: 'MP4' })).toBe(30);
    expect(candidatePriority({ url: 'x', kind: 'WebM' })).toBe(25);
    expect(candidatePriority({ url: 'x', kind: 'Audio' })).toBe(20);
  });
  it('falls back to 10 for unknown kind', () => {
    expect(candidatePriority({ url: 'x', kind: 'Media' })).toBe(10);
  });
});
