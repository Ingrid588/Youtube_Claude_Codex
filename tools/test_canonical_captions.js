'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const canonical = require('../chrome_extension/canonical_captions.js');

const root = path.resolve(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(
  path.join(root, 'temp_subs', 'ko2WzqpjWiA.en-orig.json3'), 'utf8'));
const parsed = canonical.parseJson3Object(fixture);

assert.strictEqual(parsed.audit.ok, true);
assert.strictEqual(parsed.audit.sourceEventCount, 8176);
assert.strictEqual(parsed.segments.length, 4086);
assert.strictEqual(
  parsed.segments.reduce((total, cue) => total + cue.text.trim().split(/\s+/).length, 0),
  27493);
assert.strictEqual(new Set(parsed.segments.map((cue) => cue._sourceKey)).size, 4086);
assert.strictEqual(canonical.isCanonicalTimeline(parsed.segments), true);

const synthetic = canonical.parseJson3Object({
  events: [
    { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'repeat', tOffsetMs: 0 }] },
    { tStartMs: 2000, dDurationMs: 50, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 3000, dDurationMs: 1000,
      segs: [{ utf8: 'repeat\nembedded snapshot', tOffsetMs: 0 }] },
    { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: 'repeat', tOffsetMs: 0 }] },
  ],
});
assert.strictEqual(synthetic.audit.ok, true);
assert.deepStrictEqual(synthetic.segments.map((cue) => cue.text),
  ['repeat', 'repeat embedded snapshot', 'repeat']);
assert.notStrictEqual(synthetic.segments[0]._sourceKey, synthetic.segments[2]._sourceKey);

const vtt = '\uFEFFWEBVTT\n\nNOTE metadata\nignored\n\n'
  + 'id-1\n00:00:02.500 --> 00:00:04.000 align:start\nfirst\nsecond\n\n'
  + '00:05.000 --> 00:06.000\n<v A>third</v>\n';
const vttCues = canonical.parseVttText(vtt);
assert.strictEqual(vttCues.length, 2);
assert.strictEqual(vttCues[0].start, 2.5);
assert.deepStrictEqual(vttCues[0].lines, ['first', 'second']);
assert.strictEqual(vttCues[0]._canonicalCaption, false);

// Playback suppression keys include seekEpoch in content.js. The same source
// object is suppressed in one epoch and is eligible again after a rewind.
const cueKey = synthetic.segments[0]._sourceKey;
assert.strictEqual(`7|${cueKey}`, `7|${cueKey}`);
assert.notStrictEqual(`7|${cueKey}`, `8|${cueKey}`);

console.log('browser canonical captions regression: ok');
