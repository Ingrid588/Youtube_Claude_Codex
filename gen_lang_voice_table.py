"""生成 chrome_extension/popup.js 里 LANG_VOICE_TABLE 用的数据。

用法：
  edge-tts --list-voices > voices_tmp.txt   (Windows 下用 PowerShell/cmd 重定向，注意编码用 UTF-8)
  python gen_lang_voice_table.py
输出 lang_voice_merged.json，把内容粘到 popup.js 的 LANG_VOICE_TABLE 常量里即可。

默认音色取自 content.js 现有的 _READ_VOICE_MAP（跟 live_dub_server.py 的
lang_prefix_voice 保持一致），不会因为重新生成就换掉已经在用的默认声音；
备选音色是同语言里另一种性别、edge-tts 实际可用的声音。
"""
import re
import json

text = open('chrome_extension/content.js', encoding='utf-8').read()
m = re.search(r"const _READ_VOICE_MAP = \{(.*?)\n\};", text, re.S)
block = m.group(1)
prefix_pairs = re.findall(r"(?<![\w'-])([a-z]{2,3}):\s*'([a-zA-Z-]+Neural)'", block)
default_map = dict(prefix_pairs)

CN_NAMES = {
 'zh': '中文(普通话)', 'en': '英语', 'es': '西班牙语', 'fr': '法语', 'de': '德语', 'pt': '葡萄牙语',
 'it': '意大利语', 'ru': '俄语', 'ar': '阿拉伯语', 'hi': '印地语', 'ja': '日语', 'ko': '韩语',
 'vi': '越南语', 'th': '泰语', 'id': '印尼语', 'nl': '荷兰语', 'pl': '波兰语', 'tr': '土耳其语',
 'af': '南非荷兰语', 'am': '阿姆哈拉语', 'az': '阿塞拜疆语', 'bg': '保加利亚语', 'bn': '孟加拉语',
 'bs': '波斯尼亚语', 'ca': '加泰罗尼亚语', 'cs': '捷克语', 'cy': '威尔士语', 'da': '丹麦语',
 'el': '希腊语', 'et': '爱沙尼亚语', 'fa': '波斯语', 'fi': '芬兰语', 'fil': '菲律宾语',
 'ga': '爱尔兰语', 'gl': '加利西亚语', 'gu': '古吉拉特语', 'he': '希伯来语', 'hr': '克罗地亚语',
 'hu': '匈牙利语', 'is': '冰岛语', 'iu': '因纽特语', 'jv': '爪哇语', 'ka': '格鲁吉亚语',
 'kk': '哈萨克语', 'km': '高棉语', 'kn': '卡纳达语', 'lo': '老挝语', 'lt': '立陶宛语',
 'lv': '拉脱维亚语', 'mk': '马其顿语', 'ml': '马拉雅拉姆语', 'mn': '蒙古语', 'mr': '马拉地语',
 'ms': '马来语', 'mt': '马耳他语', 'my': '缅甸语', 'nb': '挪威语', 'ne': '尼泊尔语',
 'ps': '普什图语', 'ro': '罗马尼亚语', 'si': '僧伽罗语', 'sk': '斯洛伐克语', 'sl': '斯洛文尼亚语',
 'so': '索马里语', 'sq': '阿尔巴尼亚语', 'sr': '塞尔维亚语', 'su': '巽他语', 'sv': '瑞典语',
 'sw': '斯瓦希里语', 'ta': '泰米尔语', 'te': '泰卢固语', 'uk': '乌克兰语', 'ur': '乌尔都语',
 'uz': '乌兹别克语', 'zu': '祖鲁语',
}

voices = []
with open('voices_tmp.txt', encoding='utf-8') as f:
    for line in f:
        parts = line.split()
        if len(parts) < 2:
            continue
        voices.append((parts[0], parts[1]))

gender_of = {}
region_of = {}
lang_of = {}
by_lang_region_gender = {}
for full, gender in voices:
    mm = re.match(r'^([a-zA-Z]+)-([A-Za-z]+(?:-[A-Za-z]+)?)-(.+)Neural$', full)
    if not mm:
        continue
    lang, region, name = mm.groups()
    gender_of[full] = gender
    region_of[full] = region
    lang_of[full] = lang
    by_lang_region_gender.setdefault(lang, {}).setdefault(region, {}).setdefault(gender, []).append((name, full))


def short_label(voice_id, lang):
    prefix_len = len(lang) + 1 + len(region_of.get(voice_id, '')) + 1
    name = voice_id[prefix_len:]
    return name[:-6] if name.endswith('Neural') else name


result = []
for code, default_voice in sorted(default_map.items()):
    lang = lang_of.get(default_voice, code)
    region = region_of.get(default_voice)
    default_gender = gender_of.get(default_voice, '?')
    default_label = short_label(default_voice, lang)

    alt_gender = 'Female' if default_gender == 'Male' else 'Male'
    alt_voice = None
    regions = by_lang_region_gender.get(lang, {})
    if region in regions and alt_gender in regions[region]:
        alt_voice = regions[region][alt_gender][0][1]
    else:
        for r2, genders in regions.items():
            if alt_gender in genders:
                alt_voice = genders[alt_gender][0][1]
                break
    alt_label = short_label(alt_voice, lang) if alt_voice else None

    result.append({
        'code': code,
        'name': CN_NAMES.get(code, code),
        'default_voice': default_voice,
        'default_label': default_label,
        'default_gender': 'male' if default_gender == 'Male' else 'female',
        'alt_voice': alt_voice,
        'alt_label': alt_label,
        'alt_gender': 'male' if alt_gender == 'Male' else 'female',
    })

with open('lang_voice_merged.json', 'w', encoding='utf-8') as f:
    json.dump(result, f, ensure_ascii=False)

no_alt = [r['code'] for r in result if not r['alt_voice']]
print('total', len(result), 'no_alt', no_alt)
