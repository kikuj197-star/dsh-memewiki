/**
 * 梗百科 · 本地管理页的前端逻辑（原生 JS，无构建工具）
 *
 * 只跟同源的 /api 打交道，接口在 scripts/wiki-server.mjs。
 * 四个页签：词条库（增删改查）、补别名、改动审核、状态与说明。
 */

const API = '/api'
const 每页 = 40

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))
const esc = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const 数字 = (n) => Number(n || 0).toLocaleString('zh-CN')

// ---------- 请求 ----------

async function 取JSON(路径) {
  const r = await fetch(API + 路径, { cache: 'no-store' })
  let 数据 = null
  try { 数据 = await r.json() } catch { 数据 = null }
  if (!r.ok) throw new Error((数据 && 数据.error) || ('HTTP ' + r.status))
  return 数据
}

async function 发JSON(路径, 体) {
  const r = await fetch(API + 路径, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(体 || {}),
  })
  let 数据 = null
  try { 数据 = await r.json() } catch { 数据 = null }
  if (!r.ok) throw new Error((数据 && 数据.error) || ('HTTP ' + r.status))
  return 数据
}

// ---------- 小工具 ----------

let 提示计时 = null
function 提示(文, 种类) {
  const el = $('#toast')
  el.textContent = 文
  el.className = 'show' + (种类 ? ' ' + 种类 : '')
  clearTimeout(提示计时)
  提示计时 = setTimeout(() => { el.className = '' }, 2600)
}

const 规整别名 = (原文) => {
  const 见过 = new Set()
  const 结果 = []
  for (const 项 of String(原文 || '').split(/[,，、;；\n\r]+/)) {
    const v = 项.trim()
    if (!v) continue
    const k = v.toLowerCase()
    if (见过.has(k)) continue
    见过.add(k)
    结果.push(v)
  }
  return 结果.join(',')
}

/** ISO 时间戳 → 2026-11-09 16:05（本地时区）；认不出来就原样返回 */
function 格式化时间(s) {
  const 文 = String(s || '')
  if (!文) return ''
  const d = new Date(文.includes('T') || 文.endsWith('Z') ? 文 : 文.replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return 文
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

function 防抖(fn, 毫秒) {
  let t = null
  return (...参数) => { clearTimeout(t); t = setTimeout(() => fn(...参数), 毫秒) }
}

// ---------- 总览 / 页签 ----------

let 总览 = null
let 当前页签 = 'list'

async function 刷新总览() {
  try {
    总览 = await 取JSON('/state')
  } catch (e) {
    提示('读状态失败：' + e.message, 'err')
    return
  }
  const s = 总览
  $('#badge-total').textContent = 数字(s.total)
  $('#badge-noalias').textContent = 数字(s.无别名)
  $('#badge-pending').textContent = 数字(s.待审)
  $('#sub').textContent =
    '词条 ' + 数字(s.total) +
    ' · 没别名 ' + 数字(s.无别名) +
    ' · 待审核 ' + 数字(s.待审) +
    ' · 词库建于 ' + (s.builtAt || '未知') +
    ' · v' + s.版本
  渲染状态页(s)
  渲染同步(s.同步)
}

const 页签名 = ['list', 'alias', 'review', 'status']

function 切页签(名, 不写地址) {
  if (!页签名.includes(名)) 名 = 'list'
  当前页签 = 名
  for (const t of $$('#tabs .tab')) t.classList.toggle('active', t.dataset.tab === 名)
  for (const id of 页签名) {
    $('#tab-' + id).classList.toggle('hidden', id !== 名)
  }
  if (!不写地址 && location.hash !== '#' + 名) history.replaceState(null, '', '#' + 名)
  if (名 === 'list') 载入列表()
  if (名 === 'alias') 载入别名()
  if (名 === 'review') 载入审核()
  if (名 === 'status') 刷新总览()
}

// ---------- 词条列表 ----------

const 列表 = { q: '', filter: '全部', sort: 'title', offset: 0, total: 0, busy: false }

async function 载入列表() {
  if (列表.busy) return
  列表.busy = true
  const 体 = $('#list-body')
  体.innerHTML = '<tr><td colspan="6" class="empty">读着…</td></tr>'
  try {
    const d = await 取JSON('/list?q=' + encodeURIComponent(列表.q) +
      '&filter=' + encodeURIComponent(列表.filter) +
      '&sort=' + encodeURIComponent(列表.sort) +
      '&limit=' + 每页 + '&offset=' + 列表.offset)
    列表.total = d.total
    渲染列表(d)
  } catch (e) {
    体.innerHTML = '<tr><td colspan="6" class="empty">读列表失败：' + esc(e.message) + '</td></tr>'
  } finally {
    列表.busy = false
  }
}

function 渲染列表(d) {
  const 体 = $('#list-body')
  if (!d.items.length) {
    体.innerHTML = '<tr><td colspan="6" class="empty">' +
      (列表.q ? '没搜到「' + esc(列表.q) + '」' : '这个词库还是空的') + '</td></tr>'
    $('#list-pager').innerHTML = ''
    return
  }
  体.innerHTML = d.items.map((it) => {
    const 别名们 = String(it.aliases || '').split(',').filter(Boolean)
    const 别名文 = 别名们.slice(0, 6).map(esc).join('，') +
      (别名们.length > 6 ? ' <span class="muted">…共 ' + 别名们.length + ' 个</span>' : '')
    const 关键词 = Array.isArray(it.关键词) ? it.关键词 : []
    const 全部词 = 关键词.join('、')
    const 关键词文 = 关键词.length
      ? '<div class="kw-list">' +
          关键词.slice(0, 3).map((k) => '<span class="kw" title="' + esc(全部词) + '">' + esc(k) + '</span>').join('') +
          (关键词.length > 3 ? '<span class="kw more" title="' + esc(全部词) + '">+' + (关键词.length - 3) + '</span>' : '') +
        '</div>'
      : '<span class="muted">—</span>'
    return '<tr data-title="' + esc(it.title) + '">' +
      '<td class="title-cell" data-act="edit">' + esc(it.title) +
        (it.待审核 ? ' <span class="badge accent" title="站点有改动待审核">待审</span>' : '') +
        (it.别名数 === 0 ? ' <span class="badge warn" title="还没有别名，只能靠完整标题命中">无别名</span>' : '') +
      '</td>' +
      '<td class="aliases' + (别名们.length ? '' : ' none') + '">' + (别名们.length ? 别名文 : '（空）') + '</td>' +
      '<td class="tagline">' + esc(it.tags) + '</td>' +
      '<td>' + 关键词文 + '</td>' +
      '<td><div class="snippet">' + esc(it.summary || '（还没有摘要）') + '</div></td>' +
      '<td><div class="ops">' +
        '<button class="btn sm" data-act="edit">改</button>' +
        '<button class="btn sm danger" data-act="del">删</button>' +
      '</div></td>' +
    '</tr>'
  }).join('')

  const 页数 = Math.max(1, Math.ceil(d.total / 每页))
  const 第几页 = Math.floor(列表.offset / 每页) + 1
  $('#list-pager').innerHTML = 页数 > 1
    ? '<button class="btn sm" data-page="prev"' + (列表.offset === 0 ? ' disabled' : '') + '>上一页</button>' +
      '<span>第 ' + 第几页 + ' / ' + 页数 + ' 页 · 共 ' + 数字(d.total) + ' 条</span>' +
      '<button class="btn sm" data-page="next"' + (列表.offset + 每页 >= d.total ? ' disabled' : '') + '>下一页</button>'
    : '<span>共 ' + 数字(d.total) + ' 条</span>'
}

// ---------- 补别名 ----------

const 别名 = { q: '', offset: 0, total: 0, random: false, busy: false }

async function 载入别名() {
  if (别名.busy) return
  别名.busy = true
  const 容器 = $('#alias-list')
  容器.innerHTML = '<div class="empty">读着…</div>'
  try {
    const d = await 取JSON('/alias-queue?q=' + encodeURIComponent(别名.q) +
      '&limit=' + 每页 + '&offset=' + 别名.offset + (别名.random ? '&random=1' : ''))
    别名.total = d.total
    渲染别名(d)
  } catch (e) {
    容器.innerHTML = '<div class="empty">读不出来：' + esc(e.message) + '</div>'
  } finally {
    别名.busy = false
  }
}

function 渲染别名(d) {
  const 容器 = $('#alias-list')
  $('#alias-left').textContent = 数字(d.total) + ' 条待补'
  if (!d.items.length) {
    容器.innerHTML = '<div class="empty">' +
      (别名.q ? '没搜到「' + esc(别名.q) + '」' : '太好了，所有词条都有别名了 🎉') + '</div>'
    $('#alias-pager').innerHTML = ''
    return
  }
  容器.innerHTML = d.items.map((it) => {
    const 关键词 = (d.关键词 && d.关键词[it.title]) || []
    const 提示文 = it.summary || it.用法 || ''
    return '<div class="alias-row" data-title="' + esc(it.title) + '">' +
      '<div class="info">' +
        '<h3>' + esc(it.title) + '</h3>' +
        (it.tags ? '<div class="tagline">' + esc(it.tags) + '</div>' : '') +
        (提示文 ? '<div class="preview">' + esc(提示文.slice(0, 180)) + '</div>' : '') +
        (关键词.length
          ? '<div class="chips">' + 关键词.map((k) =>
              '<button class="chip" data-kw="' + esc(k) + '" title="点一下加进别名">+ ' + esc(k) + '</button>').join('') + '</div>'
          : '') +
      '</div>' +
      '<div>' +
        '<div class="alias-input-wrap">' +
          '<input class="input" data-alias-input placeholder="别名，逗号隔开：如 kskbl,康神" autocomplete="off" />' +
          '<button class="btn primary sm" data-act="save-alias">保存</button>' +
        '</div>' +
        (关键词.length
          ? '<div class="row" style="margin-top:6px">' +
              '<button class="btn sm ghost" data-act="all-kw" data-kws="' + esc(关键词.join(',')) + '">＋全部关键词（' + 关键词.length + '）</button>' +
              '<span class="muted small">站点给的检索词，加了能提高命中率</span>' +
            '</div>'
          : '') +
        '<div class="hint">回车保存并跳到下一条' +
          (关键词.length ? '；上面的关键词点一下就加进去，也能「全部关键词」一把加' : '') +
        '</div>' +
      '</div>' +
    '</div>'
  }).join('')

  const 页数 = Math.max(1, Math.ceil(d.total / 每页))
  const 第几页 = Math.floor(别名.offset / 每页) + 1
  $('#alias-pager').innerHTML = 页数 > 1
    ? '<button class="btn sm" data-page="prev"' + (别名.offset === 0 ? ' disabled' : '') + '>上一页</button>' +
      '<span>第 ' + 第几页 + ' / ' + 页数 + ' 页 · 共 ' + 数字(d.total) + ' 条</span>' +
      '<button class="btn sm" data-page="next"' + (别名.offset + 每页 >= d.total ? ' disabled' : '') + '>下一页</button>'
    : '<span>共 ' + 数字(d.total) + ' 条</span>'
}

async function 保存单条别名(行) {
  const 标题 = 行.dataset.title
  const 输入 = $('[data-alias-input]', 行)
  const 值 = 规整别名(输入.value)
  if (!值) { 跳到下一条别名输入(行); return }
  输入.disabled = true
  try {
    await 发JSON('/alias', { title: 标题, aliases: 值, mode: 'append' })
    行.classList.add('saved')
    提示('「' + 标题 + '」的别名存好了：' + 值, 'ok')
    刷新总览()
    跳到下一条别名输入(行)
  } catch (e) {
    提示('存不了：' + e.message, 'err')
    输入.disabled = false
  }
}

function 跳到下一条别名输入(行) {
  const 全部 = $$('.alias-row', $('#alias-list'))
  const 位置 = 全部.indexOf(行)
  for (let i = 位置 + 1; i < 全部.length; i++) {
    const 下一个 = $('[data-alias-input]', 全部[i])
    if (下一个 && !下一个.disabled) { 下一个.focus(); return }
  }
  // 这一页都补完了：自动翻页；最后一页就重新拉一次（补完的会从队列里消失）
  const 还有下页 = 别名.offset + 每页 < 别名.total
  if (还有下页) { 别名.offset += 每页; 载入别名() }
  else { 别名.offset = 0; 载入别名() }
}

async function 导入批量别名() {
  const 原文 = $('#alias-bulk-text').value
  const 行们 = 原文.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  if (!行们.length) { 提示('先粘几行进来', 'err'); return }
  let 成功 = 0
  const 失败 = []
  $('#alias-bulk-log').textContent = '导入中…'
  for (const 行 of 行们) {
    const m = /^(.+?)\s*(?:\||=>|:=)\s*(.+)$/.exec(行)
    if (!m) { 失败.push(行 + '（格式不对）'); continue }
    const 标题 = m[1].trim()
    const 别名文 = 规整别名(m[2])
    if (!标题 || !别名文) { 失败.push(行 + '（空）'); continue }
    try {
      await 发JSON('/alias', { title: 标题, aliases: 别名文, mode: 'append' })
      成功++
    } catch (e) {
      失败.push(标题 + '（' + e.message + '）')
    }
  }
  $('#alias-bulk-log').innerHTML = '导入 ' + 成功 + ' 条' +
    (失败.length ? '，失败 ' + 失败.length + ' 条：' + esc(失败.slice(0, 6).join('；')) : '')
  if (成功) { 提示('成功导入 ' + 成功 + ' 条别名', 'ok'); 载入别名(); 刷新总览() }
}

// ---------- 改动审核 ----------

const 审核 = {
  status: 'pending',
  offset: 0,
  total: 0,
  items: [],
  expanded: new Set(),
  showUnchanged: false,
  busy: false,
}

function 审核卡片(项, 序号) {
  const 展开 = 审核.expanded.has(项.title)
  const 变化数 = 项.变化.length
  // 别名排最前面：补别名是这个页面最主要的事
  const 字段们 = ['aliases', 'tags', 'usage', 'origin', 'other', 'summary']
  const 字段名 = { tags: '标签', usage: '用法', origin: '出处', other: '其他', summary: '摘要', aliases: '别名' }

  // 别名永远显示：就算正文没变，站点关键词也能顺手加进别名（这正是补别名的场景）
  const 字段块 = 字段们.filter((k) => k === 'aliases' || 审核.showUnchanged || 项.字段[k].变了).map((k) => {
    const f = 项.字段[k]
    const 默认本地 = !!String(f.本地 || '').trim()
    const 单选名 = 'f-' + 序号 + '-' + k

    if (k === 'aliases') {
      const 并集 = 项.别名并集.join(',')
      return '<div class="field-block" data-field="aliases">' +
        '<div class="field-label">别名 ' +
          (f.变了 ? '<span class="badge warn">别名不同</span>' : '<span class="badge">未变</span>') +
        '</div>' +
        '<div class="cols">' +
          '<div class="side' + (默认本地 ? ' pick' : '') + '" data-side="local" data-radio="' + 单选名 + '">' +
            '<div class="side-head"><input type="radio" name="' + 单选名 + '" value="local"' + (默认本地 ? '' : '') + ' /> 本地现有</div>' +
            '<pre>' + (f.本地 ? esc(f.本地) : '<em>（空）</em>') + '</pre>' +
          '</div>' +
          '<div class="side' + (默认本地 ? '' : ' pick') + '" data-side="site" data-radio="' + 单选名 + '">' +
            '<div class="side-head"><input type="radio" name="' + 单选名 + '" value="site" /> 站点最新</div>' +
            '<pre>' + (f.站点 ? esc(f.站点) : '<em>（空）</em>') + '</pre>' +
          '</div>' +
        '</div>' +
        '<div class="row" style="margin-top:9px">' +
          '<input class="input" data-alias-result value="' + esc(并集) + '" style="flex:1" ' +
            'placeholder="合并后的别名，逗号隔开" />' +
          '<button class="btn sm" data-act="union">取并集</button>' +
        '</div>' +
        (项.keywords && 项.keywords.length
          ? '<div class="chips">' + 项.keywords.map((w) =>
              '<button class="chip" data-kw="' + esc(w) + '">+ ' + esc(w) + '（站点关键词）</button>').join('') + '</div>'
          : '') +
      '</div>'
    }

    return '<div class="field-block" data-field="' + k + '">' +
      '<div class="field-label">' + 字段名[k] + ' ' +
        (f.变了 ? '<span class="badge warn">不同</span>' : '<span class="badge">未变</span>') +
      '</div>' +
      '<div class="cols">' +
        '<div class="side' + (默认本地 ? ' pick' : '') + '" data-side="local" data-radio="' + 单选名 + '">' +
          '<div class="side-head"><input type="radio" name="' + 单选名 + '" value="local"' + (默认本地 ? ' checked' : '') + ' /> 用本地</div>' +
          '<pre>' + (f.本地 ? esc(f.本地) : '<em>（空）</em>') + '</pre>' +
        '</div>' +
        '<div class="side' + (默认本地 ? '' : ' pick') + '" data-side="site" data-radio="' + 单选名 + '">' +
          '<div class="side-head"><input type="radio" name="' + 单选名 + '" value="site"' + (默认本地 ? '' : ' checked') + ' /> 用站点</div>' +
          '<pre>' + (f.站点 ? esc(f.站点) : '<em>（空）</em>') + '</pre>' +
        '</div>' +
      '</div>' +
    '</div>'
  }).join('')

  return '<div class="review-item" data-title="' + esc(项.title) + '">' +
    '<div class="review-head" data-act="toggle">' +
      '<h3>' + esc(项.title) + '</h3>' +
      (变化数 ? '<span class="badge warn">' + 变化数 + ' 项不同</span>' : '<span class="badge">无实质差异</span>') +
      (项.local ? '' : '<span class="badge accent">本地没有</span>') +
      '<span class="review-meta">站点更新于 ' + esc(格式化时间(项.site_updated_at) || '未知') + '</span>' +
      '<div class="spacer"></div>' +
      '<span class="muted small">' + (展开 ? '收起' : '展开') + '</span>' +
    '</div>' +
    '<div class="review-body' + (展开 ? '' : ' hidden') + '">' +
      字段块 +
      '<div class="review-actions">' +
        '<button class="btn sm ghost" data-act="reject">忽略这条</button>' +
        '<button class="btn sm primary" data-act="apply">合并选中</button>' +
      '</div>' +
    '</div>' +
  '</div>'
}

async function 载入审核() {
  if (审核.busy) return
  审核.busy = true
  const 容器 = $('#review-list')
  容器.innerHTML = '<div class="empty">读着…</div>'
  const 拉 = () => 取JSON('/pending?status=' + 审核.status + '&limit=' + 每页 + '&offset=' + 审核.offset)
  try {
    let d = await 拉()
    审核.total = (d.统计 && d.统计[审核.status]) || 0
    // 合并/忽略之后当前页可能空了：退回上一页再看一次
    if (!d.items.length && 审核.offset > 0) {
      审核.offset = Math.max(0, 审核.offset - 每页)
      d = await 拉()
      审核.total = (d.统计 && d.统计[审核.status]) || 0
    }
    审核.items = d.items
    渲染审核(d)
  } catch (e) {
    容器.innerHTML = '<div class="empty">读不出来：' + esc(e.message) + '</div>'
  } finally {
    审核.busy = false
  }
}

function 渲染审核(d) {
  const 容器 = $('#review-list')
  const 标签 = { pending: '待审核', applied: '已合并', rejected: '已忽略' }
  $('#review-count').textContent = 数字(审核.total) + ' 条' + 标签[审核.status]

  if (!d.items.length) {
    容器.innerHTML = '<div class="empty">' +
      (审核.status === 'pending'
        ? '还没有待审核的改动。点上面的「检查站点改动」扫一遍站点。'
        : '这个列表是空的。') + '</div>'
    $('#review-pager').innerHTML = ''
    return
  }

  // 默认展开第一条，省得每次都点
  if (审核.status === 'pending' && 审核.expanded.size === 0 && d.items.length) {
    审核.expanded.add(d.items[0].title)
  }
  容器.innerHTML = d.items.map((项, i) => 审核卡片(项, i)).join('')

  const 页数 = Math.max(1, Math.ceil(审核.total / 每页))
  const 第几页 = Math.floor(审核.offset / 每页) + 1
  $('#review-pager').innerHTML = 页数 > 1
    ? '<button class="btn sm" data-page="prev"' + (审核.offset === 0 ? ' disabled' : '') + '>上一页</button>' +
      '<span>第 ' + 第几页 + ' / ' + 页数 + ' 页 · 共 ' + 数字(审核.total) + ' 条</span>' +
      '<button class="btn sm" data-page="next"' + (审核.offset + 每页 >= 审核.total ? ' disabled' : '') + '>下一页</button>'
    : '<span>共 ' + 数字(审核.total) + ' 条</span>'
}

function 读取卡片选择(卡) {
  const 标题 = 卡.dataset.title
  const 项 = 审核.items.find((x) => x.title === 标题)
  const take = {}
  for (const k of ['tags', 'usage', 'origin', 'other', 'summary']) {
    const 块 = $('.field-block[data-field="' + k + '"]', 卡)
    if (!块) { take[k] = 项 && 项.local && String(项.local[k] || '').trim() ? 'local' : 'site'; continue }
    const 选 = $('input[type="radio"]:checked', 块)
    take[k] = 选 ? 选.value : 'local'
  }
  const 别名框 = $('[data-alias-result]', 卡)
  take.aliases = 别名框 ? 规整别名(别名框.value) : undefined
  return { title: 标题, take }
}

async function 合并卡片(卡) {
  const { title, take } = 读取卡片选择(卡)
  const 按钮 = $('[data-act="apply"]', 卡)
  if (按钮) { 按钮.disabled = true; 按钮.textContent = '合并中…' }
  try {
    const r = await 发JSON('/pending/apply', { items: [{ title, take }] })
    提示('已合并「' + title + '」', 'ok')
    审核.expanded.delete(title)
    审核.items = 审核.items.filter((x) => x.title !== title)
    await 载入审核()
    刷新总览()
  } catch (e) {
    提示('合并失败：' + e.message, 'err')
    if (按钮) { 按钮.disabled = false; 按钮.textContent = '合并选中' }
  }
}

async function 忽略卡片(卡) {
  const 标题 = 卡.dataset.title
  if (!window.confirm('忽略「' + 标题 + '」的这次站点改动？下次站点再改还会重新排队。')) return
  try {
    await 发JSON('/pending/reject', { titles: [标题] })
    提示('已忽略「' + 标题 + '」')
    审核.expanded.delete(标题)
    await 载入审核()
    刷新总览()
  } catch (e) {
    提示('忽略失败：' + e.message, 'err')
  }
}

// ---------- 同步 ----------

let 同步轮询 = null

function 渲染同步(s) {
  if (!s) return
  const 点 = $('#sync-dot')
  点.className = 'dot ' + (s.状态 === 'running' ? 'running' : s.状态 === 'done' ? 'done' : s.状态 === 'error' ? 'error' : '')
  const 标题 = $('#sync-title')
  const 细节 = $('#sync-detail')
  const 日志 = $('#sync-log')
  const 模式名 = { 'new': '只补新词条', 'stage': '检查改动', 'stage-force': '强制全量比对', '': '' }

  if (s.状态 === 'running') {
    标题.textContent = '正在' + (模式名[s.模式] || '同步') + '…'
    细节.textContent = s.开始于 ? '开始于 ' + s.开始于 + '（全站翻一遍大概 1–3 分钟）' : ''
    日志.classList.remove('hidden')
    日志.textContent = (s.输出 || []).slice(-40).join('\n')
    日志.scrollTop = 日志.scrollHeight
  } else if (s.状态 === 'done') {
    标题.textContent = '同步完成'
    const r = s.结果
    细节.textContent = r
      ? '扫描 ' + 数字(r.scanned) + ' 条 · 新增 ' + 数字(r.added) + ' 条 · 待审核 ' + 数字(r.staged) + ' 条' +
        (r.failed ? ' · 失败 ' + r.failed + ' 条' : '') + ' · 结束于 ' + (s.结束于 || '')
      : '结束于 ' + (s.结束于 || '')
    日志.classList.remove('hidden')
    日志.textContent = (s.输出 || []).slice(-40).join('\n')
  } else if (s.状态 === 'error') {
    标题.textContent = '同步失败'
    细节.textContent = s.错误 || ''
    日志.classList.remove('hidden')
    日志.textContent = (s.输出 || []).slice(-40).join('\n')
  } else {
    标题.textContent = '还没同步过'
    const 上次 = 总览 && 总览.checkedAt
    细节.textContent = 上次
      ? '上次检查站点：' + 上次 + '（再点「检查站点改动」扫一遍）'
      : '点「检查站点改动」扫一遍 cnmeme.wiki'
    日志.classList.add('hidden')
  }
  const 忙 = s.状态 === 'running'
  for (const id of ['#btn-check', '#btn-check2', '#btn-force', '#btn-sync-new', '#btn-sync-new2']) {
    const b = $(id)
    if (b) b.disabled = 忙
  }
}

async function 启动同步(模式, 强制) {
  if (模式 === 'stage' && 强制) {
    if (!window.confirm('强制全量比对会把「上次构建以来站点改过」的老词条全部列进审核区，可能一次冒出很多条。继续？')) return
  }
  if (模式 === 'stage' && !强制) {
    const 继续 = window.confirm(
      '现在扫一遍 cnmeme.wiki：\n\n' +
      '· 站点上的新词条 → 直接补进本地词库\n' +
      '· 已有词条被站点改过 → 排进「改动审核」，等你自己挑字段合并（不会自动覆盖）\n\n' +
      '整个过程 1–3 分钟，要开始吗？'
    )
    if (!继续) return
  }
  try {
    await 发JSON('/sync', { mode: 模式, force: !!强制 })
    提示('开始同步，进度在下面看')
    await 轮询同步()
  } catch (e) {
    提示('起不来同步：' + e.message, 'err')
  }
}

function 轮询同步() {
  clearTimeout(同步轮询)
  return 取JSON('/sync').then((s) => {
    渲染同步(s)
    if (s.状态 === 'running') {
      同步轮询 = setTimeout(() => { 轮询同步() }, 1500)
    } else if (s.状态 === 'done' || s.状态 === 'error') {
      const r = s.结果
      if (s.状态 === 'done' && r) {
        提示(
          '同步完成：新增 ' + r.added + ' 条' +
          (r.staged ? '，待审核 ' + r.staged + ' 条（去「改动审核」挑要合并的）' : '，没有需要审核的改动'),
          'ok',
        )
      } else if (s.状态 === 'error') {
        提示('同步失败：' + (s.错误 || '看下面的日志'), 'err')
      }
      刷新总览()
      if (当前页签 === 'review') 载入审核()
      if (当前页签 === 'list') 载入列表()
    }
  }).catch(() => {
    同步轮询 = setTimeout(() => { 轮询同步() }, 3000)
  })
}

// ---------- 状态页 ----------

function 渲染状态页(s) {
  const 格 = [
    ['词条总数', 数字(s.total), 'memes 表里的行数'],
    ['没有别名', 数字(s.无别名), '只能靠完整标题命中'],
    ['多个别名', 数字(s.多别名), '命中面更宽'],
    ['待审核改动', 数字(s.待审), '站点改过、等你合并'],
    ['站点关键词', 数字(s.有关键词), '梗维基给的检索词，可加成别名'],
    ['已合并', 数字(s.已合并), '这次同步以来'],
    ['已忽略', 数字(s.已忽略), '站点再改会重新排队'],
  ]
  $('#status-grid').innerHTML = 格.map(([k, v, 说]) =>
    '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div>' +
    '<div class="k" style="margin-top:4px">' + 说 + '</div></div>').join('')
  const 大小 = s.dbSize ? (s.dbSize / 1024 / 1024).toFixed(1) + ' MB' : '?'
  $('#status-paths').innerHTML =
    '文件：<code>' + esc(s.db) + '</code>（' + 大小 + '）<br />' +
    '上次构建：' + esc(s.builtAt || '未知') + ' · 上次检查站点：' + esc(s.checkedAt || '还没检查过') + '<br />' +
    '插件版本：v' + esc(s.版本) + ' · 这个页面：http://127.0.0.1:' + s.port + '/'
}

// ---------- 编辑抽屉 ----------

async function 直接删除(标题) {
  if (!window.confirm('删掉「' + 标题 + '」？撤不回来。\n\n注意：这个词条如果站点上还有，下次同步会被当成新词条加回来。')) return
  try {
    await 发JSON('/delete', { title: 标题 })
    提示('删了：' + 标题)
    刷新总览()
    载入列表()
  } catch (e) {
    提示('删除失败：' + e.message, 'err')
  }
}

let 抽屉原值 = null
let 抽屉脏 = false

function 开抽屉(标题) {
  const 新 = !标题
  $('#drawer-title').textContent = 新 ? '新建词条' : '编辑：' + 标题
  $('#drawer-body').innerHTML = '<div class="empty">读着…</div>'
  $('#drawer-foot').innerHTML = ''
  $('#overlay').classList.add('open')
  $('#drawer').classList.add('open')
  $('#drawer').setAttribute('aria-hidden', 'false')

  const 数据 = 新
    ? { title: '', 原标题: '', aliases: '', tags: '', usage: '', origin: '', summary: '', other: '', slug: '', isNew: true, 关键词: [] }
    : null

  const 完成 = (行) => {
    抽屉脏 = false
    渲染抽屉(行, 新)
    if (新) setTimeout(() => { $('#f-title')?.focus() }, 30)
  }
  if (新) 完成(数据)
  else {
    取JSON('/get?title=' + encodeURIComponent(标题)).then((d) => {
      完成({
        title: d.item.title, 原标题: d.item.title,
        aliases: d.item.aliases || '', tags: d.item.tags || '',
        usage: d.item.usage || '', origin: d.item.origin || '',
        summary: d.item.summary || '', other: d.item.other || '',
        slug: d.item.slug || '', isNew: false,
        关键词: Array.isArray(d.keywords) ? d.keywords : [],
      })
    }).catch((e) => {
      $('#drawer-body').innerHTML = '<div class="empty">读不到：' + esc(e.message) + '</div>'
    })
  }
}

function 渲染抽屉(v, 新) {
  const 字段 = (id, 标签, 值, 提示文, 行数) => {
    const 标签行 = '<label for="' + id + '">' + 标签 + (提示文 ? '<span class="muted" style="font-weight:400"> · ' + 提示文 + '</span>' : '') + '</label>'
    return '<div class="form-field">' + 标签行 +
      (行数
        ? '<textarea class="textarea" id="' + id + '" rows="' + 行数 + '">' + esc(值) + '</textarea>'
        : '<input class="input" id="' + id + '" value="' + esc(值) + '" autocomplete="off" />') +
      '</div>'
  }

  $('#drawer-body').innerHTML =
    '<div class="form-field">' +
      '<label for="f-title"><b>标题</b>（梗名 / 黑话；改标题会跟着改索引）</label>' +
      '<input class="input" id="f-title" value="' + esc(v.title) + '" autocomplete="off" />' +
    '</div>' +
    字段('f-aliases', '<b>别名</b>', v.aliases, '逗号隔开。群里的俗称、缩写、口头禅、谐音都填这里，查词命中靠它') +
    (v.关键词 && v.关键词.length
      ? '<div class="form-field">' +
          '<label>站点关键词<span class="muted" style="font-weight:400"> · 梗维基给的检索词，点一下加进上面的别名</span></label>' +
          '<div class="chips">' +
            v.关键词.map((k) => '<button type="button" class="chip" data-kw="' + esc(k) + '">+ ' + esc(k) + '</button>').join('') +
          '</div>' +
          '<div class="row" style="margin-top:7px">' +
            '<button type="button" class="btn sm ghost" id="f-allkw">全部加入别名</button>' +
            '<span class="muted small">' + v.关键词.length + ' 个关键词</span>' +
          '</div>' +
        '</div>'
      : '') +
    字段('f-tags', '标签', v.tags, '逗号或顿号隔开') +
    '<div class="form-field">' +
      '<label for="f-summary">摘要<span class="muted" style="font-weight:400"> · 梗维基原文，可能带「来源」前缀或被站点截断</span></label>' +
      '<textarea class="textarea" id="f-summary" rows="3">' + esc(v.summary) + '</textarea>' +
    '</div>' +
    字段('f-usage', '怎么用 / 怎么接', v.usage, '模型优先看这一段', 7) +
    字段('f-origin', '出处 / 来历', v.origin, '', 7) +
    '<details' + (v.other ? ' open' : '') + '>' +
      '<summary>其他小节（' + (v.other ? v.other.split(/\n\n+/).length + ' 段' : '空') + '）</summary>' +
      '<textarea class="textarea" id="f-other" rows="8">' + esc(v.other) + '</textarea>' +
      '<div class="hint">来源和用法之外的内容，比如演化、争议、相关梗。来自站点的数据会拆成「## 小节」的样子。</div>' +
    '</details>' +
    (v.slug ? '<div class="hint" style="margin-top:10px">站点 slug：<code>' + esc(v.slug) + '</code></div>' : '') +
    '<div class="hint" style="margin-top:10px">存完立刻生效，下一轮对话就能查到。</div>'

  $('#drawer-foot').innerHTML =
    (新 ? '' : '<button class="btn danger" id="f-del">删除这条</button>') +
    '<div class="spacer"></div>' +
    '<button class="btn" id="f-cancel">取消</button>' +
    '<button class="btn primary" id="f-save">保存</button>'

  const 读值 = () => ({
    title: $('#f-title').value.trim(),
    原标题: v.原标题,
    aliases: 规整别名($('#f-aliases').value),
    tags: $('#f-tags').value.trim(),
    summary: $('#f-summary').value.trim(),
    usage: $('#f-usage').value.trim(),
    origin: $('#f-origin').value.trim(),
    other: $('#f-other').value.trim(),
    slug: v.slug,
    isNew: 新,
  })

  const 检查脏 = () => {
    抽屉脏 = JSON.stringify(读值()) !== 抽屉原值
  }
  for (const el of $$('#drawer-body input, #drawer-body textarea')) el.addEventListener('input', 检查脏)
  // 以规范化之后的值为基准，别因为别名的空格/去重被判成"改过"
  抽屉原值 = JSON.stringify(读值())

  // 站点关键词：点一个加一个，或者一次全加
  const 别名框 = $('#f-aliases')
  const 加进别名 = (词) => {
    if (!词) return
    别名框.value = 规整别名([别名框.value, 词].filter(Boolean).join(','))
    检查脏()
  }
  for (const b of $$('#drawer-body [data-kw]')) {
    b.addEventListener('click', () => { 加进别名(b.dataset.kw); 别名框.focus() })
  }
  const 全加 = $('#f-allkw')
  if (全加) 全加.addEventListener('click', () => {
    for (const k of (v.关键词 || [])) 加进别名(k)
    别名框.focus()
    提示('关键词已加进别名，记得点保存')
  })

  $('#f-save').addEventListener('click', async () => {
    const 值 = 读值()
    if (!值.title) { 提示('标题不能空', 'err'); return }
    const 按钮 = $('#f-save')
    按钮.disabled = true
    按钮.textContent = '存着…'
    try {
      await 发JSON('/save', 值)
      抽屉脏 = false
      提示(新 ? '建好了：' + 值.title : '存好了：' + 值.title, 'ok')
      关抽屉()
      刷新总览()
      if (当前页签 === 'list') 载入列表()
      if (当前页签 === 'alias') 载入别名()
    } catch (e) {
      提示('保存失败：' + e.message, 'err')
      按钮.disabled = false
      按钮.textContent = '保存'
    }
  })

  $('#f-cancel').addEventListener('click', 关抽屉)

  const 删 = $('#f-del')
  if (删) 删.addEventListener('click', async () => {
    if (!window.confirm('删掉「' + v.原标题 + '」？撤不回来。\n\n注意：这个词条如果站点上还有，下次同步会被当成新词条加回来。')) return
    try {
      await 发JSON('/delete', { title: v.原标题 })
      抽屉脏 = false
      提示('删了：' + v.原标题)
      关抽屉()
      刷新总览()
      if (当前页签 === 'list') 载入列表()
    } catch (e) {
      提示('删除失败：' + e.message, 'err')
    }
  })
}

function 关抽屉() {
  if (抽屉脏 && !window.confirm('改了还没保存，确定关掉？')) return
  抽屉脏 = false
  $('#overlay').classList.remove('open')
  $('#drawer').classList.remove('open')
  $('#drawer').setAttribute('aria-hidden', 'true')
}

// ---------- 事件绑定 ----------

function 绑定() {
  // 页签
  $('#tabs').addEventListener('click', (e) => {
    const 按钮 = e.target.closest('.tab')
    if (按钮) 切页签(按钮.dataset.tab)
  })
  window.addEventListener('hashchange', () => {
    切页签(location.hash.replace('#', '') || 'list', true)
  })

  // 词条库
  $('#list-q').addEventListener('input', (e) => {
    $('#list-clear').classList.toggle('hidden', !e.target.value)
  })
  $('#list-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { 列表.q = e.target.value.trim(); 列表.offset = 0; 载入列表() }
  })
  $('#list-clear').addEventListener('click', () => {
    $('#list-q').value = ''; $('#list-clear').classList.add('hidden')
    列表.q = ''; 列表.offset = 0; 载入列表()
  })
  $('#list-filter').addEventListener('change', (e) => { 列表.filter = e.target.value; 列表.offset = 0; 载入列表() })
  $('#list-sort').addEventListener('change', (e) => { 列表.sort = e.target.value; 列表.offset = 0; 载入列表() })
  $('#btn-new').addEventListener('click', () => 开抽屉(null))

  $('#list-body').addEventListener('click', (e) => {
    const 行 = e.target.closest('tr[data-title]')
    if (!行) return
    const 动作 = e.target.closest('[data-act]')?.dataset.act || 'edit'
    const 标题 = 行.dataset.title
    if (动作 === 'del') { 直接删除(标题); return }
    开抽屉(标题)
  })

  $('#list-pager').addEventListener('click', (e) => {
    const 按钮 = e.target.closest('[data-page]')
    if (!按钮) return
    if (按钮.dataset.page === 'prev') 列表.offset = Math.max(0, 列表.offset - 每页)
    else 列表.offset += 每页
    载入列表()
  })

  // 补别名
  $('#alias-q').addEventListener('input', (e) => {
    $('#alias-clear').classList.toggle('hidden', !e.target.value)
  })
  $('#alias-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { 别名.q = e.target.value.trim(); 别名.offset = 0; 别名.random = false; 载入别名() }
  })
  $('#alias-clear').addEventListener('click', () => {
    $('#alias-q').value = ''; $('#alias-clear').classList.add('hidden')
    别名.q = ''; 别名.offset = 0; 载入别名()
  })
  $('#alias-random').addEventListener('click', () => {
    别名.random = true; 别名.offset = 0; 载入别名()
  })
  $('#alias-bulk-toggle').addEventListener('click', () => {
    $('#alias-bulk').classList.toggle('hidden')
  })
  $('#alias-bulk-run').addEventListener('click', 导入批量别名)

  $('#alias-list').addEventListener('click', (e) => {
    const 关键词 = e.target.closest('[data-kw]')
    if (关键词) {
      const 行 = 关键词.closest('.alias-row')
      const 输入 = $('[data-alias-input]', 行)
      输入.value = 规整别名([输入.value, 关键词.dataset.kw].filter(Boolean).join(','))
      输入.focus()
      return
    }
    const 全部关键词 = e.target.closest('[data-act="all-kw"]')
    if (全部关键词) {
      const 行 = 全部关键词.closest('.alias-row')
      const 输入 = $('[data-alias-input]', 行)
      输入.value = 规整别名([输入.value, 全部关键词.dataset.kws].filter(Boolean).join(','))
      输入.focus()
      return
    }
    const 保存 = e.target.closest('[data-act="save-alias"]')
    if (保存) {
      const 行 = 保存.closest('.alias-row')
      保存单条别名(行)
    }
  })
  $('#alias-list').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const 输入 = e.target.closest('[data-alias-input]')
    if (!输入) return
    e.preventDefault()
    const 行 = 输入.closest('.alias-row')
    if (!输入.value.trim()) { 跳到下一条别名输入(行); return }
    保存单条别名(行)
  })
  $('#alias-pager').addEventListener('click', (e) => {
    const 按钮 = e.target.closest('[data-page]')
    if (!按钮) return
    if (按钮.dataset.page === 'prev') 别名.offset = Math.max(0, 别名.offset - 每页)
    else 别名.offset += 每页
    载入别名()
  })

  // 审核
  $('#btn-check').addEventListener('click', () => 启动同步('stage', false))
  $('#btn-check2').addEventListener('click', () => 启动同步('stage', false))
  $('#btn-force').addEventListener('click', () => 启动同步('stage', true))
  $('#btn-sync-new').addEventListener('click', () => 启动同步('new', false))
  $('#btn-sync-new2').addEventListener('click', () => 启动同步('new', false))

  $('#review-filter').addEventListener('change', (e) => {
    审核.status = e.target.value; 审核.offset = 0; 审核.expanded.clear(); 载入审核()
  })
  $('#review-show-unchanged').addEventListener('change', (e) => {
    审核.showUnchanged = e.target.checked; 渲染审核({ items: 审核.items })
  })
  $('#review-expand').addEventListener('click', () => {
    for (const 项 of 审核.items) 审核.expanded.add(项.title)
    渲染审核({ items: 审核.items })
  })
  $('#review-collapse').addEventListener('click', () => {
    审核.expanded.clear(); 渲染审核({ items: 审核.items })
  })
  $('#review-ignore-all').addEventListener('click', async () => {
    if (审核.status !== 'pending') { 提示('只在「待审核」页才能全部忽略'); return }
    if (!审核.total) { 提示('现在没有待审核的改动'); return }
    if (!window.confirm('把当前筛选下的 ' + 审核.total + ' 条改动全部忽略？\n忽略后站点再改这些词条才会重新排队。')) return
    try {
      await 发JSON('/pending/reject', { all: true })
      提示('已全部忽略')
      审核.expanded.clear()
      载入审核(); 刷新总览()
    } catch (e) { 提示('忽略失败：' + e.message, 'err') }
  })

  $('#review-list').addEventListener('click', (e) => {
    const 卡 = e.target.closest('.review-item')
    if (!卡) return

    // 点某一侧 = 选中这一侧
    const 侧 = e.target.closest('.side')
    if (侧) {
      const 块 = 侧.closest('.field-block')
      const 名 = 侧.dataset.radio
      for (const r of $$('input[type="radio"][name="' + 名 + '"]', 块)) r.checked = r.value === 侧.dataset.side
      for (const s of $$('.side', 块)) s.classList.toggle('pick', s === 侧)
      if (侧.closest('.field-block').dataset.field === 'aliases') {
        const 框 = $('[data-alias-result]', 块)
        const 标题 = 卡.dataset.title
        const 项 = 审核.items.find((x) => x.title === 标题)
        if (框 && 项) {
          框.value = 侧.dataset.side === 'local' ? 项.字段.aliases.本地 : 项.字段.aliases.站点
        }
      }
      return
    }

    const 关键词 = e.target.closest('[data-kw]')
    if (关键词) {
      const 块 = 关键词.closest('.field-block')
      const 框 = $('[data-alias-result]', 块)
      if (框) { 框.value = 规整别名([框.value, 关键词.dataset.kw].filter(Boolean).join(',')); 框.focus() }
      return
    }
    if (e.target.closest('[data-act="union"]')) {
      const 块 = 关键词 ? 关键词.closest('.field-block') : e.target.closest('.field-block')
      const 标题 = 卡.dataset.title
      const 项 = 审核.items.find((x) => x.title === 标题)
      const 框 = 块 && $('[data-alias-result]', 块)
      if (框 && 项) 框.value = 项.别名并集.join(',')
      return
    }
    if (e.target.closest('[data-act="apply"]')) { 合并卡片(卡); return }
    if (e.target.closest('[data-act="reject"]')) { 忽略卡片(卡); return }
    if (e.target.closest('[data-act="toggle"]')) {
      const 标题 = 卡.dataset.title
      if (审核.expanded.has(标题)) 审核.expanded.delete(标题)
      else 审核.expanded.add(标题)
      const 体 = $('.review-body', 卡)
      体.classList.toggle('hidden')
      const 提示文 = $('.review-head .muted.small', 卡)
      if (提示文) 提示文.textContent = 审核.expanded.has(标题) ? '收起' : '展开'
    }
  })

  $('#review-pager').addEventListener('click', (e) => {
    const 按钮 = e.target.closest('[data-page]')
    if (!按钮) return
    if (按钮.dataset.page === 'prev') 审核.offset = Math.max(0, 审核.offset - 每页)
    else 审核.offset += 每页
    审核.expanded.clear()
    载入审核()
  })

  // 抽屉 / 遮罩
  $('#overlay').addEventListener('click', 关抽屉)
  $('#drawer-close').addEventListener('click', 关抽屉)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#drawer').classList.contains('open')) 关抽屉()
    if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) {
      e.preventDefault()
      const 框 = 当前页签 === 'list' ? $('#list-q') : 当前页签 === 'alias' ? $('#alias-q') : null
      框?.focus()
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's' && $('#drawer').classList.contains('open')) {
      e.preventDefault()
      $('#f-save')?.click()
    }
  })

  // 导出
  $('#btn-export-json').addEventListener('click', () => { window.location.href = API + '/export?format=json' })
  $('#btn-export-csv').addEventListener('click', () => { window.location.href = API + '/export?format=csv' })
}

// ---------- 启动 ----------

async function 启动() {
  绑定()
  await 刷新总览()
  // 支持 /?q=xxx&filter=有关键词#list 这种直链（也方便截图和贴给别人）
  try {
    const 参 = new URLSearchParams(location.search)
    if (参.get('q')) { 列表.q = 参.get('q'); $('#list-q').value = 列表.q; $('#list-clear').classList.remove('hidden') }
    if (参.get('filter')) { 列表.filter = 参.get('filter'); $('#list-filter').value = 列表.filter }
  } catch { /* ignore */ }
  切页签(location.hash.replace('#', '') || 'list', true)
  // 上次会话可能还在同步中：接着看进度
  try {
    const s = await 取JSON('/sync')
    if (s && s.状态 === 'running') 轮询同步()
  } catch { /* ignore */ }
}

启动()
