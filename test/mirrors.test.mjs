// 根目录镜像守卫。
//
// 这个仓库在根目录放了 6 份 .md，它们不是新文档，而是 skill 内文件的**逐字节镜像**
// （方便在 GitHub 仓库首页直接读）。但仓库里从来没有东西守卫这件事——
// 2026-10-31 就出过一回：改了 `skills/.../references/qa-mode.md` 的统计口径，根目录那份没跟着改，
// 于是同一句话在仓库里有两个版本，而**没有任何测试会红**。
//
// 这类漂移的危害不在于"文档不好看"，而在于：读者点开根目录那份读到的是旧结论，
// 而判据（lint / evals）用的是新结论——两边打架，且无人知晓。
//
// 所以这里只做一件事：**逐字节相等**。镜像要改，就得两份一起改。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const SKILL = path.join(REPO, 'skills', 'fengge-wangming-tianya')

/** 根目录镜像 → skill 内源文件 */
export const MIRRORS = [
  ['style-engine.md', 'SKILL.md'],
  ['qa-mode.md', 'references/qa-mode.md'],
  ['live-qa.md', 'references/live-qa.md'],
  ['evolution.md', 'references/evolution.md'],
  ['corpus.md', 'references/corpus.md'],
  ['bilibili.md', 'references/bilibili.md'],
]

const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

for (const [mirror, source] of MIRRORS) {
  test(`镜像同步：${mirror} 与 ${source} 逐字节一致`, () => {
    const a = path.join(REPO, mirror)
    const b = path.join(SKILL, source)
    assert.ok(existsSync(a), `根目录镜像缺失：${mirror}`)
    assert.ok(existsSync(b), `源文件缺失：${source}`)
    assert.equal(read(a), read(b), `${mirror} 与 ${source} 不一致——镜像要改就得两份一起改（这是刻意的重复，不是冗余）`)
  })
}

test('根目录的 .md 要么是登记过的镜像，要么在允许清单里（防止偷偷多出一份副本）', () => {
  // 真实风险：有人往根目录丢一份"方便阅读"的 .md，跟 skill 内那份慢慢分叉，没人发现。
  // 所以根目录只允许这两类：①登记过的镜像 ②README / CHANGELOG 这类本来就该在根目录的。
  const MIRROR_FILES = new Set(MIRRORS.map(([m]) => m))
  // 本来就该在根目录的：项目文档 + 社区文件 + 每日语录（自动提交）。
  const ROOT_ALLOWED = new Set([
    'README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE',
    'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'daily.md',
  ])
  const extra = readdirSync(REPO)
    .filter((f) => f.endsWith('.md') && !MIRROR_FILES.has(f) && !ROOT_ALLOWED.has(f))
  assert.deepEqual(extra, [], `根目录出现了未登记的 .md：${extra.join(', ')}——若是镜像请加进 MIRRORS，否则请放进 docs/`)
})
