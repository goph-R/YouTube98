#!/usr/bin/env node
/*
 * youtube98 — encode profiles
 *
 * Shared by server.js, worker.js and retention.js so the output
 * extension is defined in exactly one place.
 *
 *   YT98_PROFILE=mpeg1    (default) 352px MPEG-1 in MPEG-PS
 *   YT98_PROFILE=xvid480  640px Xvid in AVI
 *
 * Switching profiles does not orphan existing files: everything that
 * looks for output accepts any KNOWN_EXTS, and the page is told the real
 * extension per video.
 */

'use strict';

const PROFILES = {
  /*
   * The conservative default. MPEG-1 in an MPEG-PS container plays on
   * Win98SE with no codec installed at all, because the OS ships a
   * DirectShow MPEG-1 decoder. Safe on a Pentium II at 352px.
   */
  mpeg1: {
    ext: '.mpg',
    desc: 'MPEG-1 352px / MP2 (no codec install needed)',
    width: 352,
    height: 288,
    fps: 25,
    args: [
      '-c:v', 'mpeg1video',
      '-b:v', '1150k', '-maxrate', '1150k', '-bufsize', '320k',
      '-c:a', 'mp2', '-ar', '44100', '-ac', '2', '-b:a', '192k'
    ]
  },

  /*
   * Measured against a file the target PII 350 / Radeon 9200 actually
   * plays — Equilibrium-HQ.avi: Xvid Simple Profile, 640x368, 23.976fps,
   * 1400 kbps video, MP3 128k. That plays with "very subtle hiccups", so
   * this profile matches it rather than exceeding it.
   *
   * Simple Profile deliberately: no B-frames, no quarter-pixel, no GMC.
   * Advanced Simple Profile would roughly double the decode cost and is
   * what makes "Xvid" files stutter on hardware this old.
   *
   * fps is capped at 24 rather than 25 to sit just under the reference.
   * A 30fps source therefore gets frame-dropped, which judders slightly
   * — the trade is deliberate, since frame rate costs as much as
   * resolution on a CPU this slow.
   *
   * REQUIRES an Xvid or DivX decoder (or ffdshow) installed on Win98.
   * Unlike mpeg1, this will not play on a bare install.
   */
  xvid480: {
    ext: '.avi',
    desc: 'Xvid Simple Profile 640px / MP3 (needs an Xvid codec on Win98)',
    width: 640,
    height: 480,
    fps: 24,
    args: [
      '-c:v', 'mpeg4', '-vtag', 'XVID',
      // Simple Profile: keep the decoder's job cheap.
      '-bf', '0', '-flags', '-qpel',
      '-b:v', '1500k', '-maxrate', '1800k', '-bufsize', '3600k',
      '-c:a', 'libmp3lame', '-ar', '44100', '-ac', '2', '-b:a', '128k'
    ]
  }
};

const NAME = process.env.YT98_PROFILE || 'mpeg1';
const PROFILE = PROFILES[NAME];

if (!PROFILE) {
  console.error('[youtube98] unknown YT98_PROFILE "' + NAME + '"; known: ' +
                Object.keys(PROFILES).join(', '));
  process.exit(2);
}

// Every extension any profile can produce. Used when looking for
// existing output so a profile switch does not hide earlier downloads.
const KNOWN_EXTS = Object.keys(PROFILES).map((k) => PROFILES[k].ext)
  .filter((e, i, a) => a.indexOf(e) === i);

/*
 * Scale to fit inside the profile's box without distorting, then pad
 * both axes up to a multiple of 16.
 *
 * The padding is not cosmetic: MPEG-1 and MPEG-4 both code in 16x16
 * macroblocks, and a dimension that is not a multiple of 16 is coded
 * padded and expected to be cropped on playback. Win98's decoders do not
 * do that reliably, and the surplus rows show up as a green band because
 * the padding carries zeroed chroma. Padding deliberately, in black,
 * avoids the whole problem.
 *
 * 16:9 at 640 gives 640x368 — which is exactly the geometry of the
 * reference file the PII is known to handle.
 */
function videoFilter(p) {
  return 'scale=' + p.width + ':' + p.height +
         ':force_original_aspect_ratio=decrease' +
         ',fps=' + p.fps +
         ',pad=ceil(iw/16)*16:ceil(ih/16)*16:(ow-iw)/2:(oh-ih)/2:black';
}

module.exports = {
  name: NAME,
  profile: PROFILE,
  ext: PROFILE.ext,
  args: PROFILE.args,
  vf: videoFilter(PROFILE),
  knownExts: KNOWN_EXTS,
  all: PROFILES
};

if (require.main === module) {
  for (const k of Object.keys(PROFILES)) {
    const p = PROFILES[k];
    console.log((k === NAME ? '* ' : '  ') + k.padEnd(9) + p.ext.padEnd(6) + p.desc);
    console.log('    -vf ' + videoFilter(p));
  }
}
