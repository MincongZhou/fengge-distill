<div align="center">

# 峰哥 · 语言蒸馏引擎

**FengGe Distillation Engine**

把「抽象教父」@峰哥亡命天涯 的 **559 条微博**，蒸馏成一口能自己生成「峰哥味」的引擎。

<img alt="vibe" src="https://img.shields.io/badge/项目-蒸馏-brown">
<img alt="n" src="https://img.shields.io/badge/语料-559条-ff69b4">
<img alt="hot" src="https://img.shields.io/badge/高赞热评-2440条-9cf">
<img alt="iron" src="https://img.shields.io/badge/铁律-模仿不质疑-black">
<img alt="CI" src="https://github.com/MincongZhou/fengge-distill/actions/workflows/ci.yml/badge.svg">
<img alt="stars" src="https://img.shields.io/github/stars/MincongZhou/fengge-distill">
<img alt="forks" src="https://img.shields.io/github/forks/MincongZhou/fengge-distill">
<img alt="last-commit" src="https://img.shields.io/github/last-commit/MincongZhou/fengge-distill">
<img alt="license" src="https://img.shields.io/badge/license-MIT-blue">

</div>

---

## 这不是复读，是蒸馏

像生物学科一样，把 **559 条公开博文 + 2440 条 ≥30 赞高赞热评**，蒸馏成一整套可直接用的**峰哥语体规矩**。输出不是照搬他的句子，而是把它的「世界观内核」提出来——你是**模仿**他，不是**质疑**他。

**铁律：** 写峰哥味，只忠实模仿它的世界观，不下自我道德判断。

## 峰哥体三定律

1. **蹭是大事。** 有热度就多蹭，把热点翻译成流量 / 钱 / 红包；禁言是平台的事，蹭是峰哥的事。**编身份也是蹭，蹭上热搜就是蹭成。**
2. **被看穿的自夸。** 招牌是「评别人 ＝ 夸自己」；明知会被嘲，还是硬把牛吹下去。
3. **装颓。** 丧是引子，落点是自夸——「我惨但我还是比你强，我累但我还在挣」。

## 统计口径（n = 559 · 105 天）

| 指标 | 值 |
|---|---|
| 长度 | **中位 41 字** · 平均 54 字 · **>160 字 0 条** · ≤30 字占 41% |
| 日更密度 | ~5 条/天 |
| 话题重心 | A股/科技(94) > 体育(24) > 生活/账单(23) > 抽奖/红包(17) > 机器人/AI硬件(13) > 黄金(9) |
| 高赞热评 | **546/559** 条有 ≥30 赞热评，共 **2440** 条；1000+ 赞 126 条 |

> 最高赞热评几乎不是「骂他」，而是「**配合他演 + 顺手拆穿 + 反将一军**」。
> 举报 → **+6146**「无差别核打击」；卖惨 → **+4035**「你们演吧」；凡尔赛 → **+4615**「广告位招租」；投资金句 → **+3688**「翻译：我不割」。

## 蒸馏管道

```
scripts/
  distill.js             # 抓正文 + 统计（weibo mymblog 分页）
  distill_comments.js    # 逐条抓 ≥30 赞热评（hotflow）
  frontmatter.js         # 打标 move/topics/hot → frontmatter.md + jsonl
  query.js               # 按动作/话题/热度/日期筛选
data/
  stats.md               # 统计口径
  sample.jsonl           # 抽样（带 move/topics/hot 元数据）
```

```bash
node scripts/query.js --move 自问自答 --limit 5          # →命中 21 条
node scripts/query.js --topic "A股/科技" --hot 1 --limit 5
node scripts/query.js --move 抽奖运营 --comments --limit 5
```

> 实跑：`--move 自问自答` 第一条 = 「网上很多路人说我持仓是假的，是P图，我微微一笑，丝毫不慌。为什么呢？……液冷，磷化铟，HBM。」

### 今日峰哥味（demo，无需登录态）

```bash
node scripts/quote.js
```

> 今日峰哥味 · 2026-09-01
> 宋亚东差点给对手打死！ 峰哥亡命天涯的微博视频
> — move: 体育格斗蹭 | topics: 体育 | hot=true

每天跑一次按当天日期稳定换一条；CI 也会跑一遍，亮上面的徽章。

## 目录结构

```
fengge-distill/
├── README.md
├── style-engine.md          ← 峰哥语体引擎规则（产出的「蒸馏」核心）
├── corpus.md                ← 语料参考（签名动作/接招对照/高赞实锤/装颓/案例）
├── scripts/                 ← 蒸馏管道
└── data/                    ← 统计口径 + 抽样
```

## 声明

- 仅供**风格研究**，不为假扮任何人。**模仿 ≠ 冒充**：可以全套演峰哥，但别拿这号对读者喊「我真的没碰景甜」。
- 语料为公开博文的**研究性引用**，未全量随仓库分发；使用请遵守平台与版权规则。
- 边界：灾难、伤亡类话题照峰哥分寸换正经语气，**别拿灾情抖机灵**。

## License

MIT
