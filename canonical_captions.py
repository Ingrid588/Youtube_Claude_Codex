"""Deterministic caption parsers shared by subtitle-prefetch servers.

JSON3 text events are the source of truth.  Newline-only aAppend events are
presentation commands and are ignored.  VTT is parsed faithfully as a legacy
fallback: timestamps are never shifted and text is never fuzzy-deduplicated.
"""
from __future__ import annotations

import html
import json
import re
import unicodedata
from pathlib import Path

CAPTION_SCHEMA = "canonical-json3-v1"
LEGACY_VTT_SCHEMA = "legacy-vtt-v1"

_IDENTITY_PUNCT = re.compile(r"""[\s“”"‘’'`´，,、；;：:。！？!?…~～\-—_]+""")
_WHOLE_MARKER = re.compile(r"^(?:\[[^\]]*\]|\([^)]*\)|【[^】]*】|（[^）]*）)$")
_VTT_TIME = re.compile(
    r"^(?P<start>(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+"
    r"(?P<end>(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})(?:\s+.*)?$"
)
_VTT_TAG = re.compile(r"<[^>]+>")


def _fnv1a(text: str) -> str:
    value = 2166136261
    for char in text:
        value ^= ord(char)
        value = (value * 16777619) & 0xFFFFFFFF
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    if value == 0:
        return "0"
    out = ""
    while value:
        value, remainder = divmod(value, 36)
        out = chars[remainder] + out
    return out


def _identity_text(text: str) -> str:
    return _IDENTITY_PUNCT.sub("", unicodedata.normalize("NFKC", text or "")).lower().strip()


def canonical_source_key(start: float, end: float, text: str) -> str:
    return f"{round(start * 1000)}:{round(end * 1000)}:{_fnv1a(_identity_text(text))}"


def _strip_marker(line: str) -> str:
    value = (line or "").strip()
    return "" if _WHOLE_MARKER.fullmatch(value) else value


def stamp_segments(segments: list[dict], schema: str = CAPTION_SCHEMA) -> list[dict]:
    canonical = schema == CAPTION_SCHEMA
    stamped = []
    for index, source in enumerate(segments or []):
        start = float(source.get("start") or 0)
        end = float(source.get("end") or start)
        text = str(source.get("text") or "").strip()
        if not text or end <= start:
            continue
        item = dict(source)
        item.update({
            "_sourceKey": source.get("_sourceKey") or canonical_source_key(start, end, text),
            "_sourceIndex": len(stamped),
            "_sourceStart": start,
            "_sourceEnd": end,
            "_sourceText": text,
            "_captionSchema": schema,
            "_canonicalCaption": canonical,
        })
        stamped.append(item)
    return stamped


def parse_json3_data(data: dict) -> tuple[list[dict], dict]:
    events = data.get("events") or []
    cues = []
    expected_chars = 0
    word_timing_count = 0
    word_timing_monotonic = True
    starts_monotonic = True
    previous_start = float("-inf")

    for event_index, event in enumerate(events):
        parts = event.get("segs") or []
        if event.get("tStartMs") is None or event.get("dDurationMs") is None or not parts:
            continue
        raw = "".join(str(part.get("utf8") or "") for part in parts)
        if not raw.replace("\n", "").strip():
            continue
        lines = [_strip_marker(line) for line in raw.splitlines()]
        lines = [line for line in lines if line]
        text = " ".join(lines).strip()
        if not text:
            continue
        start = float(event["tStartMs"]) / 1000
        end = (float(event["tStartMs"]) + max(50.0, float(event["dDurationMs"]))) / 1000
        if start < previous_start:
            starts_monotonic = False
        previous_start = start
        previous_word = float("-inf")
        for part in parts:
            if part.get("tOffsetMs") is None or not str(part.get("utf8") or "").strip():
                continue
            absolute = start + float(part["tOffsetMs"]) / 1000
            word_timing_count += 1
            if absolute < previous_word or absolute > end + 0.001:
                word_timing_monotonic = False
            previous_word = absolute
        expected_chars += len(text)
        cues.append({
            "start": start,
            "end": end,
            "text": text,
            "lines": lines,
            "_json3EventIndex": event_index,
        })

    cues = stamp_segments(cues)
    unique = len({cue["_sourceKey"] for cue in cues}) == len(cues)
    emitted_chars = sum(len(cue["text"]) for cue in cues)
    audit = {
        "ok": starts_monotonic and word_timing_monotonic and unique
        and expected_chars == emitted_chars,
        "schema": CAPTION_SCHEMA,
        "sourceEventCount": len(events),
        "emittedCueCount": len(cues),
        "expectedCharCount": expected_chars,
        "emittedCharCount": emitted_chars,
        "startsMonotonic": starts_monotonic,
        "wordTimingCount": word_timing_count,
        "wordTimingMonotonic": word_timing_monotonic,
        "uniqueSourceKeys": len({cue["_sourceKey"] for cue in cues}),
    }
    return (cues if audit["ok"] else []), audit


def parse_json3_file(path: str | Path) -> tuple[list[dict], dict]:
    with open(path, encoding="utf-8") as handle:
        return parse_json3_data(json.load(handle))


def _timestamp_seconds(value: str) -> float:
    parts = value.replace(",", ".").split(":")
    seconds = 0.0
    for part in parts:
        seconds = seconds * 60 + float(part)
    return seconds


def parse_vtt_text(vtt_text: str) -> list[dict]:
    """Faithfully parse VTT cues without shifting or fuzzy text deletion."""
    lines = vtt_text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    cues = []
    index = 0
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
        match = _VTT_TIME.match(line)
        if not match and index + 1 < len(lines):
            possible_time = lines[index + 1].strip()
            if _VTT_TIME.match(possible_time):
                index += 1
                line = possible_time
                match = _VTT_TIME.match(line)
        if not match:
            index += 1
            continue
        index += 1
        text_lines = []
        while index < len(lines) and lines[index].strip():
            visible = html.unescape(_VTT_TAG.sub("", lines[index])).strip()
            if visible:
                text_lines.append(visible)
            index += 1
        text = " ".join(text_lines).strip()
        if text:
            cues.append({
                "start": _timestamp_seconds(match.group("start")),
                "end": _timestamp_seconds(match.group("end")),
                "text": text,
                "lines": text_lines,
            })
    return stamp_segments(cues, LEGACY_VTT_SCHEMA)


def parse_vtt_file(path: str | Path) -> list[dict]:
    return parse_vtt_text(Path(path).read_text(encoding="utf-8-sig"))
