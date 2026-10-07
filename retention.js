#!/usr/bin/env node
/*
 * youtube98 — retention (plan section 7)
 *
 * Keeps /media/archive/youtube98 under a size cap by deleting the
 * least-recently-touched movies first, and tidies up after itself.
 *
 *   node retention.js             # enforce
 *   node retention.js --dry-run   # show what would go, delete nothing
 *   YT98_KEEP_GB=50 node retention.js
 *
 * Also imported by worker.js, which enforces after every completed job so
 * this needs no schedule of its own.
 *
 * Safe to run at any time: deleting a movie is now a supported operation.
 * jobState() treats a READY record with no file as never-downloaded, so
 * the page re-offers Download rather than a dead Play button.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const PROF = require('./profiles');

const BASE = __dirname;
const OUT_DIR = process.env.YT98_OUT || path.join(os.homedir(), 'youtube98');
const TMP_DIR = path.join(OUT_DIR, '.tmp');
const JOB_DIR = path.join(BASE, 'cache', 'jobs');

const GB = 1024 * 1024 * 1024;
const KEEP_BYTES = Math.round(parseFloat(process.env.YT98_KEEP_GB || '20') * GB);
/*
 * Audio has its own cap, enforced independently.
 *
 * An MP3 is ~2 MB against a video's ~200 MB, so sharing one cap would let
 * a couple of long video downloads evict a lot of music — and music is
 * more often something you keep than a watched video.
 */
const KEEP_AUDIO_BYTES = Math.round(parseFloat(process.env.YT98_KEEP_AUDIO_GB || '5') * GB);
// 0 disables the age rule; the size cap is the primary control.
const KEEP_DAYS = parseInt(process.env.YT98_KEEP_DAYS || '0', 10);
// Orphaned partial downloads in .tmp/ older than this are junk.
const TMP_STALE_HOURS = 6;

/*
 * Only ever consider files this project produced. Anything else in
 * OUT_DIR — notably _setup/ and .tmp/ — is not ours to delete.
 *
 * Matches every profile's extension, not just the active one, so
 * switching profiles does not leave old output unmanaged.
 */
const MOVIE = new RegExp('^([A-Za-z0-9_-]{11})(' +
  PROF.knownExts.map((e) => e.replace('.', '\\.')).join('|') + ')$');
const AUDIO = new RegExp('^([A-Za-z0-9_-]{11})' +
  PROF.audioExt.replace('.', '\\.') + '$');

function log(msg) {
  console.log('[retention] ' + msg);
}

function gb(bytes) {
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function listFiles(match) {
  let names;
  try {
    names = fs.readdirSync(OUT_DIR);
  } catch (e) {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = match.exec(name);
    if (!m) continue;
    const full = path.join(OUT_DIR, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch (e) {
      continue;
    }
    if (!st.isFile()) continue;
    /*
     * "Last touched" = max(atime, mtime).
     *
     * /media/archive is ext4 with relatime, so atime is only rewritten
     * when it is already older than mtime or more than 24h stale. That
     * makes this day-granular rather than a true LRU — good enough to
     * protect something watched recently, but do not read it as precise.
     * mtime is the floor so a fresh download is never the oldest entry.
     */
    out.push({
      id: m[1],
      name: name,
      full: full,
      size: st.size,
      touched: Math.max(st.atimeMs, st.mtimeMs)
    });
  }
  // Oldest first: deletion order.
  out.sort((a, b) => a.touched - b.touched);
  return out;
}

function dropJobRecord(id, dry, kind) {
  const rec = path.join(JOB_DIR, id + (kind === 'audio' ? '.audio' : '') + '.json');
  if (!fs.existsSync(rec)) return;
  if (dry) return;
  try {
    fs.unlinkSync(rec);
  } catch (e) {
    log('could not remove job record for ' + id + ': ' + e.message);
  }
}

function remove(movie, why, dry, kind) {
  log((dry ? 'would delete ' : 'deleting ') + movie.name +
      ' (' + gb(movie.size) + ', ' + why + ')');
  if (dry) return movie.size;
  try {
    fs.unlinkSync(movie.full);
  } catch (e) {
    log('FAILED to delete ' + movie.name + ': ' + e.message);
    return 0;
  }
  // Leaving the record behind is harmless but it accumulates, and the
  // page is file-driven anyway.
  dropJobRecord(movie.id, dry, kind);
  return movie.size;
}

function sweepTmp(dry) {
  let freed = 0;
  let names;
  try {
    names = fs.readdirSync(TMP_DIR);
  } catch (e) {
    return 0;
  }
  const cutoff = Date.now() - TMP_STALE_HOURS * 3600 * 1000;
  for (const name of names) {
    const full = path.join(TMP_DIR, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch (e) {
      continue;
    }
    if (!st.isFile() || st.mtimeMs > cutoff) continue;
    log((dry ? 'would clear ' : 'clearing ') + 'stale temp file ' + name +
        ' (' + gb(st.size) + ')');
    freed += st.size;
    if (!dry) {
      try { fs.unlinkSync(full); } catch (e) { /* best effort */ }
    }
  }
  return freed;
}

function enforceOne(match, cap, kind, dry, quiet) {
  const files = listFiles(match);
  let total = files.reduce((n, m) => n + m.size, 0);

  if (!quiet || dry) {
    log(kind + ': ' + files.length + ' file(s), ' + gb(total) +
        ' / cap ' + gb(cap));
  }

  let freed = 0;
  let deleted = 0;

  // Age rule first, if enabled: these are unwanted regardless of the cap.
  if (KEEP_DAYS > 0) {
    const cutoff = Date.now() - KEEP_DAYS * 86400 * 1000;
    for (const m of files) {
      if (m.touched >= cutoff) continue;
      const n = remove(m, 'older than ' + KEEP_DAYS + ' days', dry, kind);
      if (n) { freed += n; total -= n; deleted++; m.gone = true; }
    }
  }

  // Then the size cap, oldest-touched first.
  for (const m of files) {
    if (m.gone) continue;
    if (total <= cap) break;
    const n = remove(m, 'over the ' + kind + ' cap', dry, kind);
    if (n) { freed += n; total -= n; deleted++; }
  }

  return { deleted: deleted, freed: freed, total: total };
}

function enforce(options) {
  const dry = !!(options && options.dryRun);
  const quiet = !!(options && options.quiet);

  // Video and audio are capped independently.
  const v = enforceOne(MOVIE, KEEP_BYTES, 'video', dry, quiet);
  const a = enforceOne(AUDIO, KEEP_AUDIO_BYTES, 'audio', dry, quiet);

  let freed = v.freed + a.freed + sweepTmp(dry);
  const deleted = v.deleted + a.deleted;

  if (deleted || freed) {
    log((dry ? 'would free ' : 'freed ') + gb(freed) + ' in ' + deleted +
        ' file(s); now ' + gb(v.total) + ' video + ' + gb(a.total) + ' audio');
  } else if (!quiet) {
    log('nothing to do, both under cap');
  }

  return { deleted: deleted, freed: freed, total: v.total + a.total };
}

module.exports = { enforce: enforce };

if (require.main === module) {
  const dry = process.argv.indexOf('--dry-run') !== -1;
  enforce({ dryRun: dry });
}
