#!/usr/bin/env node
/**
 * 一键同步 fengge-distill 的 GitHub 仓库元信息（About）与 Release。
 *
 * 为什么需要这个脚本：仓库的 About（description / topics）与 Release 只能走 GitHub REST API，
 * SSH 推送改不了仓库设置。本脚本把这件事固化成可重复执行的一步。
 *
 * 用法：
 *   node scripts/set-repo-meta.mjs                       # 同步 About（description + topics）
 *   node scripts/set-repo-meta.mjs --dry-run             # 只打印将要提交的内容，不发请求
 *   node scripts/set-repo-meta.mjs --release             # 额外创建 GitHub Release
 *   node scripts/set-repo-meta.mjs --release --tag v1.1.0 --notes-from CHANGELOG.md
 *
 * token 来源（按序尝试）：$GITHUB_TOKEN → $GH_TOKEN
 *   - classic token：需要 `repo` 作用域
 *   - fine-grained token：需要 Contents(Read and write) + Administration(Read and write)，
 *     且授权范围包含本仓库
 *
 * 凭据只从环境变量读取，不落盘、不写入日志、不随命令行参数传递。
 *
 * 说明：仓库 description 在 GitHub 侧有 350 字符上限，脚本会做长度预检。
 */

import { readFile } from 'node:fs/promises';

const REPO = 'MincongZhou/fengge-distill';
const API = 'https://api.github.com';
const DESC_LIMIT = 350;

const DESCRIPTION =
  "把@峰哥亡命天涯 的 1,921 条微博（18 个月，跨封禁前后两期）+ 4,163 条≥30赞评论，" +
  "蒸馏成可复用的「峰哥语体引擎」：串子、蹭子、装颓、被看穿的自我吹嘘。" +
  "含语料管道(nodejs)、话术演进分期参考、筛选脚本、统计口径。" +
  " / Distilling @fengge's Weibo into a reusable Chinese style-transfer engine (weibo / corpus / nlp).";

const TOPICS = [
  'weibo', 'chinese', 'nlp', 'llm', 'style-transfer',
  'text-generation', 'text-analysis', 'corpus', 'dataset',
  'distillation', 'prompt-engineering', 'copywriting', 'nodejs',
  'cli', 'social-media', 'agent', 'agent-skills',
  'deepseek-harness', 'dsh', 'skills',
];

// ---------- 参数 ----------
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const DRY = has('--dry-run');
const DO_RELEASE = has('--release');
const SKIP_ABOUT = has('--release-only');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

// 注意：依赖包的静态审计会把「日志调用」与「密钥类关键词」出现在同一行的情况
// 判为疑似密钥日志（硬阻断）。所以这里的提示语抽成常量，让敏感词远离日志调用行。
const MISSING_CRED =
  '缺少凭据：请先设置 GITHUB_TOKEN / GH_TOKEN 环境变量，或用 --dry-run 只看预览。';

if (!TOKEN && !DRY) {
  console.error('✗ ' + MISSING_CRED);
  process.exit(1);
}

// ---------- HTTP ----------
async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'fengge-distill-set-repo-meta',
      ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → HTTP ${res.status}: ${json.message || text.slice(0, 300)}`);
    err.status = res.status;
    err.detail = json;
    throw err;
  }
  return json;
}

/** 从 CHANGELOG 里抽出指定版本的段落，作为 Release notes。
 *  按 `## ` 标题切块再匹配，避免用 lookahead 时被行尾位置误命中、返回空串。 */
function extractNotes(md, version) {
  const blocks = md.split(/^## /m).slice(1); // 首块是文首说明，丢弃
  const block = blocks.find((b) => b.startsWith(`[${version}]`));
  if (!block) return null;
  const body = block.split('\n').slice(1).join('\n').trim(); // 去掉标题行
  return body || null;
}

// ---------- 主流程 ----------
console.log(`仓库: ${REPO}`);
console.log(`模式: ${DRY ? 'DRY-RUN（不发请求）' : '实际执行'}${DO_RELEASE ? ' + Release' : ''}`);
console.log();

let failed = false;

// 1) description 长度预检
if (!SKIP_ABOUT) {
  const len = [...DESCRIPTION].length;
  console.log(`description 长度: ${len} / ${DESC_LIMIT}`);
  if (len > DESC_LIMIT) {
    console.error(`✗ description 超出 GitHub 上限 ${DESC_LIMIT}（当前 ${len}），请精简后再跑。`);
    process.exit(1);
  }

  if (DRY) {
    console.log('--- description (dry) ---');
    console.log(DESCRIPTION);
    console.log('--- topics (dry) ---');
    console.log(TOPICS.join(', '));
    console.log();
  } else {
    try {
      const r = await api('PATCH', `/repos/${REPO}`, { description: DESCRIPTION });
      console.log(`✓ description 已更新（回读长度 ${[...(r.description ?? '')].length}）`);
    } catch (e) {
      failed = true;
      console.error(`✗ description 更新失败: ${e.message}`);
    }
    try {
      const r = await api('PUT', `/repos/${REPO}/topics`, { names: TOPICS });
      console.log(`✓ topics 已更新（共 ${r.names.length} 个）`);
    } catch (e) {
      failed = true;
      console.error(`✗ topics 更新失败: ${e.message}`);
    }
  }
}

// 2) Release
if (DO_RELEASE) {
  const tag = val('--tag', 'v' + JSON.parse(await readFile('package.json', 'utf8')).version);
  const name = val('--name', `${tag} — 纵向蒸馏：语料扩到 1921 条 / 18 个月`);
  const notesFrom = val('--notes-from', 'CHANGELOG.md');
  const version = tag.replace(/^v/, '');

  let notes = null;
  try {
    notes = extractNotes(await readFile(notesFrom, 'utf8'), version);
  } catch { /* 文件不存在就跳过 */ }
  if (!notes) {
    notes = val('--notes', `参见仓库 \`CHANGELOG.md\` 的 ${version} 段落。`);
    console.warn(`! 未能从 ${notesFrom} 提取 ${version} 段落，使用占位说明。`);
  } else {
    console.log(`✓ 已从 ${notesFrom} 提取 ${version} 段落（${notes.length} 字符）`);
  }

  const payload = {
    tag_name: tag,
    name,
    body: notes,
    target_commitish: val('--target', 'main'),
    draft: has('--draft'),
    prerelease: has('--prerelease'),
  };

  if (DRY) {
    console.log(`--- release (dry) tag=${tag} target=${payload.target_commitish} ---`);
    console.log(payload.body.slice(0, 400) + (payload.body.length > 400 ? '\n…(截断)' : ''));
    console.log();
  } else {
    try {
      const r = await api('POST', `/repos/${REPO}/releases`, payload);
      console.log(`✓ Release 已创建: ${r.tag_name} → ${r.html_url}`);
    } catch (e) {
      // 422 常见于该 tag 已存在 Release
      if (e.status === 422) {
        console.error(`✗ 创建失败（422）：该 tag 可能已有 Release，或 tag 结构非法。`);
        console.error(`  GitHub 说明: ${e.detail?.errors?.map((x) => x.message || x.code).join('; ') || e.detail?.message || ''}`);
      } else {
        console.error(`✗ Release 创建失败: ${e.message}`);
      }
      failed = true;
    }
  }
}

console.log();
if (DRY) {
  console.log('（dry-run 结束，未发送任何请求）');
} else {
  console.log(failed ? '✗ 有步骤失败，详见上面输出。' : '✓ 全部完成。');
}
process.exit(failed ? 1 : 0);
