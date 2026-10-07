#!/usr/bin/env node
/*
 * youtube98 — server (plan section 3, step 2)
 *
 * Serves the feed page and thumbnails to IE5 on the Win98SE box over plain
 * HTTP. No framework, no build step, no dependencies.
 *
 *   node server.js            # listens on 0.0.0.0:8098
 *   YT98_PORT=9000 node server.js
 *
 * The /enqueue and /status endpoints land in step 3; the Download buttons
 * are rendered but inert for now.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const PROF = require('./profiles');

const BASE = __dirname;
const PORT = parseInt(process.env.YT98_PORT || '8098', 10);
const FEED_JSON = path.join(BASE, 'cache', 'feed.json');
const THUMB_DIR = path.join(BASE, 'thumbs');
const JOB_DIR = path.join(BASE, 'cache', 'jobs');
// Sane default on both platforms; override with YT98_OUT. On Windows this
// is the folder you share over SMB for the retro box to map.
const OUT_DIR = process.env.YT98_OUT || path.join(os.homedir(), 'youtube98');
const PER_PAGE = 12; // 4 across x 3 down — fits 800x600 without scrolling much
const COLS = 4;

/*
 * The output directory as the *Win98 box* sees it, used for the
 * youtube98: links and the copy-path button.
 *
 * On Linux the server's path and the retro box's path differ (the share
 * is mapped to a drive letter), so this has to be configured separately.
 * On Windows the server is usually the machine holding the files, so
 * OUT_DIR itself is a sensible default.
 */
const WIN_PATH = process.env.YT98_WIN_PATH ||
  (process.platform === 'win32' ? OUT_DIR + '\\' : 'Z:\\youtube98\\');

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// --- manual feed refresh --------------------------------------------------

// `python` on Windows (that is what python.org installs), `python3`
// elsewhere. Override with YT98_PYTHON.
const PYTHON = process.env.YT98_PYTHON ||
  (process.platform === 'win32' ? 'python' : '/usr/bin/python3');
const REFRESH_SCRIPT = path.join(BASE, 'refresh-feed.py');

/*
 * Public mode is a flag file rather than a per-run environment override.
 *
 * A one-shot override did not survive: the 30-minute timer runs with
 * cookies and dragged the feed back out of fallback within half an hour,
 * so "ignore cookies.txt" could not be stayed in. refresh-feed.py checks
 * this file on every run, including the timer's.
 *
 * `?nocookies=1` sets it; a plain refresh clears it. The real cookies.txt
 * is never touched either way.
 */
const PUBLIC_FLAG = path.join(BASE, 'cache', 'public-mode');

function publicMode() {
  return fs.existsSync(PUBLIC_FLAG);
}

function setPublicMode(on) {
  try {
    fs.mkdirSync(path.dirname(PUBLIC_FLAG), { recursive: true });
    if (on) fs.writeFileSync(PUBLIC_FLAG, new Date().toISOString() + '\n');
    else if (fs.existsSync(PUBLIC_FLAG)) fs.unlinkSync(PUBLIC_FLAG);
  } catch (e) {
    console.log('could not update public-mode flag: ' + e.message);
  }
}

let refreshing = false;
let lastRefresh = null;

/*
 * "audio" or "video" from a request. Anything unrecognised means video,
 * so an old client or a hand-typed URL keeps working.
 */
function kindOf(v) {
  return String(v == null ? '' : v).toLowerCase() === 'audio' ? 'audio' : 'video';
}

function truthy(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

// --- text handling for a 1999 browser -------------------------------------

/*
 * Win98 fonts have no emoji and IE5's UTF-8 handling is not worth trusting
 * with mixed scripts. Two-step defence:
 *   1. drop code points Win98 cannot draw (astral plane, dingbats, arrows)
 *   2. emit everything non-ASCII as a numeric character reference
 * The response body therefore ends up pure ASCII and charset negotiation
 * stops mattering, while Hungarian accents still render from the system font.
 */
function stripUndrawable(s) {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) continue;                    // emoji, astral symbols
    if (cp >= 0xfe00 && cp <= 0xfe0f) continue;   // variation selectors
    if (cp >= 0x2190 && cp <= 0x2bff) continue;   // arrows, dingbats, misc
    if (cp >= 0x200b && cp <= 0x200f) continue;   // zero-width / bidi marks
    out += ch;
  }
  return out;
}

function esc(raw) {
  const s = stripUndrawable(String(raw == null ? '' : raw));
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (cp > 126 || cp < 32) out += '&#' + cp + ';';
    else out += ch;
  }
  return out;
}

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length <= n ? t : t.slice(0, n - 1) + '\u2026';
}

function hms(sec) {
  const s = Math.max(0, parseInt(sec, 10) || 0);
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return h ? h + ':' + pad(m) + ':' + pad(r) : m + ':' + pad(r);
}

function ago(ts) {
  if (!ts) return 'unknown';
  const d = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (d < 90) return d + ' seconds ago';
  if (d < 5400) return Math.round(d / 60) + ' minutes ago';
  if (d < 172800) return Math.round(d / 3600) + ' hours ago';
  return Math.round(d / 86400) + ' days ago';
}

// --- feed -----------------------------------------------------------------

function readFeed() {
  try {
    return JSON.parse(fs.readFileSync(FEED_JSON, 'utf8'));
  } catch (e) {
    return { videos: [], error: 'feed.json unreadable: ' + e.message, stale_cookies: false };
  }
}

// --- jobs -----------------------------------------------------------------

/*
 * Job records are per (video, kind): a video can have both an MP3 and a
 * video file. The video kind keeps the original `<id>.json` name so
 * records written before this feature stay valid.
 */
function jobPath(id, kind) {
  return path.join(JOB_DIR, id + (kind === 'audio' ? '.audio' : '') + '.json');
}

function readJob(id, kind) {
  try {
    return JSON.parse(fs.readFileSync(jobPath(id, kind), 'utf8'));
  } catch (e) {
    return null;
  }
}

/*
 * State for one video, as the button needs it. An already-transcoded file
 * on disk outranks any job record: that is what makes the page correct
 * after a worker restart, a cache wipe, or a manual drop into OUT_DIR.
 */
function jobState(id, kind) {
  /*
   * For video, accept output from ANY profile, not just the active one.
   * Switching YT98_PROFILE would otherwise make every previously
   * downloaded file look as though it had never been fetched. The active
   * profile's extension is tried first so a re-encode is preferred when
   * both exist. Audio has exactly one extension.
   */
  const exts = kind === 'audio'
    ? [PROF.audioExt]
    : [PROF.ext].concat(PROF.knownExts.filter((e) => e !== PROF.ext));
  for (const ext of exts) {
    try {
      if (fs.statSync(path.join(OUT_DIR, id + ext)).size > 0) {
        return { state: 'READY', pct: 100, file: id + ext, ext: ext };
      }
    } catch (e) { /* try the next extension */ }
  }

  const job = readJob(id, kind);
  if (!job) return { state: 'NONE', pct: 0 };

  /*
   * The file is the source of truth for READY, in both directions.
   *
   * A job record saying READY with no file on disk is stale — the movie
   * was deleted by hand, or will be by the retention policy. Reporting
   * READY there left the button saying "Play", which launched the
   * protocol handler onto a missing file. So treat it as never
   * downloaded and offer Download again.
   *
   * Only READY is overridden: QUEUED/DOWNLOADING/CONVERTING legitimately
   * have no file yet, and must not be reset mid-flight.
   */
  if (job.state === 'READY') return { state: 'NONE', pct: 0 };

  return { state: job.state || 'NONE', pct: job.pct || 0, error: job.error || null };
}

/*
 * Kick off a feed refresh and return immediately.
 *
 * Detached rather than awaited on purpose: a refresh takes 10-45s, which
 * is long enough for IE5 to give up on the request. The caller gets a
 * small page with a meta-refresh back to the feed instead.
 */
function startRefresh(nocookies) {
  if (refreshing) return { started: false, reason: 'a refresh is already running' };

  // Persist the choice before running, so the timer honours it too.
  setPublicMode(nocookies);

  let child;
  try {
    // Fixed argv, no interpolation of anything client-supplied.
    child = spawn(PYTHON, [REFRESH_SCRIPT], {
      cwd: BASE,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    return { started: false, reason: 'could not start: ' + e.message };
  }

  refreshing = true;
  const started = Date.now();
  const mode = nocookies ? 'no-cookies (public RSS)' : 'normal (cookies)';
  console.log('refresh started: ' + mode);

  let tail = '';
  const grab = (b) => { tail = (tail + String(b)).slice(-2000); };
  child.stdout.on('data', grab);
  child.stderr.on('data', grab);
  child.on('error', (err) => { grab(String(err.message)); });
  child.on('close', (code) => {
    refreshing = false;
    lastRefresh = {
      mode: mode,
      code: code,
      seconds: Math.round((Date.now() - started) / 1000),
      tail: tail.trim().split(/\r?\n/).slice(-3).join(' | ')
    };
    console.log('refresh finished: ' + mode + ' rc=' + code +
                ' in ' + lastRefresh.seconds + 's');
  });

  return { started: true, mode: mode };
}

/*
 * Request cancellation of an in-flight job.
 *
 * Only writes a flag: the worker owns the child processes and kills them
 * itself. Returns the state the button should show next.
 */
function requestCancel(id, kind) {
  const job = readJob(id, kind);
  if (!job) return { state: 'NONE', pct: 0 };
  if (!['QUEUED', 'DOWNLOADING', 'CONVERTING'].includes(job.state)) {
    return { state: job.state, pct: job.pct || 0 };
  }
  /*
   * A still-QUEUED job has no child process, so it can be cancelled here
   * and now. Waiting for the worker meant the button sat on "Stopping..."
   * for as long as the *current* job took — the serial worker only looks
   * at the queue between jobs.
   *
   * `cancel` is set as well as the state: if the worker happened to pick
   * this up in the same instant, it sees the flag on its next poll and
   * aborts, so both paths converge on CANCELLED.
   */
  const instant = job.state === 'QUEUED';
  job.cancel = true;
  if (instant) {
    job.state = 'CANCELLED';
    job.pct = 0;
    job.error = null;
  }
  job.updated = Math.floor(Date.now() / 1000);
  const tmp = jobPath(id, kind) + '.part';
  fs.writeFileSync(tmp, JSON.stringify(job, null, 1));
  fs.renameSync(tmp, jobPath(id, kind));
  console.log('cancel requested for ' + id + ' [' + kind + ']' +
              (instant ? ' (was queued, cancelled immediately)' : ''));
  return { state: instant ? 'CANCELLED' : 'CANCELLING', pct: 0 };
}

function enqueue(id, feed, kind) {
  /*
   * Consult jobState(), not the raw record: it is the file-aware view.
   * Reading the record directly meant a stale READY record blocked
   * re-queuing a deleted movie forever.
   */
  const st = jobState(id, kind);
  if (['QUEUED', 'DOWNLOADING', 'CONVERTING', 'READY'].includes(st.state)) {
    // idempotent: clicking twice must not queue twice, and an existing
    // file must never be re-encoded
    return { id: id, state: st.state, pct: st.pct || 0 };
  }
  const meta = (feed.videos || []).find((v) => v.id === id) || {};
  const job = {
    id: id,
    kind: kind,
    state: 'QUEUED',
    pct: 0,
    title: meta.title || '',
    // Carried for the ID3 artist tag on audio jobs.
    channel: meta.channel || '',
    duration: meta.duration || 0,
    error: null,
    queued: Math.floor(Date.now() / 1000)
  };
  fs.mkdirSync(JOB_DIR, { recursive: true });
  const tmp = jobPath(id, kind) + '.part';
  fs.writeFileSync(tmp, JSON.stringify(job, null, 1));
  fs.renameSync(tmp, jobPath(id, kind));
  return job;
}

// --- page rendering -------------------------------------------------------

const STYLE = [
  'body { background: #c0c0c0; font-family: Verdana, Arial, sans-serif; font-size: 11px;',
  '       color: #000000; margin: 8px; }',
  'a { color: #000080; }',
  'h1 { font-size: 16px; margin: 0px 0px 2px 0px; }',
  '.bar { background: #000080; color: #ffffff; padding: 3px; font-size: 11px; }',
  '.bar a { color: #ffff00; }',
  '.warn { background: #ffff80; border: 2px solid #800000; padding: 5px; font-weight: bold; }',
  '.cell { background: #d4d0c8; border: 2px outset #d4d0c8; }',
  '.ttl { font-weight: bold; font-size: 12px; }',
  '.meta { color: #404040; font-size: 12px; }',
  // Fixed width + monospace so the progress bar has even cells and the
  // button never resizes as its caption changes. A button that reflows on
  // every poll makes the whole table jump.
  '.b { width: 136px; font-family: "Courier New", Courier, monospace;',
  '     font-size: 11px; }',
  /*
   * Both spellings, in this order. Modern browsers take `pointer` and
   * discard `hand` as invalid; IE5 discards `pointer` as unknown and
   * takes `hand`. Last valid declaration wins in each.
   */
  '.t { cursor: pointer; cursor: hand; }',
  // The MP3 button: narrow, monospace so its short captions ("D40%",
  // "STOP?") do not resize it either.
  '.a { width: 58px; font-family: "Courier New", Courier, monospace;',
  '     font-size: 11px; margin-top: 2px; }',
  '.nav { padding: 4px; }'
].join('\n');

/*
 * The server renders the correct initial button state, so a reload during a
 * long download does not lose track of it. Anything still in flight is
 * pushed into `pending` and the page resumes polling for it on load.
 *
 * No <form> is used for the JS path, but each control degrades: with
 * scripting off the Download button is a real submit into /enqueue, which
 * redirects back to the page.
 */
/*
 * Fixed 17-character progress caption, e.g.  D[####------] 40%
 * Same format the client builds, so the server-rendered initial state and
 * the polled updates look identical and nothing shifts on first poll.
 */
function progressLabel(phase, pct) {
  const p = pct || 0;
  // Last cell is reserved for 100%: a full bar at 99% reads as finished
  // when it is not. Anything above 0 gets at least one cell so the bar
  // visibly moves straight away.
  let n;
  if (p >= 100) n = 10;
  else if (p <= 0) n = 0;
  else n = Math.max(1, Math.min(9, Math.floor(p / 10)));
  let bar = '';
  for (let i = 0; i < 10; i++) bar += i < n ? '#' : '-';
  return phase + '[' + bar + ']' + String(p).padStart(3, ' ') + '%';
}

/*
 * Compact caption for the narrow MP3 button. The video button has 17
 * characters to play with; this one has about five, so the bar is dropped
 * and only the phase letter and percentage survive.
 */
function audioLabel(st) {
  if (st.state === 'READY') return 'OK';
  if (st.state === 'FAILED') return 'Err';
  if (st.state === 'QUEUED') return '...';
  if (st.state === 'CANCELLING') return 'stop';
  if (st.state === 'DOWNLOADING') return 'D' + (st.pct || 0) + '%';
  if (st.state === 'CONVERTING') return 'C' + (st.pct || 0) + '%';
  return 'MP3';
}

function buttons(id, pending, states, exts) {
  const st = jobState(id);
  const j = esc(id);
  let label = 'Download';
  let disabled = '';

  // Published to the client as ST0 so act() can decide what the button
  // does from state, instead of the page rewriting onclick handlers.
  states[id] = st.state;
  if (st.ext) exts[id] = st.ext;

  if (st.state === 'READY') {
    label = 'Play';
  } else if (st.state === 'FAILED') {
    label = 'Retry';
  } else if (st.state === 'QUEUED') {
    // In-progress buttons stay ENABLED so they can be used to stop the
    // job; the caption still shows progress.
    label = 'Queued...';
    pending.push(id);
  } else if (st.state === 'DOWNLOADING' || st.state === 'CONVERTING') {
    label = progressLabel(st.state === 'DOWNLOADING' ? 'D' : 'C', st.pct);
    pending.push(id);
  } else if (st.state === 'CANCELLING') {
    label = 'Stopping...';
    pending.push(id);
  }

  const out = [];
  out.push('<form method="post" action="/enqueue" style="display:inline; margin:0px" ' +
           'onsubmit="return submitted(\'' + j + '\')">');
  out.push('<input type="hidden" name="id" value="' + j + '">');
  // One handler for every state, never reassigned at runtime.
  out.push('<input type="submit" class="b" id="b_' + j + '" value="' +
           esc(label) + '"' + disabled +
           ' onclick="act(\'' + j + '\'); return false;">');
  /*
   * The MP3 button sits on its own line rather than beside the video
   * button: 136px + 56px would not fit a 200px cell at four columns, and
   * vertical space is cheaper than rearranging the grid.
   */
  const ast = jobState(id, 'audio');
  states['A' + id] = ast.state;
  if (['QUEUED', 'DOWNLOADING', 'CONVERTING', 'CANCELLING'].includes(ast.state)) {
    pending.push('A' + id);
  }
  out.push('<br><input type="button" class="a" id="a_' + j + '" value="' +
           esc(audioLabel(ast)) + '" onclick="actA(\'' + j + '\')">');
  out.push('</form>');
  if (st.state === 'FAILED' && st.error) {
    out.push('<br><span class="meta">' + esc(clip(st.error, 60)) + '</span>');
  }
  return out.join('');
}

function renderPage(feed, page) {
  const pending = [];
  const states = {};
  const exts = {};
  const videos = Array.isArray(feed.videos) ? feed.videos : [];
  const pages = Math.max(1, Math.ceil(videos.length / PER_PAGE));
  const p = Math.min(Math.max(1, page), pages);
  const slice = videos.slice((p - 1) * PER_PAGE, p * PER_PAGE);

  const h = [];
  h.push('<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">');
  h.push('<html><head>');
  h.push('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">');
  h.push('<title>YouTube 98</title>');
  h.push('<style type="text/css">' + STYLE + '</style>');
  h.push('</head><body>');

  h.push('<h1>YouTube 98</h1>');
  h.push('<div class="bar">Feed: <b>' + esc(feed.feed || '?') + '</b> &nbsp;|&nbsp; ' +
         videos.length + ' videos &nbsp;|&nbsp; updated ' + esc(ago(feed.generated)) +
         ' &nbsp;|&nbsp; page ' + p + ' of ' + pages + '</div>');

  if (feed.public_mode) {
    /*
     * Deliberate public mode. Must not say "cookies are stale" — nothing
     * is wrong and the mode was chosen, which is exactly what the earlier
     * wording got wrong.
     */
    h.push('<p class="warn">' +
      '<b>Public mode</b> &#8212; cookies.txt is being ignored on purpose, ' +
      'including by the 30-minute timer.<br>' +
      'Newest uploads from your subscribed channels via public RSS, ' +
      'newest first. Expect heavy overlap with the personalised feed: ' +
      'both draw on the same channels, so page 1 looks similar and the ' +
      'differences are further in.<br>' +
      'Press <b>Refresh feed</b> below to go back to the logged-in feed.' +
      '</p>');
  } else if (feed.fallback) {
    // Unintended fallback: cookies really did fail.
    h.push('<p class="warn">' +
      'Cookies are stale &#8212; re-export cookies.txt from the tablet.<br>' +
      'This is the <b>chronological fallback</b>: newest uploads from your ' +
      'subscribed channels via public RSS, not your personalised feed. ' +
      'Updated ' + esc(ago(feed.generated)) + '.<br>' +
      esc(clip(feed.error || '', 160)) + '</p>');
  } else if (feed.error || feed.stale_cookies) {
    h.push('<p class="warn">' +
      (feed.stale_cookies
        ? 'Cookies are stale &#8212; re-export cookies.txt from the tablet. '
        : 'Feed refresh failed. ') +
      'Showing the last good list, last checked ' + esc(ago(feed.checked)) + '.<br>' +
      esc(clip(feed.error || '', 160)) + '</p>');
  }

  if (!slice.length) {
    h.push('<p class="warn">No videos in the feed. Run refresh-feed.py.</p>');
  } else {
    h.push(navBar(p, pages));
    h.push('<table border="0" cellpadding="6" cellspacing="4" width="100%">');
    for (let i = 0; i < slice.length; i += COLS) {
      h.push('<tr>');
      for (let c = 0; c < COLS; c++) {
        const v = slice[i + c];
        if (!v) { h.push('<td width="25%">&nbsp;</td>'); continue; }
        // Rendered first because it fills states[v.id], which the
        // thumbnail below needs — and it keeps this to one jobState()
        // (one stat()) per video rather than two.
        const bhtml = buttons(v.id, pending, states, exts);
        const isReady = states[v.id] === 'READY';
        const j = esc(v.id);

        h.push('<td width="25%" valign="top" class="cell">');
        if (v.src) {
          /*
           * The thumbnail is the "copy path" control (the separate Path
           * button is gone). copyPath() ignores anything not READY, so
           * the only affordance needed is the cursor: `hand`, not
           * `pointer` — IE5.0 does not know `pointer`. The class is
           * swapped to "t" client-side the moment a job reaches READY.
           */
          h.push('<img id="i_' + j + '" src="' + esc(v.src) + '"' +
                 ' width="160" height="90" border="0" alt=""' +
                 (isReady ? ' class="t" title="Click to copy path"' : '') +
                 ' onclick="copyPath(\'' + j + '\')"><br>');
        } else {
          h.push('<table border="0" width="160" height="90" bgcolor="#808080"><tr>' +
                 '<td align="center"><font color="#ffffff">no image</font></td></tr></table>');
        }
        h.push('<span class="ttl">' + esc(clip(v.title, 70)) + '</span><br>');
        h.push('<span class="meta">' + esc(clip(v.channel, 28)));
        const d = hms(v.duration);
        if (d) h.push(' &#183; ' + d);
        // Publish age, when known. Makes a chronological list visibly
        // chronological instead of looking like the personalised one.
        if (v.published) h.push('<br>' + esc(ago(v.published)));
        h.push('</span><br>');
        h.push(bhtml);
        h.push('</td>');
      }
      h.push('</tr>');
    }
    h.push('</table>');
    h.push(navBar(p, pages));
  }

  h.push('<div class="bar">Files land in ' + esc(WIN_PATH) +
         '&lt;id&gt;' + esc(PROF.ext) + ' &#8212; <b>Play</b> needs the youtube98: handler: ' +
         'copy ' + esc(WIN_PATH) + '_setup\\play.vbs to C:\\youtube98\\ ' +
         'then run ' + esc(WIN_PATH) + '_setup\\youtube98.reg</div>');

  // Plain forms, no scripting: these work regardless of the JScript state.
  h.push('<div class="nav">');
  h.push('<form method="post" action="/refresh" style="display:inline; margin:0px">' +
         '<input type="submit" value="Refresh feed"></form>');
  h.push(' <form method="post" action="/refresh" style="display:inline; margin:0px">' +
         '<input type="hidden" name="nocookies" value="1">' +
         '<input type="submit" value="Refresh without cookies.txt"></form>');
  h.push(' <span class="meta">mode: <b>' +
         (publicMode() ? 'public (cookies.txt ignored)' : 'logged in') +
         '</b> &#183; or open <tt>/refresh?nocookies=1</tt></span>');
  h.push('</div>');
  /*
   * Off-screen input used by the execCommand("copy") path above. Needed
   * when the page is reached over plain http by IP, where
   * navigator.clipboard does not exist. Positioned rather than
   * display:none, because a hidden input cannot be selected.
   */
  h.push('<div style="position:absolute; left:-999px; top:-999px">' +
         '<input type="text" id="cb" value="" size="10"></div>');
  h.push(clientScript(pending, states, exts));
  h.push('</body></html>');
  return h.join('\n');
}

/*
 * Client script, written for JScript 5.0 as shipped with IE5: no const/let,
 * no arrow functions, no addEventListener, no JSON, no Array.forEach.
 *
 * Three IE5 specifics that matter:
 *   - XMLHttpRequest does not exist; it is ActiveXObject("Microsoft.XMLHTTP")
 *   - IE caches GETs aggressively, so every poll carries a cache-buster
 *     on top of the server's no-cache header
 *   - clipboardData.setData is available and is the only copy mechanism
 *     here (execCommand('copy') arrived much later)
 */
function clientScript(pending, states, exts) {
  const winp = WIN_PATH.replace(/\\/g, '\\\\');
  const ids = pending.map((i) => "'" + i + "'").join(',');
  /*
   * Only per-page values are inline; the logic is a separate cacheable
   * file, which keeps each page down to ~9.7 KB across 11+ pages.
   *
   * ST0 carries the server-rendered state of every button on this page.
   * boot() copies it into ST, so act() knows a "Play" button should play
   * rather than re-queue — without the page ever rewriting a handler.
   * Bracket assignment rather than an object literal: ids are already
   * whitelisted to 11 safe characters, and this needs no quoting rules.
   */
  const st0 = Object.keys(states)
    .map((k) => 'ST0["' + k + '"]="' + states[k] + '";')
    .join('');
  const ext0 = Object.keys(exts)
    .map((k) => 'EXT0["' + k + '"]="' + exts[k] + '";')
    .join('');
  return '<script type="text/javascript">\n' +
         'var WINP = "' + winp + '";\n' +
         'var EXT = "' + PROF.ext + '";\n' +
         'var AEXT = "' + PROF.audioExt + '";\n' +
         'var PENDING = [' + ids + '];\n' +
         'var ST0 = {};' + st0 + '\n' +
         'var EXT0 = {};' + ext0 + '\n' +
         '<\/script>\n' +
         '<script type="text/javascript" src="/yt98.js"><\/script>';
}

const CLIENT_JS = [
    /*
     * IE5 crashed with an invalid page fault in JSCRIPT.DLL — a null
     * dereference inside the script engine, which is JScript 5.0's
     * garbage-collector bug. So this file contains NO function
     * expressions at all: every function is named and global, timers are
     * handed an existing function object, and no handler is ever
     * reassigned.
     *
     * State is keyed by a composite string, not a bare video id, because
     * each video now has two independent jobs:
     *
     *   "<id>"     the video download
     *   "A<id>"    the MP3 download
     *
     * One state machine serves both; only the element id, the caption
     * width and the &kind= parameter differ.
     */
    'var seq = 0;',
    'var POLL = 2000;',
    'var PEND = [];',
    'var IDX = 0;',
    'var REQ = null;',
    'var TIMER = null;',
    'var ST = {};',
    'var PCT = {};',
    'var ARMED = null;',
    'var ARM_TIMER = null;',
    'var ARM_MS = 4000;',

    // ---- composite-key helpers -------------------------------------
    'function isAudio(k) { return k.charAt(0) == "A"; }',
    'function idOf(k) { return isAudio(k) ? k.substring(1) : k; }',
    'function kindQ(k) { return isAudio(k) ? "&kind=audio" : ""; }',
    'function el(k) {',
    '  return document.getElementById((isAudio(k) ? "a_" : "b_") + idOf(k));',
    '}',
    'function thumb(id) { return document.getElementById("i_" + id); }',
    'function label(k, text, enabled) {',
    '  var b = el(k);',
    '  if (!b) { return; }',
    '  b.value = text;',
    '  b.disabled = !enabled;',
    '}',

    // ---- transport: one reused object, synchronous ------------------
    'function getreq() {',
    '  if (REQ != null) { return REQ; }',
    '  try { REQ = new ActiveXObject("Microsoft.XMLHTTP"); }',
    '  catch (e) {',
    '    try { REQ = new XMLHttpRequest(); } catch (e2) { REQ = null; }',
    '  }',
    '  return REQ;',
    '}',
    'function httpSync(method, url, body) {',
    '  var r = getreq();',
    '  if (r == null) { return null; }',
    '  try {',
    '    r.open(method, url, false);',
    '    if (method == "POST") {',
    '      r.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");',
    '    }',
    '    r.send(method == "POST" ? body : null);',
    '    if (r.status != 200) { return null; }',
    '    return "" + r.responseText;',
    '  } catch (e3) { return null; }',
    '}',

    // ---- captions ---------------------------------------------------
    // Fixed 17 chars for the video button: D[####------] 40%
    'function bar(phase, pct) {',
    '  var n;',
    '  if (isNaN(pct)) { pct = 0; }',
    '  if (pct >= 100) { n = 10; }',
    '  else if (pct <= 0) { n = 0; }',
    '  else {',
    '    n = Math.floor(pct / 10);',
    '    if (n < 1) { n = 1; }',
    '    if (n > 9) { n = 9; }',
    '  }',
    '  var s = "";',
    '  for (var i = 0; i < 10; i++) { s = s + ((i < n) ? "#" : "-"); }',
    '  var p = "" + pct;',
    '  while (p.length < 3) { p = " " + p; }',
    '  return phase + "[" + s + "]" + p + "%";',
    '}',
    // The MP3 button is ~56px, so no room for a bar: phase letter + pct.
    'function shortCap(phase, pct) { return phase + pct + "%"; }',
    'function progCap(k, phase, pct) {',
    '  return isAudio(k) ? shortCap(phase, pct) : bar(phase, pct);',
    '}',
    'function idleCap(k) { return isAudio(k) ? "MP3" : "Download"; }',
    'function doneCap(k) { return isAudio(k) ? "OK" : "Play"; }',
    'function failCap(k) { return isAudio(k) ? "Err" : "Retry"; }',
    'function armCap(k) { return isAudio(k) ? "STOP?" : "STOP? click again"; }',

    // ---- paths ------------------------------------------------------
    'function winPath(id) { return WINP + id + (EXT0[id] || EXT); }',
    'function audioPath(id) { return WINP + id + AEXT; }',
    'function play(id) { window.location.href = "youtube98:" + winPath(id); }',
    /*
     * Four clipboard routes, because the two target browsers share none:
     * IE5's clipboardData, modern navigator.clipboard (secure contexts
     * only, which includes http://localhost), execCommand against an
     * off-screen input for plain http by IP, and finally prompt().
     * No .then() on the promise — a function expression there is exactly
     * what faults JScript 5.0.
     */
    'function putClip(p) {',
    '  var ok = false;',
    '  try {',
    '    if (window.clipboardData && window.clipboardData.setData) {',
    '      ok = window.clipboardData.setData("Text", p);',
    '      if (ok !== false) { ok = true; }',
    '    }',
    '  } catch (e) { ok = false; }',
    '  if (!ok) {',
    '    try {',
    '      if (navigator.clipboard && navigator.clipboard.writeText) {',
    '        navigator.clipboard.writeText(p);',
    '        ok = true;',
    '      }',
    '    } catch (e2) { ok = false; }',
    '  }',
    '  if (!ok) {',
    '    try {',
    '      var box = document.getElementById("cb");',
    '      if (box && document.execCommand) {',
    '        box.value = p;',
    '        box.select();',
    '        ok = document.execCommand("copy");',
    '      }',
    '    } catch (e3) { ok = false; }',
    '  }',
    '  if (ok) { alert("Copied to clipboard:\\n" + p); }',
    '  else { prompt("Copy this path (Ctrl+C):", p); }',
    '}',
    'function copyPath(id) {',
    '  if (ST[id] != "READY") { return; }',
    '  putClip(winPath(id));',
    '}',

    // ---- arming (no confirm(): IE5's return value is not dependable) -
    'function busy(s) {',
    '  return s == "QUEUED" || s == "DOWNLOADING" || s == "CONVERTING";',
    '}',
    'function restore(k) {',
    '  var s = ST[k];',
    '  if (s == "DOWNLOADING") { label(k, progCap(k, "D", PCT[k] || 0), true); }',
    '  else if (s == "CONVERTING") { label(k, progCap(k, "C", PCT[k] || 0), true); }',
    '  else if (s == "QUEUED") { label(k, isAudio(k) ? "..." : "Queued...", true); }',
    '}',
    'function disarm() {',
    '  ARM_TIMER = null;',
    '  if (!ARMED) { return; }',
    '  var k = ARMED;',
    '  ARMED = null;',
    '  restore(k);',
    '}',
    'function arm(k) {',
    '  if (ARM_TIMER != null) { window.clearTimeout(ARM_TIMER); ARM_TIMER = null; }',
    '  if (ARMED && ARMED != k) { var old = ARMED; ARMED = null; restore(old); }',
    '  ARMED = k;',
    '  label(k, armCap(k), true);',
    '  ARM_TIMER = window.setTimeout(disarm, ARM_MS);',
    '}',
    'function stop(k) {',
    '  if (ARM_TIMER != null) { window.clearTimeout(ARM_TIMER); ARM_TIMER = null; }',
    '  ARMED = null;',
    '  label(k, isAudio(k) ? "stop" : "Stopping...", false);',
    '  var t = httpSync("POST", "/cancel?id=" + idOf(k) + kindQ(k) + "&_=" + (seq++), "");',
    '  if (t == null) { restore(k); return; }',
    '  absorb(k, t);',
    '  schedule();',
    '}',

    // ---- actions ----------------------------------------------------
    /*
     * Single dispatcher per kind. The inline onclick never changes, which
     * is what keeps closures off DOM elements; what the button does is
     * decided from ST.
     */
    'function core(k) {',
    '  var s = ST[k];',
    '  if (s == "READY") {',
    '    if (isAudio(k)) { putClip(audioPath(idOf(k))); } else { play(idOf(k)); }',
    '    return;',
    '  }',
    '  if (busy(s)) {',
    '    if (ARMED == k) { stop(k); } else { arm(k); }',
    '    return;',
    '  }',
    '  if (s == "CANCELLING") { return; }',
    '  start(k);',
    '}',
    'function act(id) { core(id); }',
    'function actA(id) { core("A" + id); }',
    'function start(k) {',
    '  label(k, isAudio(k) ? "..." : "Starting...", false);',
    '  ST[k] = "QUEUED";',
    '  push(k);',
    '  var t = httpSync("POST", "/enqueue?id=" + idOf(k) + kindQ(k) + "&_=" + (seq++),',
    '                   "id=" + idOf(k) + (isAudio(k) ? "&kind=audio" : ""));',
    '  if (t == null) {',
    '    ST[k] = "NONE";',
    '    drop(k);',
    '    label(k, isAudio(k) ? "Err" : "Error", true);',
    '    return;',
    '  }',
    '  absorb(k, t);',
    '  schedule();',
    '}',

    // ---- pending list (no shift/splice: JScript 5.0 era) ------------
    'function push(k) {',
    '  for (var i = 0; i < PEND.length; i++) { if (PEND[i] == k) { return; } }',
    '  PEND[PEND.length] = k;',
    '}',
    'function drop(k) {',
    '  var out = [];',
    '  for (var i = 0; i < PEND.length; i++) {',
    '    if (PEND[i] != k) { out[out.length] = PEND[i]; }',
    '  }',
    '  PEND = out;',
    '  IDX = 0;',
    '}',

    // ---- status -----------------------------------------------------
    'function absorb(k, text) {',
    '  var parts = ("" + text).split(" ");',
    '  var st = parts[0];',
    '  var pct = parseInt(parts[1], 10);',
    '  if (isNaN(pct)) { pct = 0; }',
    '  ST[k] = st;',
    '  PCT[k] = pct;',
    '  if (st == "READY") {',
    '    drop(k);',
    '    if (ARMED == k) { ARMED = null; }',
    '    label(k, doneCap(k), true);',
    '    if (!isAudio(k)) {',
    '      var im = thumb(idOf(k));',
    '      if (im) { im.className = "t"; im.title = "Click to copy path"; }',
    '    }',
    '    return;',
    '  }',
    '  if (st == "FAILED") {',
    '    drop(k);',
    '    if (ARMED == k) { ARMED = null; }',
    '    label(k, failCap(k), true);',
    '    return;',
    '  }',
    '  if (st == "CANCELLED" || st == "NONE") {',
    '    drop(k);',
    '    if (ARMED == k) { ARMED = null; }',
    '    ST[k] = "NONE";',
    '    label(k, idleCap(k), true);',
    '    return;',
    '  }',
    '  if (st == "CANCELLING") { label(k, isAudio(k) ? "stop" : "Stopping...", false); return; }',
    '  if (ARMED == k) { return; }',
    '  if (st == "DOWNLOADING") { label(k, progCap(k, "D", pct), true); return; }',
    '  if (st == "CONVERTING") { label(k, progCap(k, "C", pct), true); return; }',
    '  label(k, isAudio(k) ? "..." : "Queued...", true);',
    '}',

    // ---- poll loop: one named function, no closures ever ------------
    'function tick() {',
    '  TIMER = null;',
    '  if (PEND.length == 0) { return; }',
    '  if (IDX >= PEND.length) { IDX = 0; }',
    '  var k = PEND[IDX];',
    '  IDX = IDX + 1;',
    '  var t = httpSync("GET", "/status?id=" + idOf(k) + kindQ(k) + "&_=" + (seq++), null);',
    '  if (t != null) { absorb(k, t); }',
    '  schedule();',
    '}',
    'function schedule() {',
    '  if (TIMER != null) { return; }',
    '  if (PEND.length == 0) { return; }',
    '  TIMER = window.setTimeout(tick, POLL);',
    '}',

    'function submitted(id) { return false; }',

    'function boot() {',
    '  var k;',
    '  for (k in ST0) { ST[k] = ST0[k]; }',
    '  for (var i = 0; i < PENDING.length; i++) { push(PENDING[i]); }',
    '  schedule();',
    '}',
    'window.onload = boot;'
].join('\n');

/*
 * Windowed page list: first, last, and +/-2 around the current page, with
 * ellipses for the gaps. A flat 1..N list was fine at 2 pages but becomes
 * a wall of links at 13+, and horizontal space on an 800x600 screen is
 * the scarce resource here.
 */
const NAV_WINDOW = 2;

/*
 * Response for /refresh. Carries a meta-refresh back to the feed so the
 * flow is click -> wait -> land on the updated list, with no scripting
 * involved at all.
 */
function refreshPage(result, nocookies) {
  const h = [];
  h.push('<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">');
  h.push('<html><head>');
  h.push('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">');
  if (result.started) h.push('<meta http-equiv="refresh" content="25;url=/">');
  h.push('<title>YouTube 98 &#8212; refresh</title>');
  h.push('<style type="text/css">' + STYLE + '</style>');
  h.push('</head><body>');
  h.push('<h1>Feed refresh</h1>');

  if (result.started) {
    h.push('<div class="bar">Started: <b>' + esc(result.mode) + '</b></div>');
    if (nocookies) {
      h.push('<p><b>Public mode is now on and stays on</b>, including for ' +
             'the 30-minute timer, until you press <b>Refresh feed</b>. ' +
             'The feed is built from public per-channel RSS. Your real ' +
             '<tt>cookies.txt</tt> is untouched.</p>');
      h.push('<p>Expect heavy overlap with the personalised feed &#8212; ' +
             'measured 89 of 150 ids in common, because both draw on the ' +
             'same subscribed channels. Page 1 looks similar; the ' +
             'differences are deeper in the list.</p>');
    } else {
      h.push('<p>Public mode <b>off</b>: using <tt>cookies.txt</tt> as ' +
             'normal. If it has expired this still falls back to public RSS ' +
             'by itself.</p>');
    }
    h.push('<p>Takes roughly 10-45 seconds depending on how many new ' +
           'thumbnails are needed. This page returns to the feed on its own ' +
           'in 25 seconds.</p>');
  } else {
    h.push('<p class="warn">Not started: ' + esc(result.reason) + '</p>');
  }

  if (lastRefresh) {
    h.push('<div class="bar">Previous run</div>');
    h.push('<p class="meta">' + esc(lastRefresh.mode) + ' &#183; exit ' +
           lastRefresh.code + ' &#183; ' + lastRefresh.seconds + 's<br>' +
           esc(clip(lastRefresh.tail || '', 300)) + '</p>');
  }

  h.push('<p><a href="/">Back to the feed</a></p>');
  h.push('</body></html>');
  return h.join('\n');
}

function navBar(p, pages) {
  if (pages < 2) return '';
  const out = ['<div class="nav">'];
  out.push(p > 1 ? '<a href="/?p=' + (p - 1) + '">[ &lt;&lt; Prev ]</a>' : '[ &lt;&lt; Prev ]');
  out.push(' &nbsp;');

  const show = new Set([1, pages]);
  for (let i = p - NAV_WINDOW; i <= p + NAV_WINDOW; i++) {
    if (i >= 1 && i <= pages) show.add(i);
  }
  const list = Array.from(show).sort((a, b) => a - b);

  let prev = 0;
  for (const i of list) {
    if (prev && i > prev + 1) out.push(' ...');
    out.push(i === p ? ' <b>[' + i + ']</b>' : ' <a href="/?p=' + i + '">' + i + '</a>');
    prev = i;
  }

  out.push(' &nbsp;');
  out.push(p < pages ? '<a href="/?p=' + (p + 1) + '">[ Next &gt;&gt; ]</a>' : '[ Next &gt;&gt; ]');
  out.push('</div>');
  return out.join('');
}

// --- http -----------------------------------------------------------------

function send(res, code, type, body, cache) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1');
  // Explicit Content-Length and no compression: ancient clients handle
  // chunked transfer and gzip poorly.
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': cache || 'no-cache',
    'Connection': 'close'
  });
  res.end(buf);
}

const server = http.createServer((req, res) => {
  /*
   * Request log. Deliberately includes the User-Agent: when something
   * misbehaves on the retro box the first question is always "did IE5
   * actually fetch /yt98.js, and did it ever poll /status?", and
   * guessing at that from the far end is hopeless.
   */
  const ua = (req.headers['user-agent'] || '-').slice(0, 60);
  const peer = req.socket.remoteAddress || '-';
  console.log([
    new Date().toISOString().slice(11, 19),
    peer,
    req.method,
    req.url,
    '"' + ua + '"'
  ].join(' '));

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    return send(res, 400, 'text/plain', 'bad request');
  }
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/' || pathname === '/index.html') {
    const feed = readFeed();
    const page = parseInt(url.searchParams.get('p') || '1', 10) || 1;
    return send(res, 200, 'text/html', renderPage(feed, page));
  }

  if (pathname === '/refresh') {
    /*
     * GET is accepted as well as POST. Strictly this mutates, so POST
     * alone would be tidier — but the whole point is being able to type
     * the URL with its query parameter into IE5's address bar, and IE5
     * cannot issue a POST that way. The page's own buttons use POST.
     */
    const fromQuery = String(url.searchParams.get('nocookies') || '');

    // The page's own buttons are forms, so the flag arrives in the body
    // rather than the query string. Accept it from either.
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1024) req.destroy(); });
      req.on('end', () => {
        const m = /(?:^|&)nocookies=([^&]*)/.exec(body);
        const fromBody = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
        const nc = truthy(fromQuery || fromBody);
        const r = startRefresh(nc);
        send(res, 200, 'text/html', refreshPage(r, nc));
      });
      return;
    }

    const nocookies = truthy(fromQuery);
    const result = startRefresh(nocookies);
    return send(res, 200, 'text/html', refreshPage(result, nocookies));
  }

  if (pathname === '/yt98.js') {
    return send(res, 200, 'application/x-javascript', CLIENT_JS,
                'max-age=86400');
  }

  if (pathname === '/enqueue' && req.method === 'POST') {
    // Whitelist first, and spawn nothing here — the worker owns subprocesses.
    const qid = url.searchParams.get('id');
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      const fid = /(?:^|&)id=([^&]*)/.exec(body);
      const formId = fid ? decodeURIComponent(fid[1].replace(/\+/g, ' ')) : null;
      const id = qid || formId;
      if (!VIDEO_ID.test(id || '')) {
        return send(res, 400, 'text/plain', 'FAILED bad id');
      }
      const km = /(?:^|&)kind=([^&]*)/.exec(body);
      const kind = kindOf(url.searchParams.get('kind') ||
                          (km ? decodeURIComponent(km[1]) : ''));
      let job;
      try {
        job = enqueue(id, readFeed(), kind);
      } catch (e) {
        return send(res, 500, 'text/plain', 'FAILED ' + e.message);
      }
      // A query-string id means the AJAX path; a form body means scripting
      // is off, so send the browser back to a page it can render.
      if (!qid && formId) {
        res.writeHead(302, { Location: '/', 'Content-Length': 0 });
        return res.end();
      }
      return send(res, 200, 'text/plain', job.state + ' ' + (job.pct || 0));
    });
    return;
  }

  if (pathname === '/cancel' && req.method === 'POST') {
    const id = url.searchParams.get('id');
    if (!VIDEO_ID.test(id || '')) return send(res, 400, 'text/plain', 'FAILED bad id');
    const st = requestCancel(id, kindOf(url.searchParams.get('kind')));
    return send(res, 200, 'text/plain', st.state + ' ' + (st.pct || 0));
  }

  if (pathname === '/status') {
    const id = url.searchParams.get('id');
    if (!VIDEO_ID.test(id || '')) return send(res, 400, 'text/plain', 'FAILED bad id');
    const st = jobState(id, kindOf(url.searchParams.get('kind')));
    return send(res, 200, 'text/plain', st.state + ' ' + (st.pct || 0));
  }

  if (pathname.startsWith('/thumbs/')) {
    // Same 11-char video-id whitelist used everywhere else; nothing else
    // can be addressed, so there is no path to traverse out of THUMB_DIR.
    const m = /^\/thumbs\/([A-Za-z0-9_-]{11})\.jpg$/.exec(pathname);
    if (!m) return send(res, 404, 'text/plain', 'not found');
    const file = path.join(THUMB_DIR, m[1] + '.jpg');
    try {
      const buf = fs.readFileSync(file);
      return send(res, 200, 'image/jpeg', buf);
    } catch (e) {
      return send(res, 404, 'text/plain', 'not found');
    }
  }

  return send(res, 404, 'text/plain', 'not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[youtube98] listening on http://0.0.0.0:' + PORT + '/');
  console.log('[youtube98] feed: ' + FEED_JSON);
});
