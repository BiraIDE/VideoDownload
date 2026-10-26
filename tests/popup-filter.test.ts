import { describe, it, expect } from 'vitest';
import { visibleCandidates, youtubeQualities, audioVariantKey, fpsBucket, normalizeYoutubeQuality } from '../utils/popup-filter';
import type { StreamCandidate, PageMeta } from '../utils/types';

describe('fpsBucket', () => {
  it('buckets fps', () => {
    expect(fpsBucket(undefined)).toBe(0);
    expect(fpsBucket(0)).toBe(0);
    expect(fpsBucket(24)).toBe(24);
    expect(fpsBucket(30)).toBe(30);
    expect(fpsBucket(48)).toBe(48);
    expect(fpsBucket(60)).toBe(60);
    expect(fpsBucket(120)).toBe(60);
  });
});

describe('audioVariantKey', () => {
  it('includes bitrate/size', () => {
    const a: StreamCandidate = { url: 'https://cdn/a.mp3', kind: 'Audio', container: 'mp3', bitrate: 128000, contentLength: 5_000_000 };
    expect(audioVariantKey(a)).toBe('audio:mp3:128000:5000000');
  });
  it('falls back to url when no bitrate/size', () => {
    const a: StreamCandidate = { url: 'https://cdn/a.mp3', kind: 'Audio', container: 'MP3' };
    expect(audioVariantKey(a)).toContain('https://cdn/a.mp3');
  });
});

describe('visibleCandidates', () => {
  it('filters text/html', () => {
    const items: StreamCandidate[] = [
      { url: 'https://cdn/a.mp4', kind: 'MP4', contentType: 'text/html' },
      { url: 'https://cdn/b.mp4', kind: 'MP4' },
    ];
    const out = visibleCandidates(items);
    expect(out.length).toBe(1);
    expect(out[0]!.url).toBe('https://cdn/b.mp4');
  });
  it('rejects invalid URL', () => {
    const items: StreamCandidate[] = [
      { url: 'not a url', kind: 'MP4' },
      { url: 'https://cdn/b.m3u8', kind: 'HLS' },
    ];
    const out = visibleCandidates(items);
    expect(out.some(i => i.url === 'not a url')).toBe(false);
  });
  it('dedups by height:fps keeping best score', () => {
    const items: StreamCandidate[] = [
      { url: 'https://cdn/720p-a.mp4', kind: 'MP4', height: 720, fps: 30, bitrate: 1_000_000 },
      { url: 'https://cdn/720p-b.m3u8', kind: 'HLS', height: 720, fps: 30, bitrate: 5_000_000 },
    ];
    const out = visibleCandidates(items);
    // same 720:30 key => keeps HLS (higher candidateScore = 50+20 vs 40)
    expect(out.length).toBe(1);
    expect(out[0]!.kind).toBe('HLS');
  });
  it('keeps Audio variants distinct by bitrate', () => {
    const items: StreamCandidate[] = [
      { url: 'https://cdn/a1.mp3', kind: 'Audio', container: 'mp3', bitrate: 128000, contentLength: 5_000_000 },
      { url: 'https://cdn/a2.mp3', kind: 'Audio', container: 'mp3', bitrate: 320000, contentLength: 9_000_000 },
    ];
    const out = visibleCandidates(items);
    expect(out.length).toBe(2);
  });
  it('does not hide Media html pages without length', () => {
    const items: StreamCandidate[] = [
      { url: 'https://site.example/page.html', kind: 'Media' },
      { url: 'https://cdn/video.m3u8', kind: 'HLS' },
    ];
    const out = visibleCandidates(items);
    expect(out.some(i => i.url.includes('page.html'))).toBe(false);
  });
  it('small contentLength hidden when manifest exists', () => {
    const items: StreamCandidate[] = [
      { url: 'https://cdn/video.m3u8', kind: 'HLS' },
      { url: 'https://cdn/small.mp4', kind: 'MP4', contentLength: 1_000_000 },
      { url: 'https://cdn/audio.mp3', kind: 'Audio', contentLength: 1_000_000 },
    ];
    const out = visibleCandidates(items);
    expect(out.some(i => i.url.includes('small.mp4'))).toBe(false);
    expect(out.some(i => i.url.includes('audio.mp3'))).toBe(true);
  });
  it('sorts ascending height', () => {
    const items: StreamCandidate[] = [
      { url: 'https://cdn/1080.mp4', kind: 'MP4', height: 1080 },
      { url: 'https://cdn/720.m3u8', kind: 'HLS', height: 720 },
      { url: 'https://cdn/480.mp4', kind: 'MP4', height: 480 },
    ];
    const out = visibleCandidates(items);
    expect(out.map(i => i.height)).toEqual([480, 720, 1080]);
  });
});

describe('youtubeQualities', () => {
  it('maps meta.qualities and dedups by height', () => {
    const meta: PageMeta = {
      qualities: [
        { label: '720p', height: 720, container: 'MP4', itag: 136 },
        { label: '720p', height: 720, container: 'WEBM', itag: 247 },
        { label: '1080p', height: 1080, container: 'MP4', itag: 137 },
      ],
    };
    const out = youtubeQualities(meta, []);
    expect(out.length).toBe(2);
    // H264 preferred over VP9 => 720p should be 136
    expect(out.find(q => q.height === 720)?.itag).toBe(136);
  });
  it('falls back to items when meta.qualities empty', () => {
    const items: StreamCandidate[] = [
      { url: 'https://cdn/a.mp4', kind: 'MP4', height: 720, itag: 136, container: 'MP4' },
      { url: 'https://cdn/b.mp4', kind: 'MP4', height: 1080, itag: 137, container: 'MP4' },
    ];
    const out = youtubeQualities({ qualities: [] }, items);
    expect(out.length).toBe(2);
  });
  it('normalizes error labels to fallback', () => {
    const meta: PageMeta = {
      qualities: [
        { label: '403 Forbidden', height: 1080, itag: 137 },
      ],
    };
    const out = youtubeQualities(meta, []);
    expect(out[0]!.label).not.toMatch(/403/);
  });
  it('sorts descending height', () => {
    const meta: PageMeta = {
      qualities: [
        { label: '480p', height: 480, itag: 135 },
        { label: '1080p', height: 1080, itag: 137 },
        { label: '720p', height: 720, itag: 136 },
      ],
    };
    const out = youtubeQualities(meta, []);
    expect(out.map(q => q.height)).toEqual([1080, 720, 480]);
  });
});

describe('normalizeYoutubeQuality', () => {
  it('replaces error label', () => {
    const q = normalizeYoutubeQuality({ label: 'http error 403', height: 720 });
    expect(q.label).toBe('720p');
  });
  it('keeps good label', () => {
    const q = normalizeYoutubeQuality({ label: '720p', height: 720 });
    expect(q.label).toBe('720p');
  });
});
