# 微调（c3-lora）—— 协议与**实跑记录**

> **这一档已经真跑过了**（2026-10-12）。结论是**负面的**：在同一个 1.5B 开源基座上，
> 微调档在最关键的行为指标上是四档里**最差**的（lint 不通过 40%，distinct-3 0.58 组内最重复）。
> 完整四档对照与解读见 [`README.md`](README.md) 的「同基座消融（本地 GPU）」一节。
>
> 本文件保留可复现的协议；**执行记录**（数据、超参、踩到的坑、吞吐）见下面第 0.5 与第 2 节。

>
> 本轮实际做法：先把 c0/c1/c2 **全部搬到同一个开源基座**（`Qwen/Qwen2.5-1.5B-Instruct`）重跑，
> 再在同一基座上训 LoRA 跑第四档——这样比出来的是"微调 vs 提示"，而不是"两个模型的差别"。

## 0.5 本机实测（不是估计，是探测结果）

| 项 | 实测值 | 命令 |
|---|---|---|
| GPU | **NVIDIA GeForce RTX 3070 Laptop，8192 MiB**；运行时 80–87 W / 1335 MHz / 最高 86 °C | `nvidia-smi` |
| 驱动 / CUDA | 驱动 591.86（CUDA 13.1）；CUDA Toolkit 12.2 已装（`nvcc` 可用）；torch 用 cu124 wheel | `nvidia-smi`、`nvcc --version` |
| PyPI / HuggingFace | 均可达（HTTP 200），不用镜像 | `Invoke-WebRequest` |
| 磁盘 | 余量 **159.9 GB** | `Get-PSDrive C` |
| 依赖 | torch 2.6.0+cu124、transformers 5.19.0、peft 0.21.2、datasets 5.1.0 | `pip list` |
| **实测吞吐** | 长 prompt 档（15k token 前缀）约 **9 token/s**；短 prompt 档约 2 s/条 | `bench/runs/run-local-qwen25-1.5b/*/*.json` 的 `ms` 字段 |

**结论：能跑，而且跑完了。** 8 GB 显存下的实际档位：

- **1.5B–3B 基座 + 普通 LoRA**：余量够（本轮用的就是 1.5B，不需要 bitsandbytes，避开 Windows 上最容易坏的那条依赖）。
- **7B 基座 + QLoRA（4-bit）**：可行但偏紧，需要 `gradient_checkpointing`、小 batch、序列长度压到 512；
  Windows 上 bitsandbytes 是主要风险点。
- 训练数据规模很小（1357 帖、正文中位 41 字），本轮训练只用 **431 秒**。

> 这一段是补记：本文档最初写的是"本机无 GPU、无训练资源"——那是一句**没核实就写下的断言**，
> 实测为假。留在这里是因为这个仓库的规矩是"没测过就别写结论"，而我自己先违反了它一次。

### 8GB 下踩到并修掉的四件事（不是"优化"，是不修就跑不了）

1. **朴素 attention 会把长 prompt 撑爆**：c1/c2 的 prompt 有 2.2 万字符 ≈ 1.5 万 token，
   PyTorch 的 math SDPA 会**物化** `[heads × seq × seq]`，单次分配就要 **12.48 GiB** → 直接 OOM。
2. **换 memory-efficient 后端也不行**：Qwen2.5 是 GQA（12 query head / 2 KV head），该后端不支持这个形状 →
   `RuntimeError: No available kernel`；flash 后端这台机器**没编进去**，没有第三条路。
   全局 `enable_math_sdp(False)` 只会把报错从 OOM 换成 "No available kernel"。
3. **正解是别一口气吞下整个 prompt**：`local_generate.py` 改成**分块 prefill（chunk=512）+ 手写采样循环**，
   峰值显存与 prompt 长度解耦。**绝不靠截断 prompt 绕过**——那会让本地档与 API 档的提示词不再逐字相同，消融当场作废。
4. **解码上限收到 400 token**：1.5B 基座在长 system 下会不收敛、一路生成到上限
   （实测有一条写了 1024 token 碎话、耗时 124 秒）。语料 p95≈120 字，400 token ≈ 300 字已远超必要，
   且这个上限**对四档一视同仁**，不构成倾斜。

两处环境适配：模型缓存放工作区内（`bench/lora/hf-cache/`，本环境下 Python 子进程写不了 `~/.cache`）；
transformers 5.x 已移除 `TrainingArguments.warmup_ratio`，改为由比例**自行换算 `warmup_steps`**（8 步）。

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

基座选择原则：中文能力好、**权重公开**、许可允许二次训练。本仓库**不锁死具体供应商版本**——
写死了就会过期，还会变成"给某个模型背书"。本轮用的是 `Qwen/Qwen2.5-1.5B-Instruct`（8GB 下最稳的一档）。

**本轮实际用的超参**（不再是模板，就是跑这一次的配置）：

```yaml
lora:
  r: 16
  alpha: 32          # alpha/r = 2
  dropout: 0.05
  target_modules: [q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj]
  bias: none
  # 可训练参数 18,464,768 / 1,562,179,072 = 1.1820%
train:
  epochs: 2              # 见下：先跑 3 轮发现 dev 损失回升，按 dev 最优点改成 2 轮
  lr: 1.0e-4
  lr_scheduler: cosine
  warmup_ratio: 0.03     # transformers 5.x 已无此参数，脚本自行换算成 warmup_steps=8
  per_device_batch_size: 4
  gradient_accumulation: 4
  cutoff_len: 512
  bf16: true
  steps: 170 ｜ 耗时 431 秒 ｜ train loss 3.7047 ｜ dev 3.9294(ep1) → 3.9001(ep2)
```

**为什么是 2 轮**：先按初稿的 3 轮跑了一遍，dev 损失是 `3.9212 → 3.8761 → 3.9159`——第 3 轮回升，开始过拟合。
既然 dev 给了信号，就不该交一个明知次优的 checkpoint，所以按 dev 最优点重训 2 轮。
完整记录见 `bench/report/lora-train.json`。

> 诚实边界：这类 1.5B 小模型的 dev 损失在 ±0.03 量级上不稳（同一配置重跑，前两轮 eval_loss 在 3.90–3.93 间浮动），
> 所以"2 轮 vs 3 轮"只能算**弱证据**，别把 0.01 的差当定论。

命令（**这就是本轮真跑的命令**，不需要 LLaMA-Factory；`train_lora.py` 直接调 transformers+peft）：

```bash
.venv/Scripts/python.exe bench/lora/train_lora.py --epochs 2 --out bench/lora/out-lora
```

如果你更习惯 LLaMA-Factory，等价的 `--stage pt` 配方是：

```bash
llamafactory-cli train --stage pt \
  --model_name_or_path Qwen/Qwen2.5-1.5B-Instruct \
  --train_file bench/lora/data/corpus-train.txt \
  --eval_dataset bench/lora/data/corpus-dev.txt \
  --template default --cutoff_len 512 \
  --lora_rank 16 --lora_alpha 32 --lora_dropout 0.05 \
  --num_train_epochs 2 --learning_rate 1e-4 --lr_scheduler_type cosine \
  --bf16 true --output_dir bench/lora/out-pt
```

指令路线（`--stage sft`）本轮**没走**：它只覆盖 25.3% 的帖子（题目只取他自己打的标签），覆盖率太低。

指令路线（`--stage sft`）本轮**没走**：它只覆盖 25.3% 的帖子（题目只取他自己打的标签），覆盖率太低。

## 3. 评测（**已执行**，与提示法同一把尺子）

```bash
# 本轮实际用的链路（本地基座版：不用 API，因此走 local_generate.py）
.venv/Scripts/python.exe bench/lora/local_generate.py \
    --run run-local-qwen25-1.5b --conditions c3-lora --adapter bench/lora/out-lora/adapter
node bench/metrics.mjs  --run run-local-qwen25-1.5b
node bench/ablation.mjs --run run-local-qwen25-1.5b
node bench/labels.mjs   sheet --run run-local-qwen25-1.5b   # 想要人工判据的话
```

**c3-lora 用的是朴素提示（c0-base 的 messages），不是 SKILL.md**：微调这一档的意义就是
"把风格训进权重、不用再灌规则"，所以必须拿最朴素那条提示去比——否则赢了也说不清是训练的功劳还是提示的功劳。
（"LoRA + 规则"那条路本轮没跑，属已知未覆盖项。）

**成本口径**：本地推理**不报美元**。`local_generate.py` 在每条记录里写 `billing: "local-gpu"`，
`ablation.mjs` 据此把成本栏显示为"本地 GPU"、只报 token 量——
把本地输出乘上 DeepSeek 的单价会凭空造出一个不存在的费用。

**验收线**（四条同时满足才算这一档值得），**本轮的实测结果**：

| 判据 | 门槛 | c3-lora 实测 | 是否达标 |
|---|---|---|---|
| lint 不通过率 | < 提示法最好档（c2 的 20%） | **40%（四档最差）** | ✗ |
| 风格 JSD | ≤ 提示法最好档（c2 的 0.11） | 0.17 | ✗ |
| **最长连续照抄** | ≤ real 对照同量级（13 字） | **22 字** | ✗ |
| distinct-3 | 不明显低于提示法最好档 | **0.58（四档最差，最重复）** | ✗ |

**四条全不达标。** 这是一个**负面结果**，见 [`README.md`](README.md) 的解读。

## 4. 已知风险与边界

- **记忆化 / 照抄**：本轮实测 c3-lora 的最长连续照抄 **22 字**，高于 real 对照的 13 字；
  而提示法 c2 档更糟（77 字）。照抄检测是必测项，不是可选项。
- **基座不可比**：`run-local-*` 那张表**不能**与 deepseek-flash 那张表合并排名——这是设计使然，不是缺陷。
- **灾难性遗忘**：`--stage pt` 会削弱基座原有的指令跟随能力。本轮 c3-lora 的产出明显变长变重复
  （中位 102 字 vs 语料 41 字；distinct-3 0.58），**很可能就是这个原因**，但本轮没有单独测指令跟随，
  属**已知未测项**。
- **8GB 是硬约束**：7B 量级需要 QLoRA(4-bit) + gradient checkpointing，Windows 上 bitsandbytes 是主要风险点；
  本轮没走那条路。**换更大的基座可能改变结论**——本轮最重要的发现恰恰是"结论依赖基座强度"。
- **版权与分发边界**：`bench/lora/data/` 是全量语料副本，**不得提交、不得随产物分发**；
  `bench/lora/out-lora/` 的 adapter 权重同样含语料记忆，**已在 .gitignore**，发布前请自行判断合规性。
- **不替上游背书**：本文件不声称任何具体基座/框架的可用性；上面所有实测数字都来自本机，
  换机器请用 `local_generate.py` 与 `train_lora.py` 重跑，别把这里的数字当常数。
- **照抄检测的一个已知盲区**：`verbatimCheck` 跳过"与候选完全相同"的语料条目，但**不处理近似重复**；
  语料里确实存在同一句发两遍（如"怀念那个曾经一天赚1000元…"），所以 real 对照那栏天然偏高。
  判读方式是"生成档与 real 对照比"，不是看绝对值。

