#!/usr/bin/env python3
import argparse
import base64
import json
import ipaddress
import os
import random
import re
import random
import time
from typing import Optional
import secrets
import socket
import sys
import threading
import time
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlencode, urljoin, urlsplit
from urllib.request import Request, urlopen

# --- DRY: tente importar de stream2jd_constants; fallback inline p/ single-file ---
try:
    from helper.stream2jd_constants import (
        VERSION,
        CLICKNLOAD_REFERER,
        MAX_MANIFEST_SIZE,
        SESSION_LIFETIME,
        DOWNLOAD_REQUEST_COOLDOWN,
        SEGMENT_REQUEST_COOLDOWN,
        UPSTREAM_TIMEOUT,
        UPSTREAM_RETRIES,
        SEGMENT_BUFFER_LIMIT,
        RETRYABLE_STATUS,
        ALLOWED_SESSION_HEADER,
        DRM_MARKERS,
        DRM_LABEL,
        YOUTUBE_VARIANT_BY_ITAG,
        YOUTUBE_H264_FALLBACKS,
        safe_name,
        encoded_url,
        decoded_url,
    )
    _USING_IMPORTED_CONSTANTS = True
except ImportError:
    try:
        from stream2jd_constants import (
            VERSION,
            CLICKNLOAD_REFERER,
            MAX_MANIFEST_SIZE,
            SESSION_LIFETIME,
            DOWNLOAD_REQUEST_COOLDOWN,
            SEGMENT_REQUEST_COOLDOWN,
            UPSTREAM_TIMEOUT,
            UPSTREAM_RETRIES,
            SEGMENT_BUFFER_LIMIT,
            RETRYABLE_STATUS,
            ALLOWED_SESSION_HEADER,
            DRM_MARKERS,
            DRM_LABEL,
            YOUTUBE_VARIANT_BY_ITAG,
            YOUTUBE_H264_FALLBACKS,
            safe_name,
            encoded_url,
            decoded_url,
        )
        _USING_IMPORTED_CONSTANTS = True
    except ImportError:
        _USING_IMPORTED_CONSTANTS = False
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
        DRM_MARKERS = {
            'widevine': ('com.widevine.alpha', 'widevine', 'urn:uuid:edef8ba9'),
            'playready': ('com.microsoft.playready', 'playready', 'urn:uuid:9a04f079'),
            'fairplay': ('com.apple.fps', 'fairplay', 'fps.1_0', 'urn:uuid:94ce86fb'),
        }
        DRM_LABEL = {
            'widevine': 'Widevine',
            'playready': 'PlayReady',
            'fairplay': 'FairPlay',
        }
        YOUTUBE_VARIANT_BY_ITAG = {
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
        YOUTUBE_H264_FALLBACKS = {
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

        def safe_name(value, limit=180):
            value = re.sub(r'[\x00-\x1f<>:"/\\|?*]+', ' ', value or 'video')
            value = re.sub(r'\s+', ' ', value).strip()[:limit].rstrip(' .') or 'video'
            parts = value.split(' ')
            parts = ['__' if p == '..' else p for p in parts]
            value = ' '.join(parts)
            return re.sub(r'\s+', ' ', value).strip() or 'video'

        def encoded_url(value):
            return base64.urlsafe_b64encode(value.encode('utf-8')).decode('ascii').rstrip('=')

        def decoded_url(value):
            value += '=' * (-len(value) % 4)
            return base64.urlsafe_b64decode(value).decode('utf-8')

def _ceil(value: float) -> int:
    """Ceil sem math: evita import marginal, usa floor division."""
    return int(-(-value // 1))

def _log(level: str, msg: str) -> None:
    """Log estruturado para stderr sem expor tokens/sessions longos."""
    sys.stderr.write(f"stream2jd [{level}] {msg}\n")

def _extract_host(url: str) -> str:
    """Extrai hostname lowercased de URL (stdlib-only)."""
    try:
        return (urlsplit(url).hostname or '').lower().strip().strip('.')
    except Exception:
        return ''

def _extract_port(url: str):
    try:
        return urlsplit(url).port
    except Exception:
        return None

def _normalize_ip_host(host: str):
    """Decodifica formas obfuscadas de IPv4 (0x7f, 0177, decimal) para dotted."""
    # 0x7f.0.0.1, 0x7f000001 etc já são bloqueados se detectados como private;
    # normaliza para ipaddress conseguir avaliar.
    h = host.lower().strip()
    # single integer -> dotted
    if re.fullmatch(r'\d+', h):
        try:
            n = int(h)
            if 0 <= n <= 4294967295:
                return '.'.join(str((n >> s) & 0xFF) for s in (24, 16, 8, 0))
        except Exception:
            pass
        return None
    if '.' not in h:
        # hex single like 0x7f000001
        if h.startswith('0x'):
            try:
                n = int(h, 16)
                return '.'.join(str((n >> s) & 0xFF) for s in (24, 16, 8, 0))
            except Exception:
                pass
        return None
    parts = h.split('.')
    if len(parts) not in (2, 3, 4):
        return None
    out = []
    for p in parts:
        try:
            if p.startswith('0x') or p.startswith('0X'):
                v = int(p, 16)
            elif len(p) > 1 and p[0] == '0' and p.isdigit():
                v = int(p, 8)
            elif p.isdigit():
                v = int(p, 10)
            else:
                return None
            if not 0 <= v <= 255:
                return None
            out.append(str(v))
        except Exception:
            return None
    # pad if less than 4 octets: last part contains remainder bytes (curl-like)
    if len(out) < 4:
        # expande último valor em bytes restantes
        try:
            last = int(out[-1])
            needed = 4 - len(out) + 1
            # need to split last integer into needed bytes
            # e.g. 2 parts: a.b where b is 24-bit
            raw_last = parts[-1]
            if raw_last.startswith('0x') or raw_last.startswith('0X'):
                n = int(raw_last, 16)
            elif len(raw_last) > 1 and raw_last[0] == '0' and raw_last.isdigit():
                n = int(raw_last, 8)
            else:
                n = int(raw_last, 10)
            bytes_needed = needed
            expanded = []
            for s in reversed([8 * i for i in range(bytes_needed)]):
                expanded.append(str((n >> s) & 0xFF))
            return '.'.join(out[:-1] + expanded)
        except Exception:
            return '.'.join(out)
    return '.'.join(out)

def _is_private_host(host: str) -> bool:
    """Detecta hosts que não devem receber headers de sessão (mitigação SSRF S-01).

    W3: cobre também formas obfuscadas (0x7f, octal) e 0.0.0.0/unspecified.
    Allowlist explícita só para 127.0.0.1/localhost quando usado sem porta
    suspeita — checagem de porta é feita em _is_blocked_upstream_url.
    """
    if not host:
        return False
    lowered = host.lower().strip().strip('.')
    if lowered in ('127.0.0.1', 'localhost'):
        return False
    if lowered == 'metadata.google.internal' or lowered.endswith('.internal'):
        return True
    # tenta normalizar obfuscado antes de ip_address
    norm = _normalize_ip_host(lowered)
    cand = norm if norm else lowered
    # se normalização mudou, avalie o IP normalizado
    if cand != lowered:
        try:
            ip = ipaddress.ip_address(cand)
            return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified
        except ValueError:
            return True  # forma estranha que decodifica mas não é IP válido -> bloqueia
    try:
        ip = ipaddress.ip_address(lowered)
        return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified
    except ValueError:
        return False

def _is_allowed_loopback(host: str, port) -> bool:
    """Loopback só é permitido para JD (9666) e helper (17442)."""
    if not host:
        return False
    h = host.lower().strip().strip('.')
    if h not in ('127.0.0.1', 'localhost', '::1', '127.000.0.001'):
        return False
    try:
        p = int(port) if port is not None else None
    except Exception:
        p = None
    return p in (9666, 17442)

def _is_blocked_upstream_url(url: str) -> bool:
    """True se URL aponta para host privado/bloqueado (SSRF guard pré-fetch)."""
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or '').lower().strip().strip('.')
        port = parsed.port
        if not host:
            return True
        if _is_allowed_loopback(host, port):
            return False
        # url com credenciais embutidas nunca deve ser proxyada
        if parsed.username or parsed.password:
            return True
        # W3: loopback nomeado sem porta permitida deve bloquear
        if host in ('localhost', '127.0.0.1', '127.000.0.001', '::1', '0.0.0.0', '::'):
            return True
        # W3: loopback/IP privado deve ser bloqueado exceto allowlist acima.
        # _is_private_host retorna False para 127.0.0.1/localhost por compat de redirect,
        # então aqui fazemos checagem direta de IP antes de delegar.
        norm = _normalize_ip_host(host)
        effective_host = norm if norm else host
        if effective_host != host:
            try:
                ip = ipaddress.ip_address(effective_host)
                if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
                    return True
                return False
            except ValueError:
                return True
        # tenta IP literal direto (inclui 127.0.0.1, ::1, 0.0.0.0)
        try:
            ip = ipaddress.ip_address(effective_host)
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
                return True
            return False
        except ValueError:
            pass
        if _is_private_host(effective_host):
            return True
        # bloco extra: 0.0.0.0 explícito e fe80::, metadata etc já cobertos
        return False
    except Exception:
        return True

def _validate_upstream_url(url: str) -> None:
    if not str(url).startswith(('http://', 'https://')):
        raise RuntimeError('a ponte aceita somente endereços HTTP ou HTTPS')
    if _is_blocked_upstream_url(url):
        raise RuntimeError('upstream para host privado/bloqueado negado (SSRF guard)')

def _is_sensitive_header(name: str) -> bool:
    low = str(name).lower()
    if low in ('authorization', 'cookie'):
        return True
    if low.startswith('x-'):
        return True
    if low in ('api-key', 'apikey', 'token', 'access-token', 'auth-token', 'signature', 'client-id', 'client-version'):
        return True
    return False

def _is_same_site(a: str, b: str) -> bool:
    if not a or not b:
        return False
    aa = a.lower().strip().strip('.')
    bb = b.lower().strip().strip('.')
    if aa == bb:
        return True
    # IP hosts nunca same-site se diferentes
    try:
        ipaddress.ip_address(aa)
        ipaddress.ip_address(bb)
        return False
    except ValueError:
        pass
    # tenta normalizar mas se falhar usa sufixo simples (últimos 2 labels)
    def _suffix(h: str) -> str:
        parts = h.split('.')
        if len(parts) >= 2:
            return '.'.join(parts[-2:])
        return h
    return _suffix(aa) == _suffix(bb)

def _filter_headers_for_target(headers: dict, source_host: str, target_url: str) -> dict:
    """S-07: só reenvia Cookie/Authorization/x-* se same-site/ same-host."""
    target_host = _extract_host(target_url)
    if not target_host:
        # sem host válido -> strip sensíveis
        return {k: v for k, v in headers.items() if not _is_sensitive_header(k)}
    if _is_same_site(source_host, target_host):
        return dict(headers)
    return {k: v for k, v in headers.items() if not _is_sensitive_header(k)}

def parse_retry_after(headers):
    """Extrai Retry-After (segundos) de headers HTTPError ou dict."""
    try:
        raw = headers.get('Retry-After') if hasattr(headers, 'get') else None
    except Exception:
        raw = None
    if raw is None and isinstance(headers, dict):
        for key, value in headers.items():
            if str(key).lower() == 'retry-after':
                raw = value
                break
    if raw is None:
        return None
    try:
        delay = int(str(raw).strip().split(',')[0])
        # Enhanced exponential backoff: skips long waits when cap hit, uses
        # golden-ratio jitter to avoid synchronized retries. Cap at 20s per
        # individual attempt — covers short CDN bans without burning threads.
        jitter = random.uniform(0, base * 0.37)  # golden ratio
        return max(1, min(base * (2 ** max(0, attempt)), cap + jitter))
    except (TypeError, ValueError):
        return None


def backoff_delay(attempt, retry_after=None):
    """Enhanced exponential backoff with golden-ratio jitter."""
    if retry_after:
        return min(retry_after + random.uniform(0, 1.0), 20.0)
    try:
        base = [1, 2, 4, 8, 16, 32, 64][min(attempt, 6)]
        cap = [20, 40, 80, 160, 320, 640, 1280][min(attempt, 6)]
        cap = min(cap, 20000)
        if base * (2 ** attempt) > cap:
            return min(cap, base * (2 ** max(0, attempt - 1)) + random.uniform(0, 2))
        # golden ratio jitter for smoother progress
        jitter = random.uniform(0, base * 0.37)
        return base + jitter
    except (TypeError, ValueError):
        return random.uniform(0, 1) if attempt <= 1 else 0.0


class App:
    def __init__(self, token, port, watch_dir=None, session_file=None):
        """watch_dir: legado JDownloader WatchFolder (.crawljob). Mantido por compat; pref. Click'n'Load."""
        self.token = token
        self.port = port
        # watch_dir legado: gera .crawljob para WatchFolder antigo do JD. Hoje o fluxo
        # primário é Click'n'Load via /flashgot; manter por compatibilidade.
        self.watch_dir = Path(watch_dir).expanduser() if watch_dir else None
        self.session_file = Path(session_file).expanduser() if session_file else None
        self.sessions = {}
        self.sessions_lock = threading.RLock()
        self.load_sessions()

    def serializable_sessions(self):
        with self.sessions_lock:
            return {
                session_id: {
                    'created': session['created'],
                    'lastAccess': session.get('lastAccess', session['created']),
                    'headers': session['headers'],
                    'kind': session['kind'],
                    'variantId': session.get('variantId'),
                    'source_host': session.get('source_host'),
                }
                for session_id, session in self.sessions.items()
            }

    def save_sessions(self):
        if not self.session_file:
            return
        self.session_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.session_file.with_suffix(self.session_file.suffix + '.tmp')
        temporary.write_text(json.dumps(self.serializable_sessions(), ensure_ascii=False), encoding='utf-8')
        temporary.chmod(0o600)
        os.replace(temporary, self.session_file)

    def load_sessions(self):
        if not self.session_file or not self.session_file.exists():
            return
        try:
            stored = json.loads(self.session_file.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return
        if not isinstance(stored, dict):
            return
        cutoff = time.time() - SESSION_LIFETIME
        restored = {}
        for session_id, value in stored.items():
            if not isinstance(session_id, str) or not isinstance(value, dict):
                continue
            created = value.get('created')
            last_access = value.get('lastAccess', created)
            headers = value.get('headers')
            if not isinstance(created, (int, float)) or not isinstance(last_access, (int, float)):
                continue
            if max(created, last_access) < cutoff or not isinstance(headers, dict):
                continue
            kind = str(value.get('kind') or 'MEDIA').upper()
            restored[session_id] = {
                'created': created,
                'lastAccess': last_access,
                'headers': headers,
                'kind': kind,
                'variantId': value.get('variantId'),
                'source_host': value.get('source_host'),
                'upstreamLock': threading.Lock(),
                'streamLock': threading.Semaphore(6),
                'lastUpstreamAt': 0.0,
            }
        with self.sessions_lock:
            self.sessions.update(restored)

    def media_filename(self, data, title):
        kind = str(data.get('kind', '')).upper()
        if kind == 'DOWNLOAD':
            suggested = re.split(r'[/\\]+', str(data.get('filename') or ''))[-1]
            if suggested:
                return safe_name(suggested)
            inferred = unquote(urlsplit(data.get('url', '')).path.rsplit('/', 1)[-1])
            return safe_name(inferred or title)
        path = urlsplit(data.get('url', '')).path.lower()
        extension = {'HLS': '.mp4', 'DASH': '.mp4', 'MP4': '.mp4', 'WEBM': '.webm'}.get(kind)
        if not extension:
            match = re.search(r'\.(mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|opus|wav|flac)$', path, re.I)
            extension = f'.{match.group(1).lower()}' if match else ('.mp3' if kind == 'AUDIO' else '.mp4')
        return title if title.lower().endswith(extension) else title + extension

    def youtube_page(self, data):
        if str(data.get('platform', '')).lower() != 'youtube':
            return None
        value = str(data.get('pageUrl') or data.get('url') or '')
        try:
            parsed = urlsplit(value)
            hostname = (parsed.hostname or '').lower()
        except Exception:
            return None
        video_id = None
        if hostname == 'youtu.be':
            video_id = parsed.path.strip('/').split('/', 1)[0]
        elif hostname in ('youtube.com', 'youtube-nocookie.com') or hostname.endswith(('.youtube.com', '.youtube-nocookie.com')):
            if parsed.path.rstrip('/') == '/watch':
                video_id = parse_qs(parsed.query).get('v', [None])[0]
            else:
                match = re.match(r'^/(?:shorts|embed|live)/([^/?#]+)', parsed.path, re.I)
                video_id = match.group(1) if match else None
        if not video_id or not re.fullmatch(r'[A-Za-z0-9_-]{6,20}', video_id):
            return None
        # A URL canonica impede que um video aberto dentro de uma playlist
        # envie acidentalmente a playlist inteira ao JDownloader.
        return 'https://www.youtube.com/watch?' + urlencode({'v': video_id})

    def youtube_variant(self, data):
        raw_height = data.get('selectedHeight')
        if raw_height is None:
            match = re.search(r'(144|240|360|480|720|1080|1440|2160|4320)p', str(data.get('selectedQuality') or ''), re.I)
            raw_height = match.group(1) if match else None
        try:
            height = int(raw_height)
        except (TypeError, ValueError):
            return None
        try:
            itag = int(data.get('selectedItag'))
        except (TypeError, ValueError):
            itag = None
        variant = YOUTUBE_VARIANT_BY_ITAG.get(itag)
        if variant:
            return variant
        try:
            fps = 60 if float(data.get('selectedFps') or 0) >= 50 else 30
        except (TypeError, ValueError):
            fps = 30
        return YOUTUBE_H264_FALLBACKS.get((height, fps)) or YOUTUBE_H264_FALLBACKS.get((height, 30))

    def youtube_variant_url(self, url, data):
        variant = self.youtube_variant(data)
        if not variant:
            return url, None
        encoded = base64.b64encode(variant.encode('ascii')).decode('ascii')
        return url + '#variant=' + encoded, variant

    def request_headers(self, data):
        headers = {}
        supplied = data.get('headers')
        if isinstance(supplied, dict):
            for raw_name, raw_value in list(supplied.items())[:32]:
                name = str(raw_name).strip()
                value = str(raw_value).replace('\r', '').replace('\n', '')[:4096]
                if value and ALLOWED_SESSION_HEADER.fullmatch(name):
                    headers[name] = value
        headers.setdefault('User-Agent', data.get('userAgent') or 'Mozilla/5.0')
        if data.get('referer'):
            headers['Referer'] = data['referer']
        elif data.get('pageUrl'):
            headers['Referer'] = data['pageUrl']
        if data.get('origin'):
            headers['Origin'] = data['origin']
        if data.get('cookie'):
            headers['Cookie'] = data['cookie']
        headers.pop('Accept-Encoding', None)
        return headers

    def classify_protection(self, kind, body):
        """Retorna (motivo_bloqueio|None, rotulo). AES-128 e liberado; Widevine/PlayReady/FairPlay bloqueiam."""
        text = body.decode('utf-8', errors='ignore')
        lowered = text.lower()
        for scheme, markers in DRM_MARKERS.items():
            if any(marker in lowered for marker in markers):
                label = {'widevine': 'Widevine', 'playready': 'PlayReady', 'fairplay': 'FairPlay'}[scheme]
                return (
                    f'{label} detectado; esse DRM nao pode ser removido pelo Stream2JD. '
                    'Use o botao Gravar aba/WebRTC para registrar a reproducao autorizada no navegador',
                    scheme,
                )
        if kind == 'HLS':
            key_lines = re.findall(r'#EXT-X-(?:SESSION-)?KEY\s*:[^\r\n]*', text, re.I)
            for line in key_lines:
                method = (re.search(r'METHOD\s*=\s*([^,]+)', line, re.I).group(1).strip().strip('"').upper() if 'METHOD' in line.upper() else '')
                keyformat = (re.search(r'KEYFORMAT\s*=\s*"([^"]*)"', line, re.I).group(1).lower() if 'KEYFORMAT' in line.upper() else '')
                if not method or method == 'NONE':
                    continue
                if any(marker in keyformat for markers in DRM_MARKERS.values() for marker in markers):
                    return (
                        'DRM via HLS KEYFORMAT detectado; chaves de protecao nao sao extraidas pelo Stream2JD. Use o gravador de aba',
                        'drm-keyformat',
                    )
                if method in ('AES-128', 'SAMPLE-AES', 'SAMPLE-AES-CTR'):
                    # Chave HTTP visivel: o proxy reescreve a URI da chave para
                    # sessao local e o JDownloader/FFmpeg descriptografa. Liberado.
                    return (None, 'aes128')
                return (
                    f'metodo de protecao HLS {method} detectado; o Stream2JD nao extrai chaves desse esquema. Use o gravador de aba',
                    'hls-key',
                )
        if kind == 'DASH' and '<contentprotection' in lowered:
            return (
                'protecao ContentProtection sem esquema Widevine/PlayReady/FairPlay identificado; '
                'tentativa liberada, mas se o download falhar use o gravador de aba',
                'cenc-generico',
            )
        return (None, 'none')

    def protection_reason(self, kind, body):
        reason, _label = self.classify_protection(kind, body)
        return reason

    def protection_info(self, kind, body):
        _reason, label = self.classify_protection(kind, body)
        return label

    def open_upstream_once(self, url, headers, timeout=UPSTREAM_TIMEOUT):
        _validate_upstream_url(url)
        # Nota: urlopen segue redirects automaticamente; validamos geturl() em fetch_buffered
        # e pré-bloqueamos host privado ANTES do fetch (W3 S-01).
        return urlopen(Request(url, headers=headers), timeout=timeout)

    def open_upstream(self, url, headers, timeout=UPSTREAM_TIMEOUT):
        return self.open_upstream_once(url, headers, timeout=timeout)

    def fetch_with_retry(self, url, headers, timeout=UPSTREAM_TIMEOUT, limit=None, label='upstream'):
        """GET com retry para 520/502/503/timeout. Retorna (resposta_final | None, ultimo_erro)."""
        last_error = None
        for attempt in range(UPSTREAM_RETRIES):
            try:
                response = self.open_upstream_once(url, headers, timeout=timeout)
                return response, None
            except HTTPError as error:
                last_error = error
                if error.code not in RETRYABLE_STATUS:
                    raise
                retry_after = parse_retry_after(error.hdrs)
                if attempt >= UPSTREAM_RETRIES - 1:
                    break
                delay = backoff_delay(attempt, retry_after)
                _log('warn', f'{label} HTTP {error.code}, tentativa {attempt + 1}/{UPSTREAM_RETRIES} em {delay:.1f}s')
                time.sleep(delay)
            except (URLError, TimeoutError, socket.timeout, ConnectionResetError, BrokenPipeError, OSError) as error:
                last_error = error
                if attempt >= UPSTREAM_RETRIES - 1:
                    break
                delay = backoff_delay(attempt)
                _log('warn', f'{label} falhou ({error}), tentativa {attempt + 1}/{UPSTREAM_RETRIES} em {delay:.1f}s')
                time.sleep(delay)
        return None, last_error

    def fetch_buffered(self, url, headers, limit=MAX_MANIFEST_SIZE, timeout=UPSTREAM_TIMEOUT, label='upstream'):
        _validate_upstream_url(url)
        response, error = self.fetch_with_retry(url, headers, timeout=timeout, label=label)
        if response is None:
            if isinstance(error, HTTPError):
                raise error
            raise RuntimeError(f'origem instavel apos {UPSTREAM_RETRIES} tentativas: {error}. Clique Retomar no JDownloader') from error
        with response:
            body = response.read(limit + 1)
            final_url = response.geturl()
            # W2-B S-01 + W3: bloqueia redirect para host privado mesmo se orig era público
            # e também se final host é obfuscado/private
            try:
                if _is_blocked_upstream_url(final_url):
                    # se orig != final e final é privado -> bloqueia
                    orig_host = (urlsplit(url).hostname or '').lower()
                    final_host = (urlsplit(final_url).hostname or '').lower()
                    if final_host and final_host != orig_host:
                        raise RuntimeError('redirect para host privado bloqueado')
                    # mesmo sem divergência aparente (ex: obfuscado com mesmo IP), mantém bloqueio
                    if _is_blocked_upstream_url(final_url):
                        raise RuntimeError('redirect para host privado bloqueado')
            except RuntimeError:
                raise
            except Exception:
                pass
            info = {
                'status': response.status,
                'contentType': response.headers.get('Content-Type') or '',
                'contentLength': response.headers.get('Content-Length'),
                'contentRange': response.headers.get('Content-Range'),
                'acceptRanges': response.headers.get('Accept-Ranges'),
                'etag': response.headers.get('ETag'),
                'lastModified': response.headers.get('Last-Modified'),
                'finalUrl': final_url,
                'headers': response.headers,
            }
        if len(body) > limit:
            raise RuntimeError('manifesto excede o limite local de 8 MB')
        return body, info

    def probe(self, data):
        headers = self.request_headers(data)
        kind = str(data.get('kind', '')).upper()
        read_limit = MAX_MANIFEST_SIZE if kind in ('HLS', 'DASH') else 64 * 1024
        probe_headers = dict(headers)
        if kind not in ('HLS', 'DASH'):
            probe_headers.setdefault('Range', 'bytes=0-65535')
        try:
            body, info = self.fetch_buffered(data['url'], probe_headers, limit=read_limit, label='probe')
            final_url = info['finalUrl']
            content_type = (info['contentType'] or '').lower()
            content_length = info['contentLength']
            content_range = info['contentRange'] or ''
        except HTTPError as error:
            if kind in ('HLS', 'DASH') or error.code not in (400, 405, 416):
                raise
            body, info = self.fetch_buffered(data['url'], headers, limit=read_limit, label='probe-fallback')
            final_url = info['finalUrl']
            content_type = (info['contentType'] or '').lower()
            content_length = info['contentLength']
            content_range = info['contentRange'] or ''
        range_total = re.search(r'/([0-9]+)$', content_range)
        if len(body) > read_limit:
            body = body[:65536]
        sample = body.lstrip()
        sample_head = sample.lower()[:2048]
        is_html_ct = 'text/html' in content_type or 'application/xhtml' in content_type or 'text/html' in sample_head.decode('utf-8', errors='ignore')[:500].lower()
        is_html_body = sample_head.startswith((b'<!doctype', b'<html', b'<head', b'<title')) or b'<html' in sample_head[:1024] or b'<head' in sample_head[:1024]
        if is_html_ct or is_html_body:
            raise RuntimeError('o endereço detectado respondeu com uma página HTML, não com um vídeo')
        # Player progressivo sem extensão pode responder
        # application/octet-stream. Aceite-o somente se o início for de um
        # contêiner de mídia conhecido; isso permite capturar URLs opacas sem
        # voltar a enviar páginas ou APIs binárias ao JDownloader.
        if kind not in ('HLS', 'DASH') and ('application/octet-stream' in content_type or not content_type):
            is_media_binary = (
                sample.startswith((b'id3', b'oggS'.lower(), b'riff'))
                or sample[4:8] == b'ftyp'
                or sample.startswith(b'\x1a\x45\xdf\xa3')
                or (len(sample) >= 2 and sample[0] == 0xff and sample[1] & 0xe0 == 0xe0)
            )
            if not is_media_binary:
                raise RuntimeError('a origem opaca não confirmou um contêiner de mídia baixável')
        if kind == 'HLS' and b'#extm3u' not in sample and 'mpegurl' not in content_type:
            raise RuntimeError('o endereço detectado não contém um manifesto HLS válido')
        if kind == 'DASH' and b'<mpd' not in sample and 'dash+xml' not in content_type:
            raise RuntimeError('o endereço detectado não contém um manifesto DASH válido')
        reason = self.protection_reason(kind, body)
        if reason:
            raise RuntimeError(reason)
        return final_url, headers, {
            'contentType': content_type,
            'contentLength': int(range_total.group(1)) if range_total else int(content_length) if content_length and content_length.isdigit() else None,
        }

    def inspect(self, data):
        kind = str(data.get('kind', '')).upper()
        final_url, headers, metadata = self.probe(data)
        if kind not in ('HLS', 'DASH'):
            public_kind = {'MP4': 'MP4', 'WEBM': 'WebM', 'AUDIO': 'Audio'}.get(kind, 'Media')
            content_type = metadata.get('contentType') or ''
            return {'variants': [{
                'url': final_url,
                'kind': public_kind,
                'contentType': content_type,
                'contentLength': metadata.get('contentLength'),
                'container': (content_type.split('/', 1)[1].split(';', 1)[0].upper()
                              if public_kind == 'Audio' and '/' in content_type
                              else public_kind.upper() if public_kind != 'Media' else None),
                'videoOnly': False,
            }], 'master': False}
        body, info = self.fetch_buffered(final_url, headers, limit=MAX_MANIFEST_SIZE, label='inspect-manifest')
        final_url = info['finalUrl']
        reason = self.protection_reason(kind, body)
        if reason:
            raise RuntimeError(reason)
        variants = self.inspect_hls(final_url, body) if kind == 'HLS' else self.inspect_dash(final_url, body)
        # Uma playlist HLS de mídia (sem master) é plenamente baixável. Exiba
        # uma opção única em vez de descartá-la por não haver STREAM-INF.
        if kind == 'HLS' and not variants and b'#EXTM3U' in body[:65536].upper():
            variants = [{
                'url': final_url,
                'kind': 'HLS',
                'quality': 'Automática',
                'container': 'HLS',
                'videoOnly': False,
                'masterUrl': final_url,
            }]
        variants.sort(key=lambda item: (item.get('height') or 10**9, item.get('fps') or 0, item.get('bitrate') or 0))
        result = {'variants': variants[:40], 'master': bool(variants)}
        try:
            result['protection'] = self.protection_info(kind, body)
        except Exception:
            pass
        return result

    def inspect_hls(self, source_url, body):
        text = body.decode('utf-8-sig', errors='replace')
        has_audio_group = '#EXT-X-MEDIA:TYPE=AUDIO' in text.upper()
        lines = text.splitlines()
        variants = []
        for index, line in enumerate(lines):
            if not line.upper().startswith('#EXT-X-STREAM-INF:'):
                continue
            raw = line.split(':', 1)[1]
            attributes = {
                match.group(1).upper(): match.group(2).strip('"')
                for match in re.finditer(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)', raw, re.I)
            }
            uri = None
            for following in lines[index + 1:]:
                following = following.strip()
                if following and not following.startswith('#'):
                    uri = following
                    break
            if not uri:
                continue
            resolution = re.match(r'(\d+)x(\d+)', attributes.get('RESOLUTION', ''), re.I)
            width = int(resolution.group(1)) if resolution else None
            height = int(resolution.group(2)) if resolution else None
            if not height:
                label_match = re.search(r'(144|240|270|360|480|540|720|1080|1440|2160|3072|4320)p?', attributes.get('NAME', '') + ' ' + attributes.get('VIDEO', ''), re.I)
                height = int(label_match.group(1)) if label_match else None
            fps = float(attributes['FRAME-RATE']) if attributes.get('FRAME-RATE', '').replace('.', '', 1).isdigit() else None
            bandwidth = attributes.get('AVERAGE-BANDWIDTH') or attributes.get('BANDWIDTH')
            bitrate = int(bandwidth) if bandwidth and bandwidth.isdigit() else None
            variant_url = urljoin(source_url, uri)
            variants.append({
                'url': source_url,
                'kind': 'HLS',
                'width': width,
                'height': height,
                'fps': fps,
                'bitrate': bitrate,
                'quality': f'{height}p{round(fps) if fps and fps >= 50 else ""}' if height else attributes.get('NAME') or 'Automática',
                'container': 'HLS',
                'videoOnly': not has_audio_group,
                'variantId': variant_url,
                'masterUrl': source_url,
            })
        return variants

    def inspect_dash(self, source_url, body):
        root = ET.fromstring(body)
        variants = []
        for adaptation in root.iter():
            if adaptation.tag.rsplit('}', 1)[-1] != 'AdaptationSet':
                continue
            adaptation_type = (adaptation.get('contentType') or adaptation.get('mimeType') or '').lower()
            for representation in adaptation.iter():
                if representation.tag.rsplit('}', 1)[-1] != 'Representation':
                    continue
                mime_type = (representation.get('mimeType') or adaptation.get('mimeType') or '').lower()
                if adaptation_type.startswith('audio') or mime_type.startswith('audio'):
                    continue
                height = int(representation.get('height') or adaptation.get('height') or 0) or None
                width = int(representation.get('width') or adaptation.get('width') or 0) or None
                bandwidth = int(representation.get('bandwidth') or 0) or None
                frame_rate = representation.get('frameRate') or adaptation.get('frameRate') or ''
                try:
                    numerator, separator, denominator = frame_rate.partition('/')
                    fps = float(numerator) / float(denominator) if separator else float(frame_rate)
                except (TypeError, ValueError, ZeroDivisionError):
                    fps = None
                variant_id = representation.get('id')
                variants.append({
                    'url': source_url,
                    'kind': 'DASH',
                    'width': width,
                    'height': height,
                    'fps': fps,
                    'bitrate': bandwidth,
                    'quality': f'{height}p{round(fps) if fps and fps >= 50 else ""}' if height else variant_id or 'Vídeo',
                    'container': (mime_type.split('/', 1)[1].upper() if '/' in mime_type else 'DASH'),
                    'videoOnly': True,
                    'variantId': variant_id,
                    'masterUrl': source_url,
                })
        return variants

    def cleanup_sessions(self):
        cutoff = time.time() - SESSION_LIFETIME
        changed = False
        with self.sessions_lock:
            expired = [
                key
                for key, value in self.sessions.items()
                if value.get('lastAccess', value['created']) < cutoff
            ]
            for session_id in expired:
                self.sessions.pop(session_id, None)
                changed = True
        if changed:
            self.save_sessions()

    def create_proxy(self, url, headers, kind, variant_id=None):
        # W3 S-01: valida b64url decoded_url ANTES de criar sessão
        _validate_upstream_url(url)
        # escopa source_host para S-07
        try:
            source_host = _extract_host(url) or _extract_host(headers.get('Referer') or headers.get('Origin') or '')
        except Exception:
            source_host = _extract_host(url)
        # guarda source_host junto aos headers
        self.cleanup_sessions()
        session_id = secrets.token_urlsafe(24)
        now = time.time()
        with self.sessions_lock:
            self.sessions[session_id] = {
                'created': now,
                'lastAccess': now,
                'headers': headers,
                'kind': str(kind).upper(),
                'variantId': variant_id,
                'upstreamLock': threading.Lock(),
                'streamLock': threading.Semaphore(6),
                'lastUpstreamAt': 0.0,
                'source_host': source_host,
            }
        self.save_sessions()
        # O JDownloader identifica URLs .mpd como download direto e salva o
        # manifesto XML com extensao .mp4. Para DASH, exponha um manifesto HLS
        # local equivalente; segmentos, cabecalhos e cookies continuam passando
        # pela mesma sessao protegida da ponte.
        if str(kind).upper() == 'DASH':
            return self.dash_hls_url(session_id, url, 'master')
        return self.proxy_url(session_id, url, kind)

    def proxy_hint(self, url, kind=None):
        if str(kind).upper() == 'HLS':
            return 'master.m3u8'
        if str(kind).upper() == 'DASH':
            return 'manifest.mpd'
        filename = unquote(urlsplit(url).path.rsplit('/', 1)[-1])
        extension = re.search(r'\.([a-z0-9]{1,8})$', filename, re.I)
        return f'resource.{extension.group(1).lower()}' if extension else 'resource.bin'

    def proxy_url(self, session_id, url, kind=None):
        hint = self.proxy_hint(url, kind)
        return f'http://127.0.0.1:{self.port}/proxy/{session_id}/{encoded_url(url)}/{hint}'

    def dash_base_url(self, session_id, url):
        return f'http://127.0.0.1:{self.port}/dash/{session_id}/{encoded_url(url)}/'

    def dash_hls_url(self, session_id, url, playlist, representation_id=None):
        """URL local de um manifesto HLS gerado a partir de um MPD DASH."""
        suffix = playlist
        if representation_id is not None:
            suffix += '-' + encoded_url(str(representation_id))
        return f'http://127.0.0.1:{self.port}/dashhls/{session_id}/{encoded_url(url)}/{suffix}.m3u8'

    @staticmethod
    def dash_name(node):
        return node.tag.rsplit('}', 1)[-1] if node is not None else ''

    def dash_child(self, node, name):
        if node is None:
            return None
        return next((child for child in list(node) if self.dash_name(child) == name), None)

    def dash_duration_seconds(self, value):
        """Converte a parte comum de uma duracao ISO-8601 de um MPD para segundos."""
        if not value:
            return None
        match = re.fullmatch(
            r'P(?:(?P<days>\d+(?:\.\d+)?)D)?(?:T(?:(?P<hours>\d+(?:\.\d+)?)H)?(?:(?P<minutes>\d+(?:\.\d+)?)M)?(?:(?P<seconds>\d+(?:\.\d+)?)S)?)?',
            str(value), re.I)
        if not match:
            return None
        values = match.groupdict(default='0')
        try:
            return (float(values['days']) * 86400 + float(values['hours']) * 3600
                    + float(values['minutes']) * 60 + float(values['seconds']))
        except ValueError:
            return None

    def dash_template_value(self, template, representation, number, timestamp):
        """Expande os identificadores SegmentTemplate usados por MPEG-DASH."""
        values = {
            'RepresentationID': str(representation.get('id') or ''),
            'Bandwidth': str(representation.get('bandwidth') or ''),
            'Number': str(number),
            'Time': str(timestamp),
        }

        def replace(match):
            key, width = match.group(1), match.group(2)
            value = values.get(key, '')
            if width and key in ('Number', 'Time'):
                try:
                    return f'{int(value):0{int(width)}d}'
                except (TypeError, ValueError):
                    return value
            return value

        # $$ e um cifrao literal no SegmentTemplate.
        placeholder = '\0DOLLAR\0'
        text = str(template or '').replace('$$', placeholder)
        text = re.sub(r'\$(RepresentationID|Bandwidth|Number|Time)(?:%0?(\d+)d)?\$', replace, text)
        return text.replace(placeholder, '$')

    def dash_streams(self, source_url, body):
        """Extrai representacoes SegmentTemplate suficientes para HLS VOD.

        Esta ponte deliberadamente nao tenta burlar DRM: manifests protegidos
        continuam sendo rejeitados pelo classificador antes de gerar playlists.
        """
        reason = self.protection_reason('DASH', body)
        if reason and self.classify_protection('DASH', body)[1] in ('widevine', 'playready', 'fairplay', 'drm-keyformat'):
            raise RuntimeError(reason)
        try:
            root = ET.fromstring(body)
        except ET.ParseError as error:
            raise RuntimeError(f'manifesto DASH invalido: {error}') from error
        period = next((node for node in root.iter() if self.dash_name(node) == 'Period'), None)
        if period is None:
            raise RuntimeError('manifesto DASH sem Periodo')
        period_duration = self.dash_duration_seconds(period.get('duration')) or self.dash_duration_seconds(root.get('mediaPresentationDuration'))
        streams = []
        for adaptation in (node for node in period.iter() if self.dash_name(node) == 'AdaptationSet'):
            adaptation_type = (adaptation.get('contentType') or adaptation.get('mimeType') or '').lower()
            for representation in (node for node in adaptation.iter() if self.dash_name(node) == 'Representation'):
                mime_type = (representation.get('mimeType') or adaptation.get('mimeType') or '').lower()
                stream_type = 'audio' if adaptation_type.startswith('audio') or mime_type.startswith('audio') else 'video'
                if stream_type == 'video' and not (adaptation_type.startswith('video') or mime_type.startswith('video')):
                    continue
                template_attrs = {}
                timeline = None
                base_url = source_url
                for node in (root, period, adaptation, representation):
                    base = self.dash_child(node, 'BaseURL')
                    if base is not None and base.text and base.text.strip():
                        base_url = urljoin(base_url, base.text.strip())
                    template = self.dash_child(node, 'SegmentTemplate')
                    if template is not None:
                        template_attrs.update(template.attrib)
                        candidate_timeline = self.dash_child(template, 'SegmentTimeline')
                        if candidate_timeline is not None:
                            timeline = candidate_timeline
                if not template_attrs.get('media') or not template_attrs.get('initialization'):
                    continue
                try:
                    timescale = int(template_attrs.get('timescale') or 1)
                    start_number = int(template_attrs.get('startNumber') or 1)
                except ValueError:
                    continue
                if timescale <= 0:
                    continue
                streams.append({
                    'id': str(representation.get('id') or ''),
                    'representation': representation,
                    'type': stream_type,
                    'mimeType': mime_type or adaptation_type,
                    'codecs': representation.get('codecs') or adaptation.get('codecs') or '',
                    'bandwidth': int(representation.get('bandwidth') or 0) or 1,
                    'width': int(representation.get('width') or adaptation.get('width') or 0) or None,
                    'height': int(representation.get('height') or adaptation.get('height') or 0) or None,
                    'template': template_attrs,
                    'timeline': timeline,
                    'timescale': timescale,
                    'startNumber': start_number,
                    'baseUrl': base_url,
                    'periodDuration': period_duration,
                })
        if not streams:
            raise RuntimeError('manifesto DASH sem representacao SegmentTemplate de audio ou video')
        return streams

    def dash_segments(self, stream):
        """Retorna (numero, tempo, duracao_em_segundos) sem adivinhar segmentos."""
        timescale = stream['timescale']
        number = stream['startNumber']
        timeline = stream['timeline']
        result = []
        if timeline is not None:
            entries = [node for node in list(timeline) if self.dash_name(node) == 'S']
            current = None
            for index, entry in enumerate(entries):
                try:
                    duration = int(entry.get('d') or 0)
                    start = int(entry.get('t')) if entry.get('t') is not None else (current if current is not None else 0)
                    repeat = int(entry.get('r') or 0)
                except ValueError as error:
                    raise RuntimeError('SegmentTimeline DASH invalida') from error
                if duration <= 0 or repeat < -1:
                    raise RuntimeError('SegmentTimeline DASH invalida')
                if repeat == -1:
                    next_start = None
                    for following in entries[index + 1:]:
                        if following.get('t') is not None:
                            try:
                                next_start = int(following.get('t'))
                            except ValueError:
                                pass
                            break
                    if next_start is None and stream['periodDuration'] is not None:
                        next_start = int(_ceil(stream['periodDuration'] * timescale))
                    if next_start is None or next_start <= start:
                        raise RuntimeError('SegmentTimeline DASH com repeticao indefinida sem duracao')
                    repeat = max(0, int(_ceil((next_start - start) / duration)) - 1)
                for offset in range(repeat + 1):
                    result.append((number, start + offset * duration, duration / timescale))
                    if len(result) > 10000:
                        raise RuntimeError('manifesto DASH possui segmentos demais para a ponte local')
                    number += 1
                current = start + (repeat + 1) * duration
            return result
        try:
            duration = int(stream['template'].get('duration') or 0)
        except ValueError as error:
            raise RuntimeError('SegmentTemplate DASH sem duracao valida') from error
        if duration <= 0 or stream['periodDuration'] is None:
            raise RuntimeError('SegmentTemplate DASH sem SegmentTimeline ou duracao do Periodo')
        count = int(_ceil(stream['periodDuration'] * timescale / duration))
        if not 0 < count <= 10000:
            raise RuntimeError('manifesto DASH possui quantidade de segmentos invalida')
        return [(number + index, index * duration, duration / timescale) for index in range(count)]

    def dash_hls_playlist(self, session_id, source_url, body, playlist, representation_id=None):
        streams = self.dash_streams(source_url, body)
        videos = [stream for stream in streams if stream['type'] == 'video']
        audios = [stream for stream in streams if stream['type'] == 'audio']
        with self.sessions_lock:
            selected_variant = (self.sessions.get(session_id) or {}).get('variantId')
        if playlist == 'master':
            if selected_variant:
                videos = [stream for stream in videos if stream['id'] == str(selected_variant)]
                if not videos:
                    raise RuntimeError('a qualidade DASH escolhida nao existe mais no manifesto')
            if not videos and not audios:
                raise RuntimeError('manifesto DASH nao oferece audio ou video reproduzivel')
            # Um audio de maior bitrate e suficiente para cada representacao de
            # video; a escolha de video continua sendo feita pelo popup.
            audio = max(audios, key=lambda stream: stream['bandwidth'], default=None)
            lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS']
            if audio and videos:
                audio_uri = self.dash_hls_url(session_id, source_url, 'audio', audio['id'])
                audio_name = (audio['codecs'] or audio['mimeType'] or 'audio').replace('"', '')
                lines.append(f'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="{audio_name}",DEFAULT=YES,AUTOSELECT=YES,URI="{audio_uri}"')
            if videos:
                for stream in videos:
                    attributes = [f'BANDWIDTH={stream["bandwidth"]}']
                    if stream['width'] and stream['height']:
                        attributes.append(f'RESOLUTION={stream["width"]}x{stream["height"]}')
                    codecs = [stream['codecs']]
                    if audio and audio['codecs']:
                        codecs.append(audio['codecs'])
                    codecs = [codec for codec in codecs if codec]
                    if codecs:
                        attributes.append('CODECS="' + ','.join(codecs).replace('"', '') + '"')
                    if audio:
                        attributes.append('AUDIO="audio"')
                    lines.append('#EXT-X-STREAM-INF:' + ','.join(attributes))
                    lines.append(self.dash_hls_url(session_id, source_url, 'video', stream['id']))
            else:
                # DASH apenas de audio: GenericM3u8 consegue abrir a playlist
                # de midia diretamente, sem inventar uma faixa de video.
                lines.append(self.dash_hls_url(session_id, source_url, 'audio', audio['id']))
            return ('\n'.join(lines) + '\n').encode('utf-8')

        stream_type = 'audio' if playlist == 'audio' else 'video'
        stream = next((item for item in streams if item['type'] == stream_type and item['id'] == str(representation_id or '')), None)
        if stream is None:
            raise RuntimeError('representacao DASH solicitada nao existe mais no manifesto')
        initialization = self.dash_template_value(stream['template']['initialization'], stream['representation'], stream['startNumber'], 0)
        init_url = self.proxy_url(session_id, urljoin(stream['baseUrl'], initialization))
        segments = self.dash_segments(stream)
        target_duration = max(1, int(_ceil(max(segment[2] for segment in segments))))
        lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-PLAYLIST-TYPE:VOD', f'#EXT-X-TARGETDURATION:{target_duration}', f'#EXT-X-MAP:URI="{init_url}"']
        for number, timestamp, duration in segments:
            media = self.dash_template_value(stream['template']['media'], stream['representation'], number, timestamp)
            lines.append(f'#EXTINF:{duration:.6f},')
            lines.append(self.proxy_url(session_id, urljoin(stream['baseUrl'], media)))
        lines.append('#EXT-X-ENDLIST')
        return ('\n'.join(lines) + '\n').encode('utf-8')

    def dash_hls_request(self, handler, session_id, source_url, playlist, representation_id=None, head_only=False):
        # W3 S-01: valida source_url decodificado antes de fetch
        try:
            _validate_upstream_url(source_url)
        except RuntimeError as e:
            try:
                handler.send_error(403, str(e))
            except Exception:
                pass
            return
        with self.sessions_lock:
            session = self.sessions.get(session_id)
            if session:
                session['lastAccess'] = time.time()
        if not session:
            handler.send_error(410, 'sessão de mídia expirada')
            return
        if str(session.get('kind') or '').upper() != 'DASH':
            handler.send_error(400, 'sessão não é DASH')
            return
        # W3 S-07: filtra headers por target
        hdrs_raw = dict(session['headers'])
        src_host = str(session.get('source_host') or _extract_host(hdrs_raw.get('Referer') or hdrs_raw.get('Origin') or '') or '')
        hdrs = _filter_headers_for_target(hdrs_raw, src_host, source_url)
        body, info = self.fetch_buffered(source_url, hdrs, limit=MAX_MANIFEST_SIZE, label='dash-hls')
        self.mark_upstream(session)
        if b'<MPD' not in body[:65536].upper():
            raise RuntimeError('a origem DASH não respondeu com um manifesto MPD válido')
        output = self.dash_hls_playlist(session_id, info['finalUrl'], body, playlist, representation_id)
        handler.send_response(200)
        handler.send_header('Content-Type', 'application/vnd.apple.mpegurl')
        handler.send_header('Content-Length', str(len(output)))
        handler.end_headers()
        if not head_only:
            handler.wfile.write(output)

    def rewrite_hls(self, session_id, source_url, body):
        """Reescreve manifesto HLS substituindo URLs pelo proxy local.

        Tenta delegar para stream2jd_hls.HLSRewriter (DRY). Fallback inline
        garante contrato single-file quando o módulo auxiliar não está presente.
        """
        reason = self.protection_reason('HLS', body)
        if reason:
            raise RuntimeError(reason)
        _Rewriter = None
        try:
            from helper.stream2jd_hls import HLSRewriter as _Rewriter  # type: ignore
        except ImportError:
            try:
                from stream2jd_hls import HLSRewriter as _Rewriter  # type: ignore
            except ImportError:
                _Rewriter = None
        if _Rewriter is not None:
            try:
                rewriter = _Rewriter(session_id, source_url, self.proxy_url)
                return rewriter.rewrite(body)
            except Exception as error:
                _log('warn', f'HLSRewriter falhou, fallback inline ({error})')
        # --- fallback inline: espelha HLSRewriter.rewrite sem dependência externa ---
        import urllib.parse as _urlparse
        text = body.decode('utf-8-sig', errors='replace')
        is_master = any(line.upper().startswith('#EXT-X-STREAM-INF:') for line in text.splitlines())
        lines = text.splitlines()
        output: list[str] = []
        for line in lines:
            stripped = line.strip()
            if stripped and not stripped.startswith('#'):
                leading = line[:len(line) - len(line.lstrip())]
                output.append(leading + self.proxy_url(session_id, _urlparse.urljoin(source_url, stripped), 'HLS' if is_master else None))
            else:
                def _replace_uri(m: re.Match) -> str:
                    quote, value = m.group(1), m.group(2)
                    if value.startswith('data:'):
                        return f'URI={quote}{value}{quote}'
                    tag = m.string.upper()
                    nested = '#EXT-X-MEDIA:' in tag or '#EXT-X-I-FRAME-STREAM-INF:' in tag
                    return f'URI={quote}' + self.proxy_url(session_id, _urlparse.urljoin(source_url, value), 'HLS' if nested else None) + quote
                output.append(re.sub(r"URI\s*=\s*([\"'])(.*?)(?:\1)", _replace_uri, line, flags=re.I))
        return ('\n'.join(output) + '\n').encode('utf-8')

    def rewrite_dash(self, session_id, source_url, body):
        reason = self.protection_reason('DASH', body)
        if reason and self.classify_protection('DASH', body)[1] in ('widevine', 'playready', 'fairplay', 'drm-keyformat'):
            raise RuntimeError(reason)
        try:
            root = ET.fromstring(body)
        except ET.ParseError as error:
            raise RuntimeError(f'manifesto DASH invalido: {error}') from error
        with self.sessions_lock:
            selected_variant = (self.sessions.get(session_id) or {}).get('variantId')
        if selected_variant:
            for adaptation in root.iter():
                if adaptation.tag.rsplit('}', 1)[-1] != 'AdaptationSet':
                    continue
                adaptation_type = (adaptation.get('contentType') or adaptation.get('mimeType') or '').lower()
                if adaptation_type.startswith('audio'):
                    continue
                for child in list(adaptation):
                    if child.tag.rsplit('}', 1)[-1] == 'Representation' and child.get('id') != selected_variant:
                        adaptation.remove(child)
        base_nodes = [node for node in root.iter() if node.tag.rsplit('}', 1)[-1] == 'BaseURL']
        if base_nodes:
            for node in base_nodes:
                if node.text and node.text.strip():
                    node.text = self.dash_base_url(session_id, urljoin(source_url, node.text.strip()))
        else:
            namespace = root.tag.split('}')[0].strip('{') if '}' in root.tag else ''
            tag = f'{{{namespace}}}BaseURL' if namespace else 'BaseURL'
            node = ET.Element(tag)
            node.text = self.dash_base_url(session_id, urljoin(source_url, '.'))
            root.insert(0, node)
        # Corrige URLs relativas (SegmentTemplate media/initialization, SegmentURL,
        # Location). Antes somente URLs absolutas eram reescritas, o que deixava
        # segmentos relativos apontando para o CDN sem sessao e gerava 403/520
        # no meio do download. Agora todo http(s) resolvido passa pelo proxy.
        uri_attributes = {'media', 'initialization', 'sourceurl', 'href'}
        for node in root.iter():
            for attribute, value in list(node.attrib.items()):
                local_name = attribute.rsplit('}', 1)[-1].lower()
                if local_name not in uri_attributes or not value.strip():
                    continue
                resolved = urljoin(source_url, value.strip())
                if not resolved.startswith(('http://', 'https://')):
                    continue
                base, separator, remainder = resolved.rpartition('/')
                if separator:
                    node.attrib[attribute] = self.dash_base_url(session_id, base + '/') + remainder
        return ET.tostring(root, encoding='utf-8', xml_declaration=True)

    def throttle_segment(self, session):
        """Espaca requisicoes de segmento para nao disparar rate-limit do CDN."""
        try:
            with self.sessions_lock:
                last = float(session.get('lastUpstreamAt') or 0.0)
            now = time.time()
            wait = SEGMENT_REQUEST_COOLDOWN - (now - last)
            if wait > 0:
                time.sleep(wait)
        except Exception as error:
            _log('warn', f'throttle_segment ignorado ({error})')

    def mark_upstream(self, session):
        try:
            with self.sessions_lock:
                session['lastUpstreamAt'] = time.time()
                session['lastAccess'] = time.time()
        except Exception as error:
            _log('warn', f'mark_upstream ignorado ({error})')

    def coerce_segment_content_type(self, session_kind, upstream_type, route_hint, upstream_url):
        value = (upstream_type or '').lower()
        kind = str(session_kind or '').upper()
        # Alguns CDNs ofuscam segmentos HLS com extensao .webp/.bin mas servem
        # video real. Se o upstream disser image/* para uma sessao HLS/DASH, o
        # JDownloader falha no demux. Forca o tipo esperado nesses casos.
        if kind == 'HLS' and value.startswith('image/'):
            return 'video/MP2T'
        if kind == 'DASH' and value.startswith('image/'):
            return 'video/mp4'
        return upstream_type or 'application/octet-stream'

    def proxy_request(self, handler, session_id, upstream_url, route_hint='', head_only=False):
        # W3 S-01: bloqueia upstream privado ANTES de abrir sessão
        try:
            _validate_upstream_url(upstream_url)
        except RuntimeError as e:
            try:
                handler.send_error(403, str(e))
            except Exception:
                pass
            return
        with self.sessions_lock:
            session = self.sessions.get(session_id)
            if session:
                session['lastAccess'] = time.time()
                if 'streamLock' not in session or not hasattr(session.get('streamLock'), 'acquire'):
                    session['streamLock'] = threading.Semaphore(6)
                if 'lastUpstreamAt' not in session:
                    session['lastUpstreamAt'] = 0.0
        if not session:
            handler.send_error(410, 'sessão de mídia expirada')
            return
        # W3 S-07: escopa headers sensíveis por source_host (só reenvia se same-site)
        headers_raw = dict(session['headers'])
        source_host = str(session.get('source_host') or _extract_host(headers_raw.get('Referer') or headers_raw.get('Origin') or '') or '')
        # fallback: extrai de primeira URL conhecida do proxy se session antiga não tinha source_host
        if not source_host:
            # tenta inferir de qualquer header origin/referer já filtrado
            pass
        headers = _filter_headers_for_target(headers_raw, source_host, upstream_url)
        if handler.headers.get('Range'):
            headers['Range'] = handler.headers['Range']
        session_kind = session.get('kind')
        is_download = session_kind == 'DOWNLOAD'
        upstream_lock = session.get('upstreamLock') if is_download else None
        stream_lock = session.get('streamLock') if not is_download else None
        headers_sent = False
        if upstream_lock:
            upstream_lock.acquire()
        stream_acquired = False
        if stream_lock:
            self.throttle_segment(session)
            stream_lock.acquire()
            stream_acquired = True
        try:
            clean_url = upstream_url.lower().split('?', 1)[0]
            hint = (route_hint or '').lower()
            guess_manifest = clean_url.endswith(('.m3u8', '.mpd')) or hint.endswith(('.m3u8', '.mpd'))
            # Manifestos e segmentos pequenos: baixa com retry ANTES de responder,
            # para nunca entregar arquivo truncado ao JDownloader. Manifestos
            # continuam limitados a 8 MiB, mas segmentos de video podem ser bem
            # maiores (o limite dedicado era declarado, porem nao era usado).
            if guess_manifest or not is_download:
                try:
                    buffer_limit = MAX_MANIFEST_SIZE if guess_manifest else SEGMENT_BUFFER_LIMIT
                    buffer_label = 'proxy-manifest' if guess_manifest else 'proxy-segment'
                    body, info = self.fetch_buffered(
                        upstream_url, headers, limit=buffer_limit, timeout=UPSTREAM_TIMEOUT, label=buffer_label)
                    self.mark_upstream(session)
                except HTTPError as error:
                    if not headers_sent:
                        try:
                            handler.send_error(error.code if error.code in RETRYABLE_STATUS else 502,
                                               f'{error.code} na origem apos {UPSTREAM_RETRIES} tentativas. Clique Retomar no JDownloader')
                        except (BrokenPipeError, ConnectionResetError):
                            pass
                    return
                except Exception as error:
                    if not headers_sent:
                        try:
                            handler.send_error(502, f'{error}. Clique Retomar no JDownloader')
                        except (BrokenPipeError, ConnectionResetError):
                            pass
                    return
                content_type = (info['contentType'] or '').lower()
                manifest = 'mpegurl' in content_type or 'dash+xml' in content_type or clean_url.endswith(('.m3u8', '.mpd')) or hint.endswith(('.m3u8', '.mpd'))
                if head_only:
                    if (clean_url.endswith('.m3u8') or hint.endswith('.m3u8')) and 'mpegurl' not in content_type:
                        content_type = 'application/vnd.apple.mpegurl'
                    elif (clean_url.endswith('.mpd') or hint.endswith('.mpd')) and 'dash+xml' not in content_type:
                        content_type = 'application/dash+xml'
                    else:
                        content_type = self.coerce_segment_content_type(session_kind, info['contentType'], route_hint, upstream_url)
                    handler.send_response(200)
                    if info.get('contentLength'):
                        handler.send_header('Content-Length', str(info['contentLength']))
                    for name in ('Accept-Ranges', 'ETag', 'Last-Modified'):
                        value = info.get(name.lower().replace('-', '') if name == 'Accept-Ranges' else name)
                        raw = info['headers'].get(name) if info.get('headers') is not None else None
                        if raw:
                            handler.send_header(name, raw)
                    handler.send_header('Content-Type', content_type or 'application/octet-stream')
                    handler.end_headers()
                    return
                if manifest:
                    try:
                        if b'#EXTM3U' in body[:65536].upper():
                            body = self.rewrite_hls(session_id, info['finalUrl'], body)
                            content_type = 'application/vnd.apple.mpegurl'
                        elif b'<MPD' in body[:65536].upper():
                            body = self.rewrite_dash(session_id, info['finalUrl'], body)
                            content_type = 'application/dash+xml'
                    except Exception as error:
                        try:
                            handler.send_error(400, str(error))
                        except (BrokenPipeError, ConnectionResetError):
                            pass
                        return
                    handler.send_response(info.get('status') or 200)
                    handler.send_header('Content-Type', content_type or 'application/octet-stream')
                    handler.send_header('X-Origin-URL', upstream_url)
                    handler.send_header('Content-Length', str(len(body)))
                    handler.end_headers()
                    headers_sent = True
                    handler.wfile.write(body)
                    return
                # Segmento bufferizado: coercao de tipo para .webp ofuscado etc.
                out_type = self.coerce_segment_content_type(session_kind, info['contentType'], route_hint, upstream_url)
                handler.send_response(info.get('status') or 200)
                handler.send_header('Content-Type', out_type)
                handler.send_header('Content-Length', str(len(body)))
                for name in ('Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified'):
                    raw = info['headers'].get(name) if info.get('headers') is not None else None
                    if raw:
                        handler.send_header(name, raw)
                handler.end_headers()
                headers_sent = True
                handler.wfile.write(body)
                return
            # Arquivo progressivo grande: streaming com retry na conexao inicial.
            response, error = self.fetch_with_retry(upstream_url, headers, timeout=UPSTREAM_TIMEOUT, label='proxy-download')
            if response is None:
                if not headers_sent:
                    try:
                        if isinstance(error, HTTPError):
                            handler.send_error(error.code, f'{error.reason}. Clique Retomar no JDownloader')
                        else:
                            handler.send_error(502, f'{error}. Clique Retomar no JDownloader')
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                return
            self.mark_upstream(session)
            with response:
                content_type = (response.headers.get('Content-Type') or '').lower()
                clean_url2 = upstream_url.lower().split('?', 1)[0]
                hint2 = (route_hint or '').lower()
                manifest2 = 'mpegurl' in content_type or 'dash+xml' in content_type or clean_url2.endswith(('.m3u8', '.mpd')) or hint2.endswith(('.m3u8', '.mpd'))
                if head_only:
                    if (clean_url2.endswith('.m3u8') or hint2.endswith('.m3u8')) and 'mpegurl' not in content_type:
                        content_type = 'application/vnd.apple.mpegurl'
                    elif (clean_url2.endswith('.mpd') or hint2.endswith('.mpd')) and 'dash+xml' not in content_type:
                        content_type = 'application/dash+xml'
                    handler.send_response(response.status)
                    for name in ('Content-Length', 'Accept-Ranges', 'ETag', 'Last-Modified'):
                        value = response.headers.get(name)
                        if value:
                            handler.send_header(name, value)
                    handler.send_header('Content-Type', content_type or 'application/octet-stream')
                    handler.end_headers()
                    headers_sent = True
                    return
                if manifest2:
                    body = response.read(MAX_MANIFEST_SIZE + 1)
                    if len(body) > MAX_MANIFEST_SIZE:
                        raise RuntimeError('manifesto excede o limite local de 8 MB')
                    if b'#EXTM3U' in body[:65536].upper():
                        body = self.rewrite_hls(session_id, response.geturl(), body)
                        content_type = 'application/vnd.apple.mpegurl'
                    elif b'<MPD' in body[:65536].upper():
                        body = self.rewrite_dash(session_id, response.geturl(), body)
                        content_type = 'application/dash+xml'
                    handler.send_response(response.status)
                    handler.send_header('Content-Type', content_type or 'application/octet-stream')
                    handler.send_header('Content-Length', str(len(body)))
                    handler.end_headers()
                    headers_sent = True
                    handler.wfile.write(body)
                    return
                handler.send_response(response.status)
                for name in ('Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified'):
                    value = response.headers.get(name)
                    if value:
                        handler.send_header(name, value)
                handler.end_headers()
                headers_sent = True
                while True:
                    chunk = response.read(256 * 1024)
                    if not chunk:
                        break
                    handler.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            # O JDownloader pode fechar uma sondagem ou um chunk assim que já
            # recebeu os bytes necessários. Isso não é uma falha do upstream.
            return
        except HTTPError as error:
            if not headers_sent:
                try:
                    handler.send_error(error.code, str(error.reason))
                except (BrokenPipeError, ConnectionResetError):
                    pass
        except Exception as error:
            if not headers_sent:
                try:
                    handler.send_error(502, f'{error}. Clique Retomar no JDownloader')
                except (BrokenPipeError, ConnectionResetError):
                    pass
        finally:
            if stream_acquired:
                try:
                    stream_lock.release()
                except Exception:
                    pass
            if upstream_lock:
                # Alguns servidores ainda contabilizam a conexão por poucos
                # milissegundos depois do último byte. Evita sobreposição no
                # encerramento quando várias partes já estavam enfileiradas.
                time.sleep(0.02)
                upstream_lock.release()

    def dash_request(self, handler, session_id, base_url, remainder, head_only=False):
        self.proxy_request(handler, session_id, urljoin(base_url, unquote(remainder)), head_only=head_only)

    def add(self, data):
        youtube_page = self.youtube_page(data)
        if youtube_page:
            upstream_url, selected_variant = self.youtube_variant_url(youtube_page, data)
            headers = {}
        else:
            upstream_url, headers, _metadata = self.probe(data)
            selected_variant = None
        full_title = safe_name(data.get('title'))
        kind = 'YOUTUBE' if youtube_page else str(data.get('kind', 'Media')).upper()
        # O JDownloader usa o pacote como subpasta e repete o titulo no nome do
        # arquivo. Limitar apenas o pacote evita caminhos acima de 260 bytes em
        # players executados via Wine sem sacrificar o nome util do video.
        title = ('YouTube - ' + safe_name(full_title, 72)) if youtube_page else full_title
        filename = None if youtube_page else self.media_filename(data, title)
        # Alguns hosts aceitam o TLS do Chrome/Python, mas fecham a conexao do
        # Java usado pelo JDownloader sem sequer responder. Isso se manifesta
        # como "Empty HTTP-Response" / antiDDoSForHost (como baixarhentais).
        # Para mídia não-YouTube, a ponte passa a ser sempre o cliente remoto;
        # assim o JD fala apenas com localhost e preservamos Referer/cookies.
        use_proxy = not youtube_page
        proxy_kind = kind if kind in ('HLS', 'DASH') else 'DOWNLOAD'
        url = self.create_proxy(upstream_url, headers, proxy_kind, data.get('variantId')) if use_proxy else upstream_url
        result = {
            'clicknload': False,
            'crawljob': None,
            'proxied': use_proxy,
            'originalUrl': upstream_url,
            'localUrl': url,
            'youtubePolicy': ('selected-variant' if selected_variant else 'best-video-with-audio-only') if youtube_page else None,
            'youtubeVariant': selected_variant,
        }

        if self.watch_dir:
            # W2-B S-06: bloqueia symlink traversal em watch_dir
            if self.watch_dir.is_symlink():
                raise RuntimeError('watch_dir não pode ser symlink')
            self.watch_dir.mkdir(parents=True, exist_ok=True)
            # revalida após mkdir (TOCTOU)
            if self.watch_dir.is_symlink():
                raise RuntimeError('watch_dir tornou-se symlink')
            job = {
                'text': url,
                'packageName': title,
                'comment': 'Stream2JD ' + kind,
                'autoStart': 'TRUE' if data.get('instantStart') else 'FALSE',
                'enabled': 'TRUE',
                'overwritePackagizerEnabled': True,
            }
            if filename:
                job['filename'] = filename
            target = self.watch_dir / f'stream2jd-{int(time.time() * 1000)}.crawljob'
            # garante que o arquivo não saia de watch_dir via symlink na parent
            if target.resolve().parent != self.watch_dir.resolve():
                raise RuntimeError('crawljob path traversal bloqueado')
            target.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            result['crawljob'] = str(target)

        payload = {
            'urls': url,
            'descriptions': 'Stream2JD ' + kind,
            'cookies': '' if use_proxy else data.get('cookie', ''),
            'package': title,
            # O plugin GenericM3u8 abre esta URL antes do manifesto. Ela precisa
            # ser local e realmente resolvível; o Referer remoto continua
            # protegido dentro da sessão do proxy acima.
            'referer': f'http://127.0.0.1:{self.port}/health',
        }
        if filename:
            payload['fnames'] = filename
        if data.get('instantStart'):
            payload['autostart'] = '1'
        try:
            request = Request(
                'http://127.0.0.1:9666/flashgot',
                data=urlencode(payload).encode(),
                # Keep this identity stable: JDownloader asks for local permission again when it changes.
                # Referer/Origin também permitem que a lista de autorização da
                # interface local reconheça a ponte após reinícios do JD.
                headers={
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': f'Stream2JD/{VERSION}',
                    # O JDownloader reconhece o Click'n'Load local sem abrir
                    # a confirmação apenas quando o Referer loopback aponta
                    # para /flashgot. Um Referer em "/" caía na validação
                    # genérica e retornava HTTP 401 mesmo com 127.0.0.1 na
                    # lista de interfaces autorizadas.
                    'Referer': CLICKNLOAD_REFERER,
                    'Origin': 'http://127.0.0.1:9666',
                },
            )
            with urlopen(request, timeout=8) as response:
                response.read()
                result['clicknload'] = 200 <= response.status < 300
        except (TimeoutError, socket.timeout):
            # A interface Click'n'Load às vezes só encerra a resposta depois
            # que o LinkGrabber terminou de analisar o arquivo. A requisição já
            # foi entregue; tratá-la como falha induz cliques e links duplicados.
            result['clicknload'] = True
            result['pending'] = True
        except Exception as error:
            if not self.watch_dir:
                raise RuntimeError("JDownloader/Click'n'Load não respondeu em 127.0.0.1:9666") from error
        return result


class Handler(BaseHTTPRequestHandler):
    app = None

    def extension_origin(self):
        origin = self.headers.get('Origin', '')
        # W2-B S-02: rejeita Origin null/empty — só extensões reais passam
        return origin.startswith(('moz-extension://', 'chrome-extension://'))

    def cors(self):
        origin = self.headers.get('Origin', '')
        # W2-B S-02: só reflete Origin de extensões reais; 'null' nunca é refletido
        if origin.startswith(('moz-extension://', 'chrome-extension://')):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Credentials', 'false')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Stream2JD-Token')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Private-Network', 'true')

    def reply(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # O navegador/JDownloader pode fechar a conexão após um timeout.
            # Isso não é falha do serviço e não deve gerar traceback ou derrubar
            # a requisição seguinte.
            return

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/health':
            return self.reply(200, {'ok': True, 'service': 'stream2jd', 'version': VERSION, 'native': True})
        if path == '/pair':
            if not self.extension_origin():
                return self.reply(403, {'error': 'pareamento permitido apenas para extensões locais'})
            return self.reply(200, {'ok': True, 'token': self.app.token})
        match = re.fullmatch(r'/dashhls/([^/]+)/([^/]+)/(master|video-[A-Za-z0-9_-]+|audio-[A-Za-z0-9_-]+)\.m3u8', path)
        if match:
            try:
                playlist = match.group(3)
                kind, separator, encoded_id = playlist.partition('-')
                representation_id = decoded_url(encoded_id) if separator else None
                return self.app.dash_hls_request(self, match.group(1), decoded_url(match.group(2)), kind, representation_id)
            except Exception as error:
                return self.send_error(400, str(error))
        match = re.fullmatch(r'/proxy/([^/]+)/([^/]+)(?:/([^/]+))?', path)
        if match:
            try:
                return self.app.proxy_request(self, match.group(1), decoded_url(match.group(2)), route_hint=match.group(3) or '')
            except Exception as error:
                return self.send_error(400, str(error))
        match = re.fullmatch(r'/dash/([^/]+)/([^/]+)/(.*)', path)
        if match:
            try:
                return self.app.dash_request(self, match.group(1), decoded_url(match.group(2)), match.group(3))
            except Exception as error:
                return self.send_error(400, str(error))
        self.reply(404, {'error': 'not found'})

    def do_HEAD(self):
        path = urlsplit(self.path).path
        match = re.fullmatch(r'/dashhls/([^/]+)/([^/]+)/(master|video-[A-Za-z0-9_-]+|audio-[A-Za-z0-9_-]+)\.m3u8', path)
        if match:
            try:
                playlist = match.group(3)
                kind, separator, encoded_id = playlist.partition('-')
                representation_id = decoded_url(encoded_id) if separator else None
                return self.app.dash_hls_request(self, match.group(1), decoded_url(match.group(2)), kind, representation_id, head_only=True)
            except Exception as error:
                return self.send_error(400, str(error))
        match = re.fullmatch(r'/proxy/([^/]+)/([^/]+)(?:/([^/]+))?', path)
        if match:
            try:
                return self.app.proxy_request(self, match.group(1), decoded_url(match.group(2)), route_hint=match.group(3) or '', head_only=True)
            except Exception as error:
                return self.send_error(400, str(error))
        match = re.fullmatch(r'/dash/([^/]+)/([^/]+)/(.*)', path)
        if match:
            try:
                return self.app.dash_request(self, match.group(1), decoded_url(match.group(2)), match.group(3), head_only=True)
            except Exception as error:
                return self.send_error(400, str(error))
        self.send_error(404, 'not found')

    def do_POST(self):
        if self.path not in ('/add', '/inspect'):
            return self.reply(404, {'error': 'not found'})
        if not secrets.compare_digest(self.headers.get('X-Stream2JD-Token', ''), self.app.token):
            return self.reply(403, {'error': 'token inválido'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 262144:
                raise RuntimeError('requisição inválida ou grande demais')
            data = json.loads(self.rfile.read(size))
            if not str(data.get('url', '')).startswith(('http://', 'https://')):
                raise RuntimeError('URL de mídia inválida')
            if self.path == '/inspect':
                self.reply(200, {'ok': True, **self.app.inspect(data)})
            else:
                self.reply(200, {'ok': True, **self.app.add(data)})
        except Exception as error:
            self.reply(400, {'ok': False, 'error': str(error)})

    def log_message(self, format_string, *args):
        # W2-B: trunca session ids nos logs de acesso (S-04)
        message = format_string % args
        # sessão aparece como /proxy/<sid>/ ou /dash/<sid>/
        message = re.sub(r'/(proxy|dash|dashhls)/([^/\s?]{8})[^/\s?]*', r'/\1/\2…', message)
        sys.stderr.write('%s %s\n' % (self.address_string(), message))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=17442)
    parser.add_argument('--watch-dir')
    parser.add_argument('--token-file', default='~/.config/stream2jd/token')
    parser.add_argument('--session-file', default='~/.config/stream2jd/sessions.json')
    args = parser.parse_args()
    token_file = Path(args.token_file).expanduser()
    token_file.parent.mkdir(parents=True, exist_ok=True)
    if not token_file.exists():
        token_file.write_text(secrets.token_urlsafe(32), encoding='utf-8')
        token_file.chmod(0o600)
    token = token_file.read_text(encoding='utf-8').strip()
    Handler.app = App(token, args.port, args.watch_dir, args.session_file)
    print(f'Stream2JD em http://127.0.0.1:{args.port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
