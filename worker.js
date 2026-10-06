#!/usr/bin/env node
/*
 * youtube98 — download + transcode worker (plan sections 4 and 5)
 *
 * Watches cache/jobs/ for QUEUED jobs and processes them one at a time:
 *
 *   yt-dlp  -> .tmp/<id>.<ext>      (best available source)
 *   ffmpeg  -> .tmp/<id>.<ext>      (per YT98_PROFILE)
 *   rename  -> $YT98_OUT/<id>.<ext>
 *
 * Serial on purpose: phobos is a 2c/4t Athlon and the encode is the only
 * real CPU work in this project. Jobs survive the browser closing, and
 * survive this process restarting.
 *
 *   node worker.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const retention = require('./retention');
const PROF = require('./profiles');

const BASE = __dirname;
const JOB_DIR = path.join(BASE, 'cache', 'jobs');
const OUT_DIR = process.env.YT98_OUT || path.join(os.homedir(), 'youtube98');
const TMP_DIR = path.join(OUT_DIR, '.tmp');
const LOCK = path.join(BASE, 'cache', 'worker.lock');

const COOKIES = process.env.YT98_COOKIES || path.join(os.homedir(), 'cookies.txt');
/*
 * On Windows yt-dlp.exe is expected on PATH (that is how winget and the
 * released binary are normally used). Elsewhere, the standalone binary
 * installed into ~/.local/bin.
 */
const YTDLP = process.env.YT98_YTDLP || (process.platform === 'win32'
  ? 'yt-dlp.exe'
  : path.join(os.homedir(), '.local/bin/yt-dlp'));
const POLL_MS = 2000;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/*
 * Encode profile for the PII 350 / Radeon 9200 (plan section 1).
 *
 * MPEG-1 in an MPEG-PS .mpg rather than the .avi the draft asked for:
 * Win98SE ships a DirectShow MPEG-1 decoder, so this plays with no codec
 * install at all, whereas MPEG-1 wrapped in AVI is the one genuinely
 * fragile combination. MP2 audio for the same reason.
 *
 * scale=352:-2 keeps the source aspect (16:9 -> 352x198) instead of
 * squashing widescreen into 4:3. fps cap at 25 cuts decode load on a
 * 350 MHz CPU for free.
 */
/*
 * Encode settings come from profiles.js, selected with YT98_PROFILE.
 * See that file for why dimensions are padded to multiples of 16 and why
 * the Xvid profile sticks to Simple Profile.
 */
const VF = PROF.vf;
const FFMPEG_ARGS = PROF.args;
const EXT = PROF.ext;

// --- job store ------------------------------------------------------------

function jobPath(id) {
  return path.join(JOB_DIR, id + '.json');
}

function readJob(id) {
  try {
    return JSON.parse(fs.readFileSync(jobPath(id), 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeJob(job) {
  job.updated = Math.floor(Date.now() / 1000);
  const tmp = jobPath(job.id) + '.part';
  fs.writeFileSync(tmp, JSON.stringify(job, null, 1));
  fs.renameSync(tmp, jobPath(job.id)); // atomic: /status never sees a half file
}

function setState(job, state, extra) {
  const prev = job.state;
  job.state = state;
  if (extra) Object.assign(job, extra);
  writeJob(job);
  // Progress now ticks every 2%, which would be ~50 log lines per phase.
  // Log transitions always, progress only at 20% marks.
  if (prev !== state || (job.pct || 0) % 20 === 0) {
    log(job.id + ' -> ' + state + (job.pct ? ' ' + job.pct + '%' : ''));
  }
}

function log(msg) {
  console.log('[worker ' + new Date().toISOString().slice(11, 19) + '] ' + msg);
}

// --- subprocess helper ----------------------------------------------------

/*
 * Always spawn with an argument array and no shell. The video id is
 * whitelisted at every entry point, but argv-not-shell is what actually
 * makes injection structurally impossible.
 */
/*
 * Cancellation.
 *
 * The server cannot kill these children itself — the worker owns them —
 * so /cancel just writes `cancel: true` into the job record and the
 * worker notices. While a child is running we poll the record once a
 * second; nothing else needs to coordinate.
 */
class Cancelled extends Error {}

function cancelRequested(id) {
  const job = readJob(id);
  return !!(job && job.cancel);
}

function run(cmd, args, onLine, job) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    let killed = false;
    let hardTimer = null;

    // Only watch for cancellation when a job owns this child.
    const watch = job ? setInterval(() => {
      if (killed || !cancelRequested(job.id)) return;
      killed = true;
      log(job.id + ' cancel requested, terminating ' + cmd);
      // Windows has no real SIGTERM: Node maps kill() to
      // TerminateProcess, so the child dies abruptly rather than
      // cleanly. Harmless here — a cancelled job's partial output is
      // discarded either way.
      try { p.kill('SIGTERM'); } catch (e) { /* already gone */ }
      // yt-dlp and ffmpeg both exit promptly on TERM; this is a backstop.
      hardTimer = setTimeout(() => {
        try { p.kill('SIGKILL'); } catch (e) { /* already gone */ }
      }, 3000);
    }, 1000) : null;

    const done = (result) => {
      if (watch) clearInterval(watch);
      if (hardTimer) clearTimeout(hardTimer);
      resolve(result);
    };

    const feed = (buf) => {
      const text = String(buf);
      tail = (tail + text).slice(-4000);
      if (onLine) text.split(/\r?\n|\r/).forEach((l) => l && onLine(l));
    };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', (err) => done({ code: -1, tail: String(err.message), killed }));
    p.on('close', (code) => done({ code, tail, killed }));
  });
}

// --- pipeline -------------------------------------------------------------

function findTmpSource(id) {
  const hit = fs.readdirSync(TMP_DIR).filter(
    (f) => f.startsWith(id + '.') && !f.endsWith(EXT) && !f.endsWith('.part')
  );
  return hit.length ? path.join(TMP_DIR, hit[0]) : null;
}

function clearTmp(id) {
  for (const f of fs.readdirSync(TMP_DIR)) {
    if (f.startsWith(id + '.')) {
      try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch (e) { /* ignore */ }
    }
  }
}

/*
 * Cap the source at 480p and prefer h264.
 *
 * The output is 352px wide, so anything above 480p is downloaded and
 * decoded for nothing. Preferring h264 over VP9 matters too: phobos is a
 * 2c/4t Athlon and decoding 1080p VP9 to feed the encoder costs far more
 * than the download saves.
 */
const FORMAT_ARGS = ['-f', 'bv*+ba/b', '-S', 'res:480,vcodec:h264'];

function downloadAttempt(job, useCookies, onPct) {
  const args = ['--newline', '--no-playlist', '--no-warnings']
    .concat(useCookies ? ['--cookies', COOKIES] : [])
    .concat(FORMAT_ARGS, [
      '-o', path.join(TMP_DIR, '%(id)s.%(ext)s'),
      'https://www.youtube.com/watch?v=' + job.id
    ]);
  return run(YTDLP, args, onPct, job);
}

async function download(job) {
  setState(job, 'DOWNLOADING', { pct: 0 });
  clearTmp(job.id);

  let last = 0;
  const onPct = (line) => {
    const m = /\[download\]\s+([\d.]+)%/.exec(line);
    if (m) {
      const pct = Math.min(99, Math.round(parseFloat(m[1])));
      // Every 2%: the client draws a 10-cell bar, so 5% steps made it jump
      // two cells at a time. A job write is a small atomic rename, cheap.
      if (pct >= last + 2) { last = pct; setState(job, 'DOWNLOADING', { pct }); }
    }
  };

  /*
   * Anonymous first, cookies only as a fallback.
   *
   * Counter-intuitive but measured: sending cookies makes YouTube route
   * the request to player clients that then fail with "The page needs to
   * be reloaded" on at least some videos, while the same video downloads
   * fine anonymously. Cookies are still needed for age-restricted or
   * members-only material, so they stay as the second attempt.
   */
  let res = await downloadAttempt(job, false, onPct);
  let via = 'anonymous';

  if (res.killed) throw new Cancelled('cancelled during download');

  if (res.code !== 0) {
    log(job.id + ' anonymous attempt failed, retrying with cookies');
    clearTmp(job.id);
    last = 0;
    res = await downloadAttempt(job, true, onPct);
    via = 'cookies';
    if (res.killed) throw new Cancelled('cancelled during download');
  }

  if (res.code !== 0) {
    const low = res.tail.toLowerCase();
    const stale = low.includes('sign in') || low.includes('not a bot');
    throw new Error((stale ? 'needs fresh cookies: ' : 'download failed: ') +
                    lastLine(res.tail));
  }

  const src = findTmpSource(job.id);
  if (!src) throw new Error('download reported success but no file appeared');
  log(job.id + ' downloaded via ' + via + ': ' + path.basename(src));
  job.via = via;
  return src;
}

/*
 * Duration of the downloaded source, in seconds.
 *
 * Needed because the RSS fallback feed carries no duration (YouTube's
 * per-channel RSS simply does not include it), and without a total the
 * convert bar would sit at 0% for the whole encode. Probing the file
 * makes progress independent of whatever the feed knew.
 */
async function probeDuration(src) {
  const res = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    src
  ]);
  const secs = parseFloat(String(res.tail).trim());
  return res.code === 0 && isFinite(secs) && secs > 0 ? Math.round(secs) : 0;
}

async function transcode(job, src) {
  setState(job, 'CONVERTING', { pct: 0 });

  if (!job.duration) {
    job.duration = await probeDuration(src);
    if (job.duration) log(job.id + ' probed duration ' + job.duration + 's');
  }

  const tmpOut = path.join(TMP_DIR, job.id + EXT);
  const args = ['-y', '-loglevel', 'info', '-i', src, '-vf', VF]
    .concat(FFMPEG_ARGS, [tmpOut]);

  const total = job.duration > 0 ? job.duration : 0;
  let last = 0;
  const res = await run('ffmpeg', args, (line) => {
    const m = /time=(\d+):(\d\d):(\d\d)/.exec(line);
    if (m && total) {
      const done = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
      const pct = Math.min(99, Math.round((done / total) * 100));
      if (pct >= last + 2) { last = pct; setState(job, 'CONVERTING', { pct }); }
    }
  }, job);

  if (res.killed) throw new Cancelled('cancelled during convert');
  if (res.code !== 0) throw new Error('ffmpeg failed: ' + lastLine(res.tail));
  if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size === 0) {
    throw new Error('ffmpeg produced an empty file');
  }

  // Same filesystem, so this is atomic: the PII never sees a partial .mpg
  // appear on the share.
  const finalOut = path.join(OUT_DIR, job.id + EXT);
  fs.renameSync(tmpOut, finalOut);
  try { fs.unlinkSync(src); } catch (e) { /* best effort */ }
  return finalOut;
}

function lastLine(s) {
  const lines = String(s).trim().split(/\r?\n/).filter(Boolean);
  return (lines[lines.length - 1] || 'no output').slice(0, 300);
}

// Not named process() — that shadows Node's global `process` object
// module-wide and breaks process.env/process.on in confusing ways.
async function runJob(job) {
  const started = Math.floor(Date.now() / 1000);
  try {
    const src = await download(job);
    const out = await transcode(job, src);
    const size = fs.statSync(out).size;
    setState(job, 'READY', {
      pct: 100,
      file: path.basename(out),
      bytes: size,
      error: null,
      finished: Math.floor(Date.now() / 1000),
      took: Math.floor(Date.now() / 1000) - started
    });
    log(job.id + ' done in ' + job.took + 's, ' +
        (size / 1048576).toFixed(1) + ' MB');
    /*
     * Enforce the size cap right after a job, so retention needs no
     * schedule of its own: the only thing that grows the directory is a
     * completed job. quiet:true keeps the log silent when under cap.
     * Never allowed to fail a job that already succeeded.
     */
    try {
      retention.enforce({ quiet: true });
    } catch (e) {
      log('retention failed (job still OK): ' + e.message);
    }
  } catch (err) {
    if (err instanceof Cancelled) {
      /*
       * CANCELLED, not FAILED: nothing went wrong, so the button should
       * offer Download again rather than Retry-with-an-error. The partial
       * download is binned, and `cancel` is cleared so a fresh request
       * for the same video is not instantly cancelled again.
       */
      clearTmp(job.id);
      setState(job, 'CANCELLED', {
        pct: 0,
        cancel: false,
        error: null,
        finished: Math.floor(Date.now() / 1000)
      });
      log(job.id + ' cancelled by request (' + err.message + ')');
      return;
    }
    setState(job, 'FAILED', {
      error: String(err.message || err),
      finished: Math.floor(Date.now() / 1000)
    });
    log(job.id + ' FAILED: ' + job.error);
  }
}

// --- main loop ------------------------------------------------------------

function nextQueued() {
  let best = null;
  for (const f of fs.readdirSync(JOB_DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    if (!VIDEO_ID.test(id)) continue;
    const job = readJob(id);
    if (!job) continue;
    // Anything left mid-flight by a worker restart is retried.
    if (job.state === 'QUEUED' || job.state === 'DOWNLOADING' ||
        job.state === 'CONVERTING') {
      if (!best || (job.queued || 0) < (best.queued || 0)) best = job;
    }
  }
  return best;
}

async function loop() {
  for (;;) {
    let job = null;
    try {
      job = nextQueued();
    } catch (e) {
      log('job scan failed: ' + e.message);
    }
    if (job) {
      // Cancelled while still queued: never start it at all.
      if (job.cancel) {
        clearTmp(job.id);
        setState(job, 'CANCELLED', { pct: 0, cancel: false, error: null });
        log(job.id + ' cancelled before starting');
        continue;
      }
      // If the output already exists, do not re-encode it.
      const existing = path.join(OUT_DIR, job.id + EXT);
      if (fs.existsSync(existing) && fs.statSync(existing).size > 0) {
        setState(job, 'READY', {
          pct: 100,
          file: path.basename(existing),
          bytes: fs.statSync(existing).size,
          error: null
        });
      } else {
        await runJob(job);
      }
    } else {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

function main() {
  for (const d of [JOB_DIR, OUT_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });

  // Single worker only: two encoders on a 2-core box would be worse than one.
  try {
    const fd = fs.openSync(LOCK, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (e) {
    const owner = (() => { try { return fs.readFileSync(LOCK, 'utf8'); } catch (_) { return '?'; } })();
    let alive = false;
    try { process.kill(parseInt(owner, 10), 0); alive = true; } catch (_) { alive = false; }
    if (alive) {
      console.error('[worker] another worker is running (pid ' + owner + ')');
      process.exit(1);
    }
    log('clearing stale lock from pid ' + owner);
    fs.writeFileSync(LOCK, String(process.pid));
  }

  const release = () => { try { fs.unlinkSync(LOCK); } catch (e) {} process.exit(0); };
  process.on('SIGINT', release);
  process.on('SIGTERM', release);

  log('watching ' + JOB_DIR);
  log('output   ' + OUT_DIR + '/<id>' + EXT + '  [profile: ' + PROF.name + ']');
  loop();
}

main();
