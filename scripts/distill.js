"use strict";
// 蒸馏峰哥微博：拉取分页博文 → 统计口径 → 落盘
const fs = require("fs");
const path = require("path");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const cookies = JSON.parse(fs.readFileSync("C:/Users/ASUS/.dsh/skills/weibo-publish/data/weibo-cookies.json", "utf8"));
function cookieHeader(c) {
  const p = [`SUB=${c.SUB}`, `SUBP=${c.SUBP}`, `WBPSESS=${c.WBPSESS}`, `ALF=${c.ALF}`];
  if (c.SCF) p.push(`SCF=${c.SCF}`);
  p.push(`XSRF-TOKEN=${c.XSRFTOKEN}`);
  return p.join("; ");
}
function H() {
  return { "User-Agent": UA, Cookie: cookieHeader(cookies), Origin: "https://weibo.com", Referer: "https://weibo.com/", "X-XSRF-TOKEN": cookies.XSRFTOKEN };
}
function strip(t) {
  return (t || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[\u200b\u200c\ufeff\s]+/g, " ").trim();
}
async function getJSON(u) {
  const r = await fetch(u, { headers: H() });
  const t = await r.text();
  let o = null; try { o = JSON.parse(t); } catch { o = null; }
  if (!o) throw new Error("non-json http " + r.status);
  return o;
}
(async () => {
  const all = [];
  const seen = new Set();
  for (let p = 1; p <= 40; p++) {
    const u = `https://weibo.com/ajax/statuses/mymblog?uid=2397417584&page=${p}&feature=0`;
    const d = await getJSON(u);
    const list = (d && d.data && d.data.list) || [];
    let added = 0;
    for (const m of list) {
      if (seen.has(m.idstr)) continue;
      seen.add(m.idstr);
      all.push({
        created_at: m.created_at,
        id: m.idstr,
        text: strip(m.text),
        reposts: m.reposts_count || 0,
        comments: m.comments_count || 0,
        attitudes: m.attitudes_count || 0,
      });
      added++;
    }
    if (!list.length || String(d.data.since_id || "") === "") break;
  }

  // ---- stats ----
  const n = all.length;
  const lens = all.map((x) => x.text.length).sort((a, b) => a - b);
  const sum = lens.reduce((a, b) => a + b, 0);
  const mid = lens[Math.floor(n / 2)];
  const mean = Math.round(sum / n);
  const buckets = { "<=30": 0, "31-60": 0, "61-100": 0, "101-160": 0, ">160": 0 };
  lens.forEach((L) => {
    if (L <= 30) buckets["<=30"]++;
    else if (L <= 60) buckets["31-60"]++;
    else if (L <= 100) buckets["61-100"]++;
    else if (L <= 160) buckets["101-160"]++;
    else buckets[">160"]++;
  });

  const bracketEmoji = /\[[^\[\]]{1,8}\]/g;
  const graphicEmoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;
  let brackets = 0, graphics = 0, bracketTotal = 0;
  for (const x of all) {
    const b = x.text.match(bracketEmoji) || [];
    bracketTotal += b.length; if (b.length) brackets++;
    const g = x.text.match(graphicEmoji) || [];
    graphics += g.length;
  }

  const openers = {};
  const openerCount = (name) => (openers[name] = (openers[name] || 0) + 1);
  for (const x of all) {
    const t = x.text;
    if (/^我/.test(t)) openerCount("我…");
    else if (/^今天|^昨天/.test(t)) openerCount("今天/昨天…");
    else if (/^峰哥/.test(t)) openerCount("峰哥…");
    else if (/^这/.test(t)) openerCount("这…");
    else if (/^妈呀/.test(t)) openerCount("妈呀");
    else if (/^恭喜|^感谢|^祝福/.test(t)) openerCount("恭喜/感谢/祝福");
    else if (/^网友|^有人说|^大家|^经常/.test(t)) openerCount("网友/有人说…");
    else if (/^你/.test(t)) openerCount("你…");
    else if (/^本人/.test(t)) openerCount("本人…");
    else if (/^实不相瞒/.test(t)) openerCount("实不相瞒");
    else if (/^#/.test(t)) openerCount("#话题标签");
    else openerCount("其他/无主短句");
  }

  const catchphrases = ["家人们", "太吓人了", "为什么", "你受得了吗", "救赎之道", "个人观点", "不构成"];
  const cf = {};
  for (const c of catchphrases) cf[c] = all.filter((x) => x.text.includes(c)).length;
  const topics = ["黄金", "孙宇晨", "景甜", "段永平", "机器人", "宇树", "UFC", "世界杯", "电影", "抽奖", "红包", "A股", "上证", "大盘", "半导体", "算力", "AI", "房价"];
  const tp = {};
  for (const t of topics) tp[t] = all.filter((x) => x.text.includes(t)).length;

  // 日期密度
  const days = new Set(all.map((x) => x.created_at.slice(4, 10)));
  const range = all.length ? all[0].created_at + " .. " + all[all.length - 1].created_at : "";

  const stat = { n, mid, mean, buckets, bracketEmojiCount: bracketTotal, bracketEmojiPosts: brackets, graphicEmoji: graphics, openers, catchphrases: cf, topics: tp, distinctDays: days.size, avgPerDay: Math.round(n / days.size), range };
  const postTexts = all.map((x) => `# ${x.created_at} | id=${x.id} | 评${x.comments} 转${x.reposts} 赞${x.attitudes}\n\n${x.text}\n`).join("\n---\n");

  const rawPath = "C:/Users/ASUS/Documents/dsh Project/dsh-chact/fg_fengge_500_raw.json";
  const corpPath = "C:/Users/ASUS/Documents/dsh Project/dsh-chact/fg_fengge_500_corpus.md";
  const statPath = "C:/Users/ASUS/Documents/dsh Project/dsh-chact/fg_fengge_500_stats.md";
  fs.writeFileSync(rawPath, JSON.stringify(all, null, 1), "utf8");
  fs.writeFileSync(corpPath, "# 峰哥微博语料（本次蒸馏 " + n + " 条）\n\n" + postTexts, "utf8");
  let md = "# 峰哥微博蒸馏统计（" + n + " 条，样本 " + range + "）\n\n";
  md += "**长度**：中位 " + mid + " 字，平均 " + mean + " 字。分布：≤30 " + buckets["<=30"] + " / 31-60 " + buckets["31-60"] + " / 61-100 " + buckets["61-100"] + " / 101-160 " + buckets["101-160"] + " / >160 " + buckets[">160"] + "\n";
  md += "**密度**：覆盖 " + days.size + " 天，日均 " + Math.round(n / days.size) + " 条/天。\n\n**开头频率**：\n";
  for (const [k, v] of Object.entries(openers).sort((a, b) => b[1] - a[1])) md += "- " + k + "：" + v + "\n";
  md += "\n**表情**：方括号表情 " + bracketTotal + " 处（" + brackets + " 帖有个），图形 emoji " + graphics + " 处。\n\n**口头禅/词频**：\n";
  for (const [k, v] of Object.entries(cf).sort((a, b) => b[1] - a[1])) md += "- " + k + "：" + v + "\n";
  md += "\n**话题命中（含该词条数）**：\n";
  for (const [k, v] of Object.entries(tp).sort((a, b) => b[1] - a[1])) md += "- " + k + "：" + v + "\n";
  fs.writeFileSync(statPath, md, "utf8");

  console.log("总数", n, "| 中位", mid, "| 平均", mean);
  console.log("长度分布", JSON.stringify(buckets));
  console.log("密度 覆盖", days.size, "天 日均", Math.round(n / days.size));
  console.log("方括号表情", bracketTotal, "帖", brackets, "| 图形emoji", graphics);
  console.log("开头:", JSON.stringify(openers));
  console.log("口头禅:", JSON.stringify(cf));
  console.log("话题:", JSON.stringify(tp));
  console.log("已写:", rawPath, "/", statPath, "/", corpPath);
})();
