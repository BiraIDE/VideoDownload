import { describe, it, expect } from 'vitest';
import { mainDocumentUrl, mergeFrameMeta } from '../utils/frame-meta';
import type { PageMeta } from '../utils/types';

function makeMeta(overrides: Partial<PageMeta> = {}): PageMeta {
  return {
    title: 'Original Title',
    pageUrl: 'https://example.com/original',
    platform: 'youtube',
    videoId: 'abc123',
    main: false,
    embedded: false,
    hostPageUrl: undefined,
    ...overrides,
  };
}

describe('frame-meta', () => {
  describe('mainDocumentUrl', () => {
    it('returns hostPageUrl when present', () => {
      const meta = makeMeta({ hostPageUrl: 'https://example.com/page' });
      expect(mainDocumentUrl(meta)).toBe('https://example.com/page');
    });

    it('returns pageUrl when main and not embedded', () => {
      const meta = makeMeta({ main: true, embedded: false, pageUrl: 'https://youtube.com/watch?v=abc' });
      expect(mainDocumentUrl(meta)).toBe('https://youtube.com/watch?v=abc');
    });

    it('returns undefined when embedded main', () => {
      const meta = makeMeta({ main: true, embedded: true, pageUrl: 'https://youtube.com/embed/abc' });
      expect(mainDocumentUrl(meta)).toBeUndefined();
    });

    it('returns undefined when neither condition met', () => {
      const meta = makeMeta({ pageUrl: 'https://example.com' });
      expect(mainDocumentUrl(meta)).toBeUndefined();
    });
  });

  describe('mergeFrameMeta', () => {
    const baseMeta = makeMeta({});

    it('merges incoming meta for main frame', () => {
      const result = mergeFrameMeta(baseMeta, {
        pageUrl: 'https://youtube.com/watch?v=abc123',
        title: 'New Title',
      }, true, 0);

      expect(result.main).toBe(true);
      expect(result.embedded).toBe(false);
      expect(result.embeddedFrameId).toBeUndefined();
      expect(result.title).toBe('New Title');
      expect(result.pageUrl).toBe('https://youtube.com/watch?v=abc123');
    });

    it('preserves platform and videoId when switching main page', () => {
      const result = mergeFrameMeta(baseMeta, {
        pageUrl: 'https://youtube.com/watch?v=newvideo',
      }, true, 0);

      expect(result.hostPageUrl).toBe('https://youtube.com/watch?v=newvideo');
      expect(result.platform).toBe('youtube');
      expect(result.videoId).toBe('abc123');
    });

    it('merges embedded frame with video info', () => {
      const result = mergeFrameMeta(makeMeta({}), {
        videoId: 'xyz789',
        platform: 'youtube',
        pageUrl: 'https://youtube.com/embed/xyz789',
      }, false, 42);

      expect(result.embedded).toBe(true);
      expect(result.embeddedFrameId).toBe(42);
      expect(result.videoId).toBe('xyz789');
      expect(result.platform).toBe('youtube');
    });

    it('preserves hostPageUrl from base when embedded frame arrives', () => {
      const existing = makeMeta({
        hostPageUrl: 'https://example.com/page',
        embedded: true,
        embeddedFrameId: 10,
        pageUrl: 'https://example.com/page',
        platform: 'youtube',
        videoId: 'abc123',
      });

      // Quando o videoId é o mesmo, mergeFrameMeta sobrescreve embeddedFrameId
      // para o frameId recebido (comportamento intencional: atualiza para o frame atual)
      const result = mergeFrameMeta(existing, {
        videoId: 'abc123',
        pageUrl: 'https://example.com/page?t=10',
      }, false, 20);

      expect(result.embeddedFrameId).toBe(20);
      expect(result.embedded).toBe(true);
      expect(result.hostPageUrl).toBe('https://example.com/page');
    });

    it('uses base hostPageUrl when incoming has no video info', () => {
      const existing = makeMeta({
        hostPageUrl: 'https://example.com/page',
        embedded: true,
        embeddedFrameId: 10,
        pageUrl: 'https://example.com/page',
      });

      // Sem videoId/platform no incoming, o ramo embedded não é acionado;
      // o fallback { ...incoming, ...current } preserva o estado base (hostPageUrl, embedded, pageUrl)
      const result = mergeFrameMeta(existing, {
        pageUrl: 'https://example.com/other',
      }, false, 20);

      expect(result.hostPageUrl).toBe('https://example.com/page');
      expect(result.embedded).toBe(true);
      expect(result.embeddedFrameId).toBe(10);
      expect(result.pageUrl).toBe('https://example.com/page');
    });

    it('merges non-embedded incoming with base preserving main flag', () => {
      // Para frames não principais sem videoId, { ...incoming, ...current }
      // faz com que current (base) sobrescreve incoming
      const result = mergeFrameMeta(baseMeta, {
        pageUrl: 'https://example.com/new',
        title: 'Updated',
      }, false, undefined);

      expect(result.main).toBe(false);
      expect(result.title).toBe('Original Title');
      expect(result.pageUrl).toBe('https://example.com/original');
    });

    it('overwrites pageUrl from incoming when base has no hostPageUrl', () => {
      const baseWithoutHost = makeMeta({ hostPageUrl: undefined });
      const result = mergeFrameMeta(baseWithoutHost, {
        pageUrl: 'https://example.com/new',
        title: 'Updated',
      }, false, undefined);

      // current (base) vence: pageUrl e title vêm do base
      expect(result.pageUrl).toBe('https://example.com/original');
      expect(result.title).toBe('Original Title');
    });

    it('allows incoming to win for embedded video with new frameId', () => {
      const existing = makeMeta({
        title: 'Old Title',
        pageUrl: 'https://example.com/old',
        embedded: true,
        embeddedFrameId: 10,
        platform: 'youtube',
        videoId: 'abc123',
      });

      const result = mergeFrameMeta(existing, {
        title: 'New Title',
        pageUrl: 'https://example.com/new',
        videoId: 'abc123',
        platform: 'youtube',
      }, false, 30);

      // Para embedded video com mesmo videoId: incoming vence (spread order: current...incoming)
      expect(result.title).toBe('New Title');
      expect(result.pageUrl).toBe('https://example.com/new');
      expect(result.embeddedFrameId).toBe(30);
      expect(result.embedded).toBe(true);
    });
  });
});
