#!/usr/bin/env python3
"""DM-2 复跑：把 scripts/shadow-capture.mjs 采到的规则层 ask 直接喂给 Piccolo 官方参考推理。

一台机器只载入一次权重，逐条 forward（一问一次，选项即候选动作）。
记录：chosen / 与规则层 top1 的一致 / 规则层选项在 Piccolo 分布里的名次 / 置信与熵 / 单条耗时。
不改动游戏世界，不调用任何 HTTP 模型端点。
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path


def state_of(prompt, fmt="text"):
    """规则层提示词里，候选清单与输出协议之外的部分才是"情境"；候选改由 Piccolo 的 Options 段给出。
    fmt="json" 只换容器不改信息：每行按"前缀：值"拆成字段，用来排除"状态格式不合厂商示例"这一混淆。"""
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
    return fields  # 交给厂商的 render_state 自己序列化（它会按 JSON 记录处理）


def build_payload(ask, instructions, order_mode="keep", state_fmt="text"):
    ids = list(dict.fromkeys(ask["candidateIds"]))  # 同 id 的重复候选在 criteria 字典里必须合并
    if order_mode == "reverse":
        ids = ids[::-1]
    elif order_mode == "rotate":  # 规则层 top1 换到中间，检验选的是语义还是位置
        ids = ids[1:] + ids[:1]
    labels = ask.get("labels") or {}
    criteria = {aid: (labels.get(aid) or aid) for aid in ids}
    return {"state": state_of(ask["prompt"], state_fmt),
            "questions": {"action": {"type": "choice", "instructions": instructions, "criteria": criteria}}}, ids


def pct(xs, q):
    if not xs:
        return float("nan")
    s = sorted(xs)
    i = min(len(s) - 1, max(0, int(round((q / 100.0) * (len(s) - 1)))))
    return s[i]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--asks", required=True)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--dtype", default="bfloat16", choices=["bfloat16", "float32"])
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--skip", type=int, default=0)
    ap.add_argument("--warmup", type=int, default=2)
    ap.add_argument("--out", default="")
    ap.add_argument("--instructions", default="从下面选项中选出这个角色此刻最该做的一件事。")
    ap.add_argument("--state-format", default="text", choices=["text","json"], help="只换状态容器，检验厂商 JSON 口径下结论是否翻转")
    ap.add_argument("--order", default="keep", choices=["keep", "rotate", "reverse"], help="打乱候选次序：检验选的是语义还是位置")
    ap.add_argument("--print-payload", type=int, default=0, help="把前 N 条真实请求打出来（自检选项文本是否带中文标签）")
    args = ap.parse_args()

    sys.path.insert(0, str(Path(args.model).resolve()))
    import torch
    import transformers
    from transformers import AutoModelForImageTextToText, AutoTokenizer
    if args.threads:
        torch.set_num_threads(args.threads)
    torch.set_grad_enabled(False)

    from piccolo_inference import FlexCompiler
    from piccolo_layout import Layout, render_question
    from types import SimpleNamespace

    descriptor = json.loads((Path(args.model) / "decision-inference.json").read_text())
    if descriptor.get("attention_mode") != "bidirectional_prompt" or descriptor.get("prompt_variant") != "flex_twice":
        raise SystemExit("Unsupported Piccolo inference contract: " + json.dumps(descriptor))

    asks = json.loads(Path(args.asks).read_text())
    if args.skip:
        asks = asks[args.skip:]
    if args.limit:
        asks = asks[:args.limit]

    t_load0 = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=True)
    compiler = FlexCompiler(tokenizer, SimpleNamespace(Layout=Layout, render_question=render_question))
    model = AutoModelForImageTextToText.from_pretrained(
        args.model, dtype=getattr(torch, args.dtype), device_map={"": args.device},
        attn_implementation="sdpa", local_files_only=True, low_cpu_mem_usage=True,
    ).eval()
    decoder = model.model.language_model
    head = model.get_output_embeddings()

    state = {"bidirectional": True}

    def full_attention_mask(module, positional, kwargs):
        if state["bidirectional"]:
            hidden = kwargs["hidden_states"]
            length = hidden.shape[1]
            kwargs["attention_mask"] = torch.zeros((hidden.shape[0], 1, length, length),
                                                  dtype=hidden.dtype, device=hidden.device)
        return positional, kwargs

    from transformers.models.qwen3_5.modeling_qwen3_5 import Qwen3_5Attention
    hooks = [module.register_forward_pre_hook(full_attention_mask, with_kwargs=True)
             for module in decoder.modules() if isinstance(module, Qwen3_5Attention)]
    expected = decoder.config.layer_types.count("full_attention")
    if len(hooks) != expected:
        raise SystemExit(f"Full-attention layer count mismatch: {len(hooks)} != {expected}")
    load_s = time.perf_counter() - t_load0

    rows_out, ms_all = [], []
    agree = illegal = 0
    ranks, tops, entropies = [], [], []
    picks, skipped = {}, 0
    for i, ask in enumerate(asks):
        payload, ids = build_payload(ask, args.instructions, args.order, args.state_format)
        if i < args.print_payload:
            print(json.dumps(payload, ensure_ascii=False, indent=1)[:2000], flush=True)
        if len(ids) < 2:  # Piccolo 的 choice 至少两个选项，单候选的 ask 不构成决策
            skipped += 1
            continue
        t0 = time.perf_counter()
        rows, layout = compiler.compile(payload)
        row = rows[0]
        key_of = {token: key for token, key in zip(row.candidate_ids, ids)}
        with torch.inference_mode():
            ids_t = torch.tensor([row.input_ids], device=args.device)
            out = decoder(input_ids=ids_t, attention_mask=None, use_cache=False)
            label_rows = head.weight[torch.tensor(row.candidate_ids, device=args.device)].float()
            logits = torch.mv(label_rows, out.last_hidden_state[0, -1].float())
            probs = torch.softmax(logits, dim=-1).cpu().tolist()
        ms = (time.perf_counter() - t0) * 1000.0
        if not all(math.isfinite(p) for p in probs):
            illegal += 1
            continue
        order = sorted(range(len(probs)), key=lambda j: -probs[j])
        pick = key_of[row.candidate_ids[order[0]]]
        rules = ask.get("rulesTop1")
        hit = pick == rules
        agree += 1 if hit else 0
        j_rules = ids.index(rules) if rules in ids else None
        rank_rules = (order.index(j_rules) + 1) if j_rules is not None else None  # 规则层选择在 Piccolo 分布里的名次
        ranks.append(rank_rules)
        tops.append(probs[order[0]])
        entropies.append(-sum(p * math.log(p) for p in probs if p > 0))
        picks[pick] = picks.get(pick, 0) + 1
        if i >= args.warmup:
            ms_all.append(ms)
        rows_out.append({"i": i, "seed": ask.get("seed"), "t": ask.get("t"), "agent": ask.get("agent"),
                         "here": ask.get("here"), "n_options": len(ids), "tokens": len(row.input_ids),
                         "repeated": row.repeated, "rulesTop1": rules, "rules_pos": j_rules,
                         "piccolo": pick, "pick_pos": order[0], "agree": hit,
                         "prob": round(probs[order[0]], 4),
                         "rank_of_rules": rank_rules,
                         "prob_of_rules": round(probs[j_rules], 4) if j_rules is not None else None,
                         "entropy": round(entropies[-1], 3), "ms": round(ms, 1)})

    def rss_gb():
        try:
            return round(int(Path("/proc/self/status").read_text().split("VmRSS:")[1].split()[0]) / 1048576, 2)
        except Exception:
            return None

    ranked = [r for r in ranks if r]
    summary = {"model": Path(args.model).name, "device": args.device, "dtype": args.dtype, "order": args.order, "state_format": args.state_format,
               "torch": torch.__version__, "transformers": transformers.__version__,
               "threads": torch.get_num_threads(), "n": len(rows_out), "illegal": illegal, "skipped": skipped,
               "load_s": round(load_s, 1), "full_attention_layers": len(hooks),
               "agree_rules_top1": round(agree / len(rows_out), 4) if rows_out else None,
               "median_prob": round(pct(tops, 50), 4), "p90_prob": round(pct(tops, 90), 4),
               "median_entropy": round(pct(entropies, 50), 3),
               "rules_rank_p50": pct(ranked, 50), "rules_rank_p90": pct(ranked, 90),
               "rules_rank_le3": round(sum(1 for r in ranked if r <= 3) / len(ranked), 4) if ranked else None,
               "pick_pos_p50": pct([r["pick_pos"] for r in rows_out], 50),
               "top_picks": dict(sorted(picks.items(), key=lambda kv: -kv[1])[:8]),
               "ms_p50": round(pct(ms_all, 50), 1), "ms_p90": round(pct(ms_all, 90), 1),
               "ms_p95": round(pct(ms_all, 95), 1), "ms_max": round(max(ms_all), 1) if ms_all else None,
               "rss_gb": rss_gb()}
    if args.out:
        Path(args.out).write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows_out) + "\n")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    for r in rows_out[:12]:
        print("  #{i} {here} n={n_options} tok={tokens} twice={repeated} rules={rulesTop1}@{rules_pos} "
              "-> piccolo={piccolo}@{pick_pos} p={prob} rank_rules={rank_of_rules} {ms}ms".format(**r))


if __name__ == "__main__":
    main()
