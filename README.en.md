<div align="center">

# FengGe Distillation Engine

**峰哥 · 语言蒸馏引擎**

Distill **1,921 posts spanning 18 months** by the Chinese blogger 「峰哥亡命天涯」 into a reusable **FengGe-style** language engine.

<img alt="vibe" src="https://img.shields.io/badge/project-distill-brown">
<img alt="n" src="https://img.shields.io/badge/corpus-1921posts-ff69b4">
<img alt="hot" src="https://img.shields.io/badge/hot_comments-4163-9cf">
<img alt="iron" src="https://img.shields.io/badge/iron_rule-imitate_not_judge-black">
<img alt="CI" src="https://github.com/MincongZhou/fengge-distill/actions/workflows/ci.yml/badge.svg">
<img alt="license" src="https://img.shields.io/badge/license-MIT-blue">

</div>

---

## It's distillation, not copying

From **1,921 public posts (2025-02 ~ 2026-08) + 4,163 high-like comments (≥30 likes)**, this project distills the **worldview** underneath a signature Chinese internet style, so you can generate "FengGe-flavored" text yourself. You **imitate** the style, you don't **judge** it.

**The timeline is distilled too:** he was **banned platform-wide on 2025-11-14** and unbanned on 2026-05-21. That gap splits the corpus into two eras whose voices differ enough that you should **pick an era before writing** — see [`evolution.md`](evolution.md).

**Iron rule:** write in FengGe's worldview faithfully — no moralizing of your own.

## Three laws of FengGe style

1. **Milking heat is the business.** Make every hot topic a stage, turn it into traffic / money / red pockets; the platform banning is the platform's business. Even fabricating an identity counts as milking — if it hits the trending list, the milk worked.
2. **Self-praise you know is seen through.** The signature move is "commenting on others = praising myself"; knowing the audience sees through it, keep doubling down anyway.
3. **Feigned weariness.** Sadness/tiredness is the hook; self-praise is the landing — "I'm down, but still better than you."

## Corpus stats

**Overall**: n = **1,921** public posts · 2025-02-04 ~ 2026-08-30 (**572 days** · ~3.4 posts/day)

| Metric | Value |
|---|---|
| Length | median **47** chars · mean **61** · only 3 posts >160 chars |
| Mix | mostly short originals · 90 reposts (4.7%) · 258 long-form (13.4%) |
| Hot comments | **785/1,921** posts have ≥30-like comments, **4,163** total; 257 are 1000+ |

**Split by era** (the ban splits the data; this is not a hand-drawn line)

| Metric | Pre-ban 2025-02~11 (1,360) | Post-unban 2026-05~08 (561) |
|---|---|---|
| Median length | 50 | **40** |
| Posts with image | 66.3% | **43.9%** |
| Opens with "我…" (I…) | 6.9% | **11.1%** |
| Opens with "峰哥…" (third person) | 7.9% | 4.5% |
| Disclaimer rate | 0.1% | 1.6% |
| Median likes | 2207 | **3367** |

> Topic migration, catchphrase rise/fall, the comment-section shift (from "arena" to "shareholders' club"), and an 18-event timeline: see [`evolution.md`](evolution.md).

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
├── evolution.md             ← voice evolution (pre/post-ban, comment ecology, event timeline)
├── scripts/                 ← distillation pipeline (CommonJS)
├── data/                    ← sample + stats
├── .github/workflows/       ← CI + daily quote
└── LICENSE (MIT)

DSH Bundle (plugin entry):
├── package.json                 ← manifest, declares dsh.bundle.patch
├── cordis.patch.yml             ← additive-only bundle patch
├── dsh.plugin.json              ← plugin metadata (contributed skills)
├── lib/index.js                 ← skill provider, registers into ctx.skills
├── skills/fengge-wangming-tianya/
│   ├── SKILL.md                 ← the packaged skill
│   ├── references/corpus.md     ← skill-relative reference (examples)
│   ├── references/evolution.md  ← skill-relative reference (era evolution)
│   └── evals/evals.json         ← behavioural acceptance cases
├── test/provider.test.mjs       ← packaging contract + provider boundary tests
└── scripts/verify-provider.mjs  ← packaging contract self-check
```

## Install as a DSH plugin (Bundle)

The repository root is also a standard **DSH Bundle**: once installed, the `fengge-wangming-tianya` skill appears in DSH's skill list, with no manual copying into `~/.dsh/skills/`. The skill body is loaded on demand; `list()` only reads metadata.

```bash
export DSH_HOME="$(mktemp -d)"             # Windows: $env:DSH_HOME = "$env:TEMP\dsh-test"
dsh plugin --profile fengge-test add /absolute/path/to/fengge-distill
dsh --profile fengge-test --dump-config    # expect a single new row: dsh-fengge-distill
```

Never hand-edit a real Profile — let the official CLI manage it:

```bash
dsh plugin --profile <profile> add <package-or-git-spec>
dsh plugin --profile <profile> remove <package>
```

- **External dependencies:** none. The plugin does not reach the network, spawn subprocesses, or write any Profile or user directory. The two `distill*.js` scripts that need a login are the offline corpus pipeline and are **not** on the plugin's runtime path — the plugin only reads the markdown under its own `skills/`.
- **Permissions:** read-only. The only file access is reading this package's `skills/<name>/SKILL.md`, resolved from `import.meta.url` (a packaging fact, never user config). No network, no shell, no credentials.
- **Known risks:** the skill produces style-imitation text whose underlying register is "farm the trend, perform the flex". Judge your own use case; boundaries are in the Disclaimer. `evals/evals.json` describes "what reads right" — it is not a security audit. Note that `skills/fengge-wangming-tianya/` and the root `style-engine.md` / `corpus.md` / `evolution.md` carry the same content in two forms; keep them in sync.
- **Verification status:** packaging contract (`npm run verify`) and provider behaviour (`npm test`) are **verified**. A disposable-Profile install / start / uninstall and the DSH STORE listing are **unverified** — that is the next gate. The upstream static audit (`build-dsh-plugin`'s `audit-plugin.mjs`) passes with zero hard blockers, but static audit passing does **not** mean a real Profile is installed or runtime-accepted.

## Disclaimer

- For **style research** only — not for pretending to be the person. **Imitating ≠ impersonating.**
- The corpus cites public posts for study and is not shipped in full; follow platform & copyright rules.
- Treat disasters/casualties with the figure's own seriousness; don't joke about tragedy.

## License

MIT
