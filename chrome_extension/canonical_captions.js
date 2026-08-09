// Deterministic YouTube json3 -> canonical cue conversion.
//
// json3 auto-caption "rolling" is represented by text events separated by
// newline-only aAppend events.  The newline events are presentation commands,
// not speech.  Every event containing text is therefore one immutable source
// cue; no visible-window diff, prefix matching, or fuzzy deletion belongs here.
(function initCanonicalCaptions(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DubCanonicalCaptions = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function canonicalCaptionsFactory() {
  'use strict';

  const SCHEMA = 'canonical-json3-v1';

  function hashText(text) {
    let h = 2166136261;
    for (const ch of String(text || '')) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function normalizeIdentityText(text) {
    return String(text || '')
      .normalize('NFKC')
      .replace(/\s+/g, '')
      .replace(/[“”"‘’'`´]/g, '')
      .replace(/[，,、；;：:。！？!?…~～\-—_]/g, '')
      .toLowerCase()
      .trim();
  }

  function stripWholeNonSpeechMarker(line) {
    const value = String(line || '').trim();
    if (!value) return '';
    if (/^(?:\[[^\]]*\]|\([^)]*\)|【[^】]*】|（[^）]*）)$/.test(value)) return '';
    return value;
  }

  function sourceKey(start, end, text) {
    return `${Math.round(start * 1000)}:${Math.round(end * 1000)}:${hashText(normalizeIdentityText(text))}`;
  }

  function parseJson3Object(data) {
    const events = Array.isArray(data?.events) ? data.events : [];
    const segments = [];
    const keys = new Set();
    let expectedCueCount = 0;
    let expectedCharCount = 0;
    let emittedCharCount = 0;
    let wordTimingCount = 0;
    let wordTimingMonotonic = true;
    let startsMonotonic = true;
    let previousStart = Number.NEGATIVE_INFINITY;

    for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
      const event = events[eventIndex];
      if (!event || !Array.isArray(event.segs) || event.dDurationMs == null
          || event.tStartMs == null) continue;

      const raw = event.segs.map((part) => String(part?.utf8 || '')).join('');
      // Newline-only aAppend events scroll the caption window. They contain no
      // speech and must never become a subtitle/TTS cue.
      if (!raw.replace(/\n/g, '').trim()) continue;

      const lines = raw.split(/\n+/).map(stripWholeNonSpeechMarker).filter(Boolean);
      if (!lines.length) continue;
      const text = lines.join(' ').trim();
      if (!text) continue;

      expectedCueCount += 1;
      expectedCharCount += text.length;
      const start = Number(event.tStartMs) / 1000;
      const end = (Number(event.tStartMs) + Math.max(50, Number(event.dDurationMs) || 0)) / 1000;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return {
          segments: [],
          audit: { ok: false, schema: SCHEMA, reason: `invalid_event_time:${eventIndex}` },
        };
      }
      if (start < previousStart) startsMonotonic = false;
      previousStart = start;

      let previousWordAt = Number.NEGATIVE_INFINITY;
      for (const part of event.segs) {
        if (part?.tOffsetMs == null || !String(part?.utf8 || '').trim()) continue;
        const absolute = start + Number(part.tOffsetMs) / 1000;
        wordTimingCount += 1;
        if (!Number.isFinite(absolute) || absolute < previousWordAt || absolute > end + 0.001) {
          wordTimingMonotonic = false;
        }
        previousWordAt = absolute;
      }

      const key = sourceKey(start, end, text);
      if (keys.has(key)) {
        return {
          segments: [],
          audit: { ok: false, schema: SCHEMA, reason: `duplicate_source_key:${eventIndex}` },
        };
      }
      keys.add(key);
      emittedCharCount += text.length;
      segments.push({
        start,
        end,
        text,
        lines,
        _sourceKey: key,
        _sourceIndex: segments.length,
        _sourceStart: start,
        _sourceEnd: end,
        _sourceText: text,
        _captionSchema: SCHEMA,
        _canonicalCaption: true,
        _json3EventIndex: eventIndex,
      });
    }

    const audit = {
      ok: expectedCueCount === segments.length
        && expectedCharCount === emittedCharCount
        && startsMonotonic
        && wordTimingMonotonic
        && keys.size === segments.length,
      schema: SCHEMA,
      sourceEventCount: events.length,
      expectedCueCount,
      emittedCueCount: segments.length,
      expectedCharCount,
      emittedCharCount,
      startsMonotonic,
      wordTimingCount,
      wordTimingMonotonic,
      uniqueSourceKeys: keys.size,
    };
    if (!audit.ok) audit.reason = 'canonical_reconciliation_failed';
    return { segments: audit.ok ? segments : [], audit };
  }

  function parseJson3Text(body) {
    try {
      const data = typeof body === 'string' ? JSON.parse(body) : body;
      return parseJson3Object(data);
    } catch (error) {
      return {
        segments: [],
        audit: {
          ok: false,
          schema: SCHEMA,
          reason: 'invalid_json3',
          error: String(error?.message || error),
        },
      };
    }
  }

  function isCanonicalTimeline(segments) {
    return Array.isArray(segments) && segments.length > 0
      && segments.every((segment, index) =>
        segment?._canonicalCaption === true
        && segment?._captionSchema === SCHEMA
        && segment?._sourceKey
        && Number(segment?._sourceIndex) === index);
  }

  function stampServerSegments(segments, schema = SCHEMA) {
    if (!Array.isArray(segments)) return [];
    return segments.map((segment, index) => {
      const start = Number(segment?.start || 0);
      const end = Number(segment?.end ?? start);
      const text = String(segment?.text || '').trim();
      return {
        ...segment,
        _sourceKey: segment?._sourceKey || sourceKey(start, end, text),
        _sourceIndex: index,
        _sourceStart: start,
        _sourceEnd: end,
        _sourceText: text,
        _captionSchema: schema,
        _canonicalCaption: schema === SCHEMA,
      };
    });
  }

  function parseVttTimestamp(value) {
    const parts = String(value || '').replace(',', '.').split(':');
    let seconds = 0;
    for (const part of parts) seconds = seconds * 60 + Number(part);
    return seconds;
  }

  function parseVttText(body) {
    const lines = String(body || '').replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n').split('\n');
    const segments = [];
    const timing = /^((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})(?:\s+.*)?$/;
    for (let index = 0; index < lines.length;) {
      let line = lines[index].trim();
      if (!line || line === 'WEBVTT' || line.startsWith('WEBVTT ')) {
        index += 1;
        continue;
      }
      if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(line)) {
        index += 1;
        while (index < lines.length && lines[index].trim()) index += 1;
        continue;
      }
      let match = line.match(timing);
      if (!match && index + 1 < lines.length && lines[index + 1].trim().match(timing)) {
        index += 1; // cue identifier
        line = lines[index].trim();
        match = line.match(timing);
      }
      if (!match) {
        index += 1;
        continue;
      }
      index += 1;
      const textLines = [];
      while (index < lines.length && lines[index].trim()) {
        const visible = lines[index].replace(/<[^>]+>/g, '').trim();
        if (visible) textLines.push(visible);
        index += 1;
      }
      const text = textLines.join(' ').trim();
      const start = parseVttTimestamp(match[1]);
      const end = parseVttTimestamp(match[2]);
      if (text && Number.isFinite(start) && Number.isFinite(end) && end > start) {
        segments.push({
          start, end, text, lines: textLines,
          _sourceIndex: segments.length,
          _sourceStart: start,
          _sourceEnd: end,
          _sourceText: text,
          _sourceKey: sourceKey(start, end, text),
          _captionSchema: 'legacy-vtt-v1',
          _canonicalCaption: false,
        });
      }
    }
    return segments;
  }

  return {
    SCHEMA,
    hashText,
    normalizeIdentityText,
    sourceKey,
    parseJson3Object,
    parseJson3Text,
    isCanonicalTimeline,
    stampServerSegments,
    parseVttText,
  };
});
