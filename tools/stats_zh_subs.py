# -*- coding: utf-8 -*-
import re, os, glob

folder = r'C:\Users\a\Videos\TubeGet\塔罗0805C'
en_files = sorted(glob.glob(os.path.join(folder, '*.en.srt')))
zh_files = sorted(glob.glob(os.path.join(folder, '*.zh-Hans.srt')))

def parse_srt(path):
    with open(path, encoding='utf-8-sig') as f:
        text = f.read()
    blocks = re.split(r'\n\s*\n', text.strip())
    cues = []
    for b in blocks:
        lines = b.strip().splitlines()
        if len(lines) < 3: continue
        m = re.match(r'(\d{2}:\d{2}:\d{2},\d{3})', lines[1])
        cues.append({'start': m.group(1), 'text': ' '.join(lines[2:]).strip()})
    return cues

BAD_TERMS = [
    ('朗读视频', 'reading→朗读视频'),
    ('通俗读物', 'general reading→通俗读物'),
    ('经典读物朗读', 'classic reading→经典读物朗读'),
    ('字母阅读材料', 'literary reading→字母阅读材料'),
    ('那种酱汁', 'slang sauce→酱汁'),
    ('蜂蜜面包', 'slay honey buns→蜂蜜面包'),
    ('重度巨蟹座', 'heavy cancer→重度巨蟹座'),
    ('交叉观察者', 'crosswatcher→交叉观察者'),
]

frag_end = re.compile(r'(的|和|或|但|而|在|以|把|被|让|给|与|如果|因为|所以|这|那|你|我|他|她|它|我们|他们|一个|这个|那个|为了|关于|就是|然后|而且|或者|或许|可能|已经|正在|将会|可以|需要|应该|想要|觉得|认为|感觉|知道|看到|听到|进行|将|会|要|是|有|没|不|也|还|就|都|更|很)\s*$')

all_zh = []
term_hits = {k:0 for k,_ in BAD_TERMS}
broken = 0
for zf in zh_files:
    for c in parse_srt(zf):
        t = c['text']
        all_zh.append(t)
        for kw, _ in BAD_TERMS:
            if kw in t:
                term_hits[kw] += 1
        if len(t) < 35 and frag_end.search(t):
            broken += 1

print('=== 全库 14 视频中文统计 ===')
print('中文 cue 总数:', len(all_zh))
print('疑似半句截断:', broken, f'({100*broken/len(all_zh):.1f}%)')
print('\n=== 典型误译/术语问题 ===')
for kw, label in BAD_TERMS:
    print(f'  {label}: {term_hits[kw]} 处')

# 可读性抽样：随机取20条较长中文看是否通顺
long = [t for t in all_zh if len(t) >= 20]
import random
random.seed(42)
sample = random.sample(long, min(15, len(long)))
print('\n=== 随机抽样 15 条较长中文（听感/可读性）===')
for i,t in enumerate(sample,1):
    print(f'{i:2}. {t[:90]}')
