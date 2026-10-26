#!/usr/bin/env python3
import json
import struct
import sys
from pathlib import Path
from urllib.request import Request, urlopen

def token_file():
    import os
    base = os.environ.get('XDG_CONFIG_HOME') or str(Path.home() / '.config')
    return Path(base) / 'stream2jd' / 'token'


TOKEN_FILE = token_file()
DEFAULT_PORT = 17442


def helper_base(message):
    try:
        port = int((message.get('payload') or {}).get('bridgePort') or message.get('port') or DEFAULT_PORT)
    except (TypeError, ValueError):
        port = DEFAULT_PORT
    if not 1024 <= port <= 65535:
        port = DEFAULT_PORT
    return f'http://127.0.0.1:{port}'


def read_exact(size):
    data = bytearray()
    while len(data) < size:
        chunk = sys.stdin.buffer.read(size - len(data))
        if not chunk:
            return None
        data.extend(chunk)
    return bytes(data)


def reply(value):
    encoded = json.dumps(value, ensure_ascii=False).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def helper_request(path, payload=None, base=None):
    headers = {}
    body = None
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        headers['Content-Type'] = 'application/json'
        try:
            headers['X-Stream2JD-Token'] = TOKEN_FILE.read_text(encoding='utf-8').strip()
        except OSError as error:
            return {'ok': False, 'error': f'token local indisponivel: {error}'}
    request = Request((base or f'http://127.0.0.1:{DEFAULT_PORT}') + path, data=body, headers=headers)
    try:
        with urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode('utf-8'))
    except Exception as error:
        if hasattr(error, 'read'):
            try:
                return json.loads(error.read().decode('utf-8'))
            except Exception:
                pass
        return {'ok': False, 'error': str(error)}


def handle(message):
    action = message.get('action')
    base = helper_base(message if isinstance(message, dict) else {})
    if action == 'health':
        return helper_request('/health', base=base)
    if action == 'add' and isinstance(message.get('payload'), dict):
        return helper_request('/add', message['payload'], base=base)
    if action == 'inspect' and isinstance(message.get('payload'), dict):
        return helper_request('/inspect', message['payload'], base=base)
    return {'ok': False, 'error': 'ação nativa inválida'}


def main():
    while True:
        raw_size = read_exact(4)
        if raw_size is None:
            return
        size = struct.unpack('<I', raw_size)[0]
        if size <= 0 or size > 1024 * 1024:
            reply({'ok': False, 'error': 'mensagem nativa excede o limite'})
            return
        payload = read_exact(size)
        if payload is None:
            return
        try:
            reply(handle(json.loads(payload.decode('utf-8'))))
        except Exception as error:
            reply({'ok': False, 'error': str(error)})


if __name__ == '__main__':
    main()
