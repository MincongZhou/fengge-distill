# 微调（c3-lora）协议 —— **未运行**

> 这一档在消融表里只有一行"未运行"，没有数字。
>
> **注意：不是"跑不了"，是本次没跑。** 本机实测有 **RTX 3070 Laptop（8GB 显存，驱动 CUDA 13.1，nvcc 12.2）**、
> PyPI 与 huggingface.co 均可达、磁盘余量 160GB；缺的只是 torch 等训练依赖还没装。
> 之所以没跑：①它不在本轮商定的范围内；②**公平对比要求 c0/c1/c2 也换到同一个开源基座上重跑**
> （理由见下面第 0 节），那是一整轮重新生成 + 重新评测，不是顺手就能做完的事。
> 所以按本仓库的规矩，**没跑过的东西不填表、不给分数**，但协议与数据都备齐，随时可以开跑。

## 0.5 本机实测的可行性（不是估计，是探测结果）

| 项 | 实测值 | 命令 |
|---|---|---|
| GPU | **NVIDIA GeForce RTX 3070 Laptop，8192 MiB**，当时占用 91 MiB / 利用率 0% | `nvidia-smi` |
| 驱动 / CUDA | 驱动 591.86（CUDA 13.1）；**CUDA Toolkit 12.2 已装**（`nvcc` 可用） | `nvidia-smi`、`nvcc --version` |
| PyPI | 可达（HTTP 200），实测 wheel 下载 ~100 KB/s→0.9 s 内完成 | `Invoke-WebRequest https://pypi.org/simple/torch/` |
| HuggingFace | **可达（HTTP 200）**，模型权重能直接拉，不用镜像 | `Invoke-WebRequest https://huggingface.co/api/models?limit=1` |
| 磁盘 | 余量 **159.9 GB** | `Get-PSDrive C` |
| torch | **未安装**（这是唯一缺的东西） | `python -c "import torch"` |

**结论：能跑。** 8 GB 显存下的实际档位：

- **1.5B–3B 基座 + 普通 LoRA**：余量充足，是稳妥选择（不需要 bitsandbytes，避开 Windows 上最容易坏的那条依赖）。
- **7B 基座 + QLoRA（4-bit）**：可行但偏紧，需要 `gradient_checkpointing`、小 batch、序列长度压到 512；
  Windows 上 bitsandbytes 是主要风险点。
- 训练数据规模很小（1357 帖、正文中位 41 字），**瓶颈不是算力而是"要不要为了可比性把整轮评测重跑一遍"**。

> 这一段是补记：本文档最初写的是"本机无 GPU、无训练资源"——那是一句**没核实就写下的断言**，
> 实测为假。留在这里是因为这个仓库的规矩是"没测过就别写结论"，而我自己先违反了它一次。


## 0. 先说一个会让整张消融表作废的方法论点

`deepseek-flash`（DeepSeek-V4.1-Flash）**只有 API，没有公开权重**，微调不了。
所以只要 LoRA 用的是别的开源基座，`c3-lora` 与 `c0/c1/c2` 就**不是同一个生成器**——
那样比出来的是"两个模型的差别"，不是"微调与提示的差别"。

⇒ **要得出可比结论，必须把 c0-base / c1-distilled / c2-retrieval 在同一开源基座上重跑一遍**，
再和 LoRA 版比。`bench/generate.mjs` 支持 `--model` 覆盖，重跑不需要改代码：

```bash
node bench/generate.mjs --model <base> --concurrency 4
node bench/metrics.mjs  --run <新runId>
node bench/ablation.mjs --run <新runId>
```

如果不想重跑，那就**别把 LoRA 那行和现有 c0/c1/c2 放在同一张表里排名**——只当成两个独立实验。

## 1. 数据

```bash
node bench/lora.mjs export --out bench/lora/data
```

产出（本机 `bench/lora/data/`，**已在 .gitignore 里**——它等于全量语料正文，
按仓库边界声明不得随仓库分发；可提交的核对面只有 `bench/report/lora-export.json`，
里面是条数与 sha256，不含正文）：

| 文件 | 内容 | 本次导出（run 2026-10-12） |
|---|---|---|
| `corpus-train.txt` | 纯风格语料，一行一帖 | 1357 帖 / 194 KiB |
| `corpus-dev.txt` | 同上，留出 | 151 帖 / 18 KiB |
| `sft-train.jsonl` | 指令配对（题目 = 该帖**自带的 #话题标签#**） | 369 条 / 131 KiB |
| `sft-dev.jsonl` | 同上 | 13 条 / 5 KiB |

三个刻意的设计选择：

- **两套数据，路径不同。** 学一个人的写法，本质是**继续预训练**（用 `corpus-*.txt`），
  不是教问答。`sft-*.jsonl` 是给"必须做指令微调"的场景备的替代路线。
- **题目只取他自己打的标签。** 带标签的帖子占 25.3%。我**不替他编选题**——
  编出来的题目会把"像他"训成"像我以为的他"，这正是 SKILL.md 里「选题器」那一节要防的事。
  代价是 sft 路线覆盖率只有四分之一，且晚期帖子带标签更少（sft-dev 只剩 13 条）。
- **时间切分，不随机切分。** `train` 是较早的帖子、`dev` 是较晚的。
  随机切分会让同一段时间的用词同时落在两边，dev 分数虚高；而且这一档最终要在**新题目**上评，
  训练侧保持同一种"时间观"才不会自欺。

## 2. 训练配方（模板，**未在本机执行**）

基座选择原则：中文能力好、**权重公开**、许可允许二次训练。本仓库**不锁定具体供应商版本**——
写死了就会过期，还会变成"给某个模型背书"。7B 量级的 instruct 基座是常见起点。

LoRA 超参（写成模板是因为它们取决于基座，不是普适常数）：

```yaml
lora:
  r: 16
  alpha: 32          # alpha/r = 2，常见的稳定起点
  dropout: 0.05
  target_modules: [q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj]
train:
  epochs: 3
  lr: 1.0e-4
  lr_scheduler: cosine
  warmup_ratio: 0.03
  per_device_batch_size: 8
  gradient_accumulation: 2
  cutoff_len: 512
  bf16: true
```

以 LLaMA-Factory 为例（**这是模板，没跑过**；换 transformers+peft 同理）：

```bash
# ① 纯语料继续训练（推荐先做这个）
llamafactory-cli train \
  --stage pt \
  --model_name_or_path <base> \
  --train_file bench/lora/data/corpus-train.txt \
  --eval_dataset bench/lora/data/corpus-dev.txt \
  --template default --cutoff_len 512 \
  --lora_rank 16 --lora_alpha 32 --lora_dropout 0.05 \
  --num_train_epochs 3 --learning_rate 1e-4 --lr_scheduler_type cosine \
  --bf16 true --output_dir bench/lora/out-pt

# ② 指令路线（可选，覆盖率只有 25.3%）
llamafactory-cli train \
  --stage sft \
  --model_name_or_path <base> \
  --dataset bench/lora/data/sft-train.jsonl \
  --eval_dataset bench/lora/data/sft-dev.jsonl \
  --template default --cutoff_len 512 \
  --lora_rank 16 --lora_alpha 32 --lora_dropout 0.05 \
  --num_train_epochs 3 --learning_rate 1e-4 --bf16 true \
  --output_dir bench/lora/out-sft
```

## 3. 评测协议（与提示法**同一把尺子**）

训练完之后，别的都不用新写，走同一条评测链：

```bash
# 用同一批 30 题（bench/prompts.jsonl）生成
node bench/generate.mjs --model <lora-merged-or-endpoint> --conditions c0-base --concurrency 4
# 自动指标 + 消融表
node bench/metrics.mjs  --run <runId>
node bench/ablation.mjs --run <runId>
# 人工盲评（成对：这是"能不能算像"的最终判据）
node bench/labels.mjs sheet --run <runId>
```

**验收线**（四条同时满足才算"微调这一档值得"，否则加的训练成本不划算）：

| 判据 | 门槛 | 理由 |
|---|---|---|
| lint 不通过率 | < 提示法最好档 | 行为指标，与 skill 契约直接挂钩 |
| 风格 JSD | ≤ 提示法最好档 | 画像贴合度 |
| **最长连续照抄** | ≤ real 对照同量级（当前 13 字） | 微调最容易退化成"背课文"；这一条是硬门槛 |
| distinct-3 | 不明显低于提示法最好档 | 防"整批一个模子" |

最后一定要跑 **成对盲评**（`bench/labels.mjs`）：自动指标只能证明"更像语料分布"，
证明不了"更像真人"。而且要看胜率的 Wilson 区间——区间跨过 50% 就是**分不出**，不要宣布胜利。

## 4. 已知风险与边界

- **记忆化 / 照抄**：1357 帖里含大量可复现的模板句（免责句、抽奖话术、平台水印）。
  LoRA 很可能整句背下来。照抄检测不是可选项，是这张表的必测项。
- **基座不可比**：见第 0 节。不换基座就没法把 LoRA 与提示法排名。
- **灾难性遗忘**：`--stage pt` 会削弱基座原有的指令跟随能力；如果你的用法是"给题目写微博"，
  必须一并评估指令跟随是否退化，别只看风格指标。
- **版权与分发边界**：`bench/lora/data/` 是全量语料副本，**不得提交、不得随产物分发**。
  训练出来的权重同样含语料记忆——发布前请自行判断合规性，本仓库不给法律结论。
- **不替上游背书**：本文件不声称任何具体基座/框架的可用性，命令是模板；跑之前请按你自己的环境核对。
