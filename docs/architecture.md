# 架构：从语料到"能验收的写作规则"

这份文档画三张图，分别回答三个问题：**数据怎么流**、**什么东西在包里**、**改了东西怎么知道没变坏**。
图里的每个框都是仓库里真实存在的东西，标了文件名；没有"规划中"的框混在里面。

---

## 一、全链路

```mermaid
flowchart TD
    subgraph S1["① 采集（离线 · 需登录态 · 不在插件运行路径上）"]
        A1["scripts/distill.js<br/>微博分页抓正文"]
        A2["scripts/distill_comments.js<br/>≥30 赞热评"]
        A3["B站切片字幕<br/>（工作区 fg_bili_* 脚本）"]
        A1 --> RAW[("fg_fengge_v2_raw.json<br/>1,921 条 · 一、二期<br/>含 retweeted/isLong/iso")]
        A1 --> INC[("data/posts.json<br/>633 条增量（gitignore）<br/>其中 2026-09-29 起 170 条 = 三期")]
        A2 --> HOT[("fg_full_hotcomments.json<br/>4163 条热评")]
        A3 --> BL[("fg_bili_corpus.json<br/>BV 为键 · 460k 字")]
        RAW --> MERGE
        INC --> MERGE
        MERGE["loadWeiboAll()<br/>按 id 去重 + 字段/日期归一化<br/>→ 2,093 条（去重 461）"]
    end

    subgraph S2["② 清洗 / 分层 / 去重"]
        B1["scripts/frontmatter.js<br/>打标 move/topics/hot"]
        B2["corpus-path.mjs<br/>定位 + sha256 溯源（不写绝对路径）"]
        B3["过滤：转发 / 长文 / 过短 / 重复"]
        B1 --> B2 --> B3
    end

    subgraph S3["③ 蒸馏（把语料变成尺子）"]
        C1["fengge-profile.mjs<br/>→ style-profile.json<br/>长度/标点/称呼/语助/高频二字组"]
        C2["fengge-ratio.mjs<br/>→ style-ratios.json<br/>40 特征比例 + Wilson 95% CI + 长度分位 + 逗号分位"]
        C3["style-features.mjs<br/>**特征定义的唯一来源**（40 条 / align 判 28 条）"]
        C3 -.-> C1
        C3 -.-> C2
    end

    subgraph S4["④ 写作路径（动笔时）"]
        D1["SKILL.md 规则<br/>选题器 / 铁律 / 分期 / 免责 / 长度"]
        D2["fengge-retrieve.mjs<br/>BM25 字符 n-gram 检索<br/>top-k 真实语料当参照"]
        D3["prompt 组装<br/>bench/generate.mjs CONDITIONS"]
        D4["生成（LLM）"]
        D1 --> D3
        D2 --> D3
        D3 --> D4
    end

    subgraph S5["⑤ 评测（四层，别把低层当高层）"]
        E1["fengge-lint.mjs<br/>规则级：硬拦 / 警告"]
        E2["fengge-align.mjs<br/>分布级：合成 95% 区间带内率"]
        E3["evals/run-evals.mjs<br/>行为级：20 条用例 + 正反例自检"]
        E4["bench/metrics.mjs<br/>统计级：lint 率 / 带内率 / JSD / MAE / distinct-n / BLEU / ROUGE-L / **最长照抄**"]
        E5["security/detect.mjs + run.mjs<br/>账号级：注入 / 冒充本人 / 隐私 / 灾难"]
        E6["bench/labels.mjs<br/>人的判据：**成对盲评胜率** + Cohen κ"]
    end

    subgraph S6["⑥ 反馈闭环"]
        F1["人工标注结果<br/>bench/report/labels-score.json"]
        F2["改 SKILL.md 的哪一条<br/>（例：免责句 40% vs 语料 0.6%）"]
        F3["回归：npm run accept<br/>lint 基线 + evals 自检 + 黄金批次 30/30"]
    end

    RAW --> B1
    HOT --> B2
    BL --> B2
    B3 --> C1
    B3 --> C2
    B3 --> D2
    D4 --> OUT[("bench/runs/&lt;runId&gt;/<br/>冻结原始输出 + usage")]
    OUT --> E4
    OUT --> E5
    OUT --> E6
    E1 --> F3
    E2 --> F3
    E3 --> F3
    E6 --> F1 --> F2 --> D1
    F3 --> F2
```

**读法**：闭环是从 ⑥ 回到 ④ 的**一条人工回路**——机器只负责把偏差指到具体特征（"免责句 40% vs 语料 0.6%"），
改不改、怎么改由人定，改完必须过 ⑤ 的全部回归。这条回路上没有任何一步是自动改规则的，这是刻意的。

---

## 二、包里 / 包外（这条边界不能糊）

```mermaid
flowchart LR
    subgraph PKG["npm 包 dsh-fengge-distill（package.json 的 files）"]
        direction TB
        P1["lib/index.js<br/>技能 provider"]
        P2["skills/&lt;name&gt;/SKILL.md + references/ + data/"]
        P3["skills/&lt;name&gt;/scripts/<br/>lint / align / ratio / profile / retrieve / check<br/>**零依赖 · 不联网 · 不起子进程 · 无凭据**"]
        P4["test/ + scripts/verify-provider.mjs"]
    end
    subgraph OUT["包外（不进 npm，GitHub 上可见）"]
        direction TB
        O1["bench/<br/>联网 · 要 API key"]
        O2["security/<br/>联网 · 要 API key"]
        O3["service/<br/>FastAPI · Docker · 调用日志 · 成本统计"]
    end
    subgraph EXT["本机/工作区（不入库）"]
        E1[("全量语料 fg_*.json")]
        E2[("bench/lora/data/<br/>训练数据＝语料副本")]
        E3[("bench/runs/ 里检索原文<br/>发布前 --redact 换 sha256")]
    end
    PKG -.->|"只读 skills/ 下的 Markdown"| PKG
    OUT -->|"调用包内脚本（子进程）"| PKG
    OUT --> E1
    OUT --> E2
    OUT --> E3
```

**规则**：任何**联网、要 key、起子进程**的东西一律在包外。
包内脚本只做纯本地计算（正则、统计、BM25），所以 `fengge-check.mjs` 当初才会把 spawn 子进程
改成直接 import——那不只是"更好的实现"，是**商店 fail-closed 门禁唯一能过的方式**。

---

## 三、改动 → 回归（决定"能不能发"）

```mermaid
flowchart TD
    G0["改了什么？"] --> G1{"改的是包内脚本/清单？"}
    G1 -->|是| R1["npm test<br/>打包契约 + provider 边界 + 语料路径不变量"]
    G1 -->|否| R2
    R1 --> R2["npm run verify<br/>打包契约自检"]
    R2 --> R3["npm run accept<br/>①lint 回归基线 ②evals 自检 5/5 ③黄金批次统计对齐 ≥85%"]
    R3 --> R4{"改了 SKILL.md 的规则？"}
    R4 -->|否| DONE["可发"]
    R4 -->|是| R5["npm run accept 里的黄金批次带内率<br/>（尺子被改歪会立刻掉下来）"]
    R5 --> R6["node bench/metrics.mjs --run &lt;runId&gt;<br/>重算消融表，看行为指标是否真的改善"]
    R6 --> R7["node bench/labels.mjs sheet --run &lt;runId&gt;<br/>人工盲评（自动指标过了不等于像）"]
    R7 --> DONE
```

**为什么不是"CI 绿了就能发"**：`accept` 只能证明"没退化"，
证明不了"更像人"。改规则这件事的最终验收永远落在 ⑥ 的人工盲评上——
而且要看胜率的 Wilson 区间，区间跨过 50% 就是**分不出**，不能宣布胜利。

---

## 四、几个容易被忽略的设计约束

| 约束 | 为什么 | 在哪体现 |
|---|---|---|
| 特征定义只有一份 | ratio 与 align 曾各抄一份（40 条 vs 28 条），改一处忘一处会"基准说 A、对齐判 B" | `style-features.mjs` + `selfcheck()` |
| 语料路径不许写死 | 写死本机路径时 `align/accept` 换机器就崩，所以一直进不了 CI | `corpus-path.mjs` + `test/corpus-path.test.mjs` |
| 派生统计随仓库走 | align 要的逗号分位不再回读语料，它才能变成纯函数进 CI | `style-ratios.json` 的 `comma` 段 |
| 溯源写 sha256 不写路径 | 把作者本机路径写进随仓库分发的 data/*.json 既泄漏又不可复现 | `provenance()` |
| 抽不到就抛错 | LCG 低位退化让"抽 20 条"静默只给 16 条，100 条评测集变 96 条 | `sampleIndices` |
| 推理统一关闭 | `deepseek-flash` 默认思考，一次调用 176 个输出 token 里 167 个是推理，极端情况下正文一个字都不剩（实测 3/9 条空输出） | `generate.mjs` 的 `thinking:{type:'disabled'}` |
| 发布前脱敏检索原文 | c2 档记录会带 240 条真实语料，等于把语料复制进仓库 | `generate.mjs --redact` |
