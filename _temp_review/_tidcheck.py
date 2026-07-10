import json
d=json.load(open(r'C:\Users\a\AppData\Local\Programs\Python\Python312\Lib\site-packages\bilibili_api\data\video_uploader_meta_pre.json',encoding='utf8'))
out=[]
for p in d['tid_list']:
    for c in p['children']:
        out.append(f"{p['name']} -> {c['id']} {c['name']}")
open('C:/video/Youtube_Claude/_tid_check.txt','w',encoding='utf-8').write('\n'.join(out))
