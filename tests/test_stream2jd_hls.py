"""Testes para stream2jd_hls — reescrita de manifests HLS."""

import pytest

from helper.stream2jd_hls import HLSRewriter


class FixtureHLSRewriter:
    """Cria um HLSRewriter com proxy_url mockável para testes isolados."""

    def __init__(self, session_id: str, source_url: str):
        self.session_id = session_id
        self.source_url = source_url
        self.proxy_calls: list = []

    def proxy_url(self, url: str, kind: str | None) -> str:
        self.proxy_calls.append((url, kind))
        return f'http://127.0.0.1:17442/proxy/{self.session_id}/{url}'

    def make_rewriter(self) -> HLSRewriter:
        return HLSRewriter(
            self.session_id,
            self.source_url,
            self.proxy_url,
        )


class TestHLSRewrite:
    """Testa a reescrita de manifests HLS pelo HLSRewriter."""

    def test_rewrite_simple_m3u8(self) -> None:
        rewriter_fixture = FixtureHLSRewriter('sess-1', 'https://cdn.example/playlist.m3u8')
        rewriter = rewriter_fixture.make_rewriter()

        body = b'''#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
https://cdn.example/segment-0.ts
#EXTINF:10.0,
https://cdn.example/segment-1.ts
#EXT-X-ENDLIST
'''

        result = rewriter.rewrite(body)

        assert result.startswith(b'#EXTM3U\n')
        assert b'http://127.0.0.1:17442/proxy/sess-1/https://cdn.example/segment-0.ts' in result
        assert b'http://127.0.0.1:17442/proxy/sess-1/https://cdn.example/segment-1.ts' in result
        assert b'#EXT-X-ENDLIST' in result

    def test_preserves_comments_and_directives(self) -> None:
        rewriter_fixture = FixtureHLSRewriter('sess-1', 'https://cdn.example/master.m3u8')
        rewriter = rewriter_fixture.make_rewriter()

        body = b'''#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720
https://cdn.example/video.m3u8
'''

        result = rewriter.rewrite(body)

        assert b'#EXTM3U' in result
        assert b'#EXT-X-VERSION:7' in result
        assert b'#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720' in result
        assert b'http://127.0.0.1:17442/proxy/sess-1/https://cdn.example/video.m3u8' in result

    def test_rewrite_uri_quoted_values(self) -> None:
        rewriter_fixture = FixtureHLSRewriter('sess-1', 'https://cdn.example/master.m3u8')
        rewriter = rewriter_fixture.make_rewriter()

        body = b'''#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="https://cdn.example/audio.m3u8"
'''

        result = rewriter.rewrite(body)

        assert b'URI="http://127.0.0.1:17442/proxy/sess-1/https://cdn.example/audio.m3u8"' in result
        assert b'TYPE=AUDIO,GROUP-ID="audio"' in result

    def test_preserves_data_uri(self) -> None:
        rewriter_fixture = FixtureHLSRewriter('sess-1', 'https://cdn.example/master.m3u8')
        rewriter = rewriter_fixture.make_rewriter()

        body = b'''#EXTM3U
#EXT-X-MEDIA:TYPE=VIDEO,URI="data:image/png;base64,iVBORw0KGgo="
'''

        result = rewriter.rewrite(body)

        assert b'URI="data:image/png;base64,iVBORw0KGgo="' in result

    def test_rewrites_relative_urls(self) -> None:
        rewriter_fixture = FixtureHLSRewriter('sess-1', 'https://cdn.example/playlist.m3u8')
        rewriter = rewriter_fixture.make_rewriter()

        body = b'''#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
segment-0.ts
#EXTINF:10.0,
segment-1.ts
'''

        result = rewriter.rewrite(body)

        assert b'http://127.0.0.1:17442/proxy/sess-1/https://cdn.example/segment-0.ts' in result
        assert b'http://127.0.0.1:17442/proxy/sess-1/https://cdn.example/segment-1.ts' in result

    def test_preserves_leading_whitespace(self) -> None:
        rewriter_fixture = FixtureHLSRewriter('sess-1', 'https://cdn.example/playlist.m3u8')
        rewriter = rewriter_fixture.make_rewriter()

        body = b'''#EXTM3U
    #EXT-X-VERSION:3
https://cdn.example/seg.ts
'''

        result = rewriter.rewrite(body)

        assert b'    #EXT-X-VERSION:3' in result


class TestHLSMasterPlaylist:
    """Testa reescrita de playlists master HLS (com STREAM-INF)."""

    def test_master_playlist_rewrites_all_uris(self) -> None:
        rewriter_fixture = FixtureHLSRewriter('sess-1', 'https://cdn.example/master.m3u8')
        rewriter = rewriter_fixture.make_rewriter()

        body = b'''#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=500000
low-quality.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000
high-quality.m3u8
'''

        result = rewriter.rewrite(body)

        assert b'http://127.0.0.1:17442/proxy/sess-1/https://cdn.example/low-quality.m3u8' in result
        assert b'http://127.0.0.1:17442/proxy/sess-1/https://cdn.example/high-quality.m3u8' in result


class TestHLSNestedPlaylistTags:
    """Testa tags HLS aninhadas (EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF)."""

    def test_ext_x_media_gets_hls_proxy(self) -> None:
        rewriter_fixture = FixtureHLSRewriter('sess-1', 'https://cdn.example/master.m3u8')
        rewriter = rewriter_fixture.make_rewriter()

        body = b'''#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"
'''

        result = rewriter.rewrite(body)

        # EXT-X-MEDIA deve usar proxy com sufixo HLS
        assert b'URI="http://127.0.0.1:17442/proxy/sess-1/https://cdn.example/audio.m3u8"' in result


class TestHLSByteOrderMark:
    """Testa remoção de BOM UTF-8 antes da decodificação."""

    def test_utf8_bom_stripped(self) -> None:
        rewriter_fixture = FixtureHLSRewriter('sess-1', 'https://cdn.example/playlist.m3u8')
        rewriter = rewriter_fixture.make_rewriter()

        # Manifest com BOM UTF-8 (3 bytes: EF BB BF)
        body = b'\xef\xbb\xbf#EXTM3U\n#EXT-X-VERSION:3\nhttps://cdn.example/seg.ts\n'

        result = rewriter.rewrite(body)

        assert result.startswith(b'#EXTM3U\n')
        assert b'http://127.0.0.1:17442/proxy/sess-1/https://cdn.example/seg.ts' in result
