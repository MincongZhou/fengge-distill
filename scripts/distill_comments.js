"use strict";
// 为已拉取的峰哥 559 条博文逐条补"高赞热评(≥30)"，并聚合。
const fs = require("fs");
const cookies = JSON.parse(fs.readFileSync("C:/Users/ASUS/.dsh/skills/weibo-publish/data/weibo-cookies.json", "utf8"));
function cookieHeader(c) {
  const p = [`SUB=${c.SUB}`, `SUBP=${c.SUBP}`, `WBPSESS=${c.WBPSESS}`, `ALF=${c.ALF}`];
  if (c.SCF) p.push(`SCF=${c.SCF}`);
  p.push(`XSRF-TOKEN=${c.XSRFTOKEN}`);
  return p.join("; ");
}
const UAM = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const hM = () => ({ "User-Agent": UAM, Cookie: cookieHeader(cookies), Referer: "https://m.weibo.cn/" });
function strip(t) {
  return (t || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[\u200b\u200c\ufeff\s]+/g, " ").trim();
}
function like(cm) { return cm.like_count || cm.like_counts || 0; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function hot(mid) {
  const u = `https://m.weibo.cn/api/comments/hotflow?id=${mid}&mid=${mid}&max_id=0&max_id_type=0`;
  const r = await fetch(u, { headers: hM() });
  const t = await r.text();
  const d = JSON.parse(t);
  const arr = Array.isArray(d.data) ? d.data : (d.data && d.data.list) || [];
  return arr.filter((c) => like(c) >= 30).sort((a, b) => like(b) - like(a));
}
(async () => {
  const posts = JSON.parse(fs.readFileSync("C:/Users/ASUS/Documents/dsh Project/dsh-chact/fg_fengge_500_raw.json", "utf8"));
  const out = [];
  let withHot = 0, totalHot = 0, consecutiveFail = 0;
  const commentExamples = [];
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    try {
      const hs = await hot(p.id);
      if (hs.length) {
        withHot++; totalHot += hs.length;
        p.hotComments = hs.slice(0, 10).map((c) => ({ u: c.user ? c.user.screen_name : "?", like: like(c), t: strip(c.text) }));
        commentExamples.push({ id: p.id, post: p.text.slice(0, 50), hot: p.hotComments.slice(0, 3) });
      }
      out.push(p);
      consecutiveFail = 0;
    } catch (e) {
      consecutiveFail++;
      if (consecutiveFail >= 12) { console.log("⚠️ 连续失败太多，在第", i, "条暂停"); break; }
    }
    if ((i + 1) % 50 === 0) console.log("进度", i + 1, "/", posts.length, "| 有≥30热评", withHot, "| 累计热评", totalHot);
    await sleep(250);
  }
  fs.writeFileSync("C:/Users/ASUS/Documents/dsh Project/dsh-chact/fg_fengge_500_hotcomments.json", JSON.stringify(out, null, 1), "utf8");
  fs.writeFileSync("C:/Users/ASUS/Documents/dsh Project/dsh-chact/fg_fengge_500_comments.md", "# 峰哥高赞热评（每条 ≥30 赞）\n\n" + commentExamples.map((c) => "## " + c.id + "  " + c.post + "\n" + c.hot.map((h) => "- +" + h.like + " [" + h.u + "] " + h.t).join("\n")).join("\n\n---\n\n"), "utf8");
  console.log("完成：总", posts.length, "条 | 有≥30热评", withHot, "条 | 累计", totalHot, "条高赞热评");
  console.log("已写 fg_fengge_500_hotcomments.json / fg_fengge_500_comments.md");
})();
