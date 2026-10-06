#!/usr/bin/env bash
#
# YouTube 98 — server-side installer for Linux / macOS.
#
#   ./install.sh                         check deps, fetch yt-dlp, make dirs
#   ./install.sh --out /srv/youtube98    choose the output directory
#   ./install.sh --systemd               also install systemd --user units
#   ./install.sh --help
#
# Installs nothing system-wide and needs no root: yt-dlp goes to
# ~/.local/bin and the service units are user units.

set -euo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OUT_DIR="${YT98_OUT:-$HOME/youtube98}"
WIN_PATH="${YT98_WIN_PATH:-Z:\\youtube98\\}"
PORT="${YT98_PORT:-8098}"
COOKIES="${YT98_COOKIES:-$HOME/cookies.txt}"
WANT_SYSTEMD=0
WANT_YTDLP=1

say()  { printf '  %s\n' "$*"; }
head2() { printf '\n== %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --out)       OUT_DIR="$2"; shift 2 ;;
    --win-path)  WIN_PATH="$2"; shift 2 ;;
    --port)      PORT="$2"; shift 2 ;;
    --cookies)   COOKIES="$2"; shift 2 ;;
    --systemd)   WANT_SYSTEMD=1; shift ;;
    --no-ytdlp)  WANT_YTDLP=0; shift ;;
    --help|-h)
      sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      cat <<EOF

Options:
  --out DIR        where finished .mpg files go (default: \$HOME/youtube98)
  --win-path P     that directory as the Win98 box sees it
                   (default: Z:\\youtube98\\)
  --port N         server port (default: 8098)
  --cookies FILE   Netscape cookie jar (default: \$HOME/cookies.txt)
  --systemd        install and start systemd --user units
  --no-ytdlp       skip the yt-dlp download
EOF
      exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# --- dependencies ---------------------------------------------------------

head2 "Checking dependencies"

NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "node not found. Install Node.js (distro package or nvm)."
say "node    $("$NODE" --version)  ($NODE)"

PYTHON="$(command -v python3 || true)"
[ -n "$PYTHON" ] || die "python3 not found."
say "python  $("$PYTHON" --version 2>&1)  ($PYTHON)"

FFMPEG="$(command -v ffmpeg || true)"
[ -n "$FFMPEG" ] || die "ffmpeg not found. Install it with your package manager."
say "ffmpeg  $("$FFMPEG" -version | head -1 | cut -d' ' -f3)  ($FFMPEG)"

# --- yt-dlp ---------------------------------------------------------------

head2 "yt-dlp"

YTDLP="${YT98_YTDLP:-$HOME/.local/bin/yt-dlp}"
if [ "$WANT_YTDLP" = 1 ]; then
  # The standalone release binary rather than a distro package: packaged
  # yt-dlp goes stale quickly and YouTube breaks it.
  mkdir -p "$(dirname "$YTDLP")"
  say "fetching the latest release to $YTDLP"
  if command -v curl >/dev/null; then
    curl -fsSL -o "$YTDLP" \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
  elif command -v wget >/dev/null; then
    wget -qO "$YTDLP" \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
  else
    die "need curl or wget to fetch yt-dlp (or pass --no-ytdlp)"
  fi
  chmod +x "$YTDLP"
fi
[ -x "$YTDLP" ] || die "yt-dlp not executable at $YTDLP"
say "yt-dlp  $("$YTDLP" --version)  ($YTDLP)"

case ":$PATH:" in
  *":$(dirname "$YTDLP"):"*) ;;
  *) say "note: $(dirname "$YTDLP") is not on your PATH (fine — the code uses the full path)" ;;
esac

# --- directories ----------------------------------------------------------

head2 "Directories"
mkdir -p "$OUT_DIR/.tmp" "$BASE/cache/jobs" "$BASE/thumbs"
say "output  $OUT_DIR"
say "cache   $BASE/cache"
[ -w "$OUT_DIR" ] || die "output directory is not writable: $OUT_DIR"

# --- cookies --------------------------------------------------------------

head2 "Cookies"
if [ -f "$COOKIES" ]; then
  chmod 600 "$COOKIES"
  say "found $COOKIES (permissions set to 600)"
  if ! head -1 "$COOKIES" | grep -qi "netscape"; then
    say "WARNING: does not look like a Netscape cookies.txt"
  fi
else
  say "no cookie jar at $COOKIES"
  say "The personalised feed needs one. Export a Netscape cookies.txt"
  say "(Firefox for Android + the YT-DLP Cookie Exporter add-on works well)"
  say "and keep it OUTSIDE this directory. Public mode works without it."
fi

case "$COOKIES" in
  "$BASE"/*) say "WARNING: the cookie jar is inside the project directory. Move it out." ;;
  "$OUT_DIR"/*) say "WARNING: the cookie jar is inside the shared output directory. Move it out." ;;
esac

# --- systemd --------------------------------------------------------------

if [ "$WANT_SYSTEMD" = 1 ]; then
  head2 "systemd --user units"
  command -v systemctl >/dev/null || die "systemctl not found"
  UNITS="$HOME/.config/systemd/user"
  mkdir -p "$UNITS"

  common="WorkingDirectory=$BASE
Environment=YT98_OUT=$OUT_DIR
Environment=YT98_WIN_PATH=$WIN_PATH
Environment=YT98_PORT=$PORT
Environment=YT98_COOKIES=$COOKIES
Environment=YT98_YTDLP=$YTDLP
Environment=PATH=$(dirname "$NODE"):$(dirname "$YTDLP"):/usr/local/bin:/usr/bin:/bin"

  cat > "$UNITS/youtube98-server.service" <<EOF
[Unit]
Description=YouTube 98 server (IE5 frontend on :$PORT)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
$common
ExecStart=$NODE $BASE/server.js
Restart=always
RestartSec=3
SyslogIdentifier=youtube98-server

[Install]
WantedBy=default.target
EOF

  cat > "$UNITS/youtube98-worker.service" <<EOF
[Unit]
Description=YouTube 98 download/transcode worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
$common
ExecStart=$NODE $BASE/worker.js
Restart=always
RestartSec=5
SyslogIdentifier=youtube98-worker

[Install]
WantedBy=default.target
EOF

  cat > "$UNITS/youtube98-feed.service" <<EOF
[Unit]
Description=YouTube 98 feed refresh
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
$common
ExecStart=$PYTHON $BASE/refresh-feed.py
SyslogIdentifier=youtube98-feed

[Install]
WantedBy=default.target
EOF

  cat > "$UNITS/youtube98-feed.timer" <<EOF
[Unit]
Description=Refresh the YouTube 98 feed every 30 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=30min
Persistent=true
AccuracySec=1min
Unit=youtube98-feed.service

[Install]
WantedBy=timers.target
EOF

  say "wrote 4 units to $UNITS"

  # Without lingering, user units stop when the last session closes.
  if command -v loginctl >/dev/null; then
    if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" != "yes" ]; then
      say "enabling linger so the units survive logout (may ask for a password)"
      loginctl enable-linger "$USER" || say "could not enable linger; run: sudo loginctl enable-linger $USER"
    fi
  fi

  systemctl --user daemon-reload
  systemctl --user enable --now \
    youtube98-server.service youtube98-worker.service youtube98-feed.timer
  say "enabled and started"
  systemctl --user --no-pager --no-legend list-units 'youtube98*' | sed 's/^/  /'
fi

# --- done -----------------------------------------------------------------

head2 "Done"
if [ "$WANT_SYSTEMD" = 1 ]; then
  say "Open http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT/ from the retro box."
  say "Logs: journalctl --user -u youtube98-server -f"
else
  say "Build the feed:   ./refresh-feed.py"
  say "Start the server: node server.js"
  say "Start the worker: node worker.js"
  say "Then open http://<this-host>:$PORT/ from the retro box."
  say "Re-run with --systemd to install services instead."
fi
say ""
say "Export $OUT_DIR over SMB and map it on the Win98 box,"
say "then set --win-path to match (currently $WIN_PATH)."
say "For Play to work, install setup/play.vbs + setup/youtube98.reg there."
