"use strict";
// [需登录态] 为 data/posts.json 逐条补「≥30 赞高赞热评」，写 data/hotcomments.json + comments.md。
// 用法：$env:WEIBO_COOKIE="C:\...\weibo-cookies.json"; node scripts/distill_comments.js
const fs = require("fs");
const path = require("path");
const COOKIE_PATH = process.env.WEIBO_COOKIE;
if (!COOKIE_PATH) { console.error("❌ 需要设置 $env:WEIBO_COOKIE 指向微博 cookie JSON 文件（本机登录态，勿提交仓库）。"); process.exit(1); }
const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, "utf8"));
const DATA = path.join(__dirname, "..", "data");
function cookieHeader(c) { const p = [`SUB=${c.SUB}`, `SUBP=${c.SUBP}`, `WBPSESS=${c.WBPSESS}`, `ALF=${c.ALF}`]; if (c.SCF) p.push(`SCF=${c.SCF}`); p.push(`XSRF-TOKEN=${c.XSRFTOKEN}`); return p.join("; "); }
const UAM = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const hM = () => ({ "User-Agent": UAM, Cookie: cookieHeader(cookies), Referer: "https://m.weibo.cn/" });
function strip(t) { return (t || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[\u200b\u200c\ufeff\s]+/g, " ").trim(); }
const like = (cm) => cm.like_count || cm.like_counts || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function hot(mid) {
  const r = await fetch(`https://m.weibo.cn/api/comments/hotflow?id=${mid}&mid=${mid}&max_id=0&max_id_type=0`, { headers: hM() });
  const d = JSON.parse(await r.text());
  const arr = Array.isArray(d.data) ? d.data : (d.data && d.data.list) || [];
  return arr.filter((c) => like(c) >= 30).sort((a, b) => like(b) - like(a));
}
(async () => {
  const posts = JSON.parse(fs.readFileSync(path.join(DATA, "posts.json"), "utf8"));
  const out = []; let withHot = 0, totalHot = 0, fail = 0;
  for (const p of posts) {
    try {
      const hs = await hot(p.id);
      if (hs.length) { withHot++; totalHot += hs.length; p.hotComments = hs.slice(0, 10).map((c) => ({ u: c.user ? c.user.screen_name : "?", like: like(c), t: strip(c.text) })); }
      fail = 0;
    } catch (e) { if (++fail >= 12) { console.log("⚠️ 连续失败太多，暂停于第", posts.indexOf(p), "条"); break; } }
    out.push(p);
    await sleep(200);
  }
  fs.writeFileSync(path.join(DATA, "hotcomments.json"), JSON.stringify(out, null, 1), "utf8");
  fs.writeFileSync(path.join(DATA, "comments.md"), "# 峰哥高赞热评（≥30 赞，n=" + totalHot + "）\n\n" + out.filter((p) => p.hotComments).map((p) => "## " + p.id + "  " + p.text.slice(0, 40) + "\n" + p.hotComments.slice(0, 3).map((h) => "- +" + h.like + " [" + h.u + "] " + h.t).join("\n")).join("\n\n---\n\n"), "utf8");
  console.log("✅ 完成：有 ≥30 热评 " + withHot + " 条 / 累计 " + totalHot + " 条 | 已写 data/hotcomments.json + data/comments.md");
})();
