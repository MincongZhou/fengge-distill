// fengge-distill: 峰哥体语言蒸馏引擎的 DSH 技能提供者。
//
// 这是一个 Cordis 插件，把仓库内 `skills/` 下的技能包注册进宿主（HOST）层的
// `ctx.skills` 注册表，因此每个 agent preset 的作用域链都会合并这些技能。
//
// 技能正文位于 `skills/<name>/SKILL.md`（本包内），provider 从 `import.meta.url`
// 定位（属于本包的装配事实，永远不读用户配置），正文按需加载。
//
// provider 协议对齐 `@deepseek-ai/dsh-skill-filesystem`：
//   - list() 只发现候选（name/description 取自 YAML frontmatter，正文不读）
//   - get()  解析命中候选的 SKILL.md，返回带目录型 resourceBase 的完整定义，
//            使 SKILL.md 中的相对引用（如 references/corpus.md）可解析
//
// 边界：不修改 DSH 核心，不读写 `@deepseek-ai/*` 官方包，不写真实 Profile，
// 无安装期生命周期脚本，运行时不联网、不起子进程。
//
// @module dsh-fengge-distill
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const name = 'dsh-fengge-distill'
const inject = ['skills']

/** 打包型技能 provider 的注册表优先级：低于本地 bundled 根目录。 */
const PACKAGED_SKILL_RANK = 550

/** 这些技能对外声明的来源桶（prompt 可见元数据）。 */
const SOURCE = 'custom'

/**
 * 解析 SKILL.md 的 YAML frontmatter，拆出元数据与正文。
 * 覆盖 DSH 技能发现消费的标量字段（name/description/whenToUse），并支持
 * 折叠标量块（`description: >` 后接缩进行）——折行按 YAML 语义用单空格连接。
 * @param text - SKILL.md 原始内容
 * @returns 元数据对象与 frontmatter 之后的正文；无 frontmatter 时返回 null
 */
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  const block = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\n+/, '')
  const metadata = {}
  let currentKey = null
  let folded = false
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd()
    if (/^[ \t]/.test(line) && currentKey !== null) {
      // 折叠标量的缩进续行：折行按 YAML 语义用单空格连接，块标量用换行
      const value = line.trim()
      if (value) {
        const separator = folded ? ' ' : '\n'
        metadata[currentKey] = metadata[currentKey].length > 0
          ? `${metadata[currentKey]}${separator}${value}`
          : value
      }
      continue
    }
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!match) {
      currentKey = null
      folded = false
      continue
    }
    let value = match[2].trim()
    folded = value === '>' || value === '>-' || value === '>+'
    if (folded) {
      value = ''
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    metadata[match[1]] = value
    currentKey = folded ? match[1] : null
  }
  return { metadata, body }
}

/**
 * 读取并解析单个技能目录的 SKILL.md。
 * @param skillFile - SKILL.md 绝对路径
 * @param signal - 可选取消信号
 * @returns 解析后的技能记录；文件消失或无法解析时返回 undefined
 */
async function parseSkillFile(skillFile, signal) {
  let text
  try {
    text = await readFile(skillFile, 'utf8')
  } catch {
    return undefined
  }
  if (signal?.aborted) return undefined
  const parsed = parseFrontmatter(text)
  if (parsed === null) return undefined
  return {
    name: parsed.metadata.name ?? '',
    description: parsed.metadata.description ?? '',
    whenToUse: parsed.metadata.whenToUse,
    metadata: parsed.metadata,
    content: parsed.body
  }
}

/**
 * 上游 `disable-model-invocation: true` 表示仅人类可调用的技能，映射到 DSH
 * 的调用标志；其余保持模型与用户均可调用。
 * @param metadata - 解析出的 frontmatter 元数据
 * @returns DSH 调用记录
 */
function invocationFrom(metadata) {
  if (metadata['disable-model-invocation'] === 'true') {
    return { modelInvocable: false, userInvocable: true }
  }
  return { modelInvocable: true, userInvocable: true }
}

/**
 * 扫描本包的 `skills/` 目录发现打包技能候选：一个子目录一个技能，各带 SKILL.md。
 * @param skillsRoot - 本包 skills 目录绝对路径
 * @param signal - 可选取消信号
 * @returns 候选列表
 */
async function discoverCandidates(skillsRoot, signal) {
  let entries
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates = []
  for (const entry of entries) {
    if (signal?.aborted) break
    if (!entry.isDirectory()) continue
    const skillDir = join(skillsRoot, entry.name)
    const skillFile = join(skillDir, 'SKILL.md')
    const parsed = await parseSkillFile(skillFile, signal)
    if (parsed === undefined) continue
    candidates.push({
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      invocation: invocationFrom(parsed.metadata),
      source: SOURCE,
      provider: name,
      rank: PACKAGED_SKILL_RANK,
      locator: skillDir,
      path: skillFile,
      ...(Object.keys(parsed.metadata).length > 0 ? { metadata: parsed.metadata } : {})
    })
  }
  return candidates
}

/** 在 `ctx.skills` 上注册打包技能 provider。 */
function apply(ctx) {
  const skillsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
  ctx.skills.registerProvider((control) => ({
    name,
    async list(options) {
      return discoverCandidates(skillsRoot, options.signal)
    },
    async get(candidate, options) {
      const parsed = await parseSkillFile(candidate.path, options.signal)
      if (parsed === undefined) return undefined
      return {
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
        invocation: invocationFrom(parsed.metadata),
        source: SOURCE,
        provider: name,
        resourceBase: { kind: 'directory', path: candidate.locator },
        path: candidate.path,
        ...(Object.keys(parsed.metadata).length > 0 ? { metadata: parsed.metadata } : {}),
        content: parsed.content
      }
    }
  }))
}

export { apply, name, inject, parseFrontmatter, discoverCandidates, parseSkillFile }
export default { apply, name, inject }
