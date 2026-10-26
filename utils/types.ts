export type StreamKind = 'HLS' | 'DASH' | 'MP4' | 'WebM' | 'Audio' | 'Media';
export type DrmScheme = 'none' | 'aes128' | 'widevine' | 'playready' | 'fairplay' | 'cenc-generico' | 'desconhecida';
export type PlatformId =
  | 'youtube'
  | 'vimeo'
  | 'dailymotion'
  | 'twitch'
  | 'facebook'
  | 'instagram'
  | 'tiktok'
  | 'x'
  | 'rumble'
  | 'odysee'
  | 'bilibili'
  | 'generic';

export interface StreamCandidate {
  url: string;
  source?: string;
  frameId?: number;
  method?: string;
  contentType?: string;
  referer?: string;
  origin?: string;
  headers?: Record<string, string>;
  kind?: StreamKind;
  platform?: PlatformId | 'youtube';
  title?: string;
  thumbnail?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  contentLength?: number;
  itag?: number;
  quality?: string;
  container?: string;
  videoOnly?: boolean;
  variantId?: string;
  masterUrl?: string;
  isBest?: boolean;
  seenAt?: number;
  drm?: DrmScheme;
  protection?: string;
}

export interface VideoQuality {
  label: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  contentLength?: number;
  itag?: number;
  container?: string;
  videoOnly?: boolean;
}

export interface YtDiag {
  responseFound?: boolean;
  formatsSeen?: number;
  levelsSeen?: number;
  playbackQuality?: string;
}

export interface PageMeta {
  title?: string;
  thumbnail?: string;
  pageUrl?: string;
  hostPageUrl?: string;
  referer?: string;
  platform?: PlatformId | 'youtube';
  videoId?: string;
  qualities?: VideoQuality[];
  main?: boolean;
  embedded?: boolean;
  embeddedFrameId?: number;
  drm?: DrmScheme;
  protection?: string;
  emeDetected?: boolean;
  contentVersion?: string;
  ytDiag?: YtDiag;
}

export interface TabCaptureState {
  items: Map<string, StreamCandidate>;
  rejected: Set<string>;
  meta: PageMeta;
  updated: number;
}

export interface ExtensionConfig {
  port: number;
  token: string;
  includeCookies: boolean;
  captureHeaders: boolean;
  instantStart: boolean;
  interceptDownloads: boolean;
}

export type RuntimeMessage =
  | { type: 'candidates'; items: StreamCandidate[]; meta: PageMeta; tabId?: number }
  | { type: 'get'; tabId: number }
  | { type: 'clear'; tabId: number };

export interface CapturePayload {
  items: StreamCandidate[];
  meta: PageMeta;
}
