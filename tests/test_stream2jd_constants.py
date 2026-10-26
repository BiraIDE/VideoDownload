"""Testes unitários para stream2jd_constants."""

import pytest

from helper.stream2jd_constants import (
    ALLOWED_SESSION_HEADER,
    CLICKNLOAD_REFERER,
    DRM_LABEL,
    DRM_MARKERS,
    MAX_MANIFEST_SIZE,
    SESSION_LIFETIME,
    VERSION,
    YOUTUBE_H264_FALLBACKS,
    YOUTUBE_VARIANT_BY_ITAG,
    encoded_url,
    safe_name,
)


class TestVersion:
    def test_version_string(self) -> None:
        assert VERSION == '1.9.19'

    def test_clicknload_referer(self) -> None:
        assert CLICKNLOAD_REFERER == 'http://127.0.0.1:9666/flashgot'

    def test_session_lifetime_seconds(self) -> None:
        assert SESSION_LIFETIME == 24 * 60 * 60

    def test_max_manifest_size(self) -> None:
        assert MAX_MANIFEST_SIZE == 8 * 1024 * 1024


class TestDRMMarkers:
    def test_widevine_markers(self) -> None:
        markers = DRM_MARKERS['widevine']
        assert 'com.widevine.alpha' in markers
        assert 'urn:uuid:edef8ba9' in markers

    def test_playready_markers(self) -> None:
        markers = DRM_MARKERS['playready']
        assert 'com.microsoft.playready' in markers
        assert 'urn:uuid:9a04f079' in markers

    def test_fairplay_markers(self) -> None:
        markers = DRM_MARKERS['fairplay']
        assert 'com.apple.fps' in markers
        assert 'fps.1_0' in markers
        assert 'urn:uuid:94ce86fb' in markers

    def test_drm_labels(self) -> None:
        assert DRM_LABEL['widevine'] == 'Widevine'
        assert DRM_LABEL['playready'] == 'PlayReady'
        assert DRM_LABEL['fairplay'] == 'FairPlay'


class TestYoutubeVariantMap:
    def test_itag_137_is_1080p_h264(self) -> None:
        assert YOUTUBE_VARIANT_BY_ITAG[137] == 'MP4_H264_1080P_30FPS_AAC_128KBIT_DASH'

    def test_itag_248_is_1080p_vp9(self) -> None:
        assert YOUTUBE_VARIANT_BY_ITAG[248] == 'MKV_VP9_1080P_30FPS_AAC_128KBIT_DASH'

    def test_itag_399_is_av1_1080p(self) -> None:
        assert YOUTUBE_VARIANT_BY_ITAG[399] == 'MP4_AV1_1920P_30FPS_AAC_128KBIT_DASH'

    def test_fallback_720p_60fps(self) -> None:
        assert YOUTUBE_H264_FALLBACKS[(720, 60)] == 'MP4_H264_720P_60FPS_AAC_128KBIT_DASH'

    def test_fallback_1080p_30fps(self) -> None:
        assert YOUTUBE_H264_FALLBACKS[(1080, 30)] == 'MP4_H264_1080P_30FPS_AAC_128KBIT_DASH'


class TestSafeName:
    def test_basic_sanitization(self) -> None:
        assert safe_name('video avec/slash:single quote') == 'video avec slash single quote'

    def test_null_bytes_removed(self) -> None:
        assert safe_name('video\x00null') == 'video null'

    def test_truncation(self) -> None:
        long_name = 'a' * 300
        result = safe_name(long_name, limit=50)
        assert len(result) == 50

    def test_empty_value_returns_video(self) -> None:
        assert safe_name('') == 'video'
        assert safe_name(None) == 'video'


class TestEncodedUrl:
    def test_roundtrip(self) -> None:
        original = 'https://example.com/video.m3u8'
        encoded = encoded_url(original)
        # decode isn't exported; test encoding properties
        assert '=' not in encoded  # no padding
        assert len(encoded) > 0

    def test_encoding_is_urlsafe(self) -> None:
        encoded = encoded_url('https://example.com/path?query=value')
        assert '+' not in encoded
        assert '/' not in encoded
