"""Canonical YouTube JSON3 and faithful legacy VTT parsing."""
from __future__ import annotations
import html
import json
import re
import unicodedata
from pathlib import Path

CAPTION_SCHEMA = "canonical-json3-v1"
LEGACY_VTT_SCHEMA = "legacy-vtt-v1"
_PUNCT = re.compile(r"""[\s“”"‘’'`´，,、；;：:。！？!?…~～\-—_]+""")
_MARKER = re.compile(r"^(?:\[[^\]]*\]|\([^)]*\)|【[^】]*】|（[^）]*）)$")
_TIME = re.compile(r"^(?P<s>(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+(?P<e>(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})(?:\s+.*)?$")
_TAG = re.compile(r"<[^>]+>")


def _hash(text):
    value = 2166136261
    for char in text:
        value = ((value ^ ord(char)) * 16777619) & 0xFFFFFFFF
    chars, out = "0123456789abcdefghijklmnopqrstuvwxyz", ""
    if not value:
        return "0"
    while value:
        value, rem = divmod(value, 36)
        out = chars[rem] + out
    return out


def _key(start, end, text):
    normalized = _PUNCT.sub("", unicodedata.normalize("NFKC", text or "")).lower().strip()
    return f"{round(start * 1000)}:{round(end * 1000)}:{_hash(normalized)}"


def stamp_segments(segments, schema=CAPTION_SCHEMA):
    result = []
    for source in segments or []:
        start, end = float(source.get("start") or 0), float(source.get("end") or 0)
        text = str(source.get("text") or "").strip()
        if not text or end <= start:
            continue
        item = dict(source)
        item.update({"_sourceKey": source.get("_sourceKey") or _key(start, end, text),
                     "_sourceIndex": len(result), "_sourceStart": start, "_sourceEnd": end,
                     "_sourceText": text, "_captionSchema": schema,
                     "_canonicalCaption": schema == CAPTION_SCHEMA})
        result.append(item)
    return result


def parse_json3_file(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    cues, previous_start, monotonic = [], float("-inf"), True
    expected_chars, word_timing_count, word_timing_monotonic = 0, 0, True
    for event_index, event in enumerate(data.get("events") or []):
        parts = event.get("segs") or []
        if event.get("tStartMs") is None or event.get("dDurationMs") is None or not parts:
            continue
        raw = "".join(str(part.get("utf8") or "") for part in parts)
        if not raw.replace("\n", "").strip():
            continue
        lines = [line.strip() for line in raw.splitlines() if line.strip() and not _MARKER.fullmatch(line.strip())]
        text = " ".join(lines).strip()
        if not text:
            continue
        start = float(event["tStartMs"]) / 1000
        end = (float(event["tStartMs"]) + max(50.0, float(event["dDurationMs"]))) / 1000
        monotonic = monotonic and start >= previous_start
        previous_start = start
        previous_word = float("-inf")
        for part in parts:
            if part.get("tOffsetMs") is None or not str(part.get("utf8") or "").strip():
                continue
            absolute = start + float(part["tOffsetMs"]) / 1000
            word_timing_count += 1
            word_timing_monotonic = (
                word_timing_monotonic and previous_word <= absolute <= end + 0.001
            )
            previous_word = absolute
        expected_chars += len(text)
        cues.append({"start": start, "end": end, "text": text, "lines": lines,
                     "_json3EventIndex": event_index})
    cues = stamp_segments(cues)
    keys = {cue["_sourceKey"] for cue in cues}
    emitted_chars = sum(len(cue["text"]) for cue in cues)
    audit = {"ok": monotonic and word_timing_monotonic and len(keys) == len(cues)
             and expected_chars == emitted_chars, "schema": CAPTION_SCHEMA,
             "sourceEventCount": len(data.get("events") or []), "emittedCueCount": len(cues),
             "expectedCharCount": expected_chars, "emittedCharCount": emitted_chars,
             "startsMonotonic": monotonic, "wordTimingCount": word_timing_count,
             "wordTimingMonotonic": word_timing_monotonic, "uniqueSourceKeys": len(keys)}
    return (cues if audit["ok"] else []), audit


def _seconds(value):
    total = 0.0
    for part in value.replace(",", ".").split(":"):
        total = total * 60 + float(part)
    return total


def parse_vtt_file(path):
    lines = Path(path).read_text(encoding="utf-8-sig").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    cues, index = [], 0
    while index < len(lines):
        line = lines[index].strip("\ufeff")
        if not line or line == "WEBVTT" or line.startswith("WEBVTT "):
            index += 1
            continue
        if line.startswith(("NOTE", "STYLE", "REGION")):
            index += 1
            while index < len(lines) and lines[index].strip():
                index += 1
            continue
        match = _TIME.match(line)
        if not match and index + 1 < len(lines) and _TIME.match(lines[index + 1].strip()):
            index += 1
            match = _TIME.match(lines[index].strip())
        if not match:
            index += 1
            continue
        index += 1
        text_lines = []
        while index < len(lines) and lines[index].strip():
            visible = html.unescape(_TAG.sub("", lines[index])).strip()
            if visible:
                text_lines.append(visible)
            index += 1
        if text_lines:
            cues.append({"start": _seconds(match.group("s")), "end": _seconds(match.group("e")),
                         "text": " ".join(text_lines), "lines": text_lines})
    return stamp_segments(cues, LEGACY_VTT_SCHEMA)
