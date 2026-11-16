#!/usr/bin/env python3
# DM-1 重放端：把采集到的真实审议询问，逐条问给指定引擎，记录选择、是否越界、延迟。
# 用法：shadow-replay.py <asks.json> <base_url> <模型路径标记> <输出.json> [条数] [并发]
# 约定：api key 只从启动脚本里取到变量，绝不打印；输出只含 id/延迟/是否合法。
import json, sys, time, urllib.request, urllib.error, re, os
from concurrent.futures import ThreadPoolExecutor

asks_file, base, model_marker, out_file = sys.argv[1:5]
limit = int(sys.argv[5]) if len(sys.argv) > 5 else 80
workers = int(sys.argv[6]) if len(sys.argv) > 6 else 3

# 从节点上的启动脚本里取 key 与模型 id（只看被标记的那一行，打印时一律打码）
def read_engine(script_glob):
    import glob
    for path in glob.glob(os.path.expanduser(script_glob)):
        txt = open(path, encoding='utf-8', errors='ignore').read()
        key = re.search(r'--api-key\s+["\']?([^\s"\']+)', txt)
        mdl = re.search(r'serve\s+["\']?([^\s"\']+)', txt)
        if key and mdl:
            return key.group(1), mdl.group(1)
    raise SystemExit('找不到 key/模型：' + script_glob)

api_key, model_id = read_engine(model_marker)
model_id = os.path.expandvars(model_id)  # 启动脚本里写的是 $HOME/models/...，展开成真实路径
try:  # 权威模型 id：以引擎自己报的为准，不靠脚本正则猜
    req = urllib.request.Request(base.rstrip('/') + '/models', headers={'authorization': 'Bearer ' + api_key})
    ids = json.loads(urllib.request.urlopen(req, timeout=10).read()).get('data') or []
    if ids:
        model_id = ids[0].get('id') or model_id
except Exception as e:
    print('取 /models 失败，沿用脚本里的路径：', type(e).__name__)
asks = json.load(open(asks_file, encoding='utf-8'))
step = max(1, len(asks) // limit)
sample = asks[::step][:limit]

def one(a):
    def call(payload):
        req = urllib.request.Request(base.rstrip('/') + '/chat/completions',
            data=json.dumps(payload).encode(), method='POST',
            headers={'content-type': 'application/json', 'authorization': 'Bearer ' + api_key})
        return urllib.request.urlopen(req, timeout=40).read()

    payload = {
        'model': model_id, 'temperature': 0.85, 'max_tokens': 100,
        'response_format': {'type': 'json_object'},
        'messages': [{'role': 'user', 'content': a['prompt']}],
        # 与生产同一适配：Qwen3.x 默认开思考，不关掉量出来的延迟不是生产延迟（D3）
        'chat_template_kwargs': {'enable_thinking': False},
    }
    t0 = time.time()
    try:
        try:
            raw = call(payload)
        except urllib.error.HTTPError as e:
            # 端点不认这个参数就按生产一样去掉重试，否则对照会变成"我们的探针失败"
            if e.code not in (400, 422):
                raise
            payload.pop('chat_template_kwargs', None)
            raw = call(payload)
        j = json.loads(raw)
        content = j['choices'][0]['message']['content']
        chosen = None
        try:
            chosen = json.loads(content).get('id')
        except Exception:
            m = re.search(r'"id"\s*:\s*"([^"]+)"', content)
            chosen = m.group(1) if m else None
        return {'seed': a['seed'], 't': a['t'], 'agent': a['agent'], 'rulesTop1': a['rulesTop1'],
                'candidateCount': a['candidateCount'], 'chosen': chosen,
                'legal': chosen in a['candidateIds'], 'agree': chosen == a['rulesTop1'],
                'ms': int((time.time() - t0) * 1000), 'err': None}
    except Exception as e:
        return {'seed': a['seed'], 't': a['t'], 'agent': a['agent'], 'rulesTop1': a['rulesTop1'],
                'candidateCount': a['candidateCount'], 'chosen': None, 'legal': False, 'agree': False,
                'ms': int((time.time() - t0) * 1000), 'err': type(e).__name__}

with ThreadPoolExecutor(workers) as ex:
    rows = list(ex.map(one, sample))
json.dump(rows, open(out_file, 'w', encoding='utf-8'), ensure_ascii=False)
ok = [r for r in rows if not r['err']]
ms = sorted(r['ms'] for r in ok)
def pct(p):
    return ms[min(len(ms) - 1, int(len(ms) * p))] if ms else None
print(json.dumps({'n': len(rows), 'ok': len(ok), 'err': len(rows) - len(ok),
                  'legal_rate': round(sum(r['legal'] for r in ok) / max(1, len(ok)), 3),
                  'agree_rules_top1': round(sum(r['agree'] for r in ok) / max(1, len(ok)), 3),
                  'err_kinds': sorted({r['err'] for r in rows if r['err']}), 'p50': pct(0.5), 'p90': pct(0.9), 'p95': pct(0.95), 'max': ms[-1] if ms else None,
                  'model': model_id.split('/')[-1], 'key_len': len(api_key)}, ensure_ascii=False))
