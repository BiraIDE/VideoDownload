"""Mapeamentos e constantes do Stream2JD."""

import base64
import re
from typing import Dict, Iterable, Tuple

VERSION = '1.9.20'
CLICKNLOAD_REFERER = 'http://127.0.0.1:9666/flashgot'
MAX_MANIFEST_SIZE = 8 * 1024 * 1024
SESSION_LIFETIME = 24 * 60 * 60
DOWNLOAD_REQUEST_COOLDOWN = 0.03
SEGMENT_REQUEST_COOLDOWN = 0.02
UPSTREAM_TIMEOUT = 60
UPSTREAM_RETRIES = 6
SEGMENT_BUFFER_LIMIT = 32 * 1024 * 1024
RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524})

ALLOWED_SESSION_HEADER = re.compile(
    r'^(?:authorization|origin|referer|user-agent|accept|accept-language|'
    r'sec-ch-ua(?:-mobile|-platform)?|x-[a-z0-9-]+|api-?key|token|'
    r'access-token|auth-token|signature|client-id|client-version)$',
    re.I,
)

# Marcadores de DRM por esquema. AES-128/SAMPLE-AES com chave HTTP visível
# NÃO é DRM: o JDownloader/FFmpeg consegue descriptografar passando a chave
# pelo proxy. Somente Widevine/PlayReady/FairPlay são bloqueados.
DRM_MARKERS: Dict[str, Tuple[str, ...]] = {
    'widevine': ('com.widevine.alpha', 'widevine', 'urn:uuid:edef8ba9'),
    'playready': ('com.microsoft.playready', 'playready', 'urn:uuid:9a04f079'),
    'fairplay': ('com.apple.fps', 'fairplay', 'fps.1_0', 'urn:uuid:94ce86fb'),
}

DRM_LABEL: Dict[str, str] = {
    'widevine': 'Widevine',
    'playready': 'PlayReady',
    'fairplay': 'FairPlay',
}


def _build_youtube_variant_map() -> Dict[int, str]:
    """Constroi o mapeamento itag → nome de variante do JDownloader.

    Extraído da tabela oficial do plugin YouTube do JDownloader.
    O fragmento #variant seleciona uma qualidade sem alterar as preferências
    globais do usuário.
    """
    return {
        # H.264/MP4 adaptativo
        160: 'MP4_H264_144P_30FPS_AAC_128KBIT_DASH',
        133: 'MP4_H264_240P_30FPS_AAC_128KBIT_DASH',
        134: 'MP4_H264_360P_30FPS_AAC_128KBIT_DASH',
        135: 'MP4_H264_480P_30FPS_AAC_128KBIT_DASH',
        212: 'MP4_H264_480P_30FPS_AAC_128KBIT_DASH_2',
        136: 'MP4_H264_720P_30FPS_AAC_128KBIT_DASH',
        298: 'MP4_H264_720P_60FPS_AAC_128KBIT_DASH',
        137: 'MP4_H264_1080P_30FPS_AAC_128KBIT_DASH',
        299: 'MP4_H264_1080P_60FPS_AAC_128KBIT_DASH',
        264: 'MP4_H264_1440P_30FPS_AAC_128KBIT_DASH',
        266: 'MP4_H264_2160P_30FPS_AAC_128KBIT_DASH',
        # VP9/WebM combinado com AAC em MKV pelo JDownloader
        278: 'MKV_VP9_144P_30FPS_AAC_128KBIT_DASH',
        242: 'MKV_VP9_240P_30FPS_AAC_128KBIT_DASH',
        243: 'MKV_VP9_360P_30FPS_AAC_128KBIT_DASH',
        244: 'MKV_VP9_480P_30FPS_AAC_128KBIT_DASH',
        247: 'MKV_VP9_720P_30FPS_AAC_128KBIT_DASH',
        302: 'MKV_VP9_720P_60FPS_AAC_128KBIT_DASH',
        248: 'MKV_VP9_1080P_30FPS_AAC_128KBIT_DASH',
        303: 'MKV_VP9_1080P_60FPS_AAC_128KBIT_DASH',
        271: 'MKV_VP9_1440P_30FPS_AAC_128KBIT_DASH',
        308: 'MKV_VP9_1440P_60FPS_AAC_128KBIT_DASH',
        313: 'MKV_VP9_WORSE_PROFILE_1_2160P_30FPS_AAC_128KBIT_DASH',
        315: 'MKV_VP9_2160P_60FPS_AAC_128KBIT_DASH',
        272: 'MKV_VP9_4320P_30FPS_AAC_128KBIT_DASH',
        # AV1/MP4
        394: 'MP4_AV1_144P_30FPS_AAC_128KBIT_DASH',
        395: 'MP4_AV1_240P_30FPS_AAC_128KBIT_DASH',
        396: 'MP4_AV1_360P_30FPS_AAC_128KBIT_DASH',
        397: 'MP4_AV1_480P_30FPS_AAC_128KBIT_DASH',
        398: 'MP4_AV1_720P_30FPS_AAC_128KBIT_DASH',
        399: 'MP4_AV1_1920P_30FPS_AAC_128KBIT_DASH',
        400: 'MP4_AV1_1440P_60FPS_AAC_128KBIT_DASH',
        401: 'MP4_AV1_2160P_60FPS_AAC_128KBIT_DASH',
        402: 'MP4_AV1_4320P_60FPS_AAC_128KBIT_DASH',
    }


def _build_youtube_h264_fallbacks() -> Dict[Tuple[int, int], str]:
    """Constroe o mapeamento (altura, fps) → variante H.264 fallback."""
    return {
        (144, 30): 'MP4_H264_144P_30FPS_AAC_128KBIT_DASH',
        (240, 30): 'MP4_H264_240P_30FPS_AAC_128KBIT_DASH',
        (360, 30): 'MP4_H264_360P_30FPS_AAC_128KBIT_DASH',
        (480, 30): 'MP4_H264_480P_30FPS_AAC_128KBIT_DASH',
        (720, 30): 'MP4_H264_720P_30FPS_AAC_128KBIT_DASH',
        (720, 60): 'MP4_H264_720P_60FPS_AAC_128KBIT_DASH',
        (1080, 30): 'MP4_H264_1080P_30FPS_AAC_128KBIT_DASH',
        (1080, 60): 'MP4_H264_1080P_60FPS_AAC_128KBIT_DASH',
        (1440, 30): 'MP4_H264_1440P_30FPS_AAC_128KBIT_DASH',
        (2160, 30): 'MP4_H264_2160P_30FPS_AAC_128KBIT_DASH',
        (2160, 60): 'MP4_H264_2160P_60FPS_AAC_128KBIT_DASH',
        (4320, 30): 'MP4_H264_4320P_30FPS_AAC_128KBIT_DASH',
    }


YOUTUBE_VARIANT_BY_ITAG = _build_youtube_variant_map()
YOUTUBE_H264_FALLBACKS = _build_youtube_h264_fallbacks()


def safe_name(value: str, limit: int = 180) -> str:
    """Sanitiza um nome de arquivo: remove caracteres proibidos e truncua."""
    value = re.sub(r'[\x00-\x1f<>:"/\\|?*]+', ' ', value or 'video')
    value = re.sub(r'\s+', ' ', value).strip()[:limit].rstrip(' .') or 'video'
    # Evita path traversal residual: ".." isolado vira "__"
    # W2-A fix: '..' isolado vira '__' — por token para evitar overlap de \s
    parts = value.split(' ')
    parts = ['__' if p == '..' else p for p in parts]
    value = ' '.join(parts)
    return re.sub(r'\s+', ' ', value).strip() or 'video'


def encoded_url(value: str) -> str:
    """Codifica uma URL em base64 URL-safe (sem padding)."""
    return base64.urlsafe_b64encode(value.encode('utf-8')).decode('ascii').rstrip('=')


def decoded_url(value: str) -> str:
    """Decodifica uma URL codificada em base64 URL-safe."""
    value += '=' * (-len(value) % 4)
    return base64.urlsafe_b64decode(value).decode('utf-8')
