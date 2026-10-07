#!/usr/bin/env python3
"""
youtube98 — feed ingestion (plan section 2, step 1)

Pulls the logged-in YouTube feed via yt-dlp, filters out anything that
cannot be downloaded, fetches and downscales thumbnails, and writes
cache/feed.json for the IE5 frontend to render.

Run from cron. Needs: yt-dlp, ffmpeg, a Netscape cookies.txt.

Usage:
    ./refresh-feed.py                  # use FEED below
    ./refresh-feed.py :ytwatchlater    # override feed source
    ./refresh-feed.py --limit 20
"""

import concurrent.futures
import datetime
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ElementTree

# --- config ---------------------------------------------------------------

BASE = os.path.dirname(os.path.abspath(__file__))

FEED = os.environ.get("YT98_FEED", ":ytrec")
# :ytrec | :ytsubs | :ytwatchlater | :ytfav | :ythistory
LIMIT = int(os.environ.get("YT98_LIMIT", "150"))

# Thumbnails are fetched concurrently. phobos is a 2c/4t Athlon, but this is
# network-bound with a trivial ffmpeg scale per image, so a modest pool is
# the difference between ~42s and ~8s for 150 items.
THUMB_WORKERS = int(os.environ.get("YT98_THUMB_WORKERS", "6"))

# Kept outside the project dir, the web root and the Samba share on purpose:
# this file is an account credential. chmod 600.
COOKIES = os.environ.get("YT98_COOKIES", os.path.expanduser("~/cookies.txt"))
# yt-dlp.exe from PATH on Windows; the standalone binary in ~/.local/bin
# elsewhere. Override with YT98_YTDLP.
YTDLP = os.environ.get(
    "YT98_YTDLP",
    "yt-dlp.exe" if os.name == "nt" else os.path.expanduser("~/.local/bin/yt-dlp"))

CACHE_DIR = os.path.join(BASE, "cache")
THUMB_DIR = os.path.join(BASE, "thumbs")
FEED_JSON = os.path.join(CACHE_DIR, "feed.json")

# --- unauthenticated fallback ---------------------------------------------
#
# The personalised feed needs cookies, and cookies expire. Without a
# fallback the page froze on the last good list until someone noticed.
#
# YouTube still serves per-channel RSS with no auth at all, so the channel
# list is harvested from :ytsubs *while cookies work* and reused when they
# do not. No Google Takeout step: the ids are already reachable. (Anonymous
# /feed/trending was checked and now redirects to the home page, so there
# is no zero-setup generic list to use instead.)
CHANNELS_JSON = os.path.join(CACHE_DIR, "channels.json")

# Sticky public mode. When this file exists, cookies.txt is ignored on
# purpose and the feed is always built from public RSS.
#
# Needed because the 30-minute timer runs with cookies and was silently
# dragging the feed back out of fallback mode within half an hour, so
# "ignore cookies.txt" could not actually be stayed in.
PUBLIC_FLAG = os.path.join(CACHE_DIR, "public-mode")
CHANNELS_MAX_AGE_DAYS = 7
CHANNELS_SCAN = 400
RSS_URL = "https://www.youtube.com/feeds/videos.xml?channel_id={cid}"
RSS_WORKERS = 8
CHANNEL_ID_RE = re.compile(r"^UC[A-Za-z0-9_-]{22}$")
ATOM = "{http://www.w3.org/2005/Atom}"
YT = "{http://www.youtube.com/xml/schemas/2015}"

# Sourced from mqdefault (320x180) so there are no letterbox bars to waste
# pixels on. Stored at the source size by default now that the page
# stretches thumbnails to the cell width: at 1024x768 a cell is ~250px, so
# a 160px image would be upscaled and look soft. Drop these back to 160/90
# if the retro box struggles to decode a page of the larger ones.
THUMB_W = int(os.environ.get("YT98_THUMB_W", "320"))
THUMB_H = int(os.environ.get("YT98_THUMB_H", "180"))
THUMB_SRC = "https://i.ytimg.com/vi/{id}/mqdefault.jpg"
# ffmpeg -q:v, 2 (best) to 31 (worst). Raising this is the cheapest way to
# cut page weight without losing resolution.
THUMB_Q = os.environ.get("YT98_THUMB_Q", "4")

HTTP_TIMEOUT = 20

# A YouTube video id is exactly 11 of these characters. The :ytrec feed also
# returns Mix/radio *playlist* entries (ids like RDHS13EKO8J9M) which are not
# downloadable as a single video and have no i.ytimg.com/vi/ thumbnail. This
# is the same whitelist the download endpoint uses, so the rule lives in one
# place conceptually: if it is not a video id, it never enters the feed.
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

# Titles yt-dlp reports for entries that exist but cannot be fetched.
UNAVAILABLE_TITLES = {
    "[private video]",
    "[deleted video]",
    "[unavailable video]",
    "[age restricted video]",
}


# --- helpers --------------------------------------------------------------


def log(msg):
    print("[youtube98] %s" % msg, file=sys.stderr)


def fail(msg, stale=False):
    """Write a machine-readable error state, then exit non-zero.

    The frontend reads `error` out of feed.json so a stale cookie shows a
    real message instead of an empty page.
    """
    os.makedirs(CACHE_DIR, exist_ok=True)
    prev = {}
    if os.path.exists(FEED_JSON):
        try:
            with open(FEED_JSON) as fh:
                prev = json.load(fh)
        except (OSError, ValueError):
            prev = {}
    prev["error"] = msg
    prev["stale_cookies"] = stale
    prev["checked"] = int(time.time())
    with open(FEED_JSON, "w") as fh:
        json.dump(prev, fh, indent=1)
    log("ERROR: %s" % msg)
    sys.exit(1)


def fetch_feed(feed, limit):
    """Try the authenticated feed.

    Returns (entries, error, stale). Does not exit: the caller decides
    whether to fall back to RSS, so a failure here is a value rather than
    the end of the run.
    """
    cmd = [
        YTDLP,
        "--cookies", COOKIES,
        "--flat-playlist",
        "--playlist-end", str(limit),
        "--no-warnings",
        "-J",
        feed,
    ]
    log("fetching %s (limit %d)" % (feed, limit))
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except FileNotFoundError:
        return None, "yt-dlp not found at %s" % YTDLP, False
    except subprocess.TimeoutExpired:
        return None, "yt-dlp timed out after 300s", False

    if proc.returncode != 0:
        err = (proc.stderr or "").strip()
        low = err.lower()
        stale = any(
            s in low
            for s in ("sign in", "login required", "cookies", "not a bot",
                      "account", "consent")
        )
        last = err.splitlines()[-1][:200] if err else "no output"
        if stale:
            return None, "cookies stale — re-export from the tablet (%s)" % last, True
        return None, "yt-dlp failed: %s" % last, False

    try:
        data = json.loads(proc.stdout)
    except ValueError:
        return None, "could not parse yt-dlp JSON output", False

    entries = data.get("entries") or []
    if not entries:
        return None, "feed returned no entries — cookies may be stale", True
    return entries, None, False


# --- channel list, harvested while authentication still works -------------


def load_channels():
    try:
        with open(CHANNELS_JSON) as fh:
            data = json.load(fh)
        return data.get("channels") or [], data.get("saved") or 0
    except (OSError, ValueError):
        return [], 0


def harvest_channels():
    """Cache the subscription channel ids for later unauthenticated use.

    Deliberately sourced from :ytsubs rather than Google Takeout: the ids
    are already reachable while cookies are good, so the fallback can
    maintain its own input with no manual export step ever.
    """
    cmd = [
        YTDLP,
        "--cookies", COOKIES,
        "--flat-playlist",
        "--playlist-end", str(CHANNELS_SCAN),
        "--no-warnings",
        "--print", "%(channel_id)s",
        ":ytsubs",
    ]
    log("harvesting subscription channel ids")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as exc:
        log("channel harvest failed: %s" % exc)
        return
    if proc.returncode != 0:
        log("channel harvest failed (rc=%d)" % proc.returncode)
        return

    seen, ids = set(), []
    for line in (proc.stdout or "").splitlines():
        cid = line.strip()
        if CHANNEL_ID_RE.match(cid) and cid not in seen:
            seen.add(cid)
            ids.append(cid)
    if not ids:
        log("channel harvest produced nothing; keeping any previous list")
        return

    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = CHANNELS_JSON + ".part"
    with open(tmp, "w") as fh:
        json.dump({"saved": int(time.time()), "channels": ids}, fh, indent=1)
    os.replace(tmp, CHANNELS_JSON)
    log("cached %d subscription channel ids" % len(ids))


def maybe_harvest_channels():
    """Refresh the cached channel list when it is missing or stale."""
    ids, saved = load_channels()
    age_days = (time.time() - saved) / 86400.0 if saved else 1e9
    if ids and age_days < CHANNELS_MAX_AGE_DAYS:
        return
    harvest_channels()


# --- unauthenticated fallback: per-channel RSS ----------------------------


def fetch_channel_rss(channel_id):
    """One channel's 15 most recent uploads, no auth required."""
    url = RSS_URL.format(cid=channel_id)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "youtube98/1.0"})
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            blob = resp.read()
    except (urllib.error.URLError, OSError) as exc:
        log("rss fetch failed for %s: %s" % (channel_id, exc))
        return []

    try:
        root = ElementTree.fromstring(blob)
    except ElementTree.ParseError as exc:
        log("rss parse failed for %s: %s" % (channel_id, exc))
        return []

    out = []
    for entry in root.findall(ATOM + "entry"):
        vid = entry.findtext(YT + "videoId") or ""
        if not VIDEO_ID_RE.match(vid):
            continue
        author = entry.find(ATOM + "author")
        published = entry.findtext(ATOM + "published") or ""
        try:
            ts = datetime.datetime.fromisoformat(published).timestamp()
        except ValueError:
            ts = 0
        out.append({
            "id": vid,
            "title": (entry.findtext(ATOM + "title") or "").strip(),
            "channel": (author.findtext(ATOM + "name") if author is not None else "") or "",
            # RSS carries no duration. The worker ffprobes the downloaded
            # source when this is 0, so convert progress still works.
            "duration": 0,
            "published": int(ts),
        })
    return out


def fetch_rss_fallback(limit):
    """Merge every cached channel's RSS into one chronological list."""
    ids, saved = load_channels()
    if not ids:
        return None, "no cached channel list to fall back on"

    log("falling back to RSS across %d channels (list saved %s)"
        % (len(ids), time.strftime("%Y-%m-%d", time.localtime(saved)) if saved else "?"))

    merged = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=RSS_WORKERS) as pool:
        for got in pool.map(fetch_channel_rss, ids):
            merged.extend(got)

    if not merged:
        return None, "every channel RSS fetch failed"

    # Newest first, deduplicated by video id.
    merged.sort(key=lambda e: e.get("published") or 0, reverse=True)
    seen, out = set(), []
    for e in merged:
        if e["id"] in seen:
            continue
        seen.add(e["id"])
        out.append(e)
        if len(out) >= limit:
            break
    log("rss fallback assembled %d videos from %d channels" % (len(out), len(ids)))
    return out, None


def usable(entry):
    """Filter out entries that exist but cannot be downloaded."""
    if not entry:
        return False
    if not VIDEO_ID_RE.match(entry.get("id") or ""):
        return False  # playlist / mix / malformed
    title = (entry.get("title") or "").strip()
    if not title or title.lower() in UNAVAILABLE_TITLES:
        return False
    # yt-dlp sets this on members-only / private / removed items.
    if entry.get("availability") in ("private", "needs_auth", "unlisted_but_removed"):
        return False
    return True


def make_thumb(video_id):
    """Download and downscale one thumbnail. Returns a relative path or None."""
    out = os.path.join(THUMB_DIR, "%s.jpg" % video_id)
    rel = "thumbs/%s.jpg" % video_id
    if os.path.exists(out) and os.path.getsize(out) > 0:
        return rel  # cached

    url = THUMB_SRC.format(id=video_id)
    tmp = os.path.join(THUMB_DIR, ".%s.src.jpg" % video_id)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "youtube98/1.0"})
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            blob = resp.read()
        if not blob:
            return None
        with open(tmp, "wb") as fh:
            fh.write(blob)
    except (urllib.error.URLError, OSError) as exc:
        log("thumb download failed for %s: %s" % (video_id, exc))
        return None

    # ffmpeg rather than PIL: already installed, and emits baseline JPEG,
    # which is what IE5 renders most reliably.
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", tmp,
        "-vf", "scale=%d:%d" % (THUMB_W, THUMB_H),
        "-q:v", THUMB_Q,
        out,
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=60)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        log("ffmpeg scale failed for %s: %s" % (video_id, exc))
        return None
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

    return rel


def main():
    feed, limit = FEED, LIMIT
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--limit":
            limit = int(args[i + 1])
            i += 2
        elif args[i].startswith(":"):
            feed = args[i]
            i += 1
        else:
            log("unknown argument: %s" % args[i])
            sys.exit(2)

    os.makedirs(CACHE_DIR, exist_ok=True)
    os.makedirs(THUMB_DIR, exist_ok=True)

    # Sticky public mode wins over everything, including a perfectly good
    # cookies.txt — that is the point of it.
    forced_public = os.path.exists(PUBLIC_FLAG)

    if forced_public:
        log("public-mode flag set: ignoring cookies.txt on purpose")
        entries, auth_err, stale = None, "public mode selected: cookies.txt ignored", False
    elif os.path.exists(COOKIES):
        entries, auth_err, stale = fetch_feed(feed, limit)
    else:
        entries, auth_err, stale = None, "cookies file missing: %s" % COOKIES, True

    fallback = False
    if entries:
        # Cookies are good right now, so top up the channel list for the
        # day they are not.
        maybe_harvest_channels()
    else:
        log("authenticated fetch failed: %s" % auth_err)
        entries, rss_err = fetch_rss_fallback(limit)
        if not entries:
            fail("%s; fallback also failed: %s" % (auth_err, rss_err), stale=stale)
        fallback = True
        feed = "rss-fallback"

    good = [e for e in entries if usable(e)]
    skipped = len(entries) - len(good)

    # Fetch thumbnails concurrently, then assemble in feed order so the
    # page ordering still reflects the feed's own ranking.
    thumbs = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=THUMB_WORKERS) as pool:
        futures = {pool.submit(make_thumb, e["id"]): e["id"] for e in good}
        for fut in concurrent.futures.as_completed(futures):
            vid = futures[fut]
            try:
                thumbs[vid] = fut.result()
            except Exception as exc:  # never let one bad image kill the run
                log("thumb worker failed for %s: %s" % (vid, exc))
                thumbs[vid] = None

    kept = [{
        "id": e["id"],
        "src": thumbs.get(e["id"]) or "",
        "title": (e.get("title") or "").strip(),
        "channel": e.get("channel") or e.get("uploader") or "",
        "duration": e.get("duration") or 0,
        # Publish time, when the source provides one. RSS always does;
        # yt-dlp's flat playlists sometimes do. Shown per tile so a
        # chronological list is visibly chronological — without it the
        # fallback is indistinguishable from the personalised feed at a
        # glance, which caused exactly that confusion.
        "published": e.get("published") or e.get("timestamp") or 0,
    } for e in good]

    if not kept:
        fail("every entry was filtered out as undownloadable")

    out = {
        "generated": int(time.time()),
        "checked": int(time.time()),
        "feed": feed,
        "count": len(kept),
        "skipped": skipped,
        # In fallback mode the list is real and current, but chronological
        # rather than personalised — the page says so rather than passing
        # it off as the normal feed.
        "fallback": fallback,
        # Deliberate public mode is NOT a stale-cookie condition. Conflating
        # them made the page claim "cookies are stale — re-export from the
        # tablet" when nothing was wrong and the mode had been chosen.
        "public_mode": forced_public,
        "stale_cookies": bool(fallback and not forced_public),
        "error": auth_err if (fallback and not forced_public) else None,
        "videos": kept,
    }
    with open(FEED_JSON, "w") as fh:
        json.dump(out, fh, indent=1)

    missing = sum(1 for v in kept if not v["src"])
    log("wrote %d videos to %s (%d skipped as undownloadable, %d without thumbnail)"
        % (len(kept), FEED_JSON, skipped, missing))


if __name__ == "__main__":
    main()
