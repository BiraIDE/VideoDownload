#!/usr/bin/env bash
# Stream2JD helper installer — hardened (W2-B)
# Garante instalação idempotente, validações de pré-requisitos e writes atômicos.
set -euo pipefail

# --- 1) Pré-requisitos ---
if ! command -v python3 >/dev/null 2>&1; then
  printf 'Erro: python3 não encontrado no PATH\n' >&2
  exit 1
fi
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
  printf 'Erro: python3 >= 3.10 é necessário (encontrado %s)\n' "$(python3 --version 2>&1)" >&2
  exit 1
fi

base_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/stream2jd"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/stream2jd"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$install_dir" "$config_dir" "$unit_dir"

helper_dir="$base_dir/helper"
# Aceita também pacotes antigos que extraíram os dois arquivos na raiz.
if [[ ! -f "$helper_dir/stream2jd_helper.py" && -f "$base_dir/stream2jd_helper.py" ]]; then
  helper_dir="$base_dir"
fi
if [[ ! -f "$helper_dir/stream2jd_helper.py" || ! -f "$helper_dir/stream2jd_native.py" ]]; then
  printf 'Erro: arquivos do Helper não encontrados em %s\n' "$base_dir" >&2
  exit 1
fi

# Valida sintaxe Python antes de instalar
python3 -m py_compile "$helper_dir/stream2jd_helper.py" "$helper_dir/stream2jd_native.py" || {
  printf 'Erro: falha na validação de sintaxe Python do helper\n' >&2
  exit 1
}

install -m 755 "$helper_dir/stream2jd_helper.py" "$install_dir/stream2jd_helper.py"
install -m 755 "$helper_dir/stream2jd_native.py" "$install_dir/stream2jd_native.py"

# Token atômico com permissão 600
if [[ ! -s "$config_dir/token" ]]; then
  tmp_token="$(mktemp "$config_dir/token.XXXXXX")"
  chmod 600 "$tmp_token"
  python3 -c 'import secrets,sys;open(sys.argv[1],"w").write(secrets.token_urlsafe(32))' "$tmp_token"
  mv -f "$tmp_token" "$config_dir/token"
  chmod 600 "$config_dir/token"
fi

# Systemd (tolerante a ambientes sem systemd --user)
if [[ -f "$base_dir/packaging/stream2jd.service.in" ]]; then
  tmp_unit="$(mktemp)"
  sed "s|@HELPER@|$install_dir/stream2jd_helper.py|g" "$base_dir/packaging/stream2jd.service.in" > "$tmp_unit"
  mv -f "$tmp_unit" "$unit_dir/stream2jd.service"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user enable stream2jd.service 2>/dev/null || true
    systemctl --user restart stream2jd.service 2>/dev/null || printf 'Aviso: não foi possível reiniciar stream2jd.service; inicie manualmente.\n' >&2
  fi
else
  printf 'Aviso: packaging/stream2jd.service.in não encontrado; pulando systemd\n' >&2
fi

# Native messaging manifests (Chrome/Firefox) — writes atômicos + validação JSON
firefox_native_dir="$HOME/.mozilla/native-messaging-hosts"
mkdir -p "$firefox_native_dir"
if [[ -f "$base_dir/packaging/native-firefox.json.in" ]]; then
  tmp_manifest="$(mktemp)"
  sed "s|@NATIVE@|$install_dir/stream2jd_native.py|g" "$base_dir/packaging/native-firefox.json.in" > "$tmp_manifest"
  python3 -m json.tool "$tmp_manifest" >/dev/null || { printf 'Erro: native-firefox.json gerado é JSON inválido\n' >&2; exit 1; }
  mv -f "$tmp_manifest" "$firefox_native_dir/stream2jd.json"
  chmod 600 "$firefox_native_dir/stream2jd.json"
fi
for chromium_native_dir in \
  "$HOME/.config/chromium/NativeMessagingHosts" \
  "$HOME/.config/google-chrome/NativeMessagingHosts" \
  "$HOME/.config/google-chrome-beta/NativeMessagingHosts" \
  "$HOME/.config/google-chrome-unstable/NativeMessagingHosts" \
  "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
  "$HOME/.config/vivaldi/NativeMessagingHosts"; do
  mkdir -p "$chromium_native_dir"
  if [[ -f "$base_dir/packaging/native-chromium.json.in" ]]; then
    tmp_manifest="$(mktemp)"
    sed "s|@NATIVE@|$install_dir/stream2jd_native.py|g" "$base_dir/packaging/native-chromium.json.in" > "$tmp_manifest"
    python3 -m json.tool "$tmp_manifest" >/dev/null || { printf 'Erro: native-chromium.json inválido para %s\n' "$chromium_native_dir" >&2; rm -f "$tmp_manifest"; continue; }
    mv -f "$tmp_manifest" "$chromium_native_dir/stream2jd.json"
    chmod 600 "$chromium_native_dir/stream2jd.json"
  fi
done

# JDownloader: whitelists loopback para Click'n'Load (idempotente)
jd_auth_file="$HOME/.jd/cfg/org.jdownloader.api.RemoteAPIConfig.externinterfaceauth.json"
if [[ -d "$(dirname -- "$jd_auth_file")" ]]; then
  python3 - "$jd_auth_file" <<'PYEOF'
import json, os, sys
from pathlib import Path
target = Path(sys.argv[1])
try:
    allowed = json.loads(target.read_text(encoding='utf-8')) if target.exists() else []
except (OSError, ValueError):
    allowed = []
if not isinstance(allowed, list):
    allowed = []
for hostname in ('127.0.0.1', 'stream2jd.local'):
    if hostname not in allowed:
        allowed.append(hostname)
temporary = target.with_suffix(target.suffix + '.stream2jd.tmp')
temporary.write_text(json.dumps(allowed, ensure_ascii=False), encoding='utf-8')
os.replace(temporary, target)
PYEOF
fi
jd_rules_file="$HOME/.jd/cfg/org.jdownloader.settings.GeneralSettings.domainrules.json"
if [[ -d "$(dirname -- "$jd_rules_file")" ]]; then
  python3 - "$jd_rules_file" <<'PYEOF'
import json, os, sys
from pathlib import Path
target = Path(sys.argv[1])
try:
    rules = json.loads(target.read_text(encoding='utf-8')) if target.exists() else []
except (OSError, ValueError):
    rules = []
if not isinstance(rules, list):
    rules = []
domain_pattern = r'127\.0\.0\.1'
rule = next((item for item in rules if isinstance(item, dict) and item.get('domainPattern') == domain_pattern), None)
if rule is None:
    rule = {
        'accountPattern': None,
        'domainPattern': domain_pattern,
        'filenamePattern': None,
        'maxChunks': 1,
        'maxSimultanDownloads': 3,
        'pluginPattern': None,
        'allowToExceedTheGlobalLimit': False,
        'enabled': True,
    }
    rules.append(rule)
else:
    rule['maxChunks'] = 1
    rule['enabled'] = True
temporary = target.with_suffix(target.suffix + '.stream2jd.tmp')
temporary.write_text(json.dumps(rules, ensure_ascii=False), encoding='utf-8')
os.replace(temporary, target)
PYEOF
fi
jd_youtube_dir="$HOME/.jd/cfg/plugins/youtube"
if [[ -d "$jd_youtube_dir" ]]; then
  python3 - "$jd_youtube_dir/Youtube.json" "$jd_youtube_dir/Youtube.collections.json" <<'PYEOF'
import json, os, shutil, sys
from pathlib import Path

def load(path, fallback):
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        return value
    except (OSError, ValueError):
        return fallback

def backup_once(path):
    if not path.exists():
        return
    backup = path.with_suffix(path.suffix + '.before-stream2jd')
    if not backup.exists():
        shutil.copy2(path, backup)

def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.stream2jd.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(temporary, path)

settings_path = Path(sys.argv[1])
collections_path = Path(sys.argv[2])
backup_once(settings_path)
backup_once(collections_path)
settings = load(settings_path, {})
if not isinstance(settings, dict):
    settings = {}
settings.update({
    'maxvideoresolution': 'P_4320',
    'collectionmergingenabled': True,
    'dashmuxingenabled': True,
    'externmultimediatoolusageenabled': True,
    'videofilenamepattern2': '*VIDEO_NAME*.*EXT*',
})
atomic_json(settings_path, settings)
collections = load(collections_path, [])
if not isinstance(collections, list):
    collections = []
normal_found = False
for item in collections:
    if not isinstance(item, dict):
        continue
    is_normal = item.get('groupingID') == 'VIDEO_NORMAL'
    item['enabled'] = is_normal
    normal_found = normal_found or is_normal
if not normal_found:
    collections.append({
        'dropdown': None,
        'groupingID': 'VIDEO_NORMAL',
        'name': 'Melhor VIDEO NORMAL',
        'variants': None,
        'enabled': True,
    })
atomic_json(collections_path, collections)
PYEOF
fi
printf 'Ponte Stream2JD e integração nativa instaladas. O YouTube agora aceita a qualidade escolhida e mantém somente um vídeo final. Reinicie o JDownloader uma vez para carregar a política.\n'
