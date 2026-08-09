#!/usr/bin/env python3
"""Regression gate for canonical JSON3 and faithful VTT timelines."""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from canonical_captions import (  # noqa: E402
    CAPTION_SCHEMA,
    parse_json3_data,
    parse_json3_file,
    parse_vtt_text,
)


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


fixture = ROOT / "temp_subs" / "ko2WzqpjWiA.en-orig.json3"
data = json.loads(fixture.read_text(encoding="utf-8"))
cues, audit = parse_json3_file(fixture)
events = data["events"]
newline_only = sum(
    1 for event in events
    if event.get("segs")
    and not "".join(str(part.get("utf8") or "") for part in event["segs"]).replace("\n", "").strip()
)
word_count = sum(len(cue["text"].split()) for cue in cues)

assert len(events) == 8176
assert newline_only == 4087
assert audit["ok"] and audit["schema"] == CAPTION_SCHEMA
assert len(cues) == 4086
assert word_count == 27493
assert len({cue["_sourceKey"] for cue in cues}) == len(cues)
assert all(cue["_sourceIndex"] == index for index, cue in enumerate(cues))

synthetic = {
    "events": [
        {"tStartMs": 1000, "dDurationMs": 1000,
         "segs": [{"utf8": "same", "tOffsetMs": 0}]},
        {"tStartMs": 2000, "dDurationMs": 100, "aAppend": 1,
         "segs": [{"utf8": "\n"}]},
        {"tStartMs": 3000, "dDurationMs": 1000,
         "segs": [{"utf8": "same\nsecond line", "tOffsetMs": 0}]},
        {"tStartMs": 5000, "dDurationMs": 1000,
         "segs": [{"utf8": "same", "tOffsetMs": 0}]},
    ]
}
synthetic_cues, synthetic_audit = parse_json3_data(synthetic)
assert synthetic_audit["ok"]
assert [cue["text"] for cue in synthetic_cues] == ["same", "same second line", "same"]
assert synthetic_cues[0]["_sourceKey"] != synthetic_cues[2]["_sourceKey"]

vtt = """\ufeffWEBVTT

STYLE
::cue { color: lime; }

NOTE ignored metadata
more metadata

cue-one
00:00:02.500 --> 00:00:04.000 align:start position:10%
first line
second line

00:05.000 --> 00:06.250
<v Speaker>third &amp; final</v>
"""
vtt_cues = parse_vtt_text(vtt)
assert len(vtt_cues) == 2
assert vtt_cues[0]["start"] == 2.5
assert vtt_cues[0]["end"] == 4.0
assert vtt_cues[0]["lines"] == ["first line", "second line"]
assert vtt_cues[0]["text"] == "first line second line"
assert vtt_cues[1]["text"] == "third & final"
assert not vtt_cues[0]["_canonicalCaption"]

# All deployable server copies must produce byte-for-byte-equivalent cue
# identities from the same JSON3 and preserve a VTT first cue's real start.
for folder in ("cloud_run_deploy", "hf_dub_space"):
    module = load_module(ROOT / folder / "canonical_captions.py", f"{folder}_captions")
    deploy_cues, deploy_audit = module.parse_json3_file(fixture)
    assert deploy_audit["ok"]
    assert [(c["start"], c["end"], c["text"], c["_sourceKey"]) for c in deploy_cues] == [
        (c["start"], c["end"], c["text"], c["_sourceKey"]) for c in cues
    ]
    with tempfile.NamedTemporaryFile("w", suffix=".vtt", encoding="utf-8", delete=False) as handle:
        handle.write(vtt)
        temp_path = handle.name
    assert module.parse_vtt_file(temp_path)[0]["start"] == 2.5

print("canonical timeline regression: ok")
