#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
train_lora.py —— 在**与 c0/c1/c2 相同的基座**上训一个 LoRA adapter（消融的 c3 档）。

走的是 bench/LORA.md 第 2 节推荐的那条路：**纯风格语料继续训练**（corpus-train.txt 一行一帖），
不是指令微调。理由：学一个人的写法本质是继续预训练；指令路线另有 sft-*.jsonl，但只覆盖 25.3% 的帖子。

本脚本不联网（数据已在本地）、不读凭据。训练规模很小（1357 帖、中位 41 字），
所以真正要防的不是算力，是**过拟合**——因此每轮结束都报 dev 损失，并把曲线落盘。

用法：
    .venv/Scripts/python.exe bench/lora/train_lora.py \
        --data bench/lora/data --out bench/lora/out-lora --epochs 3
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
REPO = BENCH.parent

# 与 local_generate.py 同一个理由：缓存放工作区内（本环境下 Python 子进程写不了 ~/.cache）。
os.environ.setdefault("HF_HOME", str(BENCH / "lora" / "hf-cache"))

BASE_MODEL = "Qwen/Qwen2.5-1.5B-Instruct"

# 与 bench/LORA.md 里写的配方一致；改这里就要同步改文档，否则文档会变成谎话
LORA = dict(r=16, lora_alpha=32, lora_dropout=0.05,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
            bias="none", task_type="CAUSAL_LM")


def _utf8_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            enc = (getattr(stream, "encoding", "") or "").lower().replace("-", "")
            if enc != "utf8":
                stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def read_lines(path: Path, min_chars: int = 8) -> list[str]:
    if not path.exists():
        sys.exit(f"缺少训练数据 {path}\n先跑：node bench/lora.mjs export --out bench/lora/data")
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if len(t) >= min_chars:
            out.append(t)
    if not out:
        sys.exit(f"{path} 里没有可用样本")
    return out


def main() -> int:
    _utf8_stdio()
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(BENCH / "lora" / "data"))
    ap.add_argument("--out", default=str(BENCH / "lora" / "out-lora"))
    ap.add_argument("--model", default=BASE_MODEL)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--grad-accum", type=int, default=4)
    ap.add_argument("--cutoff", type=int, default=512)
    ap.add_argument("--warmup-ratio", type=float, default=0.03)
    ap.add_argument("--seed", type=int, default=20261012)
    ap.add_argument("--max-steps", type=int, default=0, help=">0 时只跑这么多步（冒烟用）")
    args = ap.parse_args()

    import torch
    from datasets import Dataset
    from peft import LoraConfig, get_peft_model
    from transformers import (AutoModelForCausalLM, AutoTokenizer, DataCollatorForLanguageModeling,
                              Trainer, TrainingArguments)

    if not torch.cuda.is_available():
        sys.exit("CUDA 不可用：这台机器上 torch.cuda.is_available() 为 False，别用 CPU 硬跑（会慢到没有意义）")

    data_dir = Path(args.data)
    train_lines = read_lines(data_dir / "corpus-train.txt")
    dev_lines = read_lines(data_dir / "corpus-dev.txt")
    print(f"· 训练 {len(train_lines)} 帖 ｜ dev {len(dev_lines)} 帖")

    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=False)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    def tok(batch):
        # 纯语料继续训练：不打 chat 模板，直接按文档切；labels 由 collator 复制 input_ids
        return tokenizer(batch["text"], truncation=True, max_length=args.cutoff)

    ds_train = Dataset.from_dict({"text": train_lines}).map(tok, batched=True, remove_columns=["text"])
    ds_dev = Dataset.from_dict({"text": dev_lines}).map(tok, batched=True, remove_columns=["text"])

    model = AutoModelForCausalLM.from_pretrained(
        args.model, dtype=torch.bfloat16, device_map="cuda:0", trust_remote_code=False)  # 5.x: torch_dtype → dtype
    model.config.use_cache = False
    model.enable_input_require_grads()

    cfg_kwargs = {k: v for k, v in LORA.items()}
    peft_cfg = LoraConfig(**cfg_kwargs)
    model = get_peft_model(model, peft_cfg)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    print(f"· LoRA 可训练参数 {trainable:,} / {total:,}（{trainable / total * 100:.4f}%）")

    out_dir = Path(args.out)
    # transformers 5.x 移除了 TrainingArguments.warmup_ratio（实测 5.19 只剩 warmup_steps），
    # 所以这里自己把比例换算成步数，并把两个值都写进 train-log —— 否则文档里写的
    # "warmup_ratio 0.03" 就成了一句没人能核对的话。
    steps_per_epoch = max(1, (len(train_lines) + args.batch * args.grad_accum - 1) // (args.batch * args.grad_accum))
    total_steps = steps_per_epoch * args.epochs
    warmup_steps = max(1, round(total_steps * args.warmup_ratio))

    targs = TrainingArguments(
        output_dir=str(out_dir / "checkpoints"),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_steps=warmup_steps,
        bf16=True,
        logging_steps=10,
        save_strategy="no",
        eval_strategy="epoch",
        report_to=[],
        seed=args.seed,
        max_steps=args.max_steps if args.max_steps > 0 else -1,
    )
    collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)
    trainer = Trainer(model=model, args=targs, train_dataset=ds_train, eval_dataset=ds_dev, data_collator=collator)

    t0 = time.time()
    result = trainer.train()
    secs = time.time() - t0

    adapter_dir = out_dir / "adapter"
    model.save_pretrained(str(adapter_dir))
    tokenizer.save_pretrained(str(adapter_dir))

    adapter_dir = (out_dir / "adapter").resolve()

    # 路径转相对仓库根只为让日志好看；--out 传相对路径时 relative_to 会抛 ValueError（实测踩过），
    # 所以这里做兜底：不在仓库内就照原样记绝对路径，别让"记日志"把训练结果搞丢。
    def rel(p: Path) -> str:
        try:
            return str(Path(p).resolve().relative_to(REPO)).replace("\\", "/")
        except ValueError:
            return str(p)

    log = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "baseModel": args.model,
        "data": {"train": len(train_lines), "dev": len(dev_lines),
                 "trainFile": rel(data_dir / "corpus-train.txt")},
        "lora": LORA,
        "trainArgs": {k: getattr(args, k) for k in ("epochs", "lr", "batch", "grad_accum", "cutoff", "warmup_ratio", "seed", "max_steps")},
        "derived": {"stepsPerEpoch": steps_per_epoch, "totalSteps": total_steps, "warmupSteps": warmup_steps,
                    "why": "transformers 5.x 已无 TrainingArguments.warmup_ratio，故由 warmup_ratio 自行换算 warmup_steps"},
        "trainableParams": trainable,
        "totalParams": total,
        "wallSeconds": round(secs, 1),
        "trainLoss": round(float(result.training_loss), 4),
        "logHistory": [{k: (round(v, 4) if isinstance(v, float) else v) for k, v in row.items()}
                       for row in trainer.state.log_history],
        "adapterDir": rel(adapter_dir),
        "notRun": None,
    }
    (out_dir / "train-log.json").parent.mkdir(parents=True, exist_ok=True)
    (out_dir / "train-log.json").write_text(json.dumps(log, ensure_ascii=False, indent=2), encoding="utf-8")

    # 另存一份到 bench/report/：那里是**可提交**的核对面（out-lora/ 被 gitignore，因为 adapter 是二进制训练物）。
    # 这样"训练到底跑没跑、用什么数据什么超参"有据可查，而不必把权重入库。
    report_dir = BENCH / "report"
    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / "lora-train.json").write_text(
        json.dumps({**log, "note": "adapter 权重在 bench/lora/out-lora/（gitignore）；本文件是可提交的训练核对记录"},
                   ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n训练完成 ｜ {secs:.0f}s ｜ train loss {log['trainLoss']} ｜ adapter → {log['adapterDir']}")
    print("每轮 dev 损失（判断过拟合，别只看 train loss）：")
    for row in log["logHistory"]:
        if "eval_loss" in row:
            print(f"   epoch {row.get('epoch')}  eval_loss {row['eval_loss']}")
    print(f"训练日志 → bench/lora/out-lora/train-log.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
