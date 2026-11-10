/**
 * dsh-memewiki —— 梗百科（移植自 AstrBot 的 astrbot_plugin_memewiki）
 *
 * 三件事：
 *   1. 内置 6853 条梗 / 黑话词库（data/memes.db，SQLite，只读）——本地查，毫秒级
 *   2. LLM 工具 search_meme_wiki —— 模型没把握时自己查
 *   3. 自动预查 —— 用户消息像问梗时，先把词条查好塞进系统提示，别让模型硬猜
 *
 * 词库默认不进上下文：只在真相问梗时注入**那一条**（几百字）。
 */
import { existsSync, appendFileSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

function 自检(message) {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    appendFileSync(join(home, 'memewiki.log'), `[${new Date().toISOString()}] ${message}\n`)
  } catch (e) { /* ignore */ }
}

// Node 22.5+ 自带 SQLite；没有就降级成「只有工具、没有词库」
let DatabaseSync = null
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch (e) {
  console.warn('[memewiki] 这台 Node 没有 node:sqlite：' + (e && e.message))
}

export const name = 'memewiki'
export const inject = ['tools', 'systemPrompt', 'webServer']

const 插件根 = dirname(dirname(fileURLToPath(import.meta.url)))
const 词库文件 = join(插件根, 'data', 'memes.db')

// 插件自己的版本号（从 package.json 读，改 package.json 就跟着变）
const 当前版本 = (() => {
  try {
    return String(JSON.parse(readFileSync(join(插件根, 'package.json'), 'utf8')).version || '0.0.0')
  } catch (e) { return '0.0.0' }
})()

const 远端清单 = 'https://raw.githubusercontent.com/kikuj197-star/dsh-memewiki/main/package.json'
const 仓库地址 = 'https://github.com/kikuj197-star/dsh-memewiki'

function 拆版本(v) {
  return String(v || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0)
}

/** 比较两个语义化版本：a>b 返回正数，相等 0 */
function 比版本(a, b) {
  const x = 拆版本(a)
  const y = 拆版本(b)
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0)
    if (d) return d
  }
  return 0
}

// ---------- 配置（存在 ~/.dsh/memewiki.json，改完不用重启） ----------

const 配置目录 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 配置文件 = join(配置目录, 'memewiki.json')
const 默认配置 = { 自动思考梗: true, 串子开关: false, 串子程度: 50, 提交昵称: '大肥鱼', 联系方式: '' }

// ---------- 词库在线更新（设置页「更新词库」按钮） ----------
//
// 同步脚本是独立进程：翻 cnmeme.wiki 全站列表，只补本地没有的词条
// （--no-existing，不覆盖你手改过的）。跑一次 4–5 分钟，所以异步跑、轮询状态。

const 同步状态 = {
  状态: 'idle', // idle | running | done | error
  开始于: '',
  结束于: '',
  输出: [],
  新增: 0,
  更新: 0,
  总数: 0,
  错误: '',
}

let 同步子进程 = null
let 同步看门狗 = null

function 现在文本() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

/** 找独立 node：Electron 主进程的 process.execPath 是主程序，跑不了 .mjs */
function 找独立Node() {
  if (!process.versions || !process.versions.electron) return process.execPath
  try {
    const 运行时根 = join(配置目录, 'dsh-runtimes')
    if (existsSync(运行时根)) {
      for (const 目录 of readdirSync(运行时根)) {
        const 候选 = join(运行时根, 目录, 'dependencies', 'node', 'bin',
          process.platform === 'win32' ? 'node.exe' : 'node')
        if (existsSync(候选)) return 候选
      }
    }
  } catch (e) { /* 扫不到就用 ELECTRON_RUN_AS_NODE 兜底 */ }
  return null
}

function 推同步输出(行) {
  const 文本 = String(行 == null ? '' : 行).trimEnd()
  if (!文本) return
  同步状态.输出.push(文本)
  if (同步状态.输出.length > 80) 同步状态.输出.splice(0, 同步状态.输出.length - 80)
}

/** 从脚本输出里抠结果：「完成：6696 → 6700 条（新增 4，更新 0）」 */
function 读同步输出(行) {
  const m = /完成：(\d+) → (\d+) 条（新增 (\d+)，更新 (\d+)/.exec(行)
  if (m) {
    同步状态.总数 = Number(m[2])
    同步状态.新增 = Number(m[3])
    同步状态.更新 = Number(m[4])
  }
}

function 结束同步(码, 错误文本) {
  if (同步状态.状态 !== 'running') return
  if (同步看门狗) { clearTimeout(同步看门狗); 同步看门狗 = null }
  同步子进程 = null
  同步状态.结束于 = 现在文本()
  if (码 === 0) {
    同步状态.状态 = 'done'
    自检(`词库同步完成：新增 ${同步状态.新增}，更新 ${同步状态.更新}，现共 ${同步状态.总数} 条`)
  } else {
    同步状态.状态 = 'error'
    同步状态.错误 = 错误文本 || `同步进程退出码 ${码}`
    自检('词库同步失败：' + 同步状态.错误)
  }
}

function 启动同步() {
  if (同步子进程 || 同步状态.状态 === 'running') return { ok: false, error: '已经在同步了，等它跑完' }
  const 脚本 = join(插件根, 'scripts', 'sync-cnmeme.mjs')
  if (!existsSync(脚本)) return { ok: false, error: '找不到同步脚本：' + 脚本 }
  const 解释器 = 找独立Node()
  const 环境 = { ...process.env }
  if (!解释器) 环境.ELECTRON_RUN_AS_NODE = '1'

  同步状态.状态 = 'running'
  同步状态.开始于 = 现在文本()
  同步状态.结束于 = ''
  同步状态.输出 = []
  同步状态.新增 = 0
  同步状态.更新 = 0
  同步状态.总数 = 0
  同步状态.错误 = ''

  try {
    同步子进程 = spawn(解释器 || process.execPath, [脚本, '--no-existing'], {
      cwd: 插件根,
      env: 环境,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    同步子进程 = null
    同步状态.状态 = 'error'
    同步状态.错误 = '起不来同步进程：' + ((e && e.message) || e)
    return { ok: false, error: 同步状态.错误 }
  }

  const 收 = (块) => {
    for (const 行 of String(块).split(/\r?\n/)) {
      推同步输出(行)
      读同步输出(行)
    }
  }
  同步子进程.stdout.on('data', 收)
  同步子进程.stderr.on('data', 收)
  同步子进程.on('error', (e) => {
    推同步输出('进程错误：' + ((e && e.message) || e))
    结束同步(-1, '同步进程出错：' + ((e && e.message) || e))
  })
  同步子进程.on('close', (码) => { 结束同步(码, 码 === 0 ? '' : `同步进程退出码 ${码}`) })
  同步看门狗 = setTimeout(() => {
    if (同步子进程) {
      推同步输出('超过 15 分钟还没跑完，掐掉。')
      try { 同步子进程.kill() } catch (e) { /* ignore */ }
      结束同步(-2, '同步超时（15 分钟）')
    }
  }, 15 * 60 * 1000)

  自检('开始同步词库（只加新）')
  return { ok: true, 状态: 'running' }
}

let 配置缓存 = null
let 配置缓存时间 = 0

function 读配置() {
  const now = Date.now()
  if (配置缓存 && now - 配置缓存时间 < 3000) return 配置缓存
  let 配置 = { ...默认配置 }
  try {
    if (existsSync(配置文件)) {
      const 原文 = JSON.parse(readFileSync(配置文件, 'utf8'))
      if (原文 && typeof 原文 === 'object' && !Array.isArray(原文)) 配置 = { ...默认配置, ...原文 }
    }
  } catch (e) { /* 文件坏了就当默认 */ }
  配置缓存 = 配置
  配置缓存时间 = now
  return 配置
}

function 写配置(patch) {
  const 当前 = 读配置()
  const 下一个 = {
    自动思考梗: typeof patch?.自动思考梗 === 'boolean' ? patch.自动思考梗 : 当前.自动思考梗 !== false,
    串子开关: typeof patch?.串子开关 === 'boolean' ? patch.串子开关 : 当前.串子开关 === true,
    串子程度: Number.isFinite(Number(patch?.串子程度))
      ? Math.max(0, Math.min(100, Math.round(Number(patch.串子程度))))
      : (Number.isFinite(Number(当前.串子程度)) ? Math.max(0, Math.min(100, Math.round(Number(当前.串子程度)))) : 50),
    提交昵称: typeof patch?.提交昵称 === 'string' && patch.提交昵称.trim()
      ? patch.提交昵称.trim().slice(0, 40)
      : (typeof 当前.提交昵称 === 'string' && 当前.提交昵称.trim() ? 当前.提交昵称 : 默认配置.提交昵称),
    联系方式: typeof patch?.联系方式 === 'string'
      ? patch.联系方式.trim().slice(0, 200)
      : (typeof 当前.联系方式 === 'string' ? 当前.联系方式 : ''),
  }
  try {
    writeFileSync(配置文件, JSON.stringify(下一个, null, 2), 'utf8')
  } catch (e) {
    自检('写配置失败：' + (e && e.message))
  }
  配置缓存 = 下一个
  配置缓存时间 = Date.now()
  return 下一个
}

// ---------- 反馈给梗维基（cnmeme.wiki） ----------
//
// 用户同意后，把他对某条梗的纠正提交到梗维基。走它的第三方提交接口：
// 领凭证（clients）→ 提交（entry-requests，Bearer + 幂等键）→ 记录在本地。
// token 只存在 ~/.dsh/memewiki-feedback.json，不写日志、不进上下文、不传给模型。

const 反馈根 = 'https://cnmeme.wiki/api/v1/integrations'
const 反馈文件 = join(配置目录, 'memewiki-feedback.json')

function 读反馈() {
  try {
    if (existsSync(反馈文件)) {
      const 原文 = JSON.parse(readFileSync(反馈文件, 'utf8'))
      if (原文 && typeof 原文 === 'object' && !Array.isArray(原文)) return 原文
    }
  } catch (e) { 自检('读反馈文件失败：' + (e && e.message)) }
  return { 凭证: null, 提交记录: [], 实例id: '' }
}

function 写反馈(数据) {
  try {
    writeFileSync(反馈文件, JSON.stringify(数据, null, 2), 'utf8')
  } catch (e) { 自检('写反馈文件失败：' + (e && e.message)) }
}

function 反馈请求(路径, 选项) {
  return fetch(反馈根 + 路径, {
    ...(选项 || {}),
    headers: {
      'user-agent': 'CNMemeWikiPlugin/1.0',
      ...((选项 && 选项.headers) || {}),
    },
    signal: AbortSignal.timeout(20000),
  }).then(async (r) => {
    let 数据 = null
    try { 数据 = await r.json() } catch (e) { /* 非 JSON 响应 */ }
    return { 状态: r.status, 数据 }
  })
}

function 反馈错误说明(r) {
  const d = r && r.数据
  if (d && d.detail) {
    if (Array.isArray(d.detail)) return d.detail.map((x) => x.msg || JSON.stringify(x)).join('；')
    if (typeof d.detail === 'string') return d.detail
  }
  if (d && d.error) return String(d.error)
  return `HTTP ${r ? r.状态 : '?'}`
}

// 领凭证：用户不用注册网站，插件拿一个 contact + 昵称去换一个 90 天的 token
async function 领反馈凭证() {
  const 配置 = 读配置()
  const 联系方式 = String(配置.联系方式 || '').trim()
  if (!联系方式) return { ok: false, error: '先在设置页填一个联系方式（只用于领凭证，不公开）' }

  const 反馈 = 读反馈()
  if (!反馈.实例id) 反馈.实例id = 'dsh-' + Math.random().toString(36).slice(2, 10)

  const r = await 反馈请求('/clients', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'dsh',
      client_id: 反馈.实例id,
      name: String(配置.提交昵称 || '大肥鱼').trim().slice(0, 100) || '大肥鱼',
      contact: 联系方式.slice(0, 200),
      plugin_name: 'dsh-memewiki',
      plugin_version: 当前版本,
      homepage: 仓库地址,
    }),
  })

  if (r.状态 !== 201 || !r.数据 || !r.数据.token) {
    return { ok: false, error: '领凭证失败：' + 反馈错误说明(r) }
  }

  反馈.凭证 = {
    token: r.数据.token,
    client_id: r.数据.client_id,
    expires_at: r.数据.expires_at,
    领证于: 现在文本(),
  }
  写反馈(反馈)
  自检('反馈凭证领好了，有效期到 ' + r.数据.expires_at)
  return { ok: true, 有效期: r.数据.expires_at || '' }
}

// 从梗维基拉词条原文（公开接口，不用凭证）
async function 拉词条详情(slug) {
  try {
    const r = await fetch('https://cnmeme.wiki/api/v1/public/memes/' + encodeURIComponent(slug), {
      headers: { 'user-agent': 'CNMemeWikiPlugin/1.0' },
      signal: AbortSignal.timeout(20000),
    })
    if (!r.ok) return null
    const d = await r.json()
    return d && d.item ? d.item : d
  } catch (e) {
    自检('拉词条原文失败：' + (e && e.message))
    return null
  }
}

function 解码实体(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function 内联转Markdown(t) {
  let s = String(t || '')
  s = s.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
  s = s.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
  s = s.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  return 解码实体(s).trim()
}

// 网站的 content_html 转 Markdown：标题、段落、列表、引用、加粗、链接够用就行
function html转Markdown(html) {
  let s = String(html || '')
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => '\n' + '#'.repeat(Number(n)) + ' ' + 内联转Markdown(t) + '\n\n')
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, t) => '\n> ' + 内联转Markdown(t).replace(/\n/g, '\n> ') + '\n\n')
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => '- ' + 内联转Markdown(t) + '\n')
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, t) => 内联转Markdown(t) + '\n\n')
  s = s.replace(/<[^>]+>/g, '')
  s = 解码实体(s)
  return s.replace(/\n{3,}/g, '\n\n').trim()
}

// 在指定小节末尾追加一段（没有这一节就新建一节）
function 追加小节(正文, 小节名, 内容) {
  const 标题行 = '## ' + 小节名
  const 行们 = String(正文 || '').split('\n')
  const 起始 = 行们.findIndex((l) => l.trim() === 标题行)
  if (起始 === -1) {
    return (String(正文 || '').trim() ? String(正文).trim() + '\n\n' : '') + 标题行 + '\n\n' + 内容.trim() + '\n'
  }
  let 结束 = 行们.length
  for (let i = 起始 + 1; i < 行们.length; i++) {
    if (/^#{1,2}\s/.test(行们[i])) { 结束 = i; break }
  }
  const 前 = 行们.slice(0, 结束).join('\n').replace(/\n+$/, '')
  const 后 = 行们.slice(结束).join('\n').replace(/^\n+/, '')
  return 前 + '\n\n' + 内容.trim() + (后 ? '\n\n' + 后 : '\n')
}

// 把本地词条拼成梗维基的正文（## 小节），给设置页的「上传」用
function 本地词条转Markdown(行) {
  const 段 = []
  const 来源 = String((行 && 行.origin) || '').trim()
  const 用法 = String((行 && 行.usage) || '').trim()
  if (来源) 段.push('## 来源\n\n' + 来源)
  if (用法) 段.push('## 用法\n\n' + 用法)
  const 其他 = String((行 && 行.other) || '').trim()
  if (其他) {
    for (const 块 of 其他.split(/\n{2,}/)) {
      const 行们 = 块.split('\n')
      const 标题 = String(行们.shift() || '').trim()
      const 内容 = 行们.join('\n').trim()
      if (!标题) continue
      段.push(内容 ? '## ' + 标题 + '\n\n' + 内容 : '## ' + 标题)
    }
  }
  return 段.join('\n\n').slice(0, 20000)
}

// 提交纠正：只给要追加的那段，插件自己读原文、拼好整篇再提交
async function 提交反馈(参数) {
  const 反馈 = 读反馈()
  const 凭证 = 反馈.凭证
  if (!凭证 || !凭证.token) return { ok: false, error: '还没领凭证：先去设置页点「连接梗维基」' }

  const 标题 = String(参数?.title || '').trim()
  const 理由 = String(参数?.reason || '').trim()
  const 追加 = String(参数?.addition || '').trim()
  const 整篇 = String(参数?.content_md || '').trim()
  if (!标题) return { ok: false, error: '缺梗名（title）' }
  if (!理由) return { ok: false, error: '缺理由（reason）' }
  if (!追加 && !整篇) return { ok: false, error: '缺要加的内容（addition）' }

  // 只认精确标题：模糊匹配可能落到别的词条上，改错东西比不提交更糟
  const conn = 开词库()
  if (!conn) return { ok: false, error: '词库打不开' }
  const 行 = conn.prepare('SELECT * FROM memes WHERE title = ?').get(标题)
  if (!行) return { ok: false, error: `词库里没有「${标题}」（标题要跟词库完全一致）` }
  const slug = String(行.slug || '').trim()
  if (!slug) return { ok: false, error: '这条词条没有 slug，提交不了（可能不是从梗维基同步来的）' }

  // 正文：给了整篇就直接用；否则拉原文、只把 addition 追加到指定小节
  let 新正文 = 整篇
  if (!新正文) {
    const 详情 = await 拉词条详情(slug)
    if (!详情 || !详情.content_html) return { ok: false, error: '拉不到梗维基上的原文，没法在原文上追加' }
    const 原正文 = html转Markdown(详情.content_html)
    const 小节名 = String(参数?.section || '用法').trim() || '用法'
    新正文 = 追加小节(原正文, 小节名, 追加)
  }

  const changes = { content_md: 新正文.slice(0, 20000) }
  if (Array.isArray(参数.aliases) && 参数.aliases.length) {
    changes.aliases = 参数.aliases.slice(0, 30).map((x) => String(x))
  }
  if (Array.isArray(参数.keywords) && 参数.keywords.length) {
    changes.keywords = 参数.keywords.slice(0, 30).map((x) => String(x))
  }

  const r = await 反馈请求('/entry-requests', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + 凭证.token,
      'idempotency-key': 'dsh-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    },
    body: JSON.stringify({
      kind: 'edit',
      entry_slug: slug,
      changes,
      reason: 理由.slice(0, 2000),
    }),
  })

  if (r.状态 !== 202 || !r.数据) {
    if (r.状态 === 401) {
      反馈.凭证 = null
      写反馈(反馈)
      return { ok: false, error: '凭证失效了（或过期），去设置页点「连接梗维基」重新领一个' }
    }
    return { ok: false, error: '提交失败：' + 反馈错误说明(r) }
  }

  const 记录 = {
    时间: 现在文本(),
    标题,
    slug,
    请求id: r.数据.request_id,
    状态: r.数据.status,
  }
  反馈.提交记录 = [记录, ...(Array.isArray(反馈.提交记录) ? 反馈.提交记录 : [])].slice(0, 50)
  写反馈(反馈)
  自检(`反馈提交了：${标题}（${记录.请求id}）`)
  return { ok: true, 请求id: 记录.请求id, status: 记录.状态 }
}

// 提交记录里的状态只是提交那一刻的快照，过两天会过期——问站点要一遍最新的
async function 刷新反馈状态() {
  const 反馈 = 读反馈()
  const 凭证 = 反馈.凭证
  if (!凭证 || !凭证.token) return { ok: false, error: '还没领凭证' }
  const 记录们 = Array.isArray(反馈.提交记录) ? 反馈.提交记录 : []
  const 待查 = 记录们
    .filter((r) => r && r.请求id && !['approved', 'rejected'].includes(String(r.状态 || '')))
    .slice(0, 10)
  if (!待查.length) return { ok: true, 更新: 0 }
  let 更新 = 0
  for (const 记录 of 待查) {
    const r = await 反馈请求('/requests/' + encodeURIComponent(记录.请求id), {
      headers: { authorization: 'Bearer ' + 凭证.token },
    })
    if (r.状态 === 200 && r.数据 && r.数据.status) {
      if (记录.状态 !== r.数据.status) 更新++
      记录.状态 = r.数据.status
      记录.审核 = r.数据.review_note || ''
    }
  }
  写反馈(反馈)
  return { ok: true, 更新 }
}

// ---------- 词库 ----------

let db = null
let 词库加载过 = false

function 开词库() {
  if (词库加载过) return db
  词库加载过 = true
  try {
    if (!existsSync(词库文件)) return db
    if (!DatabaseSync) return db
    // 只读打开；Node 24 自带 node:sqlite，不用装驱动
    db = new DatabaseSync(词库文件, { readOnly: true })
  } catch (e) {
    console.warn('[memewiki] 打开词库失败：' + (e && e.message))
    db = null
  }
  return db
}

// 设置页要能往里加/改词条，需要一条可写连接（懒开、失败不影响只读查询）
let 写库连接 = null
let 写库开过 = false

function 开写库() {
  if (写库开过) return 写库连接
  写库开过 = true
  try {
    if (!existsSync(词库文件) || !DatabaseSync) return null
    写库连接 = new DatabaseSync(词库文件)
  } catch (e) {
    console.warn('[memewiki] 打开可写词库失败：' + (e && e.message))
    写库连接 = null
  }
  return 写库连接
}

// 别名子串匹配用的内存索引：消息里出现某个别名就命中（和「消息里包含标题」同一套逻辑）。
// 词条和别名会被设置页或同步脚本改动，所以索引带 60 秒寿命；设置页保存/删除时会立即清掉。
let 别名索引 = null
let 别名索引时间 = 0
let 别名最长 = 0
const 别名索引寿命 = 60 * 1000

function 清别名索引() {
  别名索引 = null
  别名索引时间 = 0
  别名最长 = 0
}

function 取别名索引() {
  const 现在 = Date.now()
  if (别名索引 && 现在 - 别名索引时间 < 别名索引寿命) return 别名索引
  const conn = 开词库()
  if (!conn) return null
  try {
    const 行们 = conn.prepare(
      "SELECT title, aliases FROM memes WHERE aliases IS NOT NULL AND TRIM(aliases) <> ''",
    ).all()
    const 映射 = new Map() // 小写别名 → 标题
    let 最长 = 0
    for (const 行 of 行们) {
      for (const 原文 of String(行.aliases).split(',')) {
        const 别名 = 原文.trim()
        // 和标题那边一致：1 个字不参与子串匹配
        if (别名.length < 2) continue
        const 键 = 别名.toLowerCase()
        if (映射.has(键)) continue
        映射.set(键, 行.title)
        if (键.length > 最长) 最长 = 键.length
      }
    }
    别名索引 = 映射
    别名最长 = 最长
    别名索引时间 = 现在
    return 映射
  } catch (e) {
    别名索引 = null
    return null
  }
}

/** 消息里包含某个别名 → 返回它的词条（取最长别名，和标题的子串匹配同一套规则） */
function 查包含别名(q) {
  const 映射 = 取别名索引()
  if (!映射 || !映射.size) return null
  const 小写 = q.toLowerCase()
  // 从长到短滑窗找，先命中的就是最长别名
  const 上限 = Math.min(小写.length, 别名最长)
  for (let 长 = 上限; 长 >= 2; 长--) {
    for (let i = 0; i + 长 <= 小写.length; i++) {
      const 标题 = 映射.get(小写.slice(i, i + 长))
      if (!标题) continue
      const conn = 开词库()
      return conn ? conn.prepare('SELECT * FROM memes WHERE title = ?').get(标题) : null
    }
  }
  return null
}

/** 查词顺序见 README「匹配规则」：精确 → 前缀 → 消息含标题 → 消息含别名 → 标题含查询词 */
function 查词库(query, 匹配 = '全部') {
  const q = String(query || '').trim()
  if (!q) return null
  const conn = 开词库()
  if (!conn) return null
  try {
    // 1) 完全一样
    const exact = 匹配 !== '别名' && conn.prepare('SELECT * FROM memes WHERE title = ?').get(q)
    if (exact) return exact
    // 1.5) 别名（缩写/俗称：「kskbl」→「康神开播了」）。别名逗号分隔，整项精确比对。
    const 别名 = conn.prepare(
      "SELECT * FROM memes WHERE aliases IS NOT NULL AND instr(',' || lower(aliases) || ',', ',' || lower(?) || ',') > 0 LIMIT 1",
    ).get(q)
    if (别名 || 匹配 !== '全部') return 别名 || null
    // 2) 标题以查询词开头（「48」→「48上单」、「tes」→「TES48」）。
    //    前缀比"包含"更精确，不会像两字中文那样乱中；取最短的那条，最接近。
    const 前缀 = conn.prepare(
      "SELECT * FROM memes WHERE lower(title) LIKE lower(?) || '%' ORDER BY length(title) ASC LIMIT 1",
    ).get(q)
    if (前缀) return 前缀
    // 3) 查询词里包含标题（问「去码头整点薯条是什么梗」）——取最长标题，最具体
    const 反查 = conn.prepare(
      'SELECT * FROM memes WHERE length(title) >= 2 AND instr(lower(?), lower(title)) > 0 ORDER BY length(title) DESC LIMIT 1',
    ).get(q)
    if (反查) return 反查
    // 3.5) 查询词里包含某个别名（「喜欢讲戒食」→ 别名「讲戒食」）。
    //      和标题那条同一套逻辑：≥2 字、取最长的那个；标题优先于别名。
    const 别名反查 = 查包含别名(q)
    if (别名反查) return 别名反查
    // 4) 标题里包含查询词（短着问「码头整」）。
    //    中文至少 3 个字才做，否则「码头」「典」这种随手两字会乱中；
    //    纯数字/字母（「48」「233」）两字也放宽——它们够specific，不放开就查不到「48上单」。
    const 短词放宽 = q.length >= 2 && /^[0-9a-z]+$/i.test(q)
    if (q.length >= 3 || 短词放宽) {
      const 正查 = conn.prepare(
        'SELECT * FROM memes WHERE instr(title, ?) > 0 ORDER BY length(title) ASC LIMIT 1',
      ).get(q)
      if (正查) return 正查
    }
    return null
  } catch (e) {
    console.warn('[memewiki] 查词库失败：' + (e && e.message))
    return null
  }
}

function 截断(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** JSON 响应。 */
function 发JSON(res, status, body) {
  const text = JSON.stringify(body)
  const bytes = Buffer.from(text, 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
  })
  res.end(bytes)
}

/** 读 JSON 请求体（设置页保存词条用）。 */
function 读请求体(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) { req.destroy(); resolve({}) ; return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/** 词条 → 给模型看的文本：「怎么用」放前面，方便直接接梗 */
function 词条文本(row) {
  if (!row) return ''
  const 标题 = String(row.title || '')
  const 用法 = 截断(row.usage, 700)
  const 解释 = 截断(row.summary || row.origin || '', 500)
  const 标签 = 截断(row.tags, 120)
  const lines = [`[梗百科]「${标题}」`]
  if (标签) lines.push(`标签：${标签}`)
  if (用法) lines.push(`怎么用 / 怎么接：\n${用法}`)
  if (解释) lines.push(`出处与含义：\n${解释}`)
  return lines.join('\n')
}

// ---------- 判断「像不像在问梗」 ----------

const 问梗模式 = /(?:是)?(?:什么梗|啥梗|什么来头|什么来历|什么出处|什么意思|啥意思|怎么用|怎么接|怎么玩|如何用)(?:啊|呀|呢|的|啊这是)?[？?。！!~～]*$/
const 裸词模式 = /^[\u4e00-\u9fa5A-Za-z0-9·]{2,10}$/
const 整句别名模式 = /^[\u4e00-\u9fa5A-Za-z0-9·]{2,32}$/
const 魔了句式 = /^这[\p{Script=Han}A-Za-z0-9·]{1,12}(?<![着著入恶惡])魔了(?:是[个辆只条位台块][\p{Script=Han}A-Za-z0-9·]{1,8})?$/u
const 捡回家开头 = /^捡(?:到|了)?一?[个只条位]?[\p{Script=Han}A-Za-z0-9·]{1,12}$/u
const 捡回家后半句 = /(?:这也太(?:好看|可爱)了吧)?(?:[他她它牠]|ta)想跟我回家$/iu

const 无语义词 = new Set([
  '这', '那', '它', '他', '她', '这个', '那个', '你', '这句话', '那句话', '上面', '刚才', '下文', '前面',
])

const 停用词 = new Set([
  '在吗', '在不在', '哈哈', '哈哈哈', '笑死', '好的', '好吧', '晚安', '早安',
  '睡觉', '吃饭', '干嘛', '没事', '收到', '谢谢', '好耶', '草', '典', '乐',
])

// 明显是闲聊/问状态的整句，别当梗去查
const 闲聊短语 = new Set([
  '我是谁', '错了', '情绪', '接下一句', '你也学一个', '今天看什么', '到底多少了',
  '搜出来了吗', '来点贴吧评价', '都是同龄人', '你同事', '道德这么高',
  '这是谁的手臂', '比我能串', '宝宝你醒了', '中国人能不能飞', '你现在什么人格',
])

const 句子成分 = /怎么样|怎么|多少|为什么|能不能|是不是|什么|了吗|了没|一下|你说|要不要|有没有/

const 唤醒词 = ['小鲸鱼', '大鲸鱼', '大肥鲸', '小肥鲸', '大肥鱼', '奶鱼', '鲸鱼', 'deepseek', 'ds']

function 清文本(text) {
  let t = String(text || '').trim()
  t = t.replace(/^(@\S+\s*)+/, '')
  for (const w of 唤醒词) {
    if (t.startsWith(w)) {
      t = t.slice(w.length).trim().replace(/^[，,。.！!？?:：]+|[，,。.！!？?:：]+$/g, '')
      break
    }
  }
  return t.trim()
}

function 清口语标点(text) {
  return text.replace(/[，,、]\s*/g, '').replace(/[。！!？?~～…]+$/g, '').trim()
}

function 查句式(text) {
  const 分句 = 清文本(text).replace(问梗模式, '').split(/[，,、。！？!?；;：:~～…“”「」『』"\s]+/u)
  if (分句.some(句子 => 魔了句式.test(句子))) return 查词库('这官方魔了，是个魔方', '精确')

  const 连句 = 分句.join('')
  const 开头 = 连句.replace(捡回家后半句, '')
  // 前置“家人们”的普通捡猫分享需有后半句，原版短句则可单独用。
  const 捡取短句 = 开头 === 连句 ? 开头.replace(/家人们$/u, '') : 开头.replace(/^家人们|家人们$/gu, '')
  return 捡取短句 !== 开头 && 捡回家开头.test(捡取短句) ? 查词库('捡个猫家人们', '精确') : null
}

function 查整句别名(text) {
  const 别名 = text.replace(问梗模式, '').replace(/[，,、。！？!?~～…]+\s*/g, '').trim()
  if (!整句别名模式.test(别名) || 停用词.has(别名) || 闲聊短语.has(别名)) return null
  return 查词库(别名, '别名')
}

function 是裸词(text) {
  return 裸词模式.test(text) && !停用词.has(text) && !闲聊短语.has(text)
}

/** 从一句话里提取候选词条；不是问梗就返回 null */
function 提取查询(text) {
  const t = 清文本(text)
  if (!t) return null
  const m = 问梗模式.exec(t)
  if (m) {
    let head = t.slice(0, m.index).replace(/^[ ，,。.！!？?]+|[ ，,。.！!？?]+$/g, '')
    head = head.replace(/^[是]+|[是]+$/g, '').trim()
    head = head.replace(/(这个梗|那个梗|这梗|那梗|这个|那个)$/, '').trim()
    head = head.replace(/(到底|究竟)$/, '').trim()
    if (无语义词.has(head)) return null
    if (head.length <= 2 && '这那它他她'.includes(head[0])) return null
    if (head.length > 1 && head.length <= 12) return head
    return null
  }
  if (是裸词(t)) {
    if (句子成分.test(t)) return null
    return t
  }
  return null
}

// ---------- 判断「是不是在给你讲一个梗」 ----------
//
// 「这是康康的梗」「这是叉叉叉的梗，你应该说……」——用户在告诉你这个梗的来历/正确用法，
// 不是在问梗。以前这种句子整段跳过，模型压根不知道要问一句「要不要反馈给梗维基」。

const 教梗模式 = /(?:这|那)(?:个)?(?:梗)?(?:其实|本来|就)?是\s*[「“"'『]?([^，,。！!？?：:；;\s「」“”"'『』]{1,16})[」”"'』]?\s*的(?:梗|段子|说法|出处|来源)/
const 疑问开头 = /^(?:谁|啥|什么|哪|哪个|哪位|咋|怎么|为什么|多少|几)/

/** 用户在讲「这是X的梗」就返回原句，否则空串 */
function 提取教梗(text) {
  const t = 清文本(text)
  if (!t) return ''
  const m = 教梗模式.exec(t)
  if (!m) return ''
  if (疑问开头.test(m[1])) return ''
  return t
}

// ---------- 会话里的最后一条用户消息 ----------

function 取文本(payload) {
  if (!payload) return ''
  if (typeof payload === 'string') return payload
  const parts = payload.parts || payload.content || payload.message
  if (typeof parts === 'string') return parts
  if (Array.isArray(parts)) {
    return parts
      .map((p) => {
        if (typeof p === 'string') return p
        if (p && typeof p.text === 'string') return p.text
        return ''
      })
      .join('\n')
  }
  if (typeof payload.text === 'string') return payload.text
  return ''
}

function 最后用户消息(session) {
  try {
    if (!session || typeof session.snapshotEvents !== 'function') return ''
    const events = session.snapshotEvents() || []
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      const kind = e && (e.type || e.kind)
      if (kind !== 'user/message') continue
      const payload = e.payload !== undefined ? e.payload : e.data
      // 跳过宿主/其它插件注入的上下文
      const src = payload && payload.source && payload.source.kind ? String(payload.source.kind) : ''
      if (src && src !== 'user') continue
      const txt = 取文本(payload)
      if (txt) return txt
    }
  } catch (e) { /* ignore */ }
  return ''
}

// ---------- 注入的规则 ----------

const 接梗规则 =
  '[梗百科·内置用法]\n' +
  '1. 查到词条就**先接梗、别科普**：照「怎么用/怎么接」回一句，像本来就会；\n' +
  '2. 只有对方明确问「这是什么梗」才解释出处，一两句就够，不要念词条；\n' +
  '3. 查不到就说不知道，别硬编，也别把两个不相干的梗拼一起；\n' +
  '4. 说话用短句，别用客服腔；\n' +
  '5. 用户纠正你、或主动告诉你某个梗的来历（「这个梗不是这么用的」「出处错了」「这是康康的梗」）时，先接住、别辩解；然后问一句「要不要把这个纠正反馈给梗维基？」——他同意才调 feedback_meme_wiki，别自己偷偷发。'

// 用户在给你讲一个梗（「这是康康的梗」）：先接住，再问要不要补进梗维基。
function 教梗提示(原句) {
  const 引 = 截断(String(原句 || '').replace(/\s+/g, ' ').trim(), 60)
  return '[梗百科·用户在给你讲一个梗]\n' +
    `用户刚说：「${引}」——他是在告诉你这个梗的来历或正确用法，不是在问梗。\n` +
    '1. 先接住：照他给的说法用一句，别辩解、别科普；\n' +
    '2. 然后主动问一句「要不要把这个补进梗维基？」——用你自己的话说，别像客服；\n' +
    '3. 他明确同意才调 feedback_meme_wiki，别自己偷偷发；反馈只给要补的那一小段（addition），插件自己拉原文、拼全文。'
}

// 串子程度：0 = 很有底线，100 = 放开了串。开关关着时不注入，交给模型自己判断。
function 串子文案() {
  const 配置 = 读配置()
  if (!配置.串子开关) return ''
  const 值 = Math.max(0, Math.min(100, Math.round(Number(配置.串子程度) || 0)))
  let 档 = ''
  let 说明 = ''
  if (值 <= 20) {
    档 = '很低'
    说明 = '把对面当真人尊重。可以接正面梗、自嘲、夸人；黑称一律不接、不复读，遇到侮辱性外号直接点一句它为什么不好，不跟着起哄。'
  } else if (值 <= 45) {
    档 = '偏低'
    说明 = '可以损操作、损发挥，不损长相、不损病。别人先用黑称、且明显是玩的时候，跟着接半句；不带头用，不上纲上线。'
  } else if (值 <= 70) {
    档 = '中等'
    说明 = '按社区语境来：别人玩得开的梗就跟着玩，损操作、损战绩、损名言都行；冲家人的词不带头用。'
  } else {
    档 = '很高'
    说明 = '放开串：黑称也照玩（「马头」「四八」这种别人先甩出来的词，接着玩，别扫兴），损操作、损战绩、损长相都接，怎么损怎么来，别端着。只对真事，不自己编新攻击。'
  }
  return `[玩梗尺度·串子程度 ${值}/100（${档}）]\n${说明}\n`
}

// ---------- 插件 ----------

export function apply(ctx) {
  自检('apply 开始')
  const 日志 = (t) => {
    自检(t)
    try { ctx.logger?.info?.('[memewiki] ' + t) } catch (e) { /* ignore */ }
  }

  // 宿主的 defineTool 会做「简写 → JSON Schema」转换；这里等价实现一份，别指望拿到真货
  const defineTool = (o) => ({
    ...o,
    parameters: {
      type: 'object',
      properties: o.parameters || {},
      additionalProperties: false,
    },
  })

  // 工具：模型自己查
  try {
    ctx.tools.register(defineTool({
      name: 'search_meme_wiki',
      description: '查网络梗、缩写、黑话的意思。内置 6853 条词库，本地毫秒级返回。\n'
        + '⚠️ 看到没有十足把握的新词/梗/缩写，先查它，别硬猜、别编。',
      parameters: {
        query: { type: 'string', description: '要查的词（梗名、缩写、黑话）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const q = String(args?.query || '').trim()
        if (!q) return '要查什么？给我一个词。'
        const 规整 = 清口语标点(q)
        const row = 查句式(q) || 查词库(q) || (规整 !== q ? 查词库(规整, '精确') : null) || 查整句别名(q)
        if (!row) return `词库里没收录「${q}」。别硬解释——说不知道，或者反问一句「这什么梗」。`
        return 接梗规则 + '\n' + 串子文案() + '\n' + 词条文本(row)
      },
    }))
    日志('工具 search_meme_wiki 已注册')
  } catch (e) {
    日志('注册工具失败：' + (e && e.message))
  }

  // 工具：把用户对梗的纠正反馈给梗维基（用户亲口同意后才调）
  try {
    ctx.tools.register(defineTool({
      name: 'feedback_meme_wiki',
      description: '把用户对某条梗的纠正反馈给梗维基（cnmeme.wiki），站内有 AI 和真人审核。\n'
        + '⚠️ 只在用户明确同意后调用，别自己偷偷发。只给要补的那一小段话（addition），插件自己去拉原文、拼好整篇再提交——不用贴全文。',
      parameters: {
        title: { type: 'string', description: '梗名（词库里的标题）' },
        addition: { type: 'string', description: '要补进词条的那段话（Markdown，一段就行，会加在指定小节末尾）' },
        reason: { type: 'string', description: '为什么补，1–2000 字' },
        section: { type: 'string', description: '加到哪个小节，默认「用法」；常见还有「来源」「演化」' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const r = await 提交反馈(args || {})
        if (!r.ok) return '没提交上：' + r.error
        return `提交好了，梗维基已收下（请求号 ${r.请求id}）。这段会加到「${String(args?.section || '用法').trim() || '用法'}」小节末尾，正文其它地方不动。站内先过 AI 审核，拿不准的转人工，结果不一定马上出来。`
      },
    }))
    日志('工具 feedback_meme_wiki 已注册')
  } catch (e) {
    日志('注册反馈工具失败：' + (e && e.message))
  }

  // 注入：用户消息像问梗时，把词条塞进系统提示（每轮现算）
  try {
    ctx.effect(() => ctx.systemPrompt.context({
      name: 'memewiki:prefetch',
      order: 950,
      text: (context) => {
        try {
          if (!读配置().自动思考梗) return ''
          const session = context?.agent?.session
          const 文本 = 最后用户消息(session)
          if (!文本) return ''
          // 用户主动讲了一个梗的来历：先接住、再问要不要反馈
          const 教梗 = 提取教梗(文本)
          if (教梗) {
            日志('教梗命中：' + 教梗.slice(0, 40))
            return 教梗提示(教梗)
          }
          const q = 提取查询(文本)
          let row = 查句式(文本) || (q ? 查词库(q) : null)
          if (!row) {
            const 原文 = 清文本(文本)
            const 规整 = 清口语标点(原文)
            const 规整查询 = 规整 === 原文 ? q : 提取查询(规整)
            if (规整查询 && 规整查询 !== q) row = 查词库(规整查询, '精确')
            // 已登记的整句别名可以超过裸词长度或包含日常问句成分。
            if (!规整查询) row = 查整句别名(原文)
          }
          if (!row) return ''
          日志(`预查命中：${row.title}`)
          return 接梗规则 + '\n' + 串子文案() + '\n' + 词条文本(row)
        } catch (e) {
          自检('预查出错：' + (e && e.message))
          return ''
        }
      },
    }), 'dsh-memewiki: 预查注入')
    日志('预查注入已注册')
  } catch (e) {
    日志('注册注入失败：' + (e && e.message))
  }

  // ---- 设置页的同源 API（/api/memewiki/*）-------------------------------
  try {
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/memewiki',
      handler: async (req, res) => {
        const route = (req.url ?? '').split('?')[0].slice('/api/memewiki'.length) || '/'
        try {
          const u = new URL(req.url ?? '/', 'http://localhost')

          if (route === '/state' && req.method === 'GET') {
            const conn = 开词库()
            let total = 0
            let builtAt = ''
            if (conn) {
              try {
                total = conn.prepare('SELECT COUNT(*) AS n FROM memes').get().n
                const meta = conn.prepare("SELECT value FROM meta WHERE key = 'built_at'").get()
                builtAt = meta ? String(meta.value || '') : ''
              } catch (e) { /* 老库没有 meta 表也无所谓 */ }
            }
            return 发JSON(res, 200, {
              ok: true,
              total,
              builtAt,
              file: 词库文件,
              writable: 开写库() !== null,
              版本: 当前版本,
              自动思考梗: 读配置().自动思考梗,
              串子开关: 读配置().串子开关 === true,
              串子程度: Math.max(0, Math.min(100, Math.round(Number(读配置().串子程度) || 0))),
              提交昵称: String(读配置().提交昵称 || 默认配置.提交昵称),
            })
          }

          if (route === '/config' && req.method === 'POST') {
            const body = await 读请求体(req)
            const 下一个 = 写配置({
              自动思考梗: body?.自动思考梗,
              串子开关: body?.串子开关,
              串子程度: body?.串子程度,
              提交昵称: body?.提交昵称,
              联系方式: body?.联系方式,
            })
            日志('配置改了：自动思考梗=' + 下一个.自动思考梗 + ' 串子=' + 下一个.串子开关 + '/' + 下一个.串子程度 + ' 昵称=' + 下一个.提交昵称)
            return 发JSON(res, 200, {
              ok: true,
              自动思考梗: 下一个.自动思考梗,
              串子开关: 下一个.串子开关,
              串子程度: 下一个.串子程度,
              提交昵称: 下一个.提交昵称,
              联系方式: 下一个.联系方式,
            })
          }

          if (route === '/check-update' && req.method === 'GET') {
            try {
              const r = await fetch(远端清单, {
                headers: { 'user-agent': 'dsh-memewiki' },
                signal: AbortSignal.timeout(8000),
              })
              if (!r.ok) {
                return 发JSON(res, 200, {
                  ok: false,
                  当前: 当前版本,
                  error: `拉不到 GitHub 上的版本文件（HTTP ${r.status}）`,
                })
              }
              const 远端 = await r.json()
              const 最新 = String((远端 && 远端.version) || '')
              if (!最新) {
                return 发JSON(res, 200, { ok: false, 当前: 当前版本, error: '远端文件里没有版本号' })
              }
              return 发JSON(res, 200, {
                ok: true,
                当前: 当前版本,
                最新,
                有更新: 比版本(最新, 当前版本) > 0,
                仓库: 仓库地址,
              })
            } catch (e) {
              return 发JSON(res, 200, {
                ok: false,
                当前: 当前版本,
                error: '连不上 GitHub（' + ((e && e.message) || '超时') + '）',
              })
            }
          }

          if (route === '/sync' && req.method === 'GET') {
            return 发JSON(res, 200, { ok: true, ...同步状态 })
          }

          if (route === '/sync' && req.method === 'POST') {
            const r = 启动同步()
            if (!r.ok) return 发JSON(res, 409, r)
            return 发JSON(res, 200, { ok: true, 状态: 同步状态 })
          }

          if (route === '/feedback' && req.method === 'GET') {
            const 反馈 = 读反馈()
            const 凭证 = 反馈.凭证
            return 发JSON(res, 200, {
              ok: true,
              已领证: !!(凭证 && 凭证.token),
              有效期: (凭证 && 凭证.expires_at) || '',
              昵称: String(读配置().提交昵称 || 默认配置.提交昵称),
              联系方式: String(读配置().联系方式 || ''),
              提交记录: Array.isArray(反馈.提交记录) ? 反馈.提交记录.slice(0, 20) : [],
            })
          }

          if (route === '/feedback/claim' && req.method === 'POST') {
            const r = await 领反馈凭证()
            return 发JSON(res, r.ok ? 200 : 409, r)
          }

          if (route === '/feedback/submit' && req.method === 'POST') {
            const b = await 读请求体(req)
            const r = await 提交反馈(b || {})
            return 发JSON(res, r.ok ? 200 : 409, r)
          }

          if (route === '/feedback/refresh' && req.method === 'POST') {
            const r = await 刷新反馈状态()
            return 发JSON(res, r.ok ? 200 : 409, r)
          }

          // 设置页「上传」：把本地这条词条整篇传到梗维基（站内会审核）
          if (route === '/upload' && req.method === 'POST') {
            const b = await 读请求体(req)
            const title = String((b && b.title) || '').trim()
            if (!title) return 发JSON(res, 400, { ok: false, error: '缺标题' })
            const conn = 开词库()
            if (!conn) return 发JSON(res, 500, { ok: false, error: '词库打不开' })
            const 行 = conn.prepare('SELECT * FROM memes WHERE title = ?').get(title)
            if (!行) return 发JSON(res, 404, { ok: false, error: `词库里没有「${title}」` })
            const 正文 = 本地词条转Markdown(行)
            if (!正文) return 发JSON(res, 400, { ok: false, error: '这条还没有正文，先在词条库里补上「用法 / 来源」再上传' })
            const 别名 = String(行.aliases || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 30)
            const r = await 提交反馈({
              title,
              content_md: 正文,
              reason: '从本地词库上传：整篇内容更新（' + 现在文本() + '）',
              aliases: 别名.length ? 别名 : undefined,
            })
            return 发JSON(res, r.ok ? 200 : 409, r)
          }

          if (route === '/list' && req.method === 'GET') {
            const conn = 开词库()
            if (!conn) return 发JSON(res, 200, { ok: true, total: 0, items: [] })
            const q = (u.searchParams.get('q') || '').trim()
            const limit = Math.min(120, Math.max(1, Number(u.searchParams.get('limit') || 40)))
            const offset = Math.max(0, Number(u.searchParams.get('offset') || 0))
            const 条件 = q ? "WHERE title LIKE ? OR tags LIKE ? OR summary LIKE ? OR aliases LIKE ?" : ''
            const args = q ? [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`] : []
            const total = conn.prepare(`SELECT COUNT(*) AS n FROM memes ${条件}`).get(...args).n
            const items = conn.prepare(
              `SELECT title, tags, usage, origin, summary, aliases FROM memes ${条件} ORDER BY title LIMIT ? OFFSET ?`,
            ).all(...args, limit, offset)
            return 发JSON(res, 200, { ok: true, total, items })
          }

          if (route === '/get' && req.method === 'GET') {
            const conn = 开词库()
            const title = (u.searchParams.get('title') || '').trim()
            if (!conn || !title) return 发JSON(res, 400, { ok: false, error: '缺 title' })
            const row = conn.prepare('SELECT * FROM memes WHERE title = ?').get(title)
            if (!row) return 发JSON(res, 404, { ok: false, error: '没有这个词条' })
            return 发JSON(res, 200, { ok: true, item: row })
          }

          if (route === '/save' && req.method === 'POST') {
            const conn = 开写库()
            if (!conn) return 发JSON(res, 500, { ok: false, error: '词库不可写' })
            const b = await 读请求体(req)
            const title = String(b.title || '').trim()
            if (!title) return 发JSON(res, 400, { ok: false, error: '标题不能空' })
            if (title.length > 60) return 发JSON(res, 400, { ok: false, error: '标题太长了（≤60 字）' })
            const 原标题 = String(b.原标题 || b.oldTitle || '').trim()
            const 改名 = 原标题 !== '' && 原标题 !== title
            const 旧行 = conn.prepare('SELECT * FROM memes WHERE title = ?').get(改名 ? 原标题 : title)
            if (改名 && !旧行) return 发JSON(res, 404, { ok: false, error: '原词条不存在，改不了标题' })
            if (改名 && conn.prepare('SELECT title FROM memes WHERE title = ?').get(title)) {
              return 发JSON(res, 409, { ok: false, error: `已经有「${title}」这个词条了，换个名字` })
            }
            // 设置页没传的字段沿用库里的（INSERT OR REPLACE / UPDATE 都会整行重建，别把 slug、other 冲掉）
            const aliases = b.aliases !== undefined
              ? String(b.aliases || '')
              : String((旧行 && 旧行.aliases) || '')
            let slug
            if (b.slug !== undefined) slug = String(b.slug || '')
            else {
              const 旧slug = 旧行 && 旧行.slug ? String(旧行.slug) : ''
              slug = 旧slug === '' || 旧slug === 原标题 ? title : 旧slug
            }
            const other = b.other !== undefined
              ? String(b.other || '')
              : String((旧行 && 旧行.other) || '')
            if (改名) {
              conn.prepare(
                'UPDATE memes SET title = ?, slug = ?, tags = ?, usage = ?, origin = ?, other = ?, summary = ?, aliases = ? WHERE title = ?',
              ).run(
                title,
                slug,
                String(b.tags || ''),
                String(b.usage || ''),
                String(b.origin || ''),
                other,
                String(b.summary || ''),
                aliases,
                原标题,
              )
            } else {
              conn.prepare(
                'INSERT OR REPLACE INTO memes (title, slug, tags, usage, origin, other, summary, aliases) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              ).run(
                title,
                slug,
                String(b.tags || ''),
                String(b.usage || ''),
                String(b.origin || ''),
                other,
                String(b.summary || ''),
                aliases,
              )
            }
            清别名索引() // 别名改过，子串索引立刻重建
            return 发JSON(res, 200, { ok: true, title, 原标题: 改名 ? 原标题 : undefined })
          }

          if (route === '/delete' && req.method === 'POST') {
            const conn = 开写库()
            if (!conn) return 发JSON(res, 500, { ok: false, error: '词库不可写' })
            const b = await 读请求体(req)
            const title = String(b.title || '').trim()
            if (!title) return 发JSON(res, 400, { ok: false, error: '缺 title' })
            conn.prepare('DELETE FROM memes WHERE title = ?').run(title)
            清别名索引() // 别名可能没了，子串索引立刻重建
            return 发JSON(res, 200, { ok: true })
          }

          return 发JSON(res, 404, { ok: false, error: `未知接口: ${route}` })
        } catch (e) {
          return 发JSON(res, 500, { ok: false, error: String((e && e.message) || e) })
        }
      },
    })
    日志('设置页 API 已注册')
  } catch (e) {
    日志('注册设置页 API 失败：' + (e && e.message))
  }
}
