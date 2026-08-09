# -*- coding: utf-8 -*-
"""
从 YouTube timedtext json3 确定性重建 SRT，并对账"零漏零重"。

用途：验证 content.js 里 parseTimedText 新版 json3 解析的正确性——
      滚动只是显示层效果，数据本身无损：每个"有文本的事件"= 一行字幕，
      纯换行/aAppend 事件是滚动分隔符。逐条产出即可，不多不少不重。

用法：
  python tools/rebuild_srt_from_json3.py temp_subs/ko2WzqpjWiA.en-orig.json3
  python tools/rebuild_srt_from_json3.py <in.json3> -o <out.srt>
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from canonical_captions import parse_json3_data


def strip_nonspeech(line):
    """去掉 [Music] (applause) ♪ 等非语音标记，尽量与 content.js 保持一致。"""
    s = line.strip()
    # 整行就是一个标记块（[...] 或 (...)）时丢弃
    if (s.startswith('[') and s.endswith(']')) or (s.startswith('(') and s.endswith(')')):
        return ''
    return s


def parse_events(data):
    """调用生产环境同一 canonical 构建器，防止验证工具与浏览器各写一套规则。"""
    cues, audit = parse_json3_data(data)
    if not audit.get('ok'):
        raise ValueError(f'canonical timeline 对账失败: {audit}')
    return cues


def fmt_ts(sec):
    if sec < 0:
        sec = 0
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'


def to_srt(cues):
    out = []
    for i, c in enumerate(cues, 1):
        out.append(str(i))
        out.append(f'{fmt_ts(c["start"])} --> {fmt_ts(c["end"])}')
        out.append(c['text'])
        out.append('')
    return '\n'.join(out)


def reconcile(data, cues):
    """对账：统计原始词数 vs 重建词数，检查单调、重叠、重复。"""
    src_events = [e for e in (data.get('events') or [])
                  if e.get('segs') and ''.join((s.get('utf8') or '') for s in e['segs']).replace('\n', '').strip()]

    def is_nonspeech_only(e):
        raw = ''.join((s.get('utf8') or '') for s in e['segs'])
        lines = [x.strip() for x in raw.split('\n') if x.strip()]
        return bool(lines) and all(not strip_nonspeech(x) for x in lines)

    nonspeech = [e for e in src_events if is_nonspeech_only(e)]
    expected_events = len(src_events) - len(nonspeech)
    src_words = sum(len(''.join((s.get('utf8') or '') for s in e['segs']).split())
                    for e in src_events if not is_nonspeech_only(e))
    out_words = sum(len(c['text'].split()) for c in cues)
    src_chars = sum(len(' '.join(
        strip_nonspeech(x) for x in ''.join(
            (s.get('utf8') or '') for s in e['segs']).split('\n')
        if strip_nonspeech(x)).strip()) for e in src_events if not is_nonspeech_only(e))
    out_chars = sum(len(c['text']) for c in cues)

    starts = [c['start'] for c in cues]
    monotonic = all(a <= b for a, b in zip(starts, starts[1:]))
    # 相邻 cue 文本重叠（尾 2 词 == 头 2 词）——理想为 0
    overlaps = 0
    for a, b in zip(cues, cues[1:]):
        aw, bw = a['text'].split(), b['text'].split()
        if len(aw) >= 2 and len(bw) >= 2 and aw[-2:] == bw[:2]:
            overlaps += 1
    # 完全相同的相邻重复
    dup_adjacent = sum(1 for a, b in zip(cues, cues[1:]) if a['text'] == b['text'])
    unique_source_keys = len({c.get('_sourceKey') for c in cues}) == len(cues)

    print('=== 对账结果 ===')
    print(f'原始有文本事件数 : {len(src_events)}')
    print(f'非语音标记(剔除) : {len(nonspeech)}  (如 [Music]/[laughter]，本就不配音)')
    print(f'预期 cue 数      : {expected_events}')
    print(f'重建 cue 数      : {len(cues)}  (期望 == 预期，零漏零重)')
    print(f'原始语音词数     : {src_words}')
    print(f'重建词数         : {out_words}  (期望完全相等)')
    print(f'原始/重建字符数  : {src_chars}/{out_chars}')
    print(f'时间戳单调       : {monotonic}')
    print(f'sourceKey 唯一   : {unique_source_keys}')
    print(f'相邻文本重叠数   : {overlaps}  (期望 0，越小越好)')
    print(f'相邻完全重复数   : {dup_adjacent}  (期望 0)')
    ok = (expected_events == len(cues)) and (src_words == out_words) \
        and (src_chars == out_chars) and monotonic and unique_source_keys
    print('结论             :', 'OK 无损' if ok else '需检查')
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input', help='timedtext json3 文件')
    ap.add_argument('-o', '--output', help='输出 SRT 路径（默认与输入同名 .srt）')
    args = ap.parse_args()

    with open(args.input, encoding='utf-8') as f:
        data = json.load(f)

    cues = parse_events(data)
    ok = reconcile(data, cues)

    out_path = args.output or (args.input.rsplit('.', 1)[0] + '.srt')
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(to_srt(cues))
    print(f'已写出 SRT       : {out_path}  ({len(cues)} 条)')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
