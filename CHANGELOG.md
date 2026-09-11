# Changelog

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)，变更按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格记录。

## [1.1.0] - 2026-09-11

> **版本线说明**：本版本是当前 `main` 历史线（root `ad07f40`）的**首个正式发布**。
> 更早的 `v1.0.0` tag 挂在一条已被重建掉的旧历史线上（root `38d105f`，与 `main` **无共同祖先**，
> 无对应 Release）。因此 `1.0.0 → 1.1.0` 只延续版本号，**不对应可比较的代码增量**。

**主题：纵向蒸馏 —— 语料从 559 条扩到 1921 条，时间跨度从 3.5 个月拉到 18 个月。**

### 新增

- **`evolution.md`**（仓库根 + `skills/fengge-wangming-tianya/references/` 两种形态，各 234 行）：峰哥话术演进的分期参考
  - 两期画像对比：封禁前 1360 条（2025-02 ~ 2025-11）vs 解封后 561 条（2026-05 ~ 2026-08）
  - 篇幅 / 开头句式 / 话题重心 / 口头禅 / 签名动作的量化迁移
  - 高赞热评生态变化（字数、点赞、高频词）
  - 18 条热点事件时间轴对回
  - 两版特征卡（2025 版 / 2026 版）
- `SKILL.md` 顶部「先选版本」指引：按目标时期选择 2025 版或 2026 版特征，并指向 `references/evolution.md`
- `scripts/set-repo-meta.mjs`：一键同步仓库 About（description + topics），可选创建 GitHub Release
- `CHANGELOG.md`：本文件

### 变更

| 项 | 旧 | 新 |
|---|---|---|
| 博文语料 | 559 条 / 105 天 | **1921 条 / 572 天**（2025-02-04 ~ 2026-08-30，日均 3.4 条） |
| 高赞热评 | 2440 条 | **4163 条**（≥30 赞） |
| 全期中位字数 | 41 | **47** |
| 包版本 | 0.1.0 | **1.1.0**（与 tag 体系对齐） |

- `README.md` / `README.en.md`：统计口径、分期对照表、目录树、两种形态同步说明全部更新
- `package.json` / `dsh.plugin.json`：描述口径更新，`files` 增 `evolution.md`
- 两份 `corpus.md`（根源档 + 技能形态）保持字节同步

### 数据发现

- **语料断档解开**：抓取在第 27 页出现断层（2026-05-22 直接跳回 2025-11-14）。回源搜证确认是
  **2025-11-14 全平台封禁、2026-05-21 解封**——这半年真空不是漏抓，是确实没发。
  该断档天然把语料劈成两期，成为分析真正的分界线。
- **一条主动放弃的归因**：曾怀疑「性别 / 社会争议话题」是封禁主因，量化后发现相关词占比仅
  0–2%（`女生` 0.3%→0.2%、`男人` 1.8%→0.5%），基数撑不住结论，**未写入报告**。

### 校验

- `node --test` → **6/6 通过**
- `node scripts/verify-provider.mjs` → **28 项 OK**
- 官方 `audit-plugin.mjs` → `static 80/80`、`isolated-acceptance-ready`、零硬阻断
- DSH 真实加载器（`dsh-skill-filesystem` 的 `FileSystemSkillProvider`）实测：
  可发现（`source=user-dsh` / `rank=400`）、可载正文（description 240 字 / content 6007 字）、
  `references/evolution.md` 相对引用可达、provider 警告 **0 条**

## [1.0.0] - 2026-09-01

> ⚠️ **孤儿 tag**：`v1.0.0` 指向旧历史线（root `38d105f`），与当前 `main`（root `ad07f40`）
> 无共同祖先，也没有对应的 Release。此条目仅作版本号延续保留，代码内容不可与 1.1.0 比较。

初始形态：自包含语料管道 + CI + 每日峰哥味。

- 峰哥体风格引擎（`style-engine.md` / `corpus.md`）
- 语料管道（`scripts/distill.js`、`distill_comments.js`、`query.js`、`quote.js`、`frontmatter.js`）
  + 统计口径（`data/stats.md`、`data/sample.jsonl`）
- GitHub Actions：`ci.yml`（离线契约校验）、`daily.yml`（每日 08:30 生成 `daily.md`）
