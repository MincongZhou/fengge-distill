# Contributing

Thanks for wanting to help improve **fengge-distill**! This is a zero-dependency Node project (Node 18+ for global `fetch`).

## Quick start

```bash
git clone git@github.com:MincongZhou/fengge-distill.git
cd fengge-distill

# Offline path (no Weibo login needed)
node scripts/query.js --move 自问自答 --limit 5
node scripts/quote.js
```

## Pipelines

- **Offline (cookie-free)** — `scripts/query.js`, `scripts/quote.js`. They read only the committed `data/sample.jsonl`. Use these for filtering, demos, and CI.
- **Live (needs Weibo login)** — `scripts/distill.js`, `scripts/distill_comments.js`. They fetch from Weibo and require a login cookie:

  ```powershell
  $env:WEIBO_COOKIE="C:\path\to\weibo-cookies.json"
  node scripts/distill.js
  node scripts/distill_comments.js
  ```

  **Never commit your cookie.** It goes in a local env var (or a GitHub Secret if you want auto-refresh).

## Adding to the corpus

1. Run `scripts/distill.js` (with `WEIBO_COOKIE`) → writes `data/posts.json` + `data/stats.md`.
2. Run `scripts/distill_comments.js` → writes `data/hotcomments.json` + `data/comments.md`.
3. Tag/label a sample into `data/sample.jsonl` (a few lines is enough for the offline path).

## Style / style-engine.md

`style-engine.md` + `corpus.md` are the distilled source of truth. If you update them, keep:
- short, punchy examples with real numbers;
- the "imitate, don't judge" rule (no moralizing about FengGe);
- the boundaries: no impersonation; treat disasters seriously.

## PRs

Open a PR with a clear description. Please run the offline scripts before submitting so CI (which runs `query.js` + `quote.js`) passes.

## License

Contributions are under [MIT](LICENSE).
