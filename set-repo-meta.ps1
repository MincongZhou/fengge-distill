param([string]$Token = $env:GITHUB_TOKEN)
# 给 fengge-distill 设置 topics（用 PUT /topics 端点）+ description（PATCH），统一 UTF-8。
# 用法：$env:GITHUB_TOKEN="ghp_xxx"; pwsh -File .\set-repo-meta.ps1
$repo = "MincongZhou/fengge-distill"
$description = "把@峰哥亡命天涯 的 559 条微博 + 2440 条≥30赞评论，蒸馏成可复用的「峰哥语体引擎」：串子、蹭子、装颓、被看穿的自我吹嘘。含语料管道(nodejs)、筛选脚本、统计口径。/ Distilling @fengge's Weibo into a reusable Chinese style-transfer engine (weibo / corpus / nlp)."
$topics = @(
  "weibo", "chinese", "nlp", "llm", "style-transfer",
  "text-generation", "text-analysis", "corpus", "dataset",
  "distillation", "prompt-engineering", "copywriting", "nodejs",
  "cli", "social-media"
)
if (-not $Token) { Write-Error "需要 token：先设置 `$env:GITHUB_TOKEN（GitHub → Settings → Developer settings → Personal access token，勾 repo 作用域）"; exit 1 }
$h = @{ Authorization = "Bearer $Token"; "Accept" = "application/vnd.github+json"; "User-Agent" = "fengge-distill" }
$utf8 = { param($o) [System.Text.Encoding]::UTF8.GetBytes(($o | ConvertTo-Json -Compress)) }
try {
  # 1) topics —— 专用端点
  Invoke-RestMethod -Method PUT -Uri "https://api.github.com/repos/$repo/topics" -Headers $h -Body (& $utf8 @{ names = $topics }) -ContentType "application/json; charset=utf-8" | Out-Null
  # 2) description —— PATCH
  Invoke-RestMethod -Method PATCH -Uri "https://api.github.com/repos/$repo" -Headers $h -Body (& $utf8 @{ description = $description }) -ContentType "application/json; charset=utf-8" | Out-Null
  $r = Invoke-RestMethod -Method GET -Uri "https://api.github.com/repos/$repo" -Headers $h
  Write-Output "OK topics = $($r.topics -join ', ')"
  Write-Output "OK desc  = $($r.description)"
} catch {
  Write-Output "ERR $($_.Exception.Message)"
  if ($_.ErrorDetails) { Write-Output $_.ErrorDetails.Message }
}
