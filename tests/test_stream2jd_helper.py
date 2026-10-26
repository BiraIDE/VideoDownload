import io
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from helper.stream2jd_helper import App, CLICKNLOAD_REFERER, MAX_MANIFEST_SIZE, SEGMENT_BUFFER_LIMIT, encoded_url


class RecordingHandler:
    def __init__(self):
        self.headers = {}
        self.status = None
        self.response_headers = {}
        self.error_message = None
        self.wfile = io.BytesIO()

    def send_response(self, status):
        self.status = status

    def send_header(self, name, value):
        self.response_headers[name] = value

    def end_headers(self):
        pass

    def send_error(self, status, message):
        self.status = status
        self.error_message = message


class BufferedFixtureApp(App):
    def __init__(self, body):
        super().__init__('test-token', 17442)
        self.body = body
        self.last_limit = None
        self.sessions['test-session'] = {
            'created': 0,
            'lastAccess': 0,
            'headers': {},
            'kind': 'HLS',
            'variantId': None,
            'upstreamLock': threading.Lock(),
            'streamLock': threading.Semaphore(2),
            'lastUpstreamAt': 0.0,
        }

    def fetch_buffered(self, url, headers, limit=MAX_MANIFEST_SIZE, timeout=60, label='upstream'):
        self.last_limit = limit
        if len(self.body) > limit:
            raise RuntimeError('resposta excede o limite de teste')
        return self.body, {
            'status': 200,
            'contentType': 'image/webp',
            'contentLength': str(len(self.body)),
            'contentRange': None,
            'acceptRanges': 'bytes',
            'etag': None,
            'lastModified': None,
            'finalUrl': url,
            'headers': {},
        }


class ProxyBufferLimitTests(unittest.TestCase):
    def test_hls_segment_larger_than_manifest_limit_uses_segment_buffer(self):
        body = b'x' * (MAX_MANIFEST_SIZE + 1)
        app = BufferedFixtureApp(body)
        handler = RecordingHandler()

        app.proxy_request(
            handler,
            'test-session',
            'https://cdn.example/seg-137-v1-a1.webp',
            route_hint='resource.webp',
        )

        self.assertEqual(SEGMENT_BUFFER_LIMIT, app.last_limit)
        self.assertEqual(200, handler.status)
        self.assertEqual('video/MP2T', handler.response_headers['Content-Type'])
        self.assertEqual(body, handler.wfile.getvalue())

    def test_manifest_keeps_the_smaller_manifest_limit(self):
        body = b'x' * (MAX_MANIFEST_SIZE + 1)
        app = BufferedFixtureApp(body)
        handler = RecordingHandler()

        app.proxy_request(
            handler,
            'test-session',
            'https://cdn.example/index.m3u8',
            route_hint='master.m3u8',
        )

        self.assertEqual(MAX_MANIFEST_SIZE, app.last_limit)
        self.assertEqual(502, handler.status)
        self.assertIn('limite', handler.error_message)


class ProgressiveProxyTests(unittest.TestCase):
    def test_progressive_media_always_uses_download_proxy(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = App('test-token', 17442, watch_dir=temporary)
            recorded = {}

            def probe(data):
                return data['url'], {'Referer': data['referer'], 'User-Agent': data['userAgent']}, {}

            def create_proxy(url, headers, kind, variant_id=None):
                recorded.update(url=url, headers=headers, kind=kind, variant_id=variant_id)
                return 'http://127.0.0.1:17442/proxy/test/resource.mp4'

            app.probe = probe
            app.create_proxy = create_proxy
            result = app.add({
                'url': 'https://server.example/video.mp4',
                'kind': 'MP4',
                'title': 'Vídeo de teste',
                'referer': 'https://site.example/pagina',
                'userAgent': 'Mozilla/5.0 teste',
            })

            self.assertTrue(result['proxied'])
            self.assertEqual('DOWNLOAD', recorded['kind'])
            self.assertEqual('https://site.example/pagina', recorded['headers']['Referer'])
            self.assertTrue(any(Path(temporary).iterdir()))

    def test_clicknload_uses_the_loopback_flashgot_referer(self):
        app = App('test-token', 17442)
        app.probe = lambda data: (data['url'], {}, {})
        app.create_proxy = lambda *_args: 'http://127.0.0.1:17442/proxy/test/resource.mp3'
        response = mock.MagicMock()
        response.status = 200
        response.read.return_value = b''
        context = mock.MagicMock()
        context.__enter__.return_value = response

        with mock.patch('helper.stream2jd_helper.urlopen', return_value=context) as open_mock:
            result = app.add({
                'url': 'https://audio.example/track.mp3',
                'kind': 'Audio',
                'title': 'Áudio de teste',
                'instantStart': True,
            })

        self.assertTrue(result['clicknload'])
        request = open_mock.call_args.args[0]
        self.assertEqual(CLICKNLOAD_REFERER, request.get_header('Referer'))
        self.assertEqual('http://127.0.0.1:9666', request.get_header('Origin'))

    def test_probe_accepts_an_extensionless_mp4_container(self):
        app = App('test-token', 17442)
        app.fetch_buffered = lambda *_args, **_kwargs: (
            b'\x00\x00\x00\x20ftypisom\x00\x00\x00\x00',
            {
                'contentType': 'application/octet-stream',
                'contentLength': '20',
                'contentRange': 'bytes 0-19/20',
                'finalUrl': 'https://media.example/watch?id=1',
            },
        )

        final_url, _headers, metadata = app.probe({'url': 'https://media.example/watch?id=1', 'kind': 'Media'})

        self.assertEqual('https://media.example/watch?id=1', final_url)
        self.assertEqual(20, metadata['contentLength'])

    def test_probe_rejects_an_opaque_non_media_response(self):
        app = App('test-token', 17442)
        app.fetch_buffered = lambda *_args, **_kwargs: (
            b'not a media container',
            {
                'contentType': 'application/octet-stream',
                'contentLength': '21',
                'contentRange': None,
                'finalUrl': 'https://api.example/resource',
            },
        )

        with self.assertRaisesRegex(RuntimeError, 'contêiner de mídia'):
            app.probe({'url': 'https://api.example/resource', 'kind': 'Media'})


DASH_FIXTURE = b'''<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT20S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <Representation id="video-720" bandwidth="1800000" width="1280" height="720">
        <SegmentTemplate timescale="1000" initialization="chunks/init-$RepresentationID$.webp" media="chunks/part-$RepresentationID$-$Number%03d$.webp" startNumber="5">
          <SegmentTimeline><S t="0" d="10000" r="1" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2">
      <Representation id="audio-main" bandwidth="128000">
        <SegmentTemplate timescale="1000" initialization="chunks/init-$RepresentationID$.webp" media="chunks/audio-$Number$.webp" startNumber="1">
          <SegmentTimeline><S t="0" d="10000" r="1" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>'''


class DashHlsFixtureApp(App):
    def __init__(self):
        super().__init__('test-token', 17442)
        self.sessions['dash-session'] = {
            'created': 0,
            'lastAccess': 0,
            'headers': {'Referer': 'https://player.example/page'},
            'kind': 'DASH',
            'variantId': 'video-720',
            'upstreamLock': threading.Lock(),
            'streamLock': threading.Semaphore(2),
            'lastUpstreamAt': 0.0,
        }

    def fetch_buffered(self, url, headers, limit=MAX_MANIFEST_SIZE, timeout=60, label='upstream'):
        self.assertEqual('https://cdn.example/video/manifest.mpd', url)
        return DASH_FIXTURE, {
            'status': 200,
            'contentType': 'application/dash+xml',
            'contentLength': str(len(DASH_FIXTURE)),
            'contentRange': None,
            'acceptRanges': 'bytes',
            'etag': None,
            'lastModified': None,
            'finalUrl': url,
            'headers': {},
        }

    # unittest assertions are useful inside fetch_buffered, which intentionally
    # mirrors the bridge's single MPD request in this isolated fixture.
    def assertEqual(self, left, right):
        if left != right:
            raise AssertionError(f'{left!r} != {right!r}')


class DashToHlsTests(unittest.TestCase):
    def test_dash_is_exposed_as_hls_master_with_audio_and_selected_video(self):
        app = DashHlsFixtureApp()
        handler = RecordingHandler()
        source = 'https://cdn.example/video/manifest.mpd'

        app.dash_hls_request(handler, 'dash-session', source, 'master')

        master = handler.wfile.getvalue().decode('utf-8')
        self.assertEqual(200, handler.status)
        self.assertEqual('application/vnd.apple.mpegurl', handler.response_headers['Content-Type'])
        self.assertIn('#EXT-X-MEDIA:TYPE=AUDIO', master)
        self.assertIn(f'video-{encoded_url("video-720")}.m3u8', master)
        self.assertNotIn('manifest.mpd\n', master)

    def test_dash_video_playlist_has_init_and_all_timeline_segments(self):
        app = DashHlsFixtureApp()
        handler = RecordingHandler()
        source = 'https://cdn.example/video/manifest.mpd'

        app.dash_hls_request(handler, 'dash-session', source, 'video', 'video-720')

        playlist = handler.wfile.getvalue().decode('utf-8')
        self.assertIn('#EXT-X-MAP:URI="http://127.0.0.1:17442/proxy/', playlist)
        self.assertIn(encoded_url('https://cdn.example/video/chunks/init-video-720.webp'), playlist)
        self.assertIn(encoded_url('https://cdn.example/video/chunks/part-video-720-005.webp'), playlist)
        self.assertIn(encoded_url('https://cdn.example/video/chunks/part-video-720-006.webp'), playlist)
        self.assertEqual(2, playlist.count('#EXTINF:10.000000,'))
        self.assertTrue(playlist.endswith('#EXT-X-ENDLIST\n'))


if __name__ == '__main__':
    unittest.main()

# ── W2-A: testes para correções de segurança ──

from helper.stream2jd_helper import _is_private_host, safe_name, Handler


class PrivateHostGuardTests(unittest.TestCase):
    def test_private_ip_is_blocked(self):
        self.assertTrue(_is_private_host('10.0.0.1'))
        self.assertTrue(_is_private_host('192.168.1.50'))
        self.assertTrue(_is_private_host('172.16.5.2'))
        self.assertTrue(_is_private_host('169.254.10.20'))
        self.assertTrue(_is_private_host('::1'))
        self.assertTrue(_is_private_host('metadata.google.internal'))

    def test_public_host_is_not_blocked(self):
        self.assertFalse(_is_private_host('8.8.8.8'))
        self.assertFalse(_is_private_host('cdn.example'))
        self.assertFalse(_is_private_host('googlevideo.com'))

    def test_loopback_allowlisted_for_jd(self):
        # 127.0.0.1/localhost são usados pelo JD localmente — não são bloqueados
        self.assertFalse(_is_private_host('127.0.0.1'))
        self.assertFalse(_is_private_host('localhost'))

    def test_fetch_buffered_blocks_redirect_to_private_host(self):
        app = App('test-token', 17442)
        # Simula um redirect que o urlopen seguiria: origem pública → final privado
        fake_response = mock.MagicMock()
        fake_response.geturl.return_value = 'http://192.168.1.1/secret'
        fake_response.status = 200
        fake_response.headers = {}
        fake_response.read.return_value = b'#EXTM3U\n'
        # geturl divergiu: bloquear
        with mock.patch.object(app, 'fetch_with_retry', return_value=(fake_response, None)):
            # fetch_buffered deve detectar redirect privado e falhar
            with self.assertRaises(RuntimeError) as ctx:
                app.fetch_buffered('https://cdn.example/playlist.m3u8', {}, label='test-ssrf')
            self.assertIn('privado', str(ctx.exception))


class SafeNameExtendedTests(unittest.TestCase):
    def test_dotdot_isolated_becomes_underscores(self):
        self.assertEqual('a __ b', safe_name('a .. b'))
        self.assertEqual('__ b', safe_name('.. b'))
        self.assertEqual('__ __ etc passwd', safe_name('../../etc/passwd'))
        self.assertNotIn('..', safe_name('../../etc/passwd'))
        self.assertNotIn('/', safe_name('../../etc/passwd'))

    def test_slash_and_control_chars_removed(self):
        self.assertNotIn('/', safe_name('a/b'))
        self.assertNotIn(chr(0), safe_name('a\x00b'))


class CorsPairSecurityTests(unittest.TestCase):
    def _handler(self, origin, pair_header=''):
        h = Handler.__new__(Handler)
        h.headers = {k: v for k, v in [('Origin', origin), ('X-Stream2JD-Pair', pair_header)] if v != '' or k == 'Origin'}
        # Para casos onde Origin == 'null' ou ''
        if origin in ('', 'null'):
            h.headers['Origin'] = origin
            if pair_header:
                h.headers['X-Stream2JD-Pair'] = pair_header
        return h

    def test_extension_origin_rejects_null(self):
        h = self._handler('null', 'stream2jd@local')
        self.assertFalse(h.extension_origin())

    def test_extension_origin_rejects_empty_with_pair(self):
        h = self._handler('', 'stream2jd@local')
        self.assertFalse(h.extension_origin())

    def test_extension_origin_accepts_moz_extension(self):
        h = self._handler('moz-extension://abc123/')
        self.assertTrue(h.extension_origin())

    def test_extension_origin_accepts_chrome_extension(self):
        h = self._handler('chrome-extension://abc123/')
        self.assertTrue(h.extension_origin())

    def test_cors_does_not_reflect_null(self):
        class Cap(Handler):
            def __init__(self, origin):
                self.headers = {'Origin': origin}
                self._hdrs = {}
            def send_header(self, k, v):
                self._hdrs[k] = v
        cap = Cap('null')
        Handler.cors(cap)  # type: ignore
        self.assertNotIn('Access-Control-Allow-Origin', cap._hdrs)

    def test_cors_reflects_extension_origin(self):
        class Cap(Handler):
            def __init__(self, origin):
                self.headers = {'Origin': origin}
                self._hdrs = {}
            def send_header(self, k, v):
                self._hdrs[k] = v
        cap = Cap('moz-extension://abc/')
        Handler.cors(cap)  # type: ignore
        self.assertEqual('moz-extension://abc/', cap._hdrs.get('Access-Control-Allow-Origin'))


class WatchDirSymlinkTests(unittest.TestCase):
    def test_add_rejects_symlinked_watch_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            real = Path(tmp) / 'real'
            real.mkdir()
            link = Path(tmp) / 'link'
            link.symlink_to(real)
            app = App('test-token', 17442, watch_dir=str(link))
            app.probe = lambda data: (data['url'], {}, {})  # type: ignore
            app.create_proxy = lambda *_a, **_k: 'http://127.0.0.1:17442/proxy/x/y'  # type: ignore
            # Mock urlopen para não precisar JD
            resp = mock.MagicMock()
            resp.status = 200
            resp.read.return_value = b''
            ctx = mock.MagicMock()
            ctx.__enter__.return_value = resp
            with mock.patch('helper.stream2jd_helper.urlopen', return_value=ctx):
                with self.assertRaises(RuntimeError) as ctx2:
                    app.add({'url': 'https://cdn.example/video.mp4', 'kind': 'MP4', 'title': 't'})
                self.assertIn('symlink', str(ctx2.exception).lower())

