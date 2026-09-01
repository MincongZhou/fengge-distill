"use strict";
// [需登录态] 蒸馏峰哥微博：抓分页博文 → 统计 → 写 data/（相对路径）。
// 用法：$env:WEIBO_COOKIE="C:\...\weibo-cookies.json"; node scripts/distill.js
const fs = require("fs");
const path = require("path");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const COOKIE_PATH = process.env.WEIBO_COOKIE;
if (!COOKIE_PATH) { console.error("❌ 需要设置 $env:WEIBO_COOKIE 指向微博 cookie JSON 文件（本机登录态，勿提交仓库）。"); process.exit(1); }
const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, "utf8"));
const DATA = path.join(__dirname, "..", "data");
function cookieHeader(c) {
  const p = [`SUB=${c.SUB}`, `SUBP=${c.SUBP}`, `WBPSESS=${c.WBPSESS}`, `ALF=${c.ALF}`];
  if (c.SCF) p.push(`SCF=${c.SCF}`);
  p.push(`XSRF-TOKEN=${c.XSRFTOKEN}`);
  return p.join("; ");
}
function H() { return { "User-Agent": UA, Cookie: cookieHeader(cookies), Origin: "https://weibo.com", Referer: "https://weibo.com/", "X-XSRF-TOKEN": cookies.XSRFTOKEN }; }
function strip(t) { return (t || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[\u200b\u200c\ufeff\s]+/g, " ").trim(); }
async function getJSON(u) { const r = await fetch(u, { headers: H() }); const t = await r.text(); let o = null; try { o = JSON.parse(t); } catch { o = null; } if (!o) throw new Error("non-json http " + r.status); return o; }

(async () => {
  const all = [], seen = new Set();
  for (let p = 1; p <= 40; p++) {
    const d = await getJSON(`https://weibo.com/ajax/statuses/mymblog?uid=2397417584&page=${p}&feature=0`);
    const list = (d.data && d.data.list) || [];
    let added = 0;
    for (const m of list) { if (seen.has(m.idstr)) continue; seen.add(m.idstr); all.push({ created_at: m.created_at, id: m.idstr, text: strip(m.text), reposts: m.reposts_count || 0, comments: m.comments_count || 0, attitudes: m.attitudes_count || 0 }); added++; }
    if (!list.length || String(d.data.since_id || "") === "") break;
  }
  const n = all.length, lens = all.map((x) => x.text.length).sort((a, b) => a - b);
  const mid = lens[Math.floor(n / 2)], mean = Math.round(lens.reduce((a, b) => a + b, 0) / n);
  const buckets = { "<=30": 0, "31-60": 0, "61-100": 0, "101-160": 0, ">160": 0 };
  lens.forEach((L) => { if (L <= 30) buckets["<=30"]++; else if (L <= 60) buckets["31-60"]++; else if (L <= 100) buckets["61-100"]++; else if (L <= 160) buckets["101-160"]++; else buckets[">160"]++; });
  const days = new Set(all.map((x) => x.created_at.slice(4, 10)));
  fs.writeFileSync(path.join(DATA, "posts.json"), JSON.stringify(all, null, 1), "utf8");
  fs.writeFileSync(path.join(DATA, "stats.md"), "# 峰哥语料统计\n\n- 条数 " + n + "\n- 中位 " + mid + " / 平均 " + mean + "\n- 分布 ≤30:" + buckets["<=30"] + " 31-60:" + buckets["31-60"] + " 61-100:" + buckets["61-100"] + " 101-160:" + buckets["101-160"] + " >160:" + buckets[">160"] + "\n- 覆盖 " + days.size + " 天，日均 " + Math.round(n / days.size) + " 条\n", "utf8");
  console.log("✅ 抓到 " + n + " 条 | 中位 " + mid + " 平均 " + mean + " | 已写 data/posts.json + data/stats.md");
})();
