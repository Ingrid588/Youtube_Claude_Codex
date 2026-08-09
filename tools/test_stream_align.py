"""隔离测试 dub9._apply_translated_line 的对齐行为。

直接 import dub9 会触发模块级副作用（会卡住），这里用 ast 只把需要的函数
抽出来单独执行，验证漏行/跳号/重复序号/串位几种模型输出异常下的回填结果。
"""
import ast
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'dub9.py')

tree = ast.parse(open(SRC, encoding='utf-8').read())
wanted = {'_apply_translated_line', '_translation_length_implausible'}
picked = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in wanted]
assert len(picked) == len(wanted), f'未找到: {wanted - {n.name for n in picked}}'

ns = {'clean_translation': lambda t: t.strip()}
exec(compile(ast.Module(body=picked, type_ignores=[]), SRC, 'exec'), ns)
apply_line = ns['_apply_translated_line']
implausible = ns['_translation_length_implausible']


def run(lines, caps, sources=None):
    batch = [{'text': (sources[i] if sources else f'src{i}'), '_cap_chars': caps[i]}
             for i in range(len(caps))]
    idx_map = dict(enumerate(batch))
    seen, ready = set(), []
    stats = {'expect': 0, 'misordered': 0, 'implausible': 0, 'out_of_range': 0}
    for line in lines:
        apply_line(line, idx_map, seen, ready.append, stats)
    for i, s in idx_map.items():
        if i not in seen and 'translation' not in s:
            s['_translate_failed'] = True
    return batch, stats, ready


failures = []


def check(name, cond, detail=''):
    print(('  OK  ' if cond else '  FAIL') + f'  {name}' + (f'  {detail}' if detail else ''))
    if not cond:
        failures.append(name)


print('1) 正常三句')
batch, stats, ready = run(['0|4|第一句译文', '1|4|第二句译文', '2|4|第三句译文'], [10, 10, 10])
check('三句都回填', [s.get('translation') for s in batch] == ['第一句译文', '第二句译文', '第三句译文'])
check('无错位', stats['misordered'] == 0)
check('回调三次', len(ready) == 3)

print('2) 模型漏掉中间一行（序号跳号）')
batch, stats, ready = run(['0|4|第一句译文', '2|4|第三句译文'], [10, 10, 10])
check('第0句正确', batch[0]['translation'] == '第一句译文')
check('第1句留空待补翻', 'translation' not in batch[1] and batch[1].get('_translate_failed'))
check('第2句未被串位', batch[2]['translation'] == '第三句译文', '按序号回填，不会被第三句顶上来')
check('记录到错位', stats['misordered'] == 1)

print('3) 重复序号只认第一次')
batch, stats, ready = run(['1|4|正确译文', '1|4|重复译文'], [10, 10])
check('不覆盖', batch[1]['translation'] == '正确译文')
check('不重复回调', len(ready) == 1, '避免同一句被合成两遍')

print('4) 越界序号被丢弃')
batch, stats, ready = run(['0|4|第一句译文', '9|4|野译文'], [10, 10])
check('越界不写入', len(ready) == 1 and stats['out_of_range'] == 1)

print('5) 串位：短原文却拿到长篇译文')
long_text = '这是一段明显不可能属于这句短原文的很长很长的译文内容还在继续往下说个不停'
batch, stats, ready = run([f'0|4|{long_text}'], [4], sources=['Yes.'])
check('明显串位被拒', 'translation' not in batch[0] and stats['implausible'] == 1)
check('标记待补翻', batch[0].get('_translate_failed') is True)

print('6) 语速快、窗口紧的密集字幕不该被误杀')
dense_src = "I really don't think that's a good idea at all right now"
dense_zh = '我真的完全不觉得现在这是个好主意'
batch, stats, ready = run([f'0|3|{dense_zh}'], [3], sources=[dense_src])
check('保留', batch[0].get('translation') == dense_zh, '窗口只够3字，但译文正常，不能当串位删掉')

print('7) 正常轻微超字数不该被误杀')
batch, stats, ready = run(['0|12|稍微超出一点点字数的译文'], [10])
check('保留', batch[0].get('translation') == '稍微超出一点点字数的译文', '只拦截数倍级串位')

print('8) 旧缓存里串位的脏译文会被判为不可信（读缓存时作废重翻）')
check('脏缓存被识别', implausible('Yes.', long_text) is True)
check('正常缓存保留', implausible(dense_src, dense_zh) is False)

print()
if failures:
    print(f'失败 {len(failures)} 项: {failures}')
    sys.exit(1)
print('全部通过')
