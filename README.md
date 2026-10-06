# YouTube 98

Browse your YouTube feed and watch videos on a **Windows 98 machine**, in
**Internet Explorer 5**, over plain HTTP.

A small server on a modern machine (Linux, macOS or Windows) does
everything the retro machine cannot: HTTPS, the modern YouTube page, and
H.264/VP9 decoding. The Win98
box only ever receives HTML 4.01 and pre-transcoded MPEG-1 files. Clicking
**Download** queues a video; when it is ready, **Play** launches it in a
local player.

Developed against a Pentium II 350 MHz with 192 MB RAM and an ATi Radeon
9200, running Win98SE and IE 5.0. MPEG-1 at 352x208 plays smoothly there.

```
  Win98SE box (IE5)                    server (Linux/macOS/Windows)
  ---------------------                ----------------------------
  feed page        <------ HTTP ------ node server.js  :8098
  thumbnails                           yt-dlp   (feed + download)
  XMLHTTP polling                      cookies.txt (exported by you)
                                       ffmpeg   (transcode to MPEG-1)
                                       worker   (serial job queue)
  Z:\youtube98\  <--- SMB share -----  $YT98_OUT
  player via youtube98: protocol
```

The retro box never does TLS, never sees H.264, and never runs Python.

---

## Requirements

**Server:** Linux, macOS or Windows 10/11 with Node.js (no npm packages
— stdlib only), Python 3,
`ffmpeg`, and [`yt-dlp`](https://github.com/yt-dlp/yt-dlp). Use a current
yt-dlp; distro packages are often too old to work against YouTube.

**Retro client:** Windows 98/98SE with IE 5.0+, a media player that handles
MPEG-1 (Media Player Classic, or the OS's own DirectShow decoder), and an
SMB share mapped to the output directory.

---

## Install

The server side runs on **Linux, macOS or Windows 10/11** — anywhere Node,
Python and ffmpeg run. The Win98 box is always the client.

### Linux / macOS

```sh
git clone https://github.com/goph-R/YouTube98.git
cd YouTube98

./install.sh                      # check deps, fetch yt-dlp, make dirs
./install.sh --systemd            # ...and install systemd --user units
./install.sh --help               # all options
```

`--systemd` writes four `systemd --user` units (server, worker, feed
service + 30-minute timer) with your paths baked in, enables lingering so
they survive logout, and starts them. No root required: yt-dlp goes to
`~/.local/bin`.

### Windows 10/11

```powershell
git clone https://github.com/goph-R/YouTube98.git
cd YouTube98

.\install.ps1                     # check deps and create directories
.\install.ps1 -InstallDeps        # install anything missing via winget
.\install.ps1 -Tasks              # register scheduled tasks (logon + 30min)
.\install.ps1 -Share -Firewall    # SMB share + open the port (needs admin)
Get-Help .\install.ps1 -Full
```

`-Tasks` generates `run-youtube98.cmd`, which holds the configuration —
scheduled tasks inherit no shell environment, so edit that file to change
settings afterwards.

> The PowerShell installer is **not tested on Windows** — it was written
> on Linux and only statically checked. Read it before running, and please
> report what breaks.

**Windows-specific caveats:**

- **Windows 98 needs SMB1** to reach a modern Windows share. Modern
  Windows disables it by default, and enabling it is a real security
  decision, not a checkbox. A Linux host with Samba configured for SMB1
  is the gentler option.
- **NTFS last-access timestamps are disabled by default**, so retention
  effectively orders by modification time rather than "least recently
  watched". It still enforces the size cap correctly.
- **There is no real `SIGTERM`.** Cancelling a job kills the child via
  `TerminateProcess`, so ffmpeg dies abruptly instead of cleanly — which
  is harmless here, since a cancelled job's partial output is discarded.

### Single-machine demo (no retro box)

Everything on one Windows 10/11 machine, viewed in a modern browser — no
SMB share, no protocol handler, no second computer:

```powershell
.\install.ps1 -InstallDeps
python refresh-feed.py
node server.js      # in one terminal
node worker.js      # in another
```

Then open **`http://localhost:8098/`** and use it as-is. The page is
HTML 4.01 built for IE5, so it looks like 1999, but everything works:
browsing, Download with its progress bar, STOP, public mode, retention.
The client script falls back from `ActiveXObject` to standard
`XMLHttpRequest` by itself.

Clicking a thumbnail copies the file's full local path, which is all you
need without the `youtube98:` handler — `YT98_WIN_PATH` defaults to
`YT98_OUT` on Windows, so the path is already right for this machine.

> **Use `localhost`, not the machine's LAN IP.** `navigator.clipboard`
> exists only in secure contexts, and `http://localhost` counts as one
> while `http://192.168.x.x` does not. Over an IP the page falls back to
> `execCommand("copy")` and then to `prompt()` — still usable, just less
> smooth.

Note the MPEG-1 352x208 output is sized for a Pentium II and will look
soft on a modern display. That is rather the point of the project; if you
want full-quality files on a one-machine setup, the transcode step is the
thing to make optional.

### Manual start (any platform)

```sh
python3 refresh-feed.py     # build the feed
node server.js              # the web server
node worker.js              # the download/transcode queue
```

Then open `http://<server>:8098/` on the Win98 box.

### Cookies

The personalised feed requires a logged-in session. yt-dlp reads a
Netscape-format `cookies.txt`.

Exporting from an **Android tablet** works well, and keeps the login off
both the server and the retro box:

- Firefox for Android + the **YT-DLP Cookie Exporter** add-on exports the
  right format directly.
- Chrome on Android is a dead end — its cookie database is app-private and
  unreadable without root.
- **Do not log out of YouTube in that browser afterwards.** Logging out
  invalidates the session server-side and kills the exported cookies.

> **`cookies.txt` is a credential.** Anyone who can read it is logged into
> your Google account. Keep it outside this repository, outside any web
> root and outside any file share, `chmod 600`. It is in `.gitignore`, but
> the safest place is somewhere this project cannot serve.

Note that automated downloading with account cookies is against YouTube's
Terms of Service. How you run this is your call.

### Playback handler (optional but recommended)

To make **Play** launch a local player, register the `youtube98:` protocol
on the Win98 machine:

```
md C:\youtube98
copy <share>\youtube98\_setup\play.vbs C:\youtube98\
```

Then run `setup/youtube98.reg` (copy it to the Win98 box first).

Windows hands a protocol handler the **entire URL** as `%1`, e.g.
`youtube98:Z:\youtube98\abc12345678.mpg` — which no media player can open.
`play.vbs` strips the scheme and launches the player with the bare path. It
searches common Media Player Classic locations and otherwise falls back to
the shell's `.mpg` association.

The `.reg` file uses the `REGEDIT4` header on purpose: the
`Windows Registry Editor Version 5.00` format is Windows 2000+ and Win98's
`regedit` refuses it.

Without the handler, clicking a **thumbnail** copies the file's Windows
path to the clipboard instead.

### Running as a service

`./install.sh --systemd` (Linux) or `.\install.ps1 -Tasks` (Windows) sets
this up. Two things that catch people out if you write the units by hand:

- **nvm-installed Node needs an absolute, versioned `ExecStart` path** —
  systemd gets no shell, so nvm's shell function is unavailable.
- **`PATH` must be set explicitly** in the worker unit, because `ffmpeg`
  is resolved from it and user services inherit no login environment.

---

## Configuration

All via environment variables. Defaults are portable; the installers
write them out for you.

| Variable | Default | Meaning |
|---|---|---|
| `YT98_PORT` | `8098` | server port |
| `YT98_COOKIES` | `~/cookies.txt` | Netscape cookie jar |
| `YT98_OUT` | `~/youtube98` | where finished `.mpg` files go (share this over SMB) |
| `YT98_WIN_PATH` | `Z:\youtube98\` (Windows: `YT98_OUT`) | the same directory as the Win98 box sees it |
| `YT98_PYTHON` | `/usr/bin/python3` (Windows: `python`) | interpreter used by the refresh endpoint |
| `YT98_FEED` | `:ytrec` | feed source (see below) |
| `YT98_LIMIT` | `150` | how many entries to ingest |
| `YT98_YTDLP` | `~/.local/bin/yt-dlp` (Windows: `yt-dlp.exe` on PATH) | yt-dlp binary |
| `YT98_KEEP_GB` | `20` | retention size cap |
| `YT98_KEEP_DAYS` | `0` | optional age cap, 0 = off |
| `YT98_THUMB_WORKERS` | `6` | parallel thumbnail fetches |

### Feed sources

yt-dlp exposes the account's own feeds. All need cookies:

| `YT98_FEED` | Feed |
|---|---|
| `:ytrec` | Recommended — the personalised home feed |
| `:ytsubs` | Subscriptions, in YouTube's order |
| `:ytwatchlater` | Watch Later |
| `:ytfav`, `:ythistory` | Favourites, watch history |

`:ytwatchlater` suits this workflow nicely: queue things on a phone, and
they appear on the retro box as a deliberate list.

---

## Using it

- **Download** — queues the video. The button caption becomes a progress
  bar, `D[####------] 40%` while downloading and `C[...]` while
  transcoding.
- **Stopping a job** — click an in-progress button once; it arms, showing
  `STOP? click again`. Click again within 4 seconds to cancel. (No
  `confirm()` dialog: IE5's return value is not dependable.) The partial
  download is discarded and the button returns to **Download**.
- **Play** — launches the local player via the `youtube98:` handler. It
  runs as a separate process, so you can keep browsing and paginating
  while the video plays.
- **Click a thumbnail** — copies the Windows path to the clipboard (only
  once the file exists).
- **Refresh feed** / **Refresh without cookies.txt** — rebuild the feed on
  demand. Also reachable as `/refresh` and `/refresh?nocookies=1`.
- **Deleting a `.mpg`** is supported: the file on disk is the source of
  truth, so the button reverts to **Download** on its own.

### Public mode

`/refresh?nocookies=1` turns on a **sticky** public mode: `cookies.txt` is
ignored, including by the scheduled refresh, and the feed is rebuilt from
public per-channel RSS. **Refresh feed** turns it back off.

This is also the automatic fallback when cookies expire, so the feed keeps
updating instead of freezing. The channel list is harvested from `:ytsubs`
whenever a logged-in refresh succeeds, so no manual export is needed.

Expect heavy overlap with the personalised feed — both draw on the same
subscribed channels, so public mode changes the *ranking* (newest first,
no algorithm), not the creators.

---

## Notes from building it

Things that cost real debugging time, in case they save you some:

- **IE5 has no `XMLHttpRequest`.** It is
  `new ActiveXObject("Microsoft.XMLHTTP")`, used synchronously here.
- **JScript 5.0 crashes on closures.** An async callback plus a
  `setTimeout(function(){...})` per poll caused an invalid page fault in
  `JSCRIPT.DLL` — its garbage collector, not the HTTP object. The client
  script therefore contains **no function expressions at all**: every
  function is named and global, timers are handed existing function
  objects, and no handler is ever reassigned to a DOM element.
- **Text is emitted as pure ASCII.** Non-ASCII becomes numeric character
  references, and characters Win98 cannot draw (emoji, dingbats) are
  stripped. Charset negotiation then stops mattering, and accented
  characters still render.
- **MPEG-1 codes in 16x16 macroblocks.** A height of 198 is coded as 208,
  and Win98's DirectShow decoder does not reliably crop the surplus rows —
  which show up as a green band, because the padding carries zeroed
  chroma. Output is therefore padded to a multiple of 16 with real black.
- **Cookies break downloads.** Authenticated requests get routed to player
  clients that fail with *"The page needs to be reloaded"*, while the same
  video downloads fine anonymously. So downloads are tried **anonymously
  first**, with cookies only as a fallback for age-restricted material.
  The *feed* still requires them.
- **Explicit `Content-Length`, `Connection: close`, no gzip.** Ancient
  clients handle chunked transfer and compression badly.
- Source is capped at 480p and h264 is preferred: the output is 352px wide,
  so anything larger is downloaded and decoded for nothing.

---

## Security

This has **no authentication whatsoever** and is designed for a trusted
LAN. `/enqueue`, `/cancel` and `/refresh` are reachable by anything that
can reach the port, and `/refresh` accepts `GET` (deliberately, so the URL
can be typed into IE5's address bar). **Do not expose it to the internet.**

Video ids are whitelisted to `^[A-Za-z0-9_-]{11}$` at every entry point and
all subprocesses are spawned with argument arrays, never a shell string.

---

## Limitations

- One encode at a time, by design.
- No search, no comments, no subscribing — it is a feed reader and
  downloader.
- Thumbnails accumulate in `thumbs/` and are never pruned.
- Public RSS carries no duration, so the worker probes the downloaded file
  instead.
- The author's older files predate the macroblock fix; re-download to
  clear the green band.

## License

[MIT](LICENSE).

Note that the MIT licence covers *this code only*. It says nothing about
YouTube's Terms of Service, which you are responsible for, and nothing
about the content you download.
