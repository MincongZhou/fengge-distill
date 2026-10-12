/**
 * pricing.mjs — 成本计算（bench/ 侧）。价格表在 bench/pricing.json，**全仓库唯一一份**。
 *
 * 为什么单独抽出来：成本数字一旦有两份实现，就会出现"bench 报 0.9 分、service 报 1.4 分"
 * 这种没人查得动的分歧。现在只有两份**实现**（这份 JS，与 service/app.py 的 Python），
 * 但只有一份**输入**（pricing.json）——分歧会立刻暴露成数字不一致，而不是各自悄悄算错。
 *
 * peak/off-peak 只按 UTC 星期与小时判定，**不查中国法定节假日**（要联网查日历，与"本地可复现"冲突）。
 * 跨节假日的成本会**高估**，方向保守；这一点在 pricing.json 与报告里都写明。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PRICING_FILE = path.join(HERE, 'pricing.json');

/** 官方价目表的键名就是 rates.<tier>.<field>PerMillion；这里做一层薄映射，不在代码里另起一套命名。 */
const FIELD = { hit: 'inputCacheHitPerMillion', miss: 'inputCacheMissPerMillion', out: 'outputPerMillion' };

export function loadPricing(file = PRICING_FILE) {
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  // 缺字段必须报错，不许拿默认价兜底——默默算错钱比启动失败坏得多
  for (const tier of ['peak', 'off_peak']) {
    for (const f of Object.values(FIELD)) {
      if (typeof p?.rates?.[tier]?.[f] !== 'number') {
        throw new Error(`价格表缺 rates.${tier}.${f}（文件：${file}）`);
      }
    }
  }
  if (!Array.isArray(p?.model?.peakWindowsUtc)) throw new Error(`价格表缺 model.peakWindowsUtc（文件：${file}）`);
  return p;
}

const hhmm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };

/** 某个 UTC 时刻是否处于 peak 时段（官方口径：周一至周五 UTC 01:00–04:00 与 06:00–10:00） */
export function isPeak(date, pricing) {
  const d = date instanceof Date ? date : new Date(date);
  const day = d.getUTCDay();                        // 0=周日
  if (day === 0 || day === 6) return false;         // 周末全天 off-peak
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return pricing.model.peakWindowsUtc.some((w) => minutes >= hhmm(w.from) && minutes < hhmm(w.to));
}

const tierKey = (peak) => (peak ? 'peak' : 'off_peak');

/**
 * 算一次调用的成本。
 * @param {object} usage DeepSeek 返回的 usage（prompt_tokens / prompt_cache_hit_tokens / completion_tokens）
 * @param {string|Date} at 调用时刻（UTC）
 */
export function costOfCall(usage, at, { pricing = loadPricing() } = {}) {
  const tier = tierKey(isPeak(at, pricing));
  const r = pricing.rates[tier];
  const promptTok = usage.prompt_tokens ?? 0;
  const cacheTok = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const missTok = Math.max(0, promptTok - cacheTok);
  const outTok = usage.completion_tokens ?? 0;        // 已含 reasoning_tokens，不重复计
  const usd =
    (missTok / 1e6) * r[FIELD.miss] +
    (cacheTok / 1e6) * r[FIELD.hit] +
    (outTok / 1e6) * r[FIELD.out];
  return { usd: +usd.toFixed(8), tier, missTok, cacheTok, outTok };
}

/** 汇总一组 {usage, at} 记录 */
export function costOfRun(records, opts = {}) {
  const pricing = opts.pricing ?? loadPricing();
  let usd = 0, missTok = 0, cacheTok = 0, outTok = 0;
  const tiers = { peak: 0, off_peak: 0 };
  for (const rec of records) {
    const c = costOfCall(rec.usage ?? {}, rec.at ?? new Date(), { pricing });
    usd += c.usd; missTok += c.missTok; cacheTok += c.cacheTok; outTok += c.outTok;
    tiers[c.tier]++;
  }
  return {
    calls: records.length,
    usd: +usd.toFixed(6),
    tokens: { cacheMiss: missTok, cacheHit: cacheTok, output: outTok, total: missTok + cacheTok + outTok },
    tiers,
    cacheHitRate: missTok + cacheTok ? +(cacheTok / (missTok + cacheTok)).toFixed(4) : 0,
  };
}
