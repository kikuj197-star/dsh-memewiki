#!/usr/bin/env node
/**
 * 梗百科 · 本地管理页
 *
 * 一个不依赖任何第三方包的小服务，直接读写插件自己的 data/memes.db，提供：
 *   - 词条的增删改查（含别名、标签、用法、出处、摘要）
 *   - 「补别名」工作台：AI 收集来的词条大多只有标题，这里能给它们补别名/俗称，提高命中率
 *   - 从 cnmeme.wiki 一键同步新词条
 *   - 站点改动的人工审核合并（sync-cnmeme.mjs --stage 负责抓，这里负责挑字段）
 *
 * 用法：
 *   node scripts/wiki-server.mjs                 # 默认 http://127.0.0.1:3917
 *   node scripts/wiki-server.mjs --port 4000
 *   node scripts/wiki-server.mjs --db D:\...\memes.db
 *   node scripts/wiki-server.mjs --no-open       # 不自动开浏览器
 *
 * 只监听回环地址，不对外网开放；接口只认同源请求（挡 DNS rebinding）。
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const 插件根 = dirname(dirname(fileURLToPath(import.meta.url)))
const 页面文件 = join(插件根, 'scripts', 'wiki-ui.html')
const 脚本文件 = join(插件根, 'scripts', 'wiki-ui.js')
const 同步脚本 = join(插件根, 'scripts', 'sync-cnmeme.mjs')

// ---- 参数 ---------------------------------------------------------------

const 参数 = process.argv.slice(2)
function 取参数(名, 默认值) {
  const i = 参数.indexOf('--' + 名)
  if (i === -1) return 默认值
  const v = 参数[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}

const 端口 = Number(取参数('port', process.env.MEMEWIKI_PORT || 3917))
const 主机 = '127.0.0.1'
const 词库文件 = resolve(String(取参数('db', process.env.MEMEWIKI_DB || join(插件根, 'data', 'memes.db'))))
const 自动开 = !参数.includes('--no-open') && process.env.MEMEWIKI_NO_OPEN !== '1'

const 版本 = (() => {
  try { return String(JSON.parse(readFileSync(join(插件根, 'package.json'), 'utf8')).version || '0.0.0') } catch { return '0.0.0' }
})()

if (!existsSync(词库文件)) {
  console.error('没找到词库：' + 词库文件)
  console.error('用 --db 指定 memes.db 的路径。')
  process.exit(1)
}

// ---- 词库连接 -----------------------------------------------------------

let 连接 = null

function 开库() {
  if (连接) return 连接
  连接 = new DatabaseSync(词库文件)
  连接.exec('PRAGMA busy_timeout = 10000')
  连接.exec(`
    CREATE TABLE IF NOT EXISTS meme_pending (
      title TEXT PRIMARY KEY,
      slug TEXT, tags TEXT, usage TEXT, origin TEXT, other TEXT, summary TEXT,
      aliases TEXT, keywords TEXT,
      site_updated_at TEXT,
      detected_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS meme_site_state (
      title TEXT PRIMARY KEY,
      slug TEXT,
      site_updated_at TEXT,
      checked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS meme_keywords (
      title TEXT PRIMARY KEY,
      keywords TEXT,
      fetched_at TEXT
    );
  `)
  return 连接
}

const 读元信息 = (键) => {
  try { return String(开库().prepare('SELECT value FROM meta WHERE key = ?').get(键)?.value || '') } catch { return '' }
}

function 现在文本() {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

// ---- 工具 ---------------------------------------------------------------

const 空 = (v) => v === null || v === undefined || String(v).trim() === ''

/** 别名/标签这类"多个值"统一成逗号分隔：去空、去重、保留原来的顺序 */
function 规整列表(原文) {
  const 值 = String(原文 ?? '')
    .split(/[,，、;；\n\r]+/)
    .map((x) => x.trim())
    .filter(Boolean)
  const 见过 = new Set()
  const 结果 = []
  for (const v of 值) {
    const 键 = v.toLowerCase()
    if (见过.has(键)) continue
    见过.add(键)
    结果.push(v)
  }
  return 结果.join(',')
}

const 拆分列表 = (原文) => 规整列表(原文).split(',').filter(Boolean)

function 发JSON(res, 状态, 数据) {
  const 文 = Buffer.from(JSON.stringify(数据), 'utf8')
  res.writeHead(状态, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(文.length),
    'cache-control': 'no-store',
  })
  res.end(文)
}

function 发文件(res, 路径, 类型) {
  let 内容
  try { 内容 = readFileSync(路径) } catch {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('读不到文件：' + 路径)
    return
  }
  res.writeHead(200, {
    'content-type': 类型,
    'content-length': String(内容.length),
    'cache-control': 'no-store',
  })
  res.end(内容)
}

function 读请求体(req) {
  return new Promise((resolve) => {
    const 块 = []
    let 大小 = 0
    req.on('data', (c) => {
      大小 += c.length
      if (大小 > 8 * 1024 * 1024) { req.destroy(); resolve({}) ; return }
      块.push(c)
    })
    req.on('end', () => {
      try {
        const 原文 = Buffer.concat(块).toString('utf8')
        resolve(原文 ? JSON.parse(原文) : {})
      } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/** 只认本站来源：挡掉别的网页偷偷 POST 过来（DNS rebinding / CSRF） */
function 来源合法(req, 服务器端口) {
  const 源 = req.headers.origin
  if (!源) return true // 同源导航/curl 不发送 Origin
  try {
    const u = new URL(源)
    const 端口文 = u.port || (u.protocol === 'https:' ? '443' : '80')
    return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && 端口文 === String(服务器端口)
  } catch { return false }
}

function 主机合法(req, 服务器端口) {
  const 头 = String(req.headers.host || '')
  const 允许 = [`127.0.0.1:${服务器端口}`, `localhost:${服务器端口}`, `[::1]:${服务器端口}`]
  return 允许.includes(头.toLowerCase())
}

// ---- 词条 CRUD -----------------------------------------------------------

const 词条字段 = ['slug', 'tags', 'usage', 'origin', 'other', 'summary', 'aliases']

/**
 * 摘要留空时的兜底：照梗维基卡片的样子拼——先「来源」，再「用法」，再其他小节，
 * 带 `## 小节` 标记，超长按句子/换行截断加「…」。纯本地规则，不调模型。
 */
function 自动摘要(体) {
  const 段 = []
  const 来源 = 洗净(体.origin)
  const 用法 = 洗净(体.usage)
  if (来源) 段.push({ 标题: '来源', 内容: 来源 })
  if (用法) 段.push({ 标题: '用法', 内容: 用法 })

  // other：同步脚本存的是「小节名\n内容」块（空行分隔）；老词条可能只有一段正文，没有小节名
  for (const 块 of String(体.other || '').split(/\n{2,}/)) {
    const 行们 = 块.split('\n').map((x) => x.trim()).filter(Boolean)
    if (!行们.length) continue
    const 首行像标题 = 行们.length > 1 && 行们[0].length <= 12 && !/[。！？；]/.test(行们[0])
    const 标题 = 首行像标题 ? 行们[0] : ''
    const 内容 = 洗净((首行像标题 ? 行们.slice(1) : 行们).join('\n'))
    if (!内容) continue
    段.push({ 标题, 内容 })
  }
  if (!段.length) return ''

  const 拼 = 段
    .map((s) => (s.标题 ? '## ' + s.标题 + '\n\n' + s.内容 : s.内容))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return 截断摘要(拼, 200)
}

/** 超长就按句号/换行断，找不到断点就硬截；结尾统一加「…」 */
function 截断摘要(文本, 上限) {
  if (文本.length <= 上限) return 文本
  const 区段 = 文本.slice(0, 上限)
  const 断点 = Math.max(
    区段.lastIndexOf('。'), 区段.lastIndexOf('！'), 区段.lastIndexOf('？'), 区段.lastIndexOf('\n'),
  )
  if (断点 >= 120) return 文本.slice(0, 断点 + 1).trimEnd() + '…'
  return 文本.slice(0, 上限).trimEnd() + '…'
}

/** 关键词跟着词条走：传了就以传的为准（空则删掉），没传就保留；改标题时一起搬 */
function 应用关键词(标题, 原标题, 体) {
  const db = 开库()
  const 给定 = 体.keywords !== undefined
  const 值 = 给定 ? 规整列表(体.keywords) : ''
  const 改名 = !!(原标题 && 原标题 !== 标题)
  try {
    if (给定) {
      if (改名) db.prepare('DELETE FROM meme_keywords WHERE title = ?').run(原标题)
      if (值) {
        db.prepare('INSERT OR REPLACE INTO meme_keywords (title, keywords, fetched_at) VALUES (?, ?, ?)')
          .run(标题, 值, 现在文本())
      } else {
        db.prepare('DELETE FROM meme_keywords WHERE title = ?').run(标题)
      }
      return
    }
    // 没传关键词：改标题就把原行搬过来，没改就什么都不做
    if (改名) {
      const 有 = db.prepare('SELECT title FROM meme_keywords WHERE title = ?').get(原标题)
      if (有) db.prepare('UPDATE meme_keywords SET title = ? WHERE title = ?').run(标题, 原标题)
    }
  } catch { /* 老库没有这张表 */ }
}

function 保存词条(体) {
  const db = 开库()
  const 标题 = String(体.title ?? '').trim()
  if (!标题) return { 状态: 400, 数据: { ok: false, error: '标题不能空' } }
  if (标题.length > 80) return { 状态: 400, 数据: { ok: false, error: '标题太长了（≤80 字）' } }

  const 原标题 = String(体.原标题 ?? 体.oldTitle ?? '').trim()
  const 改名 = 原标题 !== '' && 原标题 !== 标题
  const 旧行 = db.prepare('SELECT * FROM memes WHERE title = ?').get(改名 ? 原标题 : 标题)
  if (改名 && !旧行) return { 状态: 404, 数据: { ok: false, error: '原词条不存在，改不了标题' } }
  if (改名 && db.prepare('SELECT title FROM memes WHERE title = ?').get(标题)) {
    return { 状态: 409, 数据: { ok: false, error: `已经有「${标题}」这个词条了，换个名字` } }
  }
  // 允许只有标题的词条：AI 收集来的词条很多先只有标题，别名可以以后再补
  const 取 = (k) => (体[k] !== undefined ? String(体[k] ?? '') : String((旧行 && 旧行[k]) || ''))
  const 别名字段 = 体.aliases !== undefined ? 规整列表(体.aliases) : String((旧行 && 旧行.aliases) || '')

  // 摘要留空就自动生成（页面上的「自动生成」按钮是同一个规则，能先预览）
  let 摘要值 = 体.summary !== undefined ? String(体.summary ?? '').trim() : String((旧行 && 旧行.summary) || '')
  let 自动摘要过 = false
  if (!摘要值) {
    const 生成 = 自动摘要({ usage: 取('usage'), origin: 取('origin'), other: 取('other') })
    if (生成) {
      摘要值 = 生成
      自动摘要过 = true
    }
  }
  let slug
  if (体.slug !== undefined && String(体.slug).trim()) slug = String(体.slug).trim()
  else {
    const 旧slug = 旧行 && 旧行.slug ? String(旧行.slug) : ''
    // 没传 / 传空：老词条沿用原来的 slug；新词条就用标题（跟同步脚本一致）
    slug = 旧slug === '' || 旧slug === 原标题 ? 标题 : 旧slug
  }

  if (改名) {
    db.prepare(
      'UPDATE memes SET title = ?, slug = ?, tags = ?, usage = ?, origin = ?, other = ?, summary = ?, aliases = ? WHERE title = ?',
    ).run(标题, slug, 取('tags'), 取('usage'), 取('origin'), 取('other'), 摘要值, 别名字段, 原标题)
    // 待审核区里的标题跟着走；站点版本基线也一起迁
    try {
      db.prepare('UPDATE meme_pending SET title = ? WHERE title = ?').run(标题, 原标题)
      db.prepare('UPDATE meme_site_state SET title = ? WHERE title = ?').run(标题, 原标题)
    } catch { /* 老库没有这两张表 */ }
    应用关键词(标题, 原标题, 体)
    return { 状态: 200, 数据: { ok: true, title: 标题, 原标题, summary: 摘要值, 自动摘要: 自动摘要过 } }
  }

  db.prepare(
    'INSERT OR REPLACE INTO memes (title, slug, tags, usage, origin, other, summary, aliases) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(标题, slug, 取('tags'), 取('usage'), 取('origin'), 取('other'), 摘要值, 别名字段)
  应用关键词(标题, '', 体)
  return { 状态: 200, 数据: { ok: true, title: 标题, summary: 摘要值, 自动摘要: 自动摘要过 } }
}

function 删除词条(标题原文) {
  const db = 开库()
  const 标题 = String(标题原文 || '').trim()
  if (!标题) return { 状态: 400, 数据: { ok: false, error: '缺标题' } }
  const 存在 = db.prepare('SELECT title FROM memes WHERE title = ?').get(标题)
  if (!存在) return { 状态: 404, 数据: { ok: false, error: '没有这个词条' } }
  db.prepare('DELETE FROM memes WHERE title = ?').run(标题)
  try { db.prepare('DELETE FROM meme_pending WHERE title = ?').run(标题) } catch { /* ignore */ }
  try { db.prepare('DELETE FROM meme_keywords WHERE title = ?').run(标题) } catch { /* ignore */ }
  return { 状态: 200, 数据: { ok: true } }
}

/** 只补别名，不动别的字段（补别名工作台用） */
function 补别名(体) {
  const db = 开库()
  const 标题 = String(体.title || '').trim()
  if (!标题) return { 状态: 400, 数据: { ok: false, error: '缺标题' } }
  const 旧行 = db.prepare('SELECT title, aliases FROM memes WHERE title = ?').get(标题)
  if (!旧行) return { 状态: 404, 数据: { ok: false, error: '没有这个词条' } }
  const 合并 = 体.mode === 'set' ? false : true
  const 新别名 = 体.aliases !== undefined ? String(体.aliases) : ''
  const 结果 = 合并
    ? 规整列表([String(旧行.aliases || ''), 新别名].filter(Boolean).join(','))
    : 规整列表(新别名)
  db.prepare('UPDATE memes SET aliases = ? WHERE title = ?').run(结果, 标题)
  return { 状态: 200, 数据: { ok: true, title: 标题, aliases: 结果, 数量: 拆分列表(结果).length } }
}

// ---- 词条列表 -----------------------------------------------------------

const 过滤条件 = {
  全部: '',
  无别名: "(m.aliases IS NULL OR TRIM(m.aliases) = '')",
  有别名: "(m.aliases IS NOT NULL AND TRIM(m.aliases) <> '')",
  多别名: "(m.aliases IS NOT NULL AND (LENGTH(m.aliases) - LENGTH(REPLACE(m.aliases, ',', ''))) >= 1)",
  有改动: "m.title IN (SELECT title FROM meme_pending WHERE status = 'pending')",
  有关键词: "(k.keywords IS NOT NULL AND TRIM(k.keywords) <> '')",
}

function 列表(参数表) {
  const db = 开库()
  const q = String(参数表.get('q') || '').trim()
  const 过滤 = String(参数表.get('filter') || '全部')
  const 排序 = String(参数表.get('sort') || 'title')
  const limit = Math.min(200, Math.max(1, Number(参数表.get('limit') || 40)))
  const offset = Math.max(0, Number(参数表.get('offset') || 0))

  const 条件们 = []
  const 值 = []
  const f = 过滤条件[过滤]
  if (f) 条件们.push(f)
  if (q) {
    条件们.push('(m.title LIKE ? OR m.aliases LIKE ? OR m.tags LIKE ? OR m.summary LIKE ? OR m.usage LIKE ? OR k.keywords LIKE ?)')
    for (let i = 0; i < 6; i++) 值.push(`%${q}%`)
  }
  const where = 条件们.length ? 'WHERE ' + 条件们.join(' AND ') : ''
  const 连表 = 'FROM memes m LEFT JOIN meme_keywords k ON k.title = m.title'
  const order = 排序 === 'alias'
    ? "ORDER BY (m.aliases IS NULL OR TRIM(m.aliases) = '') ASC, m.title"
    : 'ORDER BY m.title'

  const total = db.prepare(`SELECT COUNT(*) AS n ${连表} ${where}`).get(...值).n
  const 行们 = db.prepare(
    `SELECT m.title, m.slug, m.tags, m.summary, m.aliases, COALESCE(k.keywords, '') AS keywords
     ${连表} ${where} ${order} LIMIT ? OFFSET ?`,
  ).all(...值, limit, offset)

  const 待审 = new Set(db.prepare("SELECT title FROM meme_pending WHERE status = 'pending'").all().map((r) => r.title))
  const items = 行们.map((r) => ({
    title: r.title,
    slug: r.slug,
    tags: r.tags || '',
    summary: r.summary || '',
    aliases: r.aliases || '',
    关键词: 拆分列表(r.keywords),
    别名数: 拆分列表(r.aliases).length,
    待审核: 待审.has(r.title),
  }))
  return { ok: true, total, items, limit, offset }
}

// ---- 改动审核 -----------------------------------------------------------

const 对比字段 = [
  { 键: 'tags', 名: '标签' },
  { 键: 'usage', 名: '用法' },
  { 键: 'origin', 名: '出处' },
  { 键: 'other', 名: '其他' },
  { 键: 'summary', 名: '摘要' },
  { 键: 'aliases', 名: '别名' },
]

const 洗净 = (v) => String(v ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()
const 别名集 = (v) => new Set(拆分列表(v).map((x) => x.toLowerCase()))

function 待审列表(参数表) {
  const db = 开库()
  const status = String(参数表.get('status') || 'pending')
  const limit = Math.min(200, Math.max(1, Number(参数表.get('limit') || 30)))
  const offset = Math.max(0, Number(参数表.get('offset') || 0))
  const 计数 = db.prepare('SELECT status, COUNT(*) AS n FROM meme_pending GROUP BY status').all()
  const 统计 = { pending: 0, applied: 0, rejected: 0 }
  for (const r of 计数) 统计[r.status] = r.n

  const 行们 = db.prepare(
    'SELECT * FROM meme_pending WHERE status = ? ORDER BY detected_at DESC, title LIMIT ? OFFSET ?',
  ).all(status, limit, offset)

  const items = 行们.map((行) => {
    const 本地 = db.prepare('SELECT * FROM memes WHERE title = ?').get(行.title) || null
    const 变化 = []
    const 字段 = {}
    for (const f of 对比字段) {
      const 站 = 洗净(行[f.键])
      const 本地值 = 洗净(本地 && 本地[f.键])
      let 变
      if (f.键 === 'aliases') {
        const 站集 = 别名集(站)
        const 本地集 = 别名集(本地值)
        变 = 站集.size !== 本地集.size || [...站集].some((x) => !本地集.has(x))
      } else {
        变 = 站 !== 本地值
      }
      字段[f.键] = { 本地: 本地值, 站点: 站, 变了: 变 }
      if (变) 变化.push(f.键)
    }
    const 本地别名 = 拆分列表(本地 && 本地.aliases)
    const 站点别名 = 拆分列表(行.aliases)
    const 并集 = [...new Set([...本地别名, ...站点别名])]
    // 关键词优先用这次抓到的站点版本；没有就退回同步时存的那份
    let 关键词 = 拆分列表(行.keywords)
    if (!关键词.length) {
      try {
        const kw = db.prepare('SELECT keywords FROM meme_keywords WHERE title = ?').get(行.title)
        关键词 = 拆分列表(kw && kw.keywords)
      } catch { /* 老库没有关键词表 */ }
    }
    return {
      title: 行.title,
      slug: 行.slug,
      status: 行.status,
      site_updated_at: 行.site_updated_at,
      detected_at: 行.detected_at,
      keywords: 关键词,
      local: 本地 ? {
        tags: 本地.tags || '', usage: 本地.usage || '', origin: 本地.origin || '',
        other: 本地.other || '', summary: 本地.summary || '', aliases: 本地.aliases || '',
      } : null,
      字段,
      变化,
      别名并集: 并集,
    }
  })
  return { ok: true, 统计, status, items, limit, offset }
}

/** 记下"这条词条的站点版本已经处理过"：只前进不后退，ISO 时间字符串可以直接比大小 */
function 记站点版本(标题, slug, 版本时间) {
  const db = 开库()
  const 现有 = db.prepare('SELECT site_updated_at FROM meme_site_state WHERE title = ?').get(标题)
  const 旧 = String((现有 && 现有.site_updated_at) || '')
  const 新 = String(版本时间 || '')
  const 值 = 新 > 旧 ? 新 : 旧
  db.prepare(
    'INSERT OR REPLACE INTO meme_site_state (title, slug, site_updated_at, checked_at) VALUES (?, ?, ?, ?)',
  ).run(标题, slug || 标题, 值, 现在文本())
}

function 应用待审(体) {
  const db = 开库()
  const 条目 = Array.isArray(体.items) ? 体.items : []
  if (!条目.length) return { 状态: 400, 数据: { ok: false, error: '没选要合并的词条' } }

  let 合并数 = 0
  const 失败 = []
  db.exec('BEGIN')
  try {
    for (const 项 of 条目) {
      const 标题 = String(项.title || '').trim()
      if (!标题) continue
      const 行 = db.prepare("SELECT * FROM meme_pending WHERE title = ? AND status = 'pending'").get(标题)
      if (!行) { 失败.push(`${标题}：不在待审核区`); continue }
      const 本地 = db.prepare('SELECT * FROM memes WHERE title = ?').get(标题)

      const 取字 = (键, 选择) => {
        const 站 = 洗净(行[键])
        const 本地值 = 洗净(本地 && 本地[键])
        const v = String(选择 ?? '').trim()
        if (v === 'site' || v === '站点') return 站
        if (v === 'local' || v === '本地') return 本地值
        if (v === 'union' || v === '并集') {
          if (键 === 'aliases') return [...new Set([...拆分列表(本地值), ...拆分列表(站)])].join(',')
          return 本地值 || 站
        }
        if (v === '') return 本地值
        return v // 直接当内容用
      }

      const 选择 = 项.take || {}
      // 默认：本地有就用本地，本地空就用站点；别名取并集——不误删你手填的
      const 合并 = {}
      for (const f of 对比字段) {
        const 默认 = 本地 && !空(本地[f.键]) ? 'local' : 'site'
        合并[f.键] = f.键 === 'aliases' ? 取字('aliases', 选择.aliases ?? 'union') : 取字(f.键, 选择[f.键] ?? 默认)
      }

      if (本地) {
        db.prepare(
          'UPDATE memes SET tags = ?, usage = ?, origin = ?, other = ?, summary = ?, aliases = ?, slug = ? WHERE title = ?',
        ).run(合并.tags, 合并.usage, 合并.origin, 合并.other, 合并.summary, 合并.aliases, 行.slug || 本地.slug || 标题, 标题)
      } else {
        db.prepare(
          'INSERT OR REPLACE INTO memes (title, slug, tags, usage, origin, other, summary, aliases) VALUES (?,?,?,?,?,?,?,?)',
        ).run(标题, 行.slug || 标题, 合并.tags, 合并.usage, 合并.origin, 合并.other, 合并.summary, 合并.aliases)
      }
      db.prepare("UPDATE meme_pending SET status = 'applied' WHERE title = ?").run(标题)
      记站点版本(标题, 行.slug, 行.site_updated_at)
      合并数++
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    return { 状态: 500, 数据: { ok: false, error: '合并失败，已回滚：' + ((e && e.message) || e) } }
  }
  return { 状态: 200, 数据: { ok: true, merged: 合并数, failed: 失败 } }
}

function 忽略待审(体) {
  const db = 开库()
  const 全 = 体.all === true
  const 标题们 = Array.isArray(体.titles) ? 体.titles.map((x) => String(x || '').trim()).filter(Boolean) : []
  if (!全 && !标题们.length) return { 状态: 400, 数据: { ok: false, error: '没说忽略哪条' } }

  const 目标 = 全
    ? db.prepare("SELECT * FROM meme_pending WHERE status = 'pending'").all()
    : 标题们.map((t) => db.prepare("SELECT * FROM meme_pending WHERE title = ? AND status = 'pending'").get(t)).filter(Boolean)

  db.exec('BEGIN')
  try {
    for (const 行 of 目标) {
      db.prepare("UPDATE meme_pending SET status = 'rejected' WHERE title = ?").run(行.title)
      // 记下"这个版本我看过、不合并"，下次检查不会再把它排出来；站点再改一次才会重新排队
      记站点版本(行.title, 行.slug, 行.site_updated_at)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    return { 状态: 500, 数据: { ok: false, error: '忽略失败：' + ((e && e.message) || e) } }
  }
  return { 状态: 200, 数据: { ok: true, ignored: 目标.length } }
}

// ---- 同步（子进程）------------------------------------------------------

const 同步状态 = {
  状态: 'idle', // idle | running | done | error
  模式: '',
  开始于: '',
  结束于: '',
  输出: [],
  结果: null,
  错误: '',
}

let 同步进程 = null
let 看门狗 = null

function 推输出(行) {
  const 文本 = String(行 == null ? '' : 行).trimEnd()
  if (!文本) return
  同步状态.输出.push(文本)
  if (同步状态.输出.length > 300) 同步状态.输出.splice(0, 同步状态.输出.length - 300)
  const m = /^SYNC_RESULT\s+(\{.*\})\s*$/.exec(文本)
  if (m) { try { 同步状态.结果 = JSON.parse(m[1]) } catch { /* ignore */ } }
}

function 结束同步(码, 错误文) {
  if (同步状态.状态 !== 'running') return
  if (看门狗) { clearTimeout(看门狗); 看门狗 = null }
  同步进程 = null
  同步状态.结束于 = 现在文本()
  if (码 === 0) 同步状态.状态 = 'done'
  else {
    同步状态.状态 = 'error'
    同步状态.错误 = 错误文 || `同步进程退出码 ${码}`
  }
}

function 启动同步(模式, 强制) {
  if (同步进程 || 同步状态.状态 === 'running') return { 状态: 409, 数据: { ok: false, error: '已经在同步了，等它跑完' } }
  if (!existsSync(同步脚本)) return { 状态: 500, 数据: { ok: false, error: '找不到同步脚本：' + 同步脚本 } }

  const 脚本参数 = ['--no-warnings', 同步脚本]
  if (模式 === 'new') 脚本参数.push('--no-existing')
  else {
    脚本参数.push('--stage')
    if (强制) 脚本参数.push('--force')
  }

  同步状态.状态 = 'running'
  同步状态.模式 = 模式 === 'new' ? 'new' : 强制 ? 'stage-force' : 'stage'
  同步状态.开始于 = 现在文本()
  同步状态.结束于 = ''
  同步状态.输出 = []
  同步状态.结果 = null
  同步状态.错误 = ''

  try {
    同步进程 = spawn(process.execPath, 脚本参数, {
      cwd: 插件根,
      env: { ...process.env, MEMEWIKI_DB: 词库文件 },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    同步进程 = null
    同步状态.状态 = 'error'
    同步状态.错误 = '起不来同步进程：' + ((e && e.message) || e)
    return { 状态: 500, 数据: { ok: false, error: 同步状态.错误 } }
  }

  const 收 = (块) => { for (const 行 of String(块).split(/\r?\n/)) 推输出(行) }
  同步进程.stdout.on('data', 收)
  同步进程.stderr.on('data', 收)
  同步进程.on('error', (e) => { 推输出('进程错误：' + ((e && e.message) || e)); 结束同步(-1, '同步进程出错') })
  同步进程.on('close', (码) => 结束同步(码, 码 === 0 ? '' : `同步进程退出码 ${码}`))
  看门狗 = setTimeout(() => {
    if (同步进程) {
      推输出('超过 20 分钟还没跑完，掐掉。')
      try { 同步进程.kill() } catch { /* ignore */ }
      结束同步(-2, '同步超时（20 分钟）')
    }
  }, 20 * 60 * 1000)

  return { 状态: 200, 数据: { ok: true, ...同步状态 } }
}

// ---- 状态 / 导出 --------------------------------------------------------

function 状态总览() {
  const db = 开库()
  const 总 = db.prepare('SELECT COUNT(*) AS n FROM memes').get().n
  const 无别名 = db.prepare("SELECT COUNT(*) AS n FROM memes WHERE aliases IS NULL OR TRIM(aliases) = ''").get().n
  const 一别名 = db.prepare(
    "SELECT COUNT(*) AS n FROM memes WHERE aliases IS NOT NULL AND TRIM(aliases) <> '' AND (LENGTH(aliases) - LENGTH(REPLACE(aliases, ',', ''))) = 0",
  ).get().n
  const 多别名 = db.prepare(
    "SELECT COUNT(*) AS n FROM memes WHERE aliases IS NOT NULL AND (LENGTH(aliases) - LENGTH(REPLACE(aliases, ',', ''))) >= 1",
  ).get().n
  const 待审 = db.prepare("SELECT COUNT(*) AS n FROM meme_pending WHERE status = 'pending'").get().n
  const 已合并 = db.prepare("SELECT COUNT(*) AS n FROM meme_pending WHERE status = 'applied'").get().n
  const 已忽略 = db.prepare("SELECT COUNT(*) AS n FROM meme_pending WHERE status = 'rejected'").get().n
  let 有关键词 = 0
  try {
    有关键词 = db.prepare("SELECT COUNT(*) AS n FROM meme_keywords WHERE keywords IS NOT NULL AND TRIM(keywords) <> ''").get().n
  } catch { /* 老库没有关键词表 */ }
  let 大小 = 0
  try { 大小 = statSync(词库文件).size } catch { /* ignore */ }
  return {
    ok: true,
    版本,
    total: 总,
    无别名,
    一别名,
    有别名: 总 - 无别名,
    多别名,
    待审,
    已合并,
    已忽略,
    有关键词,
    builtAt: 读元信息('built_at'),
    checkedAt: 读元信息('checked_at'),
    db: 词库文件,
    dbSize: 大小,
    port: 服务器端口,
    同步: 同步状态,
  }
}

function 导出(参数表) {
  const db = 开库()
  const 格式 = String(参数表.get('format') || 'json')
  const 行们 = db.prepare(
    `SELECT m.title, m.slug, m.tags, m.usage, m.origin, m.other, m.summary, m.aliases,
            COALESCE(k.keywords, '') AS keywords
     FROM memes m LEFT JOIN meme_keywords k ON k.title = m.title ORDER BY m.title`,
  ).all()
  if (格式 === 'csv') {
    const 头 = ['title', 'slug', 'tags', 'usage', 'origin', 'other', 'summary', 'aliases', 'keywords']
    const 转义 = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"'
    const 文 = '\uFEFF' + [头.join(',')].concat(行们.map((r) => 头.map((k) => 转义(r[k])).join(','))).join('\r\n')
    return { 类型: 'text/csv; charset=utf-8', 文, 文件名: `memes-${现在文本().replace(/[: ]/g, '-')}.csv` }
  }
  return {
    类型: 'application/json; charset=utf-8',
    文: JSON.stringify({ 导出时间: 现在文本(), 条数: 行们.length, 词条: 行们 }, null, 2),
    文件名: `memes-${现在文本().replace(/[: ]/g, '-')}.json`,
  }
}

// ---- HTTP 服务 ----------------------------------------------------------

let 服务器端口 = 端口

const 服务器 = createServer(async (req, res) => {
  try {
    if (!主机合法(req, 服务器端口)) {
      res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('只接受 127.0.0.1 访问')
      return
    }

    const u = new URL(req.url ?? '/', `http://127.0.0.1:${服务器端口}`)
    const 路径 = u.pathname
    const 方法 = req.method || 'GET'

    if (方法 === 'GET' && (路径 === '/' || 路径 === '/index.html')) {
      发文件(res, 页面文件, 'text/html; charset=utf-8')
      return
    }
    if (方法 === 'GET' && 路径 === '/app.js') {
      发文件(res, 脚本文件, 'text/javascript; charset=utf-8')
      return
    }
    if (方法 === 'GET' && 路径 === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }

    if (!路径.startsWith('/api/')) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('没有这个页面')
      return
    }

    if (方法 !== 'GET' && !来源合法(req, 服务器端口)) {
      发JSON(res, 403, { ok: false, error: '不认识的来源' })
      return
    }
    if (方法 === 'POST' && !String(req.headers['content-type'] || '').includes('application/json')) {
      发JSON(res, 415, { ok: false, error: '只收 application/json' })
      return
    }

    const 路由 = 路径.slice('/api'.length)

    if (方法 === 'GET' && 路由 === '/state') return 发JSON(res, 200, 状态总览())
    if (方法 === 'GET' && 路由 === '/list') return 发JSON(res, 200, 列表(u.searchParams))
    if (方法 === 'GET' && 路由 === '/get') {
      const t = String(u.searchParams.get('title') || '').trim()
      if (!t) return 发JSON(res, 400, { ok: false, error: '缺 title' })
      const db = 开库()
      const row = db.prepare('SELECT * FROM memes WHERE title = ?').get(t)
      if (!row) return 发JSON(res, 404, { ok: false, error: '没有这个词条' })
      const kw = db.prepare('SELECT keywords FROM meme_keywords WHERE title = ?').get(t)
      return 发JSON(res, 200, { ok: true, item: row, keywords: 拆分列表(kw && kw.keywords) })
    }
    if (方法 === 'GET' && 路由 === '/alias-queue') {
      const db = 开库()
      const limit = Math.min(200, Math.max(1, Number(u.searchParams.get('limit') || 40)))
      const offset = Math.max(0, Number(u.searchParams.get('offset') || 0))
      const q = String(u.searchParams.get('q') || '').trim()
      const 随机 = u.searchParams.get('random') === '1'
      const 条件 = ["(aliases IS NULL OR TRIM(aliases) = '')"]
      const 值 = []
      if (q) { 条件.push('(title LIKE ? OR summary LIKE ? OR tags LIKE ?)'); 值.push(`%${q}%`, `%${q}%`, `%${q}%`) }
      const where = 'WHERE ' + 条件.join(' AND ')
      const total = db.prepare(`SELECT COUNT(*) AS n FROM memes ${where}`).get(...值).n
      const items = db.prepare(
        `SELECT title, tags, summary, usage, aliases FROM memes ${where} ORDER BY ${随机 ? 'RANDOM()' : 'title'} LIMIT ? OFFSET ?`,
      ).all(...值, limit, offset).map((r) => ({
        title: r.title,
        tags: r.tags || '',
        summary: r.summary || '',
        用法: String(r.usage || '').slice(0, 220),
        aliases: r.aliases || '',
      }))
      // 站点关键词（同步时从列表接口收下来的）——点一下就能加进别名
      const 关键词 = {}
      try {
        for (const r of db.prepare("SELECT title, keywords FROM meme_keywords WHERE keywords IS NOT NULL AND TRIM(keywords) <> ''").all()) {
          关键词[r.title] = 拆分列表(r.keywords)
        }
        // 待审核区里的更新鲜，盖掉表里的
        for (const r of db.prepare("SELECT title, keywords FROM meme_pending WHERE status = 'pending' AND keywords <> ''").all()) {
          关键词[r.title] = 拆分列表(r.keywords)
        }
      } catch { /* 老库没有关键词表 */ }
      return 发JSON(res, 200, { ok: true, total, items, 关键词 })
    }
    if (方法 === 'POST' && 路由 === '/save') {
      const r = 保存词条(await 读请求体(req))
      return 发JSON(res, r.状态, r.数据)
    }
    if (方法 === 'POST' && 路由 === '/summarize') {
      const 体 = await 读请求体(req)
      return 发JSON(res, 200, { ok: true, summary: 自动摘要({ usage: 体.usage, origin: 体.origin, other: 体.other }) })
    }
    if (方法 === 'POST' && 路由 === '/delete') {
      const 体 = await 读请求体(req)
      const r = 删除词条(体.title)
      return 发JSON(res, r.状态, r.数据)
    }
    if (方法 === 'POST' && 路由 === '/alias') {
      const r = 补别名(await 读请求体(req))
      return 发JSON(res, r.状态, r.数据)
    }
    if (方法 === 'GET' && 路由 === '/pending') return 发JSON(res, 200, 待审列表(u.searchParams))
    if (方法 === 'POST' && 路由 === '/pending/apply') {
      const r = 应用待审(await 读请求体(req))
      return 发JSON(res, r.状态, r.数据)
    }
    if (方法 === 'POST' && 路由 === '/pending/reject') {
      const r = 忽略待审(await 读请求体(req))
      return 发JSON(res, r.状态, r.数据)
    }
    if (方法 === 'GET' && 路由 === '/sync') return 发JSON(res, 200, { ok: true, ...同步状态 })
    if (方法 === 'POST' && 路由 === '/sync') {
      const 体 = await 读请求体(req)
      const r = 启动同步(体.mode === 'new' ? 'new' : 'stage', 体.force === true)
      return 发JSON(res, r.状态, r.数据)
    }
    if (方法 === 'GET' && 路由 === '/export') {
      const r = 导出(u.searchParams)
      const 内容 = Buffer.from(r.文, 'utf8')
      res.writeHead(200, {
        'content-type': r.类型,
        'content-length': String(内容.length),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(r.文件名)}`,
        'cache-control': 'no-store',
      })
      res.end(内容)
      return
    }

    发JSON(res, 404, { ok: false, error: '没有这个接口：' + 路由 })
  } catch (e) {
    try { 发JSON(res, 500, { ok: false, error: String((e && e.message) || e) }) } catch { /* ignore */ }
  }
})

服务器.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`端口 ${端口} 被占了。换一个：node scripts/wiki-server.mjs --port 3918`)
    process.exit(1)
  }
  console.error('服务出错：' + ((e && e.message) || e))
  process.exit(1)
})

服务器.listen(端口, 主机, () => {
  服务器端口 = 服务器.address().port
  const 地址 = `http://${主机}:${服务器端口}/`
  console.log('')
  console.log('  梗百科 · 本地管理页')
  console.log('  ' + 地址)
  console.log('  词库：' + 词库文件)
  console.log('  Ctrl+C 关掉。只监听本机，关掉页面不影响 QQ 那边用词库。')
  console.log('')
  if (自动开) {
    try {
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', '""', 地址], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      } else if (process.platform === 'darwin') {
        spawn('open', [地址], { detached: true, stdio: 'ignore' }).unref()
      } else {
        spawn('xdg-open', [地址], { detached: true, stdio: 'ignore' }).unref()
      }
    } catch { /* 打不开就算了，地址已经打出来了 */ }
  }
})

for (const 信号 of ['SIGINT', 'SIGTERM']) {
  process.on(信号, () => {
    try { if (同步进程) 同步进程.kill() } catch { /* ignore */ }
    try { 连接?.close() } catch { /* ignore */ }
    服务器.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  })
}
