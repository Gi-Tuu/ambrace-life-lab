#!/usr/bin/env python3
"""DM-2b 对照：同一批规则层 ask 喂给 StartLux-Decision-4B（CC BY-NC，只测不上）。

目的不是选它上线，而是把"单 token 读出头在我们这种近义中文候选上会塌"这件事，
归因到读出头设计还是 4B 容量：Piccolo-4B 与它同族读出、同格式请求，可以逐条对比。
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path


def state_of(prompt, fmt="text"):
    """与 piccolo-shadow.py 同一套切分：fmt=json 只把情境换成字段容器，信息一字不加。"""
    out = []
    for line in prompt.split("\n"):
        if line.startswith("可做的事") or line.startswith("只输出 JSON") or line.startswith("如果此刻有在场的人"):
            break
        out.append(line)
    if fmt != "json":
        return "\n".join(out)
    fields = {}
    for line in out:
        head, sep, rest = line.partition("：")
        fields[(head.strip() or "line")] = (rest.strip() if sep else line.strip())
    return fields


def build(ask, instructions, order_mode="keep", state_fmt="text"):
    ids = list(dict.fromkeys(ask["candidateIds"]))
    if order_mode == "reverse":
        ids = ids[::-1]
    elif order_mode == "rotate":
        ids = ids[1:] + ids[:1]
    labels = ask.get("labels") or {}
    criteria = {aid: (labels.get(aid) or aid) for aid in ids}
    return (state_of(ask["prompt"], state_fmt),
            {"action": {"type": "choice", "instructions": instructions, "criteria": criteria}}), ids


def pct(xs, q):
    if not xs:
        return float("nan")
    s = sorted(xs)
    return s[min(len(s) - 1, max(0, int(round((q / 100.0) * (len(s) - 1)))))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--asks", required=True)
    ap.add_argument("--device", default="cuda:0")
    ap.add_argument("--chunk", type=int, default=20)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--state-format", default="text", choices=["text","json"])
    ap.add_argument("--order", default="keep", choices=["keep", "rotate", "reverse"])
    ap.add_argument("--single", type=int, default=0, help="额外用 decide() 逐条跑 N 条，量单请求时延")
    ap.add_argument("--out", default="")
    ap.add_argument("--instructions", default="从下面选项中选出这个角色此刻最该做的一件事。")
    args = ap.parse_args()

    sys.path.insert(0, str(Path(args.model).resolve()))
    import torch
    from startlux_decision import StartLuxDecision

    asks = json.loads(Path(args.asks).read_text())
    if args.limit:
        asks = asks[:args.limit]
    t0 = time.perf_counter()
    eng = StartLuxDecision(args.model, device=args.device)
    load_s = time.perf_counter() - t0

    results, agree, picks, tops, single_ms = [], 0, {}, [], []
    for start in range(0, len(asks), args.chunk):
        batch, idsets, kept = [], [], []
        for offset, ask in enumerate(asks[start:start + args.chunk]):
            req, ids = build(ask, args.instructions, args.order, args.state_format)
            if len(ids) < 2:
                continue
            batch.append(req)
            idsets.append(ids)
            kept.append((start + offset, ask))
        if not batch:
            continue
        c0 = time.perf_counter()
        answers = eng.decide_batch(batch)
        per_ask = (time.perf_counter() - c0) * 1000.0 / len(batch)
        for (i, ask), ids, ans_map in zip(kept, idsets, answers):
            ans = (ans_map or {}).get("action") or {}
            probs = ans.get("probabilities") or {}
            if not probs:
                continue
            pick = ans.get("choice")
            order = sorted(probs, key=lambda k: -probs[k])
            rules = ask.get("rulesTop1")
            hit = pick == rules
            agree += 1 if hit else 0
            picks[pick] = picks.get(pick, 0) + 1
            tops.append(probs[order[0]])
            results.append({"i": i, "seed": ask.get("seed"), "agent": ask.get("agent"), "here": ask.get("here"),
                            "n_options": len(ids), "rulesTop1": rules, "startlux": pick, "agree": hit,
                            "prob": round(probs[order[0]], 4),
                            "rank_of_rules": order.index(rules) + 1 if rules in probs else None,
                            "prob_of_rules": round(probs.get(rules, 0.0), 4),
                            "confidence": round(float(ans.get("confidence") or 0), 4),
                            "entropy": round(-sum(p * math.log(p) for p in probs.values() if p > 0), 3),
                            "per_ask_ms": round(per_ask, 1)})

    for ask in asks[:args.single]:  # 厂商口径是"一次请求三个问题 26ms"：单请求路径单独量
        req, ids = build(ask, args.instructions, args.order, args.state_format)
        if len(ids) < 2:
            continue
        c0 = time.perf_counter()
        eng.decide(*req)
        single_ms.append((time.perf_counter() - c0) * 1000.0)

    ranked = [r["rank_of_rules"] for r in results if r["rank_of_rules"]]
    summary = {"model": Path(args.model).name, "device": args.device, "order": args.order, "state_format": args.state_format,
               "torch": torch.__version__, "load_s": round(load_s, 1), "chunk": args.chunk,
               "n": len(results), "agree_rules_top1": round(agree / len(results), 4) if results else None,
               "median_prob": round(pct(tops, 50), 4),
               "median_entropy": round(pct([r["entropy"] for r in results], 50), 3),
               "rules_rank_p50": pct(ranked, 50),
               "rules_rank_le3": round(sum(1 for r in ranked if r <= 3) / len(ranked), 4) if ranked else None,
               "batch_per_ask_ms_p50": round(pct([r["per_ask_ms"] for r in results], 50), 1),
               "batch_per_ask_ms_p95": round(pct([r["per_ask_ms"] for r in results], 95), 1),
               "single_ms_p50": round(pct(single_ms[2:], 50), 1) if len(single_ms) > 3 else None,
               "top_picks": dict(sorted(picks.items(), key=lambda kv: -kv[1])[:8])}
    if args.out:
        Path(args.out).write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in results) + "\n")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
