<div align="center">

# FengGe Distillation Engine

**峰哥 · 语言蒸馏引擎**

Distill **559 posts** by the Chinese blogger 「峰哥亡命天涯」 into a reusable **FengGe-style** language engine.

<img alt="vibe" src="https://img.shields.io/badge/project-distill-brown">
<img alt="n" src="https://img.shields.io/badge/corpus-559posts-ff69b4">
<img alt="hot" src="https://img.shields.io/badge/hot_comments-2440-9cf">
<img alt="iron" src="https://img.shields.io/badge/iron_rule-imitate_not_judge-black">
<img alt="CI" src="https://github.com/MincongZhou/fengge-distill/actions/workflows/ci.yml/badge.svg">
<img alt="license" src="https://img.shields.io/badge/license-MIT-blue">

</div>

---

## It's distillation, not copying

From **559 public posts + 2,440 high-like comments (≥30 likes)**, this project distills the **worldview** underneath a signature Chinese internet style, so you can generate "FengGe-flavored" text yourself. You **imitate** the style, you don't **judge** it.

**Iron rule:** write in FengGe's worldview faithfully — no moralizing of your own.

## Three laws of FengGe style

1. **Milking heat is the business.** Make every hot topic a stage, turn it into traffic / money / red pockets; the platform banning is the platform's business. Even fabricating an identity counts as milking — if it hits the trending list, the milk worked.
2. **Self-praise you know is seen through.** The signature move is "commenting on others = praising myself"; knowing the audience sees through it, keep doubling down anyway.
3. **Feigned weariness.** Sadness/tiredness is the hook; self-praise is the landing — "I'm down, but still better than you."

## Corpus stats (n = 559 · 105 days)

| Metric | Value |
|---|---|
| Length | median **41** · mean **54** · **0 posts >160 chars** · ≤30 chars = 41% |
| Cadence | ~5 posts/day |
| Topics | A-share/tech(94) > sports(24) > life(23) > lottery(17) > robots/AI(13) > gold(9) |
| Hot comments | **546/559** posts have ≥30-like comments, **2,440** total; 126 are 1000+ |

> Top hot comments are rarely "attacking him" — they're **"play along + expose + one-up"**.
> (report → "+6146 nuclear strike"; self-pity → "+4035 keep acting"; flex → "+4615 ad slot for rent"; investing gold quote → "+3688 translation: I won't sell").

## Distillation pipeline

```
scripts/
  distill.js             # fetch posts + stats (needs Weibo login cookie via $env:WEIBO_COOKIE)
  distill_comments.js    # fetch ≥30-like hot comments (needs cookie)
  frontmatter.js         # tag move/topics/hot → frontmatter.md + jsonl
  query.js               # offline filter (NO login) over data/sample.jsonl
  quote.js               # "today's FengGe flavor" (NO login), used by CI + daily refresh
data/
  sample.jsonl           # tagged sample
  stats.md               # stats
```

```bash
node scripts/query.js --move 自问自答 --limit 5       # filter by style-move
node scripts/quote.js                                 # today's FengGe flavor
```

The offline path (query / quote / CI / daily) reads only the committed `data/sample.jsonl` — **no Weibo login needed**. Only the two `distill*` scripts hit Weibo live and require a login cookie (set locally, never committed).

## Structure

```
fengge-distill/
├── README.md · README.en.md
├── style-engine.md          ← the distilled style rules
├── corpus.md                ← corpus reference
├── scripts/                 ← distillation pipeline
├── data/                    ← sample + stats
├── .github/workflows/       ← CI + daily quote
└── LICENSE (MIT)
```

## Disclaimer

- For **style research** only — not for pretending to be the person. **Imitating ≠ impersonating.**
- The corpus cites public posts for study and is not shipped in full; follow platform & copyright rules.
- Treat disasters/casualties with the figure's own seriousness; don't joke about tragedy.

## License

MIT
