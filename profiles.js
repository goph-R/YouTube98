#!/usr/bin/env node
/*
 * youtube98 — encode profiles
 *
 * Shared by server.js, worker.js and retention.js so the output
 * extension and the ffmpeg settings live in exactly one place.
 *
 *   node profiles.js              list profiles and the resolved settings
 *   YT98_PROFILE=xvid512 ...      pick one
 *   YT98_WIDTH=576 YT98_VB=1200   override any individual knob
 *
 * Switching profiles does not orphan existing files: everything that
 * looks for output accepts any KNOWN_EXTS, and the page is told the real
 * extension per video.
 */

'use strict';

/*
 * Calibration comes from two files the target machine (Pentium II
 * 350 MHz, Radeon 9200, Win98SE) is known to play:
 *
 *   Equilibrium.avi      Xvid SP, 512x288, 23.976fps,  768 kbps  — smooth
 *   Equilibrium-HQ.avi   Xvid SP, 640x368, 23.976fps, 1400 kbps  — "very
 *                        subtle hiccups", and worth it
 *
 * So the ceiling is known from both sides, and the three profiles below
 * bracket it rather than guessing.
 */
const PROFILES = {
  /*
   * The safe default: MPEG-1 in MPEG-PS plays on Win98SE with no codec
   * installed at all, because the OS ships a DirectShow MPEG-1 decoder.
   */
  mpeg1: {
    ext: '.mpg',
    desc: '352px MPEG-1 / MP2 — needs no codec on Win98',
    vcodec: 'mpeg1video',
    acodec: 'mp2',
    width: 352, height: 288, fps: 25, vb: 1150, ab: 192,
    simple: false,
    cbr: true          // hold it near-constant; MPEG-1 decoders prefer that
  },

  /*
   * Mid: matched to Equilibrium.avi, the one that plays smoothly.
   * 16:9 lands on exactly 512x288 — no padding needed, since 288 is
   * already a multiple of 16. Bitrate a little above the reference
   * because YouTube sources carry more noise than a film transfer.
   */
  xvid512: {
    ext: '.avi',
    desc: '512px Xvid SP / MP3 — matched to the file that plays smoothly',
    vcodec: 'mpeg4', vtag: 'XVID',
    acodec: 'libmp3lame',
    width: 512, height: 384, fps: 24, vb: 1000, ab: 128,
    simple: true,
    cbr: false
  },

  /*
   * High: matched to Equilibrium-HQ.avi. Expect the same "subtle
   * hiccups" that file has — that is the known cost of this quality.
   */
  xvid640: {
    ext: '.avi',
    desc: '640px Xvid SP / MP3 — matched to the HQ file (subtle hiccups)',
    vcodec: 'mpeg4', vtag: 'XVID',
    acodec: 'libmp3lame',
    width: 640, height: 480, fps: 24, vb: 1500, ab: 128,
    simple: true,
    cbr: false
  }
};

/*
 * Friendly aliases. `low`/`mid`/`high` because that is how these get
 * talked about in practice, and `xvid480` because it was the original
 * name of the 640px profile and existing service units may still say it.
 */
const ALIASES = {
  low: 'mpeg1',
  mid: 'xvid512',
  high: 'xvid640',
  xvid480: 'xvid640'
};

// --- selection + per-knob overrides --------------------------------------

const REQUESTED = process.env.YT98_PROFILE || 'mpeg1';
const NAME = ALIASES[REQUESTED] || REQUESTED;

if (!PROFILES[NAME]) {
  console.error('[youtube98] unknown YT98_PROFILE "' + REQUESTED + '"; known: ' +
                Object.keys(PROFILES).join(', ') +
                ' (aliases: ' + Object.keys(ALIASES).join(', ') + ')');
  process.exit(2);
}

function num(envName, fallback) {
  const v = process.env[envName];
  if (v === undefined || v === '') return fallback;
  const n = parseFloat(v);
  if (!isFinite(n) || n <= 0) {
    console.error('[youtube98] ignoring bad ' + envName + '="' + v + '"');
    return fallback;
  }
  return n;
}

/*
 * Every knob is individually overridable, so tuning for a particular
 * machine does not need a code change. Start from a profile, then nudge:
 *
 *   YT98_PROFILE=xvid512 YT98_FPS=20        same size, less CPU
 *   YT98_PROFILE=xvid640 YT98_VB=1200       same size, lower bitrate
 *   YT98_PROFILE=xvid640 YT98_WIDTH=576     between the two presets
 */
const base = PROFILES[NAME];
const PROFILE = {
  ext:    process.env.YT98_EXT || base.ext,
  desc:   base.desc,
  vcodec: process.env.YT98_VCODEC || base.vcodec,
  vtag:   process.env.YT98_VTAG || base.vtag,
  acodec: process.env.YT98_ACODEC || base.acodec,
  width:  Math.round(num('YT98_WIDTH',  base.width)),
  height: Math.round(num('YT98_HEIGHT', base.height)),
  fps:    num('YT98_FPS', base.fps),
  vb:     Math.round(num('YT98_VB', base.vb)),
  ab:     Math.round(num('YT98_AB', base.ab)),
  simple: base.simple,
  cbr:    base.cbr
};

// Every video extension any profile can produce, so looking for existing
// output never misses a file made under a different profile.
const KNOWN_EXTS = Object.keys(PROFILES).map((k) => PROFILES[k].ext)
  .concat([PROFILE.ext])
  .filter((e, i, a) => a.indexOf(e) === i);

/*
 * Audio-only output, requested per job rather than per profile — a video
 * and an MP3 of the same id can both exist.
 *
 * ID3v2.3 *and* ID3v1 are both written on purpose: that is the pair
 * Winamp on Win98 reads reliably, and v2.4 is not well supported by
 * players of that era. Since the filename is only the video id, the tags
 * are the only thing carrying the title and channel.
 */
const AUDIO = {
  ext: '.mp3',
  desc: 'MP3 audio only (ID3v2.3 + ID3v1 for Winamp on Win98)',
  acodec: process.env.YT98_MP3_CODEC || 'libmp3lame',
  ab: Math.round(num('YT98_MP3_AB', 192))
};

function audioArgs(a) {
  return [
    '-vn',
    '-c:a', a.acodec, '-ar', '44100', '-ac', '2', '-b:a', a.ab + 'k',
    '-id3v2_version', '3', '-write_id3v1', '1'
  ];
}

/*
 * Scale to fit inside the box without distorting, then pad both axes up
 * to a multiple of 16.
 *
 * The padding is not cosmetic. MPEG-1 and MPEG-4 both code in 16x16
 * macroblocks, so a dimension that is not a multiple of 16 is coded
 * padded and expected to be cropped on playback — and Win98's decoders
 * do not do that reliably. The surplus rows then show as a green band,
 * because the padding carries zeroed chroma. Padding deliberately, in
 * black, removes the problem.
 */
function videoFilter(p) {
  return 'scale=' + p.width + ':' + p.height +
         ':force_original_aspect_ratio=decrease' +
         ',fps=' + p.fps +
         ',pad=ceil(iw/16)*16:ceil(ih/16)*16:(ow-iw)/2:(oh-ih)/2:black';
}

function ffmpegArgs(p) {
  const maxrate = p.cbr ? p.vb : Math.round(p.vb * 1.2);
  const bufsize = p.cbr ? Math.round(p.vb * 0.28) : Math.round(p.vb * 2.4);
  let a = ['-c:v', p.vcodec];
  if (p.vtag) a = a.concat(['-vtag', p.vtag]);
  /*
   * Simple Profile only: no B-frames, no quarter-pixel, no GMC.
   * Advanced Simple Profile roughly doubles the decode cost, and is most
   * of why "Xvid" has a reputation for stuttering on hardware this old.
   */
  if (p.simple) a = a.concat(['-bf', '0', '-flags', '-qpel']);
  a = a.concat([
    '-b:v', p.vb + 'k',
    '-maxrate', maxrate + 'k',
    '-bufsize', bufsize + 'k',
    '-c:a', p.acodec, '-ar', '44100', '-ac', '2', '-b:a', p.ab + 'k'
  ]);
  return a;
}

module.exports = {
  name: NAME,
  requested: REQUESTED,
  profile: PROFILE,
  ext: PROFILE.ext,
  args: ffmpegArgs(PROFILE),
  vf: videoFilter(PROFILE),
  knownExts: KNOWN_EXTS,
  all: PROFILES,
  // audio is a per-job choice, not a profile
  audio: AUDIO,
  audioExt: AUDIO.ext,
  audioArgs: audioArgs(AUDIO)
};

if (require.main === module) {
  const box = (p) => p.width + 'x' + p.height;
  console.log('Profiles (* = active):\n');
  for (const k of Object.keys(PROFILES)) {
    const p = PROFILES[k];
    const active = (k === NAME);
    console.log((active ? '* ' : '  ') + k.padEnd(9) + p.ext.padEnd(6) +
                box(p).padEnd(9) + (p.fps + 'fps').padEnd(7) +
                (p.vb + 'k').padEnd(7) + p.desc);
  }
  console.log('\nAliases: ' + JSON.stringify(ALIASES));
  console.log('\nResolved settings for "' + NAME + '":');
  console.log('  -vf ' + videoFilter(PROFILE));
  console.log('  ' + ffmpegArgs(PROFILE).join(' '));
  console.log('\nAudio-only output (per job, the MP3 button):');
  console.log('  ' + AUDIO.ext + '  ' + audioArgs(AUDIO).join(' '));
  console.log('\nOverridable: YT98_WIDTH YT98_HEIGHT YT98_FPS YT98_VB YT98_AB');
  console.log('             YT98_VCODEC YT98_VTAG YT98_ACODEC YT98_EXT');
  console.log('             YT98_MP3_AB YT98_MP3_CODEC');
}
