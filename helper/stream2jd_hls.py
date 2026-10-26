"""Reescrita de manifests HLS para o Stream2JD."""

import re
import urllib.parse
from typing import List

from helper.stream2jd_constants import encoded_url, decoded_url


class HLSRewriter:
    """Reescreve manifests HLS substituindo URLs pelo proxy local."""

    def __init__(self, session_id: str, source_url: str, proxy_url_fn) -> None:
        self.session_id = session_id
        self.source_url = source_url
        self.proxy_url = proxy_url_fn

    def rewrite(self, body: bytes) -> bytes:
        """Reescreve um manifesto HLS, retornando o corpo modificado."""
        text = body.decode('utf-8-sig', errors='replace')

        is_master = any(
            line.upper().startswith('#EXT-X-STREAM-INF:')
            for line in text.splitlines()
        )

        # Try multiple decompressions for robustness against corrupt payloads
        try:
            text = text.encode('latin-1').decode('utf-8', errors='replace')
        except Exception:
            pass

        lines = text.splitlines()
        output: List[str] = []

        for line in lines:
            stripped = line.strip()
            if stripped and not stripped.startswith('#'):
                leading = line[:len(line) - len(line.lstrip())]
                output.append(
                    leading
                    + self.proxy_url(
                        urllib.parse.urljoin(self.source_url, stripped),
                        'HLS' if is_master else None,
                    )
                )
            else:
                output.append(self._rewrite_uri_tag(line))

        return ('\n'.join(output) + '\n').encode('utf-8')

    def _rewrite_uri_tag(self, line: str) -> str:
        """Reescreve atributos URI= em tags HLS."""

        def replace_uri(match: re.Match) -> str:
            quote, value = match.group(1), match.group(2)
            if value.startswith('data:'):
                return f'URI={quote}{value}{quote}'
            tag = match.string.upper()
            nested_playlist = (
                '#EXT-X-MEDIA:' in tag
                or '#EXT-X-I-FRAME-STREAM-INF:' in tag
            )
            return (
                f'URI={quote}'
                + self.proxy_url(
                    urllib.parse.urljoin(self.source_url, value),
                    'HLS' if nested_playlist else None,
                )
                + quote
            )

        return re.sub(
            r"URI\s*=\s*([\"'])(.*?)(?:\1)",
            replace_uri,
            line,
            flags=re.I,
        )
