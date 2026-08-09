# -*- coding: utf-8 -*-
"""对比 YouTube 英/中自动翻译字幕质量（按时间轴对齐抽样）。"""
import re, os, glob, json

FOLDER = r'C:\Users\a\Videos\TubeGet\塔罗0805C'

def parse_srt(path):
    with open(path, encoding='utf-8-sig') as f:
        text = f.read()
    blocks = re.split(r'\n\s*\n', text.strip())
    cues = []
    for b in blocks:
        lines = b.strip().splitlines()
        if len(lines) < 3:
            continue
        m = re.match(r'(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})', lines[1])
        if not m:
            continue
        cues.append({'start': m.group(1), 'end': m.group(2), 'text': ' '.join(lines[2:]).strip()})
    return cues

def ts_ms(ts):
    h, m, rest = ts.split(':')
    s, ms = rest.split(',')
    return int(h)*3600000 + int(m)*60000 + int(s)*1000 + int(ms)

def match_zh(en_path, zh_files):
    num = os.path.basename(en_path).split('-')[0]
    for z in zh_files:
        if os.path.basename(z).startswith(num + '-'):
            return z
    return None

# 常见塔罗/占卜语境误译模式
ISSUE_PATTERNS = [
    (r'朗读视频|朗读', 'reading→朗读(应为占卜解读)'),
    (r'通俗读物', 'general reading→通俗读物(误)'),
    (r'阅读\b', 'reading→阅读(塔罗语境应为占卜)'),
    (r'是的，是的|是的 是的', '过度"是的"填充'),
    (r'交叉观察者', 'crosswatcher直译'),
    (r'能量卡', 'energy cards?'),
    (r'这个频道', 'this channel'),
    (r'魔鬼', 'devil/the devil card'),
    (r'他们来了', 'they come'),
]

def analyze_pair(en_path, zh_path):
    en = parse_srt(en_path)
    zh = parse_srt(zh_path)
    en_by_start = {c['start']: c['text'] for c in en}
    zh_by_start = {c['start']: c['text'] for c in zh}
    common = sorted(set(en_by_start) & set(zh_by_start))
    issues = []
    for pat, label in ISSUE_PATTERNS:
        cnt = sum(1 for c in zh if re.search(pat, c['text']))
        if cnt:
            issues.append({'pattern': label, 'count': cnt})
    # 抽样：开头、中间、结尾各5条
    samples = []
    idxs = list(range(min(5, len(common))))
    mid = len(common)//2
    idxs += list(range(max(0,mid-2), min(len(common), mid+3)))
    idxs += list(range(max(0,len(common)-5), len(common)))
    seen = set()
    for i in idxs:
        if i in seen or i >= len(common):
            continue
        seen.add(i)
        st = common[i]
        samples.append({'start': st, 'en': en_by_start[st], 'zh': zh_by_start[st]})
    return {
        'file': os.path.basename(en_path)[:60],
        'en_count': len(en),
        'zh_count': len(zh),
        'aligned': len(common),
        'count_diff': len(en)-len(zh),
        'issues': issues,
        'samples': samples[:12],
    }

def main():
    en_files = sorted(glob.glob(os.path.join(FOLDER, '*.en.srt')))
    zh_files = sorted(glob.glob(os.path.join(FOLDER, '*.zh-Hans.srt')))
    results = []
    total_issues = {}
    for en in en_files:
        zh = match_zh(en, zh_files)
        if not zh:
            print('NO MATCH:', en)
            continue
        r = analyze_pair(en, zh)
        results.append(r)
        for iss in r['issues']:
            total_issues[iss['pattern']] = total_issues.get(iss['pattern'], 0) + iss['count']
    print('=== 14 个视频英中字幕统计 ===')
    for r in results:
        print(f"{r['file']:60} EN={r['en_count']:4} ZH={r['zh_count']:4} 对齐={r['aligned']:4} 差={r['count_diff']:+d}")
    print('\n=== 全库常见误译/问题模式 ===')
    for k,v in sorted(total_issues.items(), key=lambda x:-x[1]):
        print(f'  {k}: {v} 处')
    print('\n=== 抽样对比（视频1 金牛座 前段）===')
    for s in results[0]['samples'][:8]:
        print(f"[{s['start']}]")
        print(f"  EN: {s['en'][:120]}")
        print(f"  ZH: {s['zh'][:120]}")
    print('\n=== 抽样对比（视频4 双鱼座 中段）===')
    for s in results[3]['samples'][4:8]:
        print(f"[{s['start']}]")
        print(f"  EN: {s['en'][:120]}")
        print(f"  ZH: {s['zh'][:120]}")
    print('\n=== 抽样对比（视频13 狮子座 中段）===')
    for s in results[12]['samples'][4:8]:
        print(f"[{s['start']}]")
        print(f"  EN: {s['en'][:120]}")
        print(f"  ZH: {s['zh'][:120]}")
    with open(os.path.join(FOLDER, '_compare_report.json'), 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print('\n详细报告已写:', os.path.join(FOLDER, '_compare_report.json'))

if __name__ == '__main__':
    main()
