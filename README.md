<div align="center">

# 峰哥 · 语言蒸馏引擎

**FengGe Distillation Engine**

把「抽象教父」@峰哥亡命天涯 的 **1,921 条微博（跨 18 个月）**，蒸馏成一口能自己生成「峰哥味」的引擎。

<img alt="vibe" src="https://img.shields.io/badge/项目-蒸馏-brown">
<img alt="n" src="https://img.shields.io/badge/语料-1921条-ff69b4">
<img alt="hot" src="https://img.shields.io/badge/高赞热评-4163条-9cf">
<img alt="iron" src="https://img.shields.io/badge/铁律-模仿不质疑-black">
<img alt="CI" src="https://github.com/MincongZhou/fengge-distill/actions/workflows/ci.yml/badge.svg">
<img alt="stars" src="https://img.shields.io/github/stars/MincongZhou/fengge-distill">
<img alt="forks" src="https://img.shields.io/github/forks/MincongZhou/fengge-distill">
<img alt="last-commit" src="https://img.shields.io/github/last-commit/MincongZhou/fengge-distill">
<img alt="license" src="https://img.shields.io/badge/license-MIT-blue">

</div>

---

## 这不是复读，是蒸馏

像生物学科一样，把 **1,921 条公开博文（2025-02 ~ 2026-08）+ 4,163 条 ≥30 赞高赞热评**，蒸馏成一整套可直接用的**峰哥语体规矩**。输出不是照搬他的句子，而是把它的「世界观内核」提出来——你是**模仿**他，不是**质疑**他。

**纵向也蒸馏了**：他 2025-11-14 被**全平台封禁**、2026-05-21 解封，这个数据断档把语料天然劈成两期——**两期文风差异大到需要「先选版本」再动笔**，见 [`evolution.md`](evolution.md)。

**铁律：** 写峰哥味，只忠实模仿它的世界观，不下自我道德判断。

## 峰哥体三定律

1. **蹭是大事。** 有热度就多蹭，把热点翻译成流量 / 钱 / 红包；禁言是平台的事，蹭是峰哥的事。**编身份也是蹭，蹭上热搜就是蹭成。**
2. **被看穿的自夸。** 招牌是「评别人 ＝ 夸自己」；明知会被嘲，还是硬把牛吹下去。
3. **装颓。** 丧是引子，落点是自夸——「我惨但我还是比你强，我累但我还在挣」。

## 统计口径

**主口径**：n = **1,921** 条公开博文 · 2025-02-04 ~ 2026-08-30（**572 天** · 日均 3.4 条）

| 指标 | 值 |
|---|---|
| 长度 | **中位 47 字** · 平均 61 字 · >160 字仅 3 条 |
| 构成 | 纯原创短句为主 · 转发型 90 条(4.7%) · 长文型 258 条(13.4%) |
| 高赞热评 | **785/1,921** 条有 ≥30 赞热评，共 **4,163** 条；1000+ 赞 257 条 |

**分期口径**（封禁把数据劈成两段，这不是人为划线）

| 指标 | 封禁前 2025-02~11（1,360 条） | 解封后 2026-05~08（561 条） |
|---|---|---|
| 中位字数 | 50 | **40** |
| 带图率 | 66.3% | **43.9%** |
| 开头「我…」 | 6.9% | **11.1%** |
| 开头「峰哥…」 | 7.9% | 4.5% |
| 免责声明率 | 0.1% | 1.6% |
| 中位点赞 | 2207 | **3367** |

> 话题迁移（半导体 +2.7pt / AI +1.9pt / A股 +1.8pt；直播 −2.0pt）、口头禅兴衰（「为什么」翻倍、免责句成标配）、热评生态（评论区从「吵架现场」变「股友会」）、18 条热点时间轴——见 [`evolution.md`](evolution.md)。

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

### 今日峰哥味（demo）

```bash
node scripts/quote.js
```

> 今日峰哥味 · 2026-09-01
> 收工了，一个人吃碗面，32，没约女粉，跟家人们报备。今天没蹭到大的，但我不慌，日子是填出来的，流量是攒出来的。个人观点，不构成熬夜建议。
> — move: 报备体 | topics: 生活 | hot=false

## 目录结构

```
fengge-distill/
├── README.md
├── style-engine.md              ← 峰哥语体引擎规则（产出的「蒸馏」核心）
├── corpus.md                    ← 语料参考（签名动作/接招对照/高赞实锤/装颓/案例）
├── evolution.md                 ← 话术演进（封禁前后两期 · 热评生态 · 热点时间轴）
├── scripts/                     ← 蒸馏管道（CommonJS）
├── data/                        ← 统计口径 + 抽样
└── package.json                 ← DSH Bundle 清单（插件入口）
    cordis.patch.yml             ← Bundle Patch（只新增插件自有条目）
    dsh.plugin.json              ← 插件元数据（声明贡献的技能）
    lib/index.js                 ← 技能 provider（ESM，注册进 ctx.skills）
    skills/fengge-wangming-tianya/
        SKILL.md                 ← 打包进插件的技能本体
        references/corpus.md     ← 技能相对引用（详例）
        references/evolution.md  ← 技能相对引用（分期演进）
        evals/evals.json         ← 行为验收用例
    test/provider.test.mjs       ← 打包契约与 provider 边界测试
    scripts/verify-provider.mjs  ← 打包契约自检
```

## 作为 DSH 插件安装（Bundle）

仓库根同时是一个标准 **DSH Bundle**：装上之后，`fengge-wangming-tianya` 这个技能会出现在 DSH 的技能列表里，无需手动往 `~/.dsh/skills/` 里拷文件。

**它做什么**：把仓库里蒸馏好的峰哥语体规则，通过插件的技能 provider 注册进宿主技能注册表（host-plane），于是每个 agent preset 的作用域链都能拿到这个技能。技能正文按需加载，`list()` 阶段只读元数据、不读正文。

**安装（推荐先用一次性 Profile 验证，别直接写真实 Profile）**：

```bash
export DSH_HOME="$(mktemp -d)"          # Windows: $env:DSH_HOME = "$env:TEMP\dsh-test"
dsh plugin --profile fengge-test add /absolute/path/to/fengge-distill
dsh --profile fengge-test --dump-config  # 预期看到唯一新条目 dsh-fengge-distill
```

真实 Profile 安装时不要手动改 Profile 清单，交给官方 CLI：

```bash
dsh plugin --profile <profile> add <package-or-git-spec>
dsh plugin --profile <profile> remove <package>
```

**外部依赖**：无。插件不联网、不起子进程、不写任何 Profile 或用户目录，也不声明任何运行期依赖。`scripts/distill*.js` 那两条**需要登录态**的抓取脚本属于仓库自带的离线蒸馏管道，**不在插件运行路径上**——插件只读包内 `skills/` 下的 Markdown。

**权限**：只读。唯一的文件访问是读取本包内的 `skills/<name>/SKILL.md`（路径由 `import.meta.url` 推导，属于本包装配事实，不读用户配置）；无网络、无 Shell、无凭据。

**已知风险**：
- 技能产出的是**风格模仿文本**。风格本体是「蹭流量 + 表演式吹牛」，请自行判断使用场景；仓库边界见下方「声明」。
- 技能里的 `evals/evals.json` 是行为验收用例，不是安全审计；它只描述「写成什么样算对味」。
- 打包进插件的 `skills/fengge-wangming-tianya/` 与仓库根 `style-engine.md` / `corpus.md` / `evolution.md` 是同一份内容的两种形态（技能形态 / 源档）。改了一处请同步另一处。

**验证状态（分清层级，别把低层证据当高层验收）**：

| 层级 | 状态 |
|---|---|
| 打包契约（清单字段、Patch 唯一性、无生命周期脚本、无符号链接） | **已验证**：`npm run verify` |
| provider 行为（发现技能、按需加载正文、对畸形/缺失输入 fail closed） | **已验证**：`npm test` |
| 上游契约静态审计（官方 `build-dsh-plugin` 的 `audit-plugin.mjs`） | **已验证**：见下一节 |
| 一次性 Profile 的安装 / 启动 / 卸载 / 回滚 | **未验证**：需要真实 DSH 运行时与隔离 Profile 的实测记录 |
| DSH STORE 收录状态 | **未验证**：由商城固定 Commit 自动复检决定 |

**下一道门**：在一次性 Profile 里跑完安装 → 配置合成 → 冷启动 → 技能可见 → 卸载，把每一步的证据记下来；静态审计通过**不等于**真实 Profile 已安装或已完成运行时验收。

## 上游契约静态审计

```bash
npm test                           # 打包契约 + provider 边界（本包自带）
npm run verify                     # 打包契约自检（本包自带）
# 上游只读审计（需另取 build-dsh-plugin 仓库）
node <build-dsh-plugin>/build-dsh-plugin/scripts/audit-plugin.mjs .
```

读法：**Hard blockers 必须为空**。分数里的 `Runtime evidence` 在没有一次性 Profile 证据前恒为 0——那是「证据还没给」，不是「跑不通」，不要靠填分把它糊过去。

静态审计基线（固定来源）：

- Commit：`566367a06bb05ef4121499ece3f84ad8e30ed4c9`
- 结果：零硬阻断，`status=isolated-acceptance-ready`，static `77/80`（Tests 12/12、Documentation 8/8；未取满的 3 分是「一次性 Profile 的运行时证据尚未提供」）
- 说明：该 Commit 只是**静态契约**的审计基线，不代表已完成运行验收；后续提交会使基线前移，需重新审计。

上架契约逐条自查（对应 DSH STORE 固定 Commit 门禁）：

- [x] 公开 GitHub 仓库，目标包可固定到 40 位 Commit
- [x] `package.json` 声明 `dsh.bundle.patch`，且 Patch 文件位于包内
- [x] Bundle Patch 只新增；entry ID 唯一且为插件自有（`dsh-fengge-distill`）
- [x] manifest / LICENSE / 生命周期脚本 / Node 与 DSH 兼容声明相互一致
- [x] 无生命周期脚本（`preinstall`/`install`/`postinstall`/`prepare`）、无运行期依赖
- [x] 不使用 `@deepseek-ai/*` 命名空间，不禁用、替换或冒充官方组件
- [x] README 说明用途、安装启用方式、外部依赖、权限与已知风险
- [ ] 一次性 Profile 的安装 / 启动 / 卸载证据（**下一道门**）

## 声明

- 仅供**风格研究**，不为假扮任何人。**模仿 ≠ 冒充**：可以全套演峰哥，但别拿这号对读者喊「我真的没碰景甜」。
- 语料为公开博文的**研究性引用**，未全量随仓库分发；使用请遵守平台与版权规则。
- 边界：灾难、伤亡类话题照峰哥分寸换正经语气，**别拿灾情抖机灵**。

## License

MIT
