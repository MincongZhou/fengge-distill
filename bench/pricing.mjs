/**
 * pricing.mjs — 唯一的价格来源与成本计算（bench/ 与 service/ 都用它）。
 *
 * 为什么单独抽出来：成本数字一旦有两份实现，就会出现"bench 报 0.9 分、service 报 1.4 分"
 * 这种没人查得动的分歧。价格表在 bench/pricing.json，算法只在这里。
 *
 * peak/off-peak 只按 UTC 星期与小时判定，**不查中国法定节假日**（要联网查日历，与"本地可复现"冲突）。
 * 跨节假日的成本会**高估**，这一点在 pricing.json 和报告里都写明。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PRICING_FILE = path.join(HERE, 'pricing.json');

export function loadPricing(file = PRICING_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 某个 UTC 时刻是否处于 peak 时段 */
export function isPeak(date, pricing) {
  const w = pricing.peakWindows;
  const d = date instanceof Date ? date : new Date(date);
  const day = d.getUTCDay();                     // 0=周日
  if (!w.weekdays.includes(day)) return false;
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  return w.hours.some(([from, to]) => h >= from && h < to);
}

/**
 * 算一次调用的成本。
 * @param {object} usage   DeepSeek 返回的 usage（含 prompt_tokens / prompt_cache_hit_tokens / completion_tokens）
 * @param {string|Date} at 调用时刻（UTC）
 * @returns {{usd:number, tier:'peak'|'off-peak', missTok:number, cacheTok:number, outTok:number}}
 */
export function costOfCall(usage, at, { pricing = loadPricing(), model = 'deepseek-flash' } = {}) {
  const m = pricing.models[model];
  if (!m) throw new Error(`价格表里没有模型 ${model}`);
  const tier = isPeak(at, pricing) ? 'peak' : 'off-peak';
  const promptTok = usage.prompt_tokens ?? 0;
  const cacheTok = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const missTok = Math.max(0, promptTok - cacheTok);
  const outTok = usage.completion_tokens ?? 0;
  const usd =
    (missTok / 1e6) * m.inputCacheMiss[tier === 'peak' ? 'peak' : 'offPeak'] +
    (cacheTok / 1e6) * m.inputCacheHit[tier === 'peak' ? 'peak' : 'offPeak'] +
    (outTok / 1e6) * m.output[tier === 'peak' ? 'peak' : 'offPeak'];
  return { usd: +usd.toFixed(8), tier, missTok, cacheTok, outTok };
}

/** 汇总一组 {usage, at} 记录 */
export function costOfRun(records, opts = {}) {
  let usd = 0, missTok = 0, cacheTok = 0, outTok = 0;
  const tiers = { peak: 0, 'off-peak': 0 };
  for (const r of records) {
    const c = costOfCall(r.usage ?? {}, r.at ?? new Date(), opts);
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
