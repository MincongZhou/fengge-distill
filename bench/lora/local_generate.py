#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
local_generate.py —— 在**同一个开源基座**上跑四档条件，产出与 API 版 schema 一致的冻结结果。

为什么要它：本轮要回答"微调和提示法比，到底差多少"。而 deepseek-flash 只有 API、没有权重，
微调不了；只要 c3-lora 用别的基座，它和 c0/c1/c2 就**不是同一个生成器**，比出来的是模型的差别。
所以做法是：**把四档全搬到同一个开源基座上重跑**，c3-lora 只是多挂一个 LoRA adapter。

关键设计：
  1. messages 不是这里拼的 —— 从 bench/lora/data/conditions.json 逐字读入（由
     bench/lora/export-conditions.mjs 调 buildMessages() 导出）。本文件里**没有任何条件模板**，
     所以不可能出现"我照着 API 版重写了一遍、写得挺像"这种不可比的漂移。
  2. 产物写进 bench/runs/<runId>/<条件>/<题号>.json，字段与 API 版一致，于是
     bench/metrics.mjs 与 bench/ablation.mjs **一行都不用改**就能评。
  3. usage 里记的是**本地 token 数**，但额外标 "billing": "local-gpu" —— 成本表据此显示"本地 GPU"
     而不是把电费硬套成 DeepSeek 的美元价。

用法：
    .venv/Scripts/python.exe bench/lora/local_generate.py --run run-qwen25-1.5b \
        --conditions c0-base,c1-distilled,c2-retrieval
    .venv/Scripts/python.exe bench/lora/local_generate.py --run run-qwen25-1.5b \
        --conditions c3-lora --adapter bench/lora/out-lora
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent          # bench/
REPO = BENCH.parent

# 模型缓存放**工作区内**，不要用默认的 ~/.cache/huggingface。
# 两个理由：①本环境下 Python 子进程对用户 profile 的写入被限制（实测直接 PermissionError 建不出目录）；
# ②三个 GiB 的权重本来也不该塞进用户目录。改这里就要同步 .gitignore（已有 bench/lora/hf-cache/）。
os.environ.setdefault("HF_HOME", str(BENCH / "lora" / "hf-cache"))
# 8GB 显存下的必要设置：碎片化会让"明明还够"的分配失败
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

DEFAULT_CONDITIONS = BENCH / "lora" / "data" / "conditions.json"
RUNS = BENCH / "runs"

# 与 API 版对齐的解码参数：temperature 1.0。
# max_new_tokens 上限收在 400 而不是 API 版的 4000：实测 1.5B 基座在长 system 下会不收敛、
# 一路生成到上限（有一条 p01 写了 1024 token 的碎话，耗时 124 秒），把上限压到 400
# 既远高于必要（语料 p95≈120 字，API 档实际只用到 ~130 token），又能把无谓生成掐掉。
# 这个上限对**四档一视同仁**，所以不构成对某一档的倾斜。上限不改变未触顶条目的结果。
TEMPERATURE = 1.0
MAX_NEW_TOKENS = 400
BASE_MODEL = "Qwen/Qwen2.5-1.5B-Instruct"


def _utf8_stdio() -> None:
    """Windows 中文控制台默认 GBK，打印中文/✓ 会 UnicodeEncodeError —— 与 service/ 那边同一个坑。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            enc = (getattr(stream, "encoding", "") or "").lower().replace("-", "")
            if enc != "utf8":
                stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def load_conditions(path: Path) -> dict:
    if not path.exists():
        sys.exit(
            f"缺少 {path}\n先跑：node bench/lora/export-conditions.mjs\n"
            "（它把四档条件的最终 messages 逐字导出，保证本地基座与 API 版提示词完全相同）"
        )
    data = json.loads(path.read_text(encoding="utf-8"))
    for key in ("prompts", "conditions", "messages", "decode"):
        if key not in data:
            sys.exit(f"{path} 结构不对，缺 {key} 字段")
    return data


def build_model(model_id: str, adapter: str | None):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    if not torch.cuda.is_available():
        sys.exit("CUDA 不可用：torch.cuda.is_available() 为 False。先确认装了 CUDA 版 torch。")

    # 长 prompt 必须走 memory-efficient attention（实测踩过两次，不是"优化"）：
    # c1/c2 档 prompt 有 2.2 万字符 ≈ 1.5 万 token，PyTorch 的 math 后端会**物化**
    # [heads × seq × seq] 矩阵 —— 单次分配就要 12.48 GiB，8GB 卡直接 OOM。
    # 而全局 enable_math_sdp(False) 的路子在 torch 2.6 上会变成 "No available kernel"（flash 没编进去），
    # 所以正确做法是用 sdpa_kernel 上下文管理器**显式指定**后端（见 generate_one）。
    # 绝不靠缩短 prompt 来绕：那会让本地档与 API 档的提示词不再逐字相同，消融当场作废。
    from torch.nn.attention import SDPBackend, sdpa_kernel
    _probe_q = torch.randn(1, 4, 15000, 128, dtype=torch.bfloat16, device="cuda")
    for be, name in ((SDPBackend.EFFICIENT_ATTENTION, "memory-efficient"),
                     (SDPBackend.MATH, "math")):
        try:
            with sdpa_kernel([be]):
                torch.nn.functional.scaled_dot_product_attention(_probe_q, _probe_q, _probe_q)
            print(f"· SDPA 后端可用：{name}")
        except Exception as e:
            print(f"· SDPA 后端不可用：{name}（{type(e).__name__}）")
    del _probe_q
    torch.cuda.empty_cache()

    print(f"· 基座 {model_id} ｜ adapter {adapter or '（无）'}")
    tokenizer = AutoTokenizer.from_pretrained(model_id, trust_remote_code=False)
    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        dtype=torch.bfloat16,   # 3070 是 Ampere，bf16 可用，比 fp16 稳。
                                # 注意参数名：transformers 5.x 已把 torch_dtype 改名 dtype（旧名会告警）。
        device_map="cuda:0",
        trust_remote_code=False,
    )
    if adapter:
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, adapter)
    model.eval()
    used = torch.cuda.memory_allocated() / 1024**3
    print(f"· 模型已加载 ｜ 显存占用 {used:.2f} GiB / {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GiB")
    return model, tokenizer, torch


def generate_one(model, tokenizer, torch, messages, *, seed: int, chunk: int = 512):
    """
    分块 prefill + 手写采样循环，返回 (文本, 用量, finish_reason, 毫秒)。

    为什么不用 model.generate()（实测踩了三层坑才退到这里）：
      · math SDPA 会物化 [heads × seq × seq]：1.5 万 token 的 prompt 单次要 12.48 GiB，8GB 卡 OOM；
      · 想改成只用 memory-efficient 后端 → Qwen2.5 是 GQA（12 query head / 2 KV head），
        该后端不支持这个形状，于是 "No available kernel"（flash 后端本机没编进去，没有第三条路）；
      · 唯一的正解是**别一次性吞下整个 prompt**：按 chunk 逐段 prefill，每段只与已有 KV 做注意力，
        峰值显存与 prompt 长度解耦。绝不靠截断 prompt 绕过——那会让本地档与 API 档的提示词不再逐字相同。

    采样循环手写是为了与 HF 的 do_sample 保持一致：temperature 先于 top_p（这里 top_p=1.0 即不裁剪）。
    """
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    enc = tokenizer([text], return_tensors="pt").to("cuda:0")
    input_ids = enc["input_ids"]
    prompt_tokens = int(input_ids.shape[1])

    torch.manual_seed(seed)
    t0 = time.time()
    generated: list[int] = []
    eos_id = tokenizer.eos_token_id
    past = None
    last_logits = None

    with torch.no_grad():
        for start in range(0, prompt_tokens, chunk):
            piece = input_ids[:, start:start + chunk]
            out = model(input_ids=piece, past_key_values=past, use_cache=True)
            past = out.past_key_values
            last_logits = out.logits[:, -1, :]
        for _ in range(MAX_NEW_TOKENS):
            probs = torch.softmax(last_logits / TEMPERATURE, dim=-1)
            tok = torch.multinomial(probs, num_samples=1)
            tid = int(tok.item())
            if eos_id is not None and tid == eos_id:
                break
            generated.append(tid)
            out = model(input_ids=tok, past_key_values=past, use_cache=True)
            past = out.past_key_values
            last_logits = out.logits[:, -1, :]

    ms = int((time.time() - t0) * 1000)
    completion_tokens = len(generated)
    answer = tokenizer.decode(generated, skip_special_tokens=True).strip()
    finish = "length" if completion_tokens >= MAX_NEW_TOKENS else "stop"
    return answer, {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
        # 本地没有前缀缓存这回事；明确写 0，不要让成本表凭空算出一个"缓存命中优惠"
        "prompt_cache_hit_tokens": 0,
    }, finish, ms


def main() -> int:
    _utf8_stdio()
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, help="runId，产物落 bench/runs/<runId>/")
    ap.add_argument("--conditions", required=True, help="逗号分隔，如 c0-base,c1-distilled")
    ap.add_argument("--conditions-file", default=str(DEFAULT_CONDITIONS))
    ap.add_argument("--model", default=BASE_MODEL)
    ap.add_argument("--adapter", default=None, help="LoRA adapter 目录；c3-lora 用")
    ap.add_argument("--seed", type=int, default=20261012)
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 题（冒烟用）")
    ap.add_argument("--force", action="store_true", help="重跑已存在的条目")
    args = ap.parse_args()

    cond_file = Path(args.conditions_file)
    data = load_conditions(cond_file)
    prompts = data["prompts"]
    if args.limit:
        prompts = prompts[: args.limit]
    wanted = [c.strip() for c in args.conditions.split(",") if c.strip()]
    for c in wanted:
        if c not in data["messages"]:
            sys.exit(f"conditions.json 里没有 {c}（有：{', '.join(data['messages'])}）")

    model, tokenizer, torch = build_model(args.model, args.adapter)

    run_dir = RUNS / args.run
    run_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = run_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {
        "runId": args.run,
        "at": datetime.now(timezone.utc).isoformat(),
        "engine": "local-transformers",
        "model": args.model,
        "adapter": args.adapter,
        "baseModelPolicy": "四档共用同一基座（这是本轮消融成立的前提）；c3-lora 仅多挂一个 LoRA adapter",
        "temperature": TEMPERATURE,
        "maxNewTokens": MAX_NEW_TOKENS,
        "billing": "local-gpu",
        "conditionsFile": str(cond_file.relative_to(REPO)).replace("\\", "/"),
        "conditionsFileWhy": "messages 逐字来自 bench/lora/export-conditions.mjs，本脚本不含任何条件模板",
        "prompts": len(prompts),
    }
    manifest["conditions"] = sorted(set(manifest.get("conditions", [])) | set(wanted))
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"· runId {args.run} ｜ 条件 {' / '.join(wanted)} ｜ 题数 {len(prompts)} ｜ 合计 {len(wanted) * len(prompts)} 次生成")
    done = 0
    total = len(wanted) * len(prompts)
    toc = time.time()
    for c in wanted:
        out_dir = run_dir / c
        out_dir.mkdir(parents=True, exist_ok=True)
        for i, p in enumerate(prompts):
            dst = out_dir / f"{p['id']}.json"
            if dst.exists() and not args.force:
                done += 1
                print(f"  [{done:>3}/{total}] {c} {p['id']} 已存在，跳过")
                continue
            messages = data["messages"][c][p["id"]]
            text_out, usage, finish, ms = generate_one(
                model, tokenizer, torch, messages, seed=args.seed + i
            )
            rec = {
                "id": p["id"],
                "axis": p.get("axis"),
                "topic": p.get("topic"),
                "condition": c,
                "text": text_out,
                "finishReason": finish,
                "model": args.model + (f"+lora:{args.adapter}" if args.adapter else ""),
                "billing": "local-gpu",     # 成本表据此显示"本地 GPU"，不把电费套成 DeepSeek 的美元价
                "usage": usage,
                "ms": ms,
                "attempts": 1,
                "at": datetime.now(timezone.utc).isoformat(),
                "promptChars": sum(len(m["content"]) for m in messages),
                "decode": {"temperature": TEMPERATURE, "maxNewTokens": MAX_NEW_TOKENS, "seed": args.seed + i},
            }
            dst.write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
            done += 1
            print(f"  [{done:>3}/{total}] {c} {p['id']} {usage['completion_tokens']}out {ms}ms ｜ {text_out[:28].replace(chr(10), ' ')}")
    print(f"\n完成 {done} 条 → bench/runs/{args.run}/ ｜ 耗时 {time.time() - toc:.0f}s ｜ 计费口径：本地 GPU（不是 API 账单）")
    print("注意：c3-lora 与 c0/c1/c2 只有在这一步用的是**同一个基座**时才可比 —— 见 manifest.baseModelPolicy。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
