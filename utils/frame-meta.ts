import type { PageMeta } from './types';

export function mainDocumentUrl(meta: PageMeta): string | undefined {
  return meta.hostPageUrl ?? (meta.main && !meta.embedded ? meta.pageUrl : undefined);
}

export function mergeFrameMeta(current: PageMeta, incoming: PageMeta, isMainFrame: boolean, frameId?: number): PageMeta {
  if (isMainFrame) {
    if (current.embedded && Boolean(current.platform || current.videoId)) {
      return {
        ...incoming,
        ...current,
        hostPageUrl: incoming.pageUrl,
        referer: incoming.pageUrl ?? current.referer,
        main: true,
      };
    }
    return {
      ...current,
      ...incoming,
      hostPageUrl: incoming.pageUrl,
      main: true,
      embedded: false,
      embeddedFrameId: undefined,
    };
  }

  const embeddedVideo = Boolean(incoming.videoId || incoming.platform);
  if (embeddedVideo) {
    const sameVideo = !current.videoId || !incoming.videoId || current.videoId === incoming.videoId;
    const sameFrame = current.embeddedFrameId == null || current.embeddedFrameId === frameId;
    if (!current.embedded || sameVideo || sameFrame) {
      const hostPageUrl = mainDocumentUrl(current);
      return {
        ...current,
        ...incoming,
        hostPageUrl,
        referer: hostPageUrl ?? incoming.referer,
        main: current.main ?? false,
        embedded: true,
        embeddedFrameId: frameId,
      };
    }
    return current;
  }

  return { ...incoming, ...current, main: current.main ?? false };
}
