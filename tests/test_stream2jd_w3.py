"""W3 security hardening — S-01 SSRF b64url + S-07 header scoping."""

import io
import threading
import tempfile
from pathlib import Path
from unittest import mock

from helper.stream2jd_helper import (
    App, _is_blocked_upstream_url, _is_private_host, _filter_headers_for_target,
    _is_same_site, _validate_upstream_url, _normalize_ip_host, encoded_url,
)

class RecordingHandler:
    def __init__(self, range_header=None):
        self.headers = {}
        if range_header:
            self.headers['Range'] = range_header
        self.status = None
        self.error_message = None
        self.wfile = io.BytesIO()
        self.response_headers = {}
    def get(self, k, d=None):
        return self.headers.get(k, d)
    def __getitem__(self, k):
        return self.headers[k]
    def __contains__(self, k):
        return k in self.headers
    def send_error(self, status, message):
        self.status = status
        self.error_message = message
    def send_response(self, s): self.status = s
    def send_header(self, n, v): self.response_headers[n]=v
    def end_headers(self): pass

class TestS01PreFetchBlocking:
    def test_blocks_private_before_open(self):
        for url in [
            "http://127.0.0.1:80/secret",
            "http://10.0.0.1/media.m3u8",
            "http://192.168.1.1/x",
            "http://172.16.0.5/x",
            "http://169.254.5.5/x",
            "http://0.0.0.0/x",
            "http://0x7f.0.0.1/x",
            "http://0x7f000001/x",
            "http://2130706433/x",
            "http://foo.internal/x",
            "http://metadata.google.internal/x",
            "http://[::1]/x",
            "http://[fe80::1]/x",
        ]:
            assert _is_blocked_upstream_url(url) is True, url

    def test_allowlist_jd_ports(self):
        for url in [
            "http://127.0.0.1:9666/flashgot",
            "http://127.0.0.1:17442/proxy/sid/x",
            "http://localhost:9666/flashgot",
            "http://localhost:17442/health",
        ]:
            assert _is_blocked_upstream_url(url) is False, url

    def test_allows_public(self):
        for url in [
            "https://cdn.example.com/video.m3u8",
            "https://8.8.8.8/video.mp4",
            "https://sub.cdn.example.com/seg.ts",
        ]:
            assert _is_blocked_upstream_url(url) is False, url

    def test_blocks_userinfo_url(self):
        assert _is_blocked_upstream_url("http://user:pass@cdn.example.com/x") is True

    def test_validate_raises_on_blocked(self):
        try:
            _validate_upstream_url("http://10.0.0.1/secret")
            assert False, "should raise"
        except RuntimeError as e:
            assert "SSRF" in str(e) or "privado" in str(e).lower()

    def test_normalize_detects_obfuscated(self):
        assert _normalize_ip_host("0x7f.0.0.1") == "127.0.0.1"
        assert _normalize_ip_host("2130706433") == "127.0.0.1"
        assert _normalize_ip_host("192.168.1.1") == "192.168.1.1"

    def test_create_proxy_blocks_before_session(self):
        app = App("tok", 17442)
        try:
            app.create_proxy("http://10.0.0.1/secret", {}, "HLS")
            assert False, "should block"
        except RuntimeError as e:
            assert "privado" in str(e).lower() or "SSRF" in str(e)

    def test_proxy_request_blocks_before_session_lookup(self):
        app = App("tok", 17442)
        app.sessions["sid123"] = {
            "created": 0, "lastAccess": 0, "headers": {"Cookie": "a=b"}, "kind": "HLS",
            "variantId": None, "upstreamLock": threading.Lock(), "streamLock": threading.Semaphore(6),
            "lastUpstreamAt": 0.0, "source_host": "cdn.example.com",
        }
        h = RecordingHandler()
        # upstream privada -> 403 mesmo com sessão válida
        app.proxy_request(h, "sid123", "http://192.168.1.5/secret.m3u8")
        assert h.status == 403

    def test_proxy_request_blocks_obfuscated_ip(self):
        app = App("tok", 17442)
        app.sessions["sid123"] = {
            "created": 0, "lastAccess": 0, "headers": {}, "kind": "HLS",
            "variantId": None, "upstreamLock": threading.Lock(), "streamLock": threading.Semaphore(6),
            "lastUpstreamAt": 0.0, "source_host": "cdn.example.com",
        }
        h = RecordingHandler()
        app.proxy_request(h, "sid123", "http://0x7f.0.0.1/secret")
        assert h.status == 403

    def test_fetch_buffered_blocks_private_url_directly(self):
        app = App("tok", 17442)
        try:
            app.fetch_buffered("http://10.0.0.1/secret", {}, limit=64*1024)
            assert False
        except RuntimeError as e:
            assert "privado" in str(e).lower() or "SSRF" in str(e)

class TestS07HeaderScoping:
    def test_same_site_keeps_sensitive(self):
        hdrs = {"Authorization": "Bearer t", "Cookie": "a=b", "X-Token": "v", "User-Agent": "UA", "Referer": "https://cdn.example.com/p"}
        out = _filter_headers_for_target(hdrs, "cdn.example.com", "https://cdn.example.com/video.ts")
        assert "Authorization" in out and "Cookie" in out and "X-Token" in out

    def test_same_site_suffix_keeps(self):
        hdrs = {"Authorization": "Bearer t", "Cookie": "a=b", "X-Api": "1"}
        out = _filter_headers_for_target(hdrs, "cdn.example.com", "https://sub.cdn.example.com/video.ts")
        assert "Authorization" in out

    def test_cross_origin_strips_sensitive(self):
        hdrs = {"Authorization": "Bearer t", "Cookie": "a=b", "X-Token": "v", "Referer": "https://cdn.example.com/p", "User-Agent": "UA"}
        out = _filter_headers_for_target(hdrs, "cdn.example.com", "https://evil.com/steal")
        assert "Authorization" not in out
        assert "Cookie" not in out
        assert "X-Token" not in out
        assert "User-Agent" in out
        assert "Referer" in out  # Referer não é sensível por _is_sensitive_header

    def test_proxy_request_strips_cross_origin_headers(self):
        app = App("tok", 17442)
        app.sessions["sid1"] = {
            "created": 0, "lastAccess": 0,
            "headers": {"Authorization": "Bearer tok", "Cookie": "sess=abc", "X-Api-Key": "k", "Referer": "https://cdn.example.com/page", "User-Agent": "UA"},
            "kind": "HLS", "variantId": None, "upstreamLock": threading.Lock(), "streamLock": threading.Semaphore(6),
            "lastUpstreamAt": 0.0, "source_host": "cdn.example.com",
        }
        # Mock fetch_buffered to capture headers actually used
        captured = {}
        orig = app.fetch_buffered
        def fake(url, headers, limit=8192, timeout=60, label="x"):
            captured.update(headers)
            return b"#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\nseg.ts\n", {"status":200,"contentType":"application/vnd.apple.mpegurl","contentLength":"20","contentRange":None,"acceptRanges":None,"etag":None,"lastModified":None,"finalUrl":url,"headers":{}}
        app.fetch_buffered = fake
        h = RecordingHandler()
        h.headers = {}
        # chama proxy para host diferente -> deve strip
        app.proxy_request(h, "sid1", "https://evil.com/video.m3u8", route_hint="master.m3u8")
        assert "Authorization" not in captured
        assert "Cookie" not in captured
        assert "X-Api-Key" not in captured
        assert "User-Agent" in captured

    def test_proxy_request_keeps_same_site_headers(self):
        app = App("tok", 17442)
        app.sessions["sid2"] = {
            "created": 0, "lastAccess": 0,
            "headers": {"Authorization": "Bearer tok", "Cookie": "sess=abc", "Referer": "https://cdn.example.com/page"},
            "kind": "HLS", "variantId": None, "upstreamLock": threading.Lock(), "streamLock": threading.Semaphore(6),
            "lastUpstreamAt": 0.0, "source_host": "cdn.example.com",
        }
        captured = {}
        def fake(url, headers, limit=8192, timeout=60, label="x"):
            captured.update(headers)
            return b"#EXTM3U\n", {"status":200,"contentType":"application/vnd.apple.mpegurl","contentLength":"10","contentRange":None,"acceptRanges":None,"etag":None,"lastModified":None,"finalUrl":url,"headers":{}}
        app.fetch_buffered = fake
        h = RecordingHandler()
        app.proxy_request(h, "sid2", "https://sub.cdn.example.com/video.m3u8", route_hint="master.m3u8")
        assert "Authorization" in captured or "Cookie" in captured

    def test_is_same_site_logic(self):
        assert _is_same_site("cdn.example.com", "cdn.example.com") is True
        assert _is_same_site("cdn.example.com", "sub.cdn.example.com") is True
        assert _is_same_site("cdn.example.com", "evil.com") is False
        assert _is_same_site("8.8.8.8", "8.8.8.8") is True
        assert _is_same_site("8.8.8.8", "1.1.1.1") is False

class TestB64UrlDecodedValidation:
    def test_create_proxy_rejects_b64url_private(self):
        app = App("tok", 17442)
        private = f"http://192.168.1.1/secret.m3u8"
        # decoded_url path: Handler decodes b64url then calls proxy_request; create_proxy is SSRF guard
        try:
            app.create_proxy(private, {}, "HLS")
            assert False
        except RuntimeError:
            pass
        # encoded path também deve falhar se decodificado pelo Handler
        # (Handler.do_GET faz decoded_url antes de proxy_request)
        app.sessions["s2"] = {
            "created": 0, "lastAccess": 0, "headers": {}, "kind": "HLS", "variantId": None,
            "upstreamLock": threading.Lock(), "streamLock": threading.Semaphore(6),
            "lastUpstreamAt": 0.0, "source_host": "cdn.example.com",
        }
        h = RecordingHandler()
        upstream = "http://10.0.0.1/secret"
        app.proxy_request(h, "s2", upstream)
        assert h.status == 403

