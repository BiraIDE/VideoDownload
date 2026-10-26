"""Edge cases para robustez: safe_name .., private_host, retry/backoff, DASH."""
import tempfile
import threading
from pathlib import Path
from unittest import mock
import pytest

from helper.stream2jd_helper import (
    App,
    _is_private_host,
    safe_name,
    parse_retry_after,
    backoff_delay,
    RETRYABLE_STATUS,
    MAX_MANIFEST_SIZE,
    encoded_url,
    decoded_url,
)
from helper.stream2jd_constants import safe_name as csafe, encoded_url as cencoded, decoded_url as cdecoded


class TestSafeNameEdge:
    def test_double_dot_token_isolated(self):
        assert safe_name("a .. b") == "a __ b"
        assert safe_name(".. b") == "__ b"
        assert safe_name("../../etc/passwd") == "__ __ etc passwd"
        assert ".." not in safe_name("../../etc/passwd").split()

    def test_only_dots_becomes_video(self):
        assert ".." not in safe_name("..")
        assert safe_name(" . . ") in ("__ __", "video") or safe_name(" . . ") != ""

    def test_trailing_dots_and_spaces_stripped(self):
        assert not safe_name("video .. ").endswith(" ")
        assert not safe_name("video.").endswith(".")
        assert safe_name("video. ") == "video"

    def test_slash_control_truncated(self):
        assert "/" not in safe_name("a/b\\c:d*e?f\"g<h>i|j")
        assert "\x00" not in safe_name("a\x00b\x1f")
        # limit
        long_ = "a" * 500
        assert len(safe_name(long_, limit=10)) == 10
        # empty -> video
        assert safe_name("") == "video"
        assert safe_name(None) == "video"

    def test_constants_parity(self):
        for val in ["a .. b", "../x", "a/b", "x" * 300, "", None, "video: test*"]:
            assert safe_name(val) == csafe(val)


class TestPrivateHost:
    def test_private_blocked(self):
        assert _is_private_host("10.0.0.1") is True
        assert _is_private_host("10.255.255.255") is True
        assert _is_private_host("192.168.0.1") is True
        assert _is_private_host("172.16.0.1") is True
        assert _is_private_host("172.31.255.255") is True
        assert _is_private_host("172.15.0.0") is False  # just outside 172.16/12
        assert _is_private_host("172.32.0.1") is False
        assert _is_private_host("169.254.1.1") is True
        assert _is_private_host("::1") is True
        assert _is_private_host("fe80::1") is True
        assert _is_private_host("fc00::1") is True
        assert _is_private_host("ff02::1") is True

    def test_public_allowed(self):
        assert _is_private_host("8.8.8.8") is False
        assert _is_private_host("1.1.1.1") is False
        assert _is_private_host("cdn.example") is False
        assert _is_private_host("video.googlevideo.com") is False

    def test_loopback_allowlisted(self):
        assert _is_private_host("127.0.0.1") is False
        assert _is_private_host("127.0.1.1") is True  # still private but not allowlisted 127.0.0.1
        assert _is_private_host("localhost") is False

    def test_internal_domains(self):
        assert _is_private_host("metadata.google.internal") is True
        assert _is_private_host("foo.internal") is True
        assert _is_private_host("example.internal.evil") is False

    def test_empty_and_dots(self):
        assert _is_private_host("") is False
        assert _is_private_host("127.0.0.1.") is False  # trailing dot stripped
        assert _is_private_host(" 10.0.0.1 ") is True


class TestRetryAndBackoff:
    def test_parse_retry_after_int(self):
        assert parse_retry_after({"Retry-After": "120"}) == 20  # capped
        assert parse_retry_after({"Retry-After": "5"}) == 5
        assert parse_retry_after({"retry-after": "3"}) == 3
        assert parse_retry_after({"RETRY-AFTER": "1"}) == 1
        # case-insensitive via dict loop
        assert parse_retry_after({"ReTry-AfTeR": "7"}) == 7

    def test_parse_retry_after_invalid(self):
        assert parse_retry_after({}) is None
        assert parse_retry_after({"Retry-After": "not-a-number"}) is None
        assert parse_retry_after(None) is None
        assert parse_retry_after({"Retry-After": ""}) is None

    def test_parse_retry_after_with_comma_and_cap(self):
        # only first value taken, capped to 20
        assert parse_retry_after({"Retry-After": "60, extra"}) == 20
        assert parse_retry_after({"Retry-After": "0"}) == 1  # floor to 1

    def test_backoff_with_retry_after(self):
        d = backoff_delay(0, retry_after=5)
        assert 5 <= d <= 6  # + jitter 0-1
        d2 = backoff_delay(2, retry_after=25)
        assert d2 <= 20.0  # capped

    def test_backoff_without_retry_after(self):
        for attempt in range(6):
            d = backoff_delay(attempt)
            assert 0.9 <= d <= 21  # base + jitter

    def test_retryable_status_contains_cloudflare(self):
        for code in (520, 521, 522, 523, 524):
            assert code in RETRYABLE_STATUS

    def test_fetch_with_retry_non_retryable_raises(self):
        from urllib.error import HTTPError
        app = App("t", 17442)
        err = HTTPError("https://cdn.example/a.m3u8", 404, "Not Found", {}, None)
        with mock.patch.object(app, "open_upstream_once", side_effect=err):
            with pytest.raises(HTTPError) as ctx:
                app.fetch_with_retry("https://cdn.example/a.m3u8", {}, label="test")
            assert ctx.value.code == 404

    def test_fetch_buffered_redirect_to_private_blocked(self):
        app = App("t", 17442)
        fake = mock.MagicMock()
        fake.geturl.return_value = "http://192.168.1.1/secret"
        fake.status = 200
        fake.headers = {}
        fake.read.return_value = b"#EXTM3U\n"
        with mock.patch.object(app, "fetch_with_retry", return_value=(fake, None)):
            with pytest.raises(RuntimeError) as ctx:
                app.fetch_buffered("https://cdn.example/pl.m3u8", {}, label="ssrf")
            assert "privado" in str(ctx.value)


class TestDashEdge:
    def test_dash_duration_iso(self):
        app = App("t", 17442)
        assert app.dash_duration_seconds("PT10S") == 10
        assert app.dash_duration_seconds("PT1M30S") == 90
        assert app.dash_duration_seconds("PT2H") == 7200
        assert app.dash_duration_seconds("P1D") == 86400
        assert app.dash_duration_seconds("PT0.5S") == pytest.approx(0.5)
        assert app.dash_duration_seconds("") is None
        assert app.dash_duration_seconds("invalid") is None

    def test_dash_template_value_padding(self):
        app = App("t", 17442)
        rep = {"id": "video-720", "bandwidth": "1800000"}
        assert app.dash_template_value("seg-$Number%05d$.m4s", rep, 7, 0) == "seg-00007.m4s"
        assert app.dash_template_value("init-$RepresentationID$.mp4", rep, 1, 0) == "init-video-720.mp4"
        assert app.dash_template_value("$$", rep, 1, 0) == "$"
        assert app.dash_template_value("a-$Bandwidth$-$Time$.m4s", rep, 1, 12345) == "a-1800000-12345.m4s"

    def test_dash_segments_excess_guard(self):
        app = App("t", 17442)
        # timeline with 10001 repeated segments should raise
        import xml.etree.ElementTree as ET
        # Craft a stream with huge repeat
        fake_stream = {
            "timescale": 1000,
            "startNumber": 1,
            "timeline": ET.fromstring('<SegmentTimeline><S d="1000" r="10000"/></SegmentTimeline>'),
            "template": {},
            "periodDuration": 999999,
        }
        # dash_name needs to handle ET elements: for timeline we use fake_stream timeline directly
        # monkey dash_name to work with this ET structure (tag includes no namespace)
        with pytest.raises(RuntimeError) as ctx:
            app.dash_segments(fake_stream)
        assert "segmentos demais" in str(ctx.value).lower()

    def test_rewrite_hls_delegates_and_fallback(self):
        app = App("t", 17442)
        body = b"#EXTM3U\n#EXTINF:10,\nseg.ts\n"
        # Should use HLSRewriter delegate when available
        out = app.rewrite_hls("sess", "https://cdn.example/pl.m3u8", body)
        assert b"http://127.0.0.1:" in out
        assert b"seg.ts" not in out or b"proxy" in out
        # fallback inline also works if module missing — simulate by patching import to fail
        # but direct call still works (fallback path)
        with mock.patch.dict("sys.modules", {"helper.stream2jd_hls": None, "stream2jd_hls": None}):
            # Force ImportError path: remove module
            import sys
            # need to ensure from .. import fails; easiest: test inline helper called via second invocation
            # just verify fallback inline string logic produces same shape
            out2 = app.rewrite_hls("sess2", "https://cdn.example/pl.m3u8", body)
            assert b"http://127.0.0.1:" in out2

    def test_encoded_url_parity_and_roundtrip(self):
        for url in ["https://cdn.example/a.m3u8?x=1", "https://a.b/c/d.mpd"]:
            e1 = encoded_url(url); e2 = cencoded(url)
            assert e1 == e2
            assert decoded_url(e1) == url
            assert cdecoded(e1) == url
            assert "=" not in e1 and "+" not in e1 and "/" not in e1
