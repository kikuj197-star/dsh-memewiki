/**
 * dsh-memewiki —— 浏览器半侧（手写的 __ModuleLoader__ bundle，无需构建工具）。
 *
 * 注册一个「梗百科」设置页（slot: settings.section）：
 *   - 看词库有多少条、搜词条；
 *   - 点开一条改「用法 / 出处 / 摘要 / 标签」；
 *   - 自己新建词条（标题 + 内容），马上生效（下一轮对话就能查到）。
 *
 * 与宿主端只走同源 HTTP（/api/memewiki/*），不碰 RPC。
 */

window.__ModuleLoader__.load({
  id: 'dsh-memewiki',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var Component = React.Component
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useMemo = React.useMemo
    var useState = React.useState
    var useRef = React.useRef
    var Fragment = React.Fragment

    var API = '/api/memewiki'

    // ---- 同源 API ---------------------------------------------------------

    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try { data = text === '' ? null : JSON.parse(text) } catch (e) { data = null }
        if (!res.ok) {
          var msg = data && data.error ? data.error : ('HTTP ' + res.status)
          throw new Error(msg)
        }
        return data
      })
    }
    function apiGet(path) {
      return fetch(API + path, { cache: 'no-store' }).then(readJson)
    }
    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    // ---- 样式 -------------------------------------------------------------

    var CSS = [
      '.mw-root{display:flex;flex-direction:column;gap:14px;padding:4px 2px 24px;min-width:0;font-size:13px}',
      '.mw-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.mw-title{font-size:15px;font-weight:600}',
      '.mw-sub{opacity:.62;font-size:12px}',
      '.mw-search{display:flex;gap:8px;flex:1;min-width:220px;flex-wrap:wrap;align-items:center}',
      '.mw-input{flex:1;min-width:0;padding:7px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.34);background:transparent;color:inherit;font:inherit;outline:none}',
      '.mw-input:focus{border-color:rgba(120,170,255,.8)}',
      '.mw-btn{padding:7px 12px;border-radius:8px;border:1px solid rgba(127,127,127,.34);background:transparent;color:inherit;font:inherit;cursor:pointer;white-space:nowrap}',
      '.mw-btn:hover{background:rgba(127,127,127,.12)}',
      '.mw-btn.primary{border-color:rgba(120,170,255,.75);background:rgba(120,170,255,.16)}',
      '.mw-btn.danger{border-color:rgba(255,110,110,.5);color:rgba(255,130,130,.95)}',
      '.mw-list{display:flex;flex-direction:column;border:1px solid rgba(127,127,127,.22);border-radius:10px;overflow:hidden;max-height:46vh;overflow-y:auto}',
      '.mw-row{display:flex;align-items:flex-start;gap:10px;padding:9px 11px;border-bottom:1px solid rgba(127,127,127,.14)}',
      '.mw-row:last-child{border-bottom:none}',
      '.mw-row:hover{background:rgba(127,127,127,.08)}',
      '.mw-row-main{flex:1;min-width:0}',
      '.mw-name{font-weight:600;margin-bottom:2px}',
      '.mw-tags{font-size:11px;opacity:.6;margin-left:6px;font-weight:400}',
      '.mw-desc{font-size:12px;opacity:.72;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mw-empty{padding:18px;text-align:center;opacity:.55}',
      '.mw-edit{border:1px solid rgba(127,127,127,.28);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:9px;background:rgba(127,127,127,.05)}',
      '.mw-field{display:flex;flex-direction:column;gap:4px}',
      '.mw-field label{font-size:12px;opacity:.68}',
      '.mw-area{min-height:64px;resize:vertical;font:inherit;line-height:1.5;padding:7px 9px;border-radius:8px;border:1px solid rgba(127,127,127,.34);background:transparent;color:inherit;outline:none}',
      '.mw-area:focus{border-color:rgba(120,170,255,.8)}',
      '.mw-actions{display:flex;gap:8px;justify-content:flex-end}',
      '.mw-note{font-size:12px;padding:8px 10px;border-radius:8px;background:rgba(120,170,255,.12);border:1px solid rgba(120,170,255,.28)}',
      '.mw-note.err{background:rgba(255,110,110,.12);border-color:rgba(255,110,110,.4)}',
      '.mw-pager{display:flex;align-items:center;gap:10px;justify-content:center;font-size:12px;opacity:.8}',
      '.mw-toggle{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:10px;border:1px solid rgba(127,127,127,.22);background:rgba(127,127,127,.05)}',
      '.mw-check{display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:600}',
      '.mw-check input{width:15px;height:15px;cursor:pointer}',
      '.mw-slider{display:flex;align-items:center;gap:10px;margin-top:8px}',
      '.mw-slider input[type=range]{flex:1;cursor:pointer}',
      '.mw-slider span{font-size:12px;opacity:.85;white-space:nowrap}',
      '.mw-tabs{display:flex;gap:6px;padding:0 0 2px}',
      '.mw-tab{padding:6px 13px;border-radius:8px;border:1px solid transparent;background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer;opacity:.62}',
      '.mw-tab:hover{background:rgba(127,127,127,.1);opacity:.9}',
      '.mw-tab.active{opacity:1;border-color:rgba(120,170,255,.45);background:rgba(120,170,255,.14);font-weight:600}',
      '.mw-about{display:flex;flex-direction:column;gap:18px;padding:20px 2px 24px;max-width:720px}',
      '.mw-hero{display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:14px;border:1px solid rgba(127,127,127,.22);background:linear-gradient(135deg,rgba(120,170,255,.15),rgba(127,127,127,.05))}',
      '.mw-logo{width:58px;height:58px;border-radius:15px;display:flex;align-items:center;justify-content:center;font-size:29px;line-height:1;background:rgba(120,170,255,.17);border:1px solid rgba(120,170,255,.36);flex:none}',
      '.mw-hero-name{font-size:17px;font-weight:650;line-height:1.25}',
      '.mw-hero-meta{font-size:12px;opacity:.6;margin-top:3px}',
      '.mw-sec{display:flex;flex-direction:column;gap:8px}',
      '.mw-sec-h{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}',
      '.mw-p{margin:0;font-size:12.5px;line-height:1.72;opacity:.8}',
      '.mw-links{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.mw-url{display:block;padding:7px 9px;border-radius:8px;border:1px dashed rgba(127,127,127,.35);background:rgba(127,127,127,.06);font-size:12px;line-height:1.4;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:text}',
      '.mw-credits{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font-size:12.5px;line-height:1.65;opacity:.82}',
      '.mw-source{padding:11px 13px;border-radius:10px;border:1px solid rgba(120,170,255,.3);background:rgba(120,170,255,.1);display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12.5px}',
      '.mw-source-label{opacity:.85}',
      '.mw-foot{text-align:center;font-size:12px;opacity:.55;padding:2px 0 8px}',
      '.mw-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}',
      '.mw-table th,.mw-table td{text-align:left;padding:6px 8px;border-bottom:1px solid rgba(127,127,127,.18);vertical-align:top}',
      '.mw-table th{font-weight:600;opacity:.62;white-space:nowrap}',
    ].join('\n')

    function 串子档(v) {
      if (v <= 20) return '很低：很尊重，黑称不接'
      if (v <= 45) return '偏低：损操作可以，损长相不行'
      if (v <= 70) return '中等：跟着社区玩'
      return '很高：放开串，黑称也玩'
    }

    // ---- 设置页 -----------------------------------------------------------

    var PAGE = 40

    function 状态文案(s) {
      var 表 = { queued: '排队中', processing: '审核中', approved: '已通过', rejected: '被驳回', needs_review: '转人工审核' }
      return 表[s] || s || ''
    }

    function About(props) {
      var 版 = props.版本 || ''
      var 条数 = props.词条数 || 0
      var 建于 = props.builtAt || ''
      var 仓库 = 'https://github.com/kikuj197-star/dsh-memewiki'
      var 简介 = 条数
        ? '把 ' + 条数 + ' 条网络梗、缩写和黑话装进一个本地 SQLite 词库。'
        : '把网络梗、缩写和黑话装进一个本地 SQLite 词库。'
      return h('div', { className: 'mw-about' },
        h('div', { className: 'mw-hero' },
          h('div', { className: 'mw-logo' }, '🐳'),
          h('div', null,
            h('div', { className: 'mw-hero-name' }, '梗百科'),
            h('div', { className: 'mw-hero-meta' },
              'dsh-memewiki' +
              (版 ? ' · v' + 版 : '') +
              (条数 ? ' · ' + 条数 + ' 条词条' : '') +
              (建于 ? ' · 词库建于 ' + 建于 : '')),
          ),
        ),

        h('div', { className: 'mw-sec' },
          h('div', { className: 'mw-sec-h' }, '📖 项目简介'),
          h('p', { className: 'mw-p' },
            简介 + '你问「XX 是什么梗」的时候，它会在模型看到这句话之前先把词条查好塞进上下文，让模型直接接梗，不用硬猜。'),
          h('p', { className: 'mw-p' },
            '查词、注入全在本地，不联网、零依赖，只用 Node 自带的 node:sqlite。词条还能在设置页里自己增删改，改完下一轮对话就生效。'),
        ),

        h('div', { className: 'mw-sec' },
          h('div', { className: 'mw-sec-h' }, '⭐ 开源与支持'),
          h('p', { className: 'mw-p' },
            '项目以 MIT 协议开源，完全免费。如果它帮你接住了一个梗，去仓库点一颗 ⭐ 就是最直接的鼓励。'),
          h('div', { className: 'mw-links' },
            h('a', { className: 'mw-btn primary', href: 仓库, target: '_blank', rel: 'noopener noreferrer' }, '⭐ 去 GitHub 点亮 Star'),
            h('a', { className: 'mw-btn', href: 仓库 + '/issues', target: '_blank', rel: 'noopener noreferrer' }, '提 Issue / PR'),
          ),
          h('p', { className: 'mw-p' }, '仓库地址（按钮打不开时手动复制）：'),
          h('code', { className: 'mw-url' }, 仓库),
          h('p', { className: 'mw-p' },
            '遇到查不到的梗、错漏的释义，或者想要新功能，都欢迎来仓库说一声 —— 梗是大家一起补的。'),
        ),

        h('div', { className: 'mw-sec' },
          h('div', { className: 'mw-sec-h' }, '🙏 致谢'),
          h('p', { className: 'mw-p' }, '这个插件能接住梗，靠的是这些人和这些地方：'),
          h('ul', { className: 'mw-credits' },
            h('li', null, '🌐 梗维基 —— 词库的全部词条（来源、用法、标签、别名）都来自站上整理的内容'),
            h('li', null, '🐋 thawline —— DSH 版 dsh-memewiki 的作者，本仓库在它的基础上加了本地管理页与站点改动审核'),
            h('li', null, '🧩 in1t1a1 —— 原 AstrBot 插件 astrbot_plugin_memewiki 的作者，本插件从它移植而来'),
            h('li', null, '🛠️ DSH 官方 —— 插件体系、设置页插槽，还有 node:sqlite 的底子'),
          ),
          h('div', { className: 'mw-source' },
            h('span', { className: 'mw-source-label' }, '梗维基原网站：'),
            h('a', { href: 'https://cnmeme.wiki', target: '_blank', rel: 'noopener noreferrer' }, 'https://cnmeme.wiki'),
          ),
        ),

        h('div', { className: 'mw-foot' }, '💌 谢谢每一位还在用「梗百科」的你 —— 下次群里冒出怪词，别慌，先问我。'),
      )
    }

    function Section(props) {
      var [q, setQ] = useState('')
      var [items, setItems] = useState([])
      var [total, setTotal] = useState(0)
      var [offset, setOffset] = useState(0)
      var [stats, setStats] = useState(null)
      var [editing, setEditing] = useState(null)
      var [busy, setBusy] = useState(false)
      var [msg, setMsg] = useState(null)
      var [auto, setAuto] = useState(true)
      var [串子开, set串子开] = useState(false)
      var [串子度, set串子度] = useState(50)
      var [昵称, set昵称] = useState('大肥鱼')
      var 昵称基准 = useRef('大肥鱼')
      var [联系方式, set联系方式] = useState('')
      var 联系方式基准 = useRef('')
      var [反馈, set反馈] = useState(null)
      var [连中, set连中] = useState(false)
      var [上传中, set上传中] = useState('')
      var [版本, set版本] = useState('')
      var [更新, set更新] = useState(null)
      var [查更新中, set查更新中] = useState(false)
      var [视图, set视图] = useState('list')
      var [同步, set同步] = useState(null)
      var qRef = useRef('')

      var load = useCallback(function (query, off) {
        qRef.current = query || ''
        setBusy(true)
        apiGet('/list?q=' + encodeURIComponent(query || '') + '&limit=' + PAGE + '&offset=' + (off || 0))
          .then(function (d) {
            setItems((d && d.items) || [])
            setTotal((d && d.total) || 0)
            setOffset(off || 0)
            setMsg(null)
          })
          .catch(function (e) { setMsg({ kind: 'err', text: '读词库失败：' + e.message }) })
          .then(function () { setBusy(false) })
      }, [])

      useEffect(function () {
        apiGet('/state').then(function (d) {
          setStats(d)
          set版本((d && d.版本) || '')
          setAuto(d && typeof d.自动思考梗 === 'boolean' ? d.自动思考梗 : true)
          set串子开(!!(d && d.串子开关))
          set串子度(d && typeof d.串子程度 === 'number' ? d.串子程度 : 50)
          var 名 = d && typeof d.提交昵称 === 'string' && d.提交昵称 ? d.提交昵称 : '大肥鱼'
          set昵称(名)
          昵称基准.current = 名
        }).catch(function () {})
        load('', 0)
        apiGet('/sync').then(function (d) {
          if (d && d.状态 === 'running') set同步(d)
        }).catch(function () {})
        apiGet('/feedback').then(function (d) {
          if (!d || !d.ok) return
          set反馈(d)
          var 联 = typeof d.联系方式 === 'string' ? d.联系方式 : ''
          set联系方式(联)
          联系方式基准.current = 联
          // 记录里的状态是提交那一刻的快照：有还没出结果的，就顺手问一遍站点
          var 待查 = (d.提交记录 || []).some(function (r) {
            return r && r.请求id && r.状态 !== 'approved' && r.状态 !== 'rejected'
          })
          if (待查) {
            apiPost('/feedback/refresh', {})
              .then(function () { return apiGet('/feedback') })
              .then(function (x) { if (x && x.ok) set反馈(x) })
              .catch(function () {})
          }
        }).catch(function () {})
      }, [])

      function 检查更新() {
        set查更新中(true)
        set更新(null)
        apiGet('/check-update')
          .then(function (d) {
            set更新(d || { ok: false, error: '没拿到结果' })
            if (d && d.ok) set版本(d.当前 || 版本)
          })
          .catch(function (e) { set更新({ ok: false, error: e.message }) })
          .then(function () { set查更新中(false) })
      }

      function 更新词库() {
        if (同步 && 同步.状态 === 'running') return
        setMsg(null)
        set同步({ 状态: 'running', 输出: [], 新增: 0, 更新: 0, 总数: 0, 错误: '' })
        apiPost('/sync', {})
          .then(function (d) { if (d && d.状态) set同步(d.状态) })
          .catch(function (e) {
            set同步(null)
            setMsg({ kind: 'err', text: '起不来同步：' + e.message })
          })
      }

      // 同步跑着的时候每 2 秒看一眼；跑完刷新词条数，并把列表拉回第一页
      useEffect(function () {
        if (!同步 || 同步.状态 !== 'running') return
        var 停 = false
        var t = setTimeout(function () {
          apiGet('/sync').then(function (d) {
            if (停 || !d) return
            set同步(d)
            if (d.状态 === 'done' || d.状态 === 'error') {
              apiGet('/state').then(function (s) {
                setStats(s)
                set版本((s && s.版本) || '')
              }).catch(function () {})
              if (d.状态 === 'done') load(qRef.current, 0)
            }
          }).catch(function (e) {
            if (!停) setMsg({ kind: 'err', text: '同步状态读不出来：' + e.message })
          })
        }, 2000)
        return function () { 停 = true; clearTimeout(t) }
      }, [同步])

      function 切换串子() {
        var 下一个 = !串子开
        set串子开(下一个)
        apiPost('/config', { 串子开关: 下一个, 串子程度: 串子度 })
          .then(function (d) {
            set串子开(!!(d && d.串子开关))
            setMsg({
              kind: 'ok',
              text: 下一个
                ? '串子程度：接管了。以后玩梗的尺度按你拉的这根杆来。'
                : '串子程度：关。以后玩梗我自己判断，看它冲谁去。',
            })
          })
          .catch(function (e) { set串子开(!下一个); setMsg({ kind: 'err', text: '改不了：' + e.message }) })
      }

      function 存串子度(值) {
        var v = Math.max(0, Math.min(100, Math.round(值)))
        set串子度(v)
        apiPost('/config', { 串子开关: 串子开, 串子程度: v })
          .then(function (d) { set串子度(d && typeof d.串子程度 === 'number' ? d.串子程度 : v) })
          .catch(function (e) { setMsg({ kind: 'err', text: '改不了：' + e.message }) })
      }

      function 切换自动() {
        var 下一个 = !auto
        setAuto(下一个)
        apiPost('/config', { 自动思考梗: 下一个 })
          .then(function (d) {
            setAuto(!!(d && d.自动思考梗))
            setMsg({ kind: 'ok', text: 下一个 ? '自动思考梗：开。以后我察觉你在问梗，会自己去查。' : '自动思考梗：关。以后我不主动查，你叫我查我才查。' })
          })
          .catch(function (e) { setAuto(!下一个); setMsg({ kind: 'err', text: '改不了：' + e.message }) })
      }

      function 存昵称() {
        var v = String(昵称 || '').trim() || '大肥鱼'
        set昵称(v)
        if (v === 昵称基准.current) return
        apiPost('/config', { 提交昵称: v })
          .then(function (d) {
            var 存下 = d && typeof d.提交昵称 === 'string' && d.提交昵称 ? d.提交昵称 : v
            set昵称(存下)
            昵称基准.current = 存下
            setMsg({ kind: 'ok', text: '提交昵称改成「' + 存下 + '」了' })
          })
          .catch(function (e) { setMsg({ kind: 'err', text: '改不了：' + e.message }) })
      }

      function 存联系方式() {
        var v = String(联系方式 || '').trim()
        set联系方式(v)
        if (v === 联系方式基准.current) return
        apiPost('/config', { 联系方式: v })
          .then(function (d) {
            var 存下 = d && typeof d.联系方式 === 'string' ? d.联系方式 : v
            set联系方式(存下)
            联系方式基准.current = 存下
            setMsg({ kind: 'ok', text: v ? '联系方式存好了（只发给梗维基后台做溯源，不公开）' : '联系方式清空了' })
          })
          .catch(function (e) { setMsg({ kind: 'err', text: '存不了：' + e.message }) })
      }

      function 连接梗维基() {
        if (连中) return
        set连中(true)
        apiPost('/feedback/claim', {})
          .then(function (d) {
            if (!d || !d.ok) {
              setMsg({ kind: 'err', text: (d && d.error) || '领凭证失败' })
              return
            }
            setMsg({ kind: 'ok', text: '连上了，凭证有效期到 ' + (d.有效期 || '（没给日期）') + '。以后我就能帮你把纠正提交上去了。' })
            apiGet('/feedback').then(function (x) { if (x && x.ok) set反馈(x) }).catch(function () {})
          })
          .catch(function (e) { setMsg({ kind: 'err', text: '连不上：' + e.message }) })
          .then(function () { set连中(false) })
      }

      // 把本地这条词条整篇传到梗维基（站内会审核）
      function 上传(it) {
        if (上传中) return
        if (!反馈 || !反馈.已领证) {
          setMsg({ kind: 'err', text: '还没连梗维基：先去「反馈」页填联系方式，点「连接梗维基」' })
          return
        }
        set上传中(it.title)
        setMsg({ kind: 'ok', text: '正在把「' + it.title + '」传到梗维基…' })
        apiPost('/upload', { title: it.title })
          .then(function (d) {
            if (!d || !d.ok) {
              setMsg({ kind: 'err', text: (d && d.error) || '上传失败' })
              return
            }
            setMsg({ kind: 'ok', text: '「' + it.title + '」传上去了，梗维基已收下（请求号 ' + (d.请求id || '?') + '），等站内 AI 和真人审核。' })
            apiGet('/feedback').then(function (x) { if (x && x.ok) set反馈(x) }).catch(function () {})
          })
          .catch(function (e) { setMsg({ kind: 'err', text: '传不上去：' + e.message }) })
          .then(function () { set上传中('') })
      }

      function 搜索() { load(q, 0) }

      function 新建() {
        setEditing({ title: '', 原标题: '', tags: '', usage: '', origin: '', summary: '', aliases: '', isNew: true })
        setMsg(null)
      }

      function 编辑(it) {
        setMsg(null)
        var 用行 = function (row) {
          setEditing({
            title: row.title,
            原标题: row.title,
            tags: row.tags || '',
            usage: row.usage || '',
            origin: row.origin || '',
            summary: row.summary || '',
            aliases: row.aliases || '',
            isNew: false,
          })
        }
        // 列表里带不全所有字段，编辑前先按标题拉一次完整词条（别名就丢在这上面过）
        apiGet('/get?title=' + encodeURIComponent(it.title))
          .then(function (d) { 用行((d && d.item) || it) })
          .catch(function () { 用行(it) })
      }

      function 保存() {
        if (!editing) return
        var title = String(editing.title || '').trim()
        if (!title) { setMsg({ kind: 'err', text: '标题不能空' }); return }
        setBusy(true)
        apiPost('/save', editing)
          .then(function () {
            setMsg({ kind: 'ok', text: '存好了：' + title })
            setEditing(null)
            load(q, offset)
          })
          .catch(function (e) { setMsg({ kind: 'err', text: '保存失败：' + e.message }) })
          .then(function () { setBusy(false) })
      }

      function 删除(it) {
        if (!it) return
        if (!window.confirm('删掉「' + it.title + '」？撤不回来。')) return
        setBusy(true)
        apiPost('/delete', { title: it.title })
          .then(function () {
            setMsg({ kind: 'ok', text: '删了：' + it.title })
            load(q, offset)
          })
          .catch(function (e) { setMsg({ kind: 'err', text: '删除失败：' + e.message }) })
          .then(function () { setBusy(false) })
      }

      var 共 = stats && typeof stats.total === 'number' ? stats.total : total
      var 页数 = Math.max(1, Math.ceil(total / PAGE))
      var 第几页 = Math.floor(offset / PAGE) + 1

      // 「反馈」页：以后把东西交给梗维基的配置都放这儿
      var 反馈区 = h(Fragment, null,
        msg ? h('div', { className: 'mw-note' + (msg.kind === 'err' ? ' err' : '') }, msg.text) : null,

        h('div', { className: 'mw-toggle' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('span', { style: { fontWeight: 600 } }, '提交昵称'),
            h('input', {
              className: 'mw-input',
              style: { maxWidth: '220px' },
              value: 昵称,
              maxLength: 40,
              placeholder: '大肥鱼',
              onChange: function (e) { set昵称(e.target.value) },
              onBlur: 存昵称,
              onKeyDown: function (e) { if (e.key === 'Enter') e.target.blur() },
            }),
          ),
          h('div', { className: 'mw-sub' }, '以后把梗的纠正反馈给梗维基时，用这个名字署名。默认「大肥鱼」，随时能改。'),
        ),

        // 反馈规则单独一张卡，放在「反馈给梗维基」上面
        h('div', { className: 'mw-toggle' },
          h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '反馈规则'),
          h('div', { className: 'mw-sub' }, '· 你在聊天里纠正了某个梗、或者补了更准的用法，我会先接住，再问一句「要不要把这个纠正反馈给梗维基？」——你点头我才发，不偷偷发。'),
          h('div', { className: 'mw-sub' }, '· 只提交你要补的那一段（默认加在该梗「用法」小节的末尾），插件自己去拉原文、拼接、整篇提交，不用你把全文贴过来。'),
          h('div', { className: 'mw-sub' }, '· 也可以直接在「词条库」里点某条梗的「上传」，把本地改好的整篇内容传上去。'),
          h('div', { className: 'mw-sub' }, '· 提交后进站内审核：AI 先看，拿不准转人工。通过或驳回都会写进下面的「提交记录」，不是即时生效。'),
          h('div', { className: 'mw-sub' }, '· 署名用上面的「提交昵称」；联系方式只发给梗维基后台做溯源，不公开、不进词条。'),
          h('div', { className: 'mw-sub' }, '· 每张凭证 24 小时最多 20 次词条提交（反馈和上传合计），超了会被限流，别一口气连点。'),
        ),

        h('div', { className: 'mw-toggle' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('span', { style: { fontWeight: 600 } }, '反馈给梗维基'),
            h('input', {
              className: 'mw-input',
              style: { maxWidth: '260px' },
              value: 联系方式,
              maxLength: 200,
              placeholder: '部署者的邮箱或可联系账号',
              onChange: function (e) { set联系方式(e.target.value) },
              onBlur: 存联系方式,
              onKeyDown: function (e) { if (e.key === 'Enter') e.target.blur() },
            }),
            h('button', { className: 'mw-btn', onClick: 连接梗维基, disabled: 连中 },
              连中 ? '连…' : (反馈 && 反馈.已领证 ? '换一张凭证' : '连接梗维基')),
          ),
          h('div', { className: 'mw-sub' },
            (反馈 && 反馈.已领证 ? '已连接（凭证到 ' + (反馈.有效期 || '?') + '）。' : '还没连接。') +
            '你纠正我某个梗的时候，我会问要不要把纠正提交到梗维基；提交后由站内 AI 和真人审核。联系方式只发给梗维基后台做溯源，不公开、不进词条。'),
        ),

        // 提交记录单独一张卡，别跟上面的输入框挤在一起
        h('div', { className: 'mw-toggle' },
          h('div', { style: { fontWeight: 600, marginBottom: '2px' } }, '提交记录'),
          反馈 && 反馈.提交记录 && 反馈.提交记录.length
            ? h('table', { className: 'mw-table' },
                h('thead', null,
                  h('tr', null,
                    h('th', null, '时间'),
                    h('th', null, '梗'),
                    h('th', null, '状态'),
                    h('th', null, '审核备注'),
                  ),
                ),
                h('tbody', null,
                  反馈.提交记录.slice(0, 20).map(function (r) {
                    return h('tr', { key: (r.请求id || '') + (r.时间 || '') },
                      h('td', null, r.时间 || ''),
                      h('td', null, r.标题 || ''),
                      h('td', null, 状态文案(r.状态)),
                      h('td', null, r.审核 || ''),
                    )
                  }),
                ),
              )
            : h('div', { className: 'mw-sub' }, '还没有上传或反馈过。在「词条库」里点某条梗的「上传」，就能把本地改好的内容传到梗维基。'),
        ),
      )

      var 列表区 = h(Fragment, null,
        更新
          ? h('div', { className: 'mw-note' + (更新.ok === false || 更新.有更新 ? ' err' : '') },
              !更新.ok
                ? '检查更新失败：' + (更新.error || '不知道为啥')
                : 更新.有更新
                  ? '有新版本：v' + 更新.最新 + '（你现在 v' + 更新.当前 + '）→ ' + (更新.仓库 || '去 GitHub 拉新版')
                  : '已经是最新版本：v' + 更新.当前,
            )
          : null,

        同步
          ? h('div', { className: 'mw-note' + (同步.状态 === 'error' ? ' err' : '') },
              同步.状态 === 'running'
                ? '正在从梗维基同步词库… ' + (同步.输出 && 同步.输出.length ? 同步.输出[同步.输出.length - 1] : '开始翻列表，大概 4–5 分钟。')
                : 同步.状态 === 'done'
                  ? (同步.新增 === 0 && 同步.更新 === 0
                      ? '词库已经是最新的，没有新词条。'
                      : '词库更新完了：新增 ' + 同步.新增 + ' 条，更新 ' + 同步.更新 + ' 条' +
                        (同步.总数 ? '，现共 ' + 同步.总数 + ' 条' : '') + '。')
                  : '同步失败：' + (同步.错误 || '不知道为啥'),
            )
          : null,

        msg ? h('div', { className: 'mw-note' + (msg.kind === 'err' ? ' err' : '') }, msg.text) : null,

        h('div', { className: 'mw-toggle' },
          h('label', { className: 'mw-check' },
            h('input', { type: 'checkbox', checked: auto, onChange: 切换自动 }),
            h('span', null, '自动思考梗'),
          ),
          h('div', { className: 'mw-sub' },
            auto
              ? '开着：我察觉到你在问梗，会自己去词库查好再接话（每轮带一小段接梗规则）。'
              : '关着：我不主动查。想知道某个梗，直接说「查一下 xxx」或者问我，我再动手。',
          ),
        ),

        h('div', { className: 'mw-toggle' },
          h('label', { className: 'mw-check' },
            h('input', { type: 'checkbox', checked: 串子开, onChange: 切换串子 }),
            h('span', null, '串子程度（手动接管玩梗尺度）'),
          ),
          h('div', { className: 'mw-sub' },
            串子开
              ? '开着：玩梗的尺度按下面这根杆来。'
              : '关着：我自己判断——可以损技术、损操作，不损家人。',
          ),
          串子开
            ? h('div', { className: 'mw-slider' },
                h('input', {
                  type: 'range',
                  min: 0,
                  max: 100,
                  step: 5,
                  value: 串子度,
                  onChange: function (e) { set串子度(Number(e.target.value)) },
                  onMouseUp: function (e) { 存串子度(Number(e.target.value)) },
                  onTouchEnd: function (e) { 存串子度(Number(e.target.value)) },
                }),
                h('span', null, 串子度 + ' / 100 · ' + 串子档(串子度)),
              )
            : null,
        ),

        editing
          ? h(Editor, {
              value: editing,
              busy: busy,
              onChange: setEditing,
              onSave: 保存,
              onCancel: function () { setEditing(null); setMsg(null) },
            })
          : null,

        h('div', { className: 'mw-list' },
          items.length === 0
            ? h('div', { className: 'mw-empty' }, busy ? '读着…' : (q ? '没搜到「' + q + '」' : '词库是空的'))
            : items.map(function (it) {
                return h('div', { className: 'mw-row', key: it.title },
                  h('div', { className: 'mw-row-main' },
                    h('div', { className: 'mw-name' }, it.title,
                      it.tags ? h('span', { className: 'mw-tags' }, it.tags) : null),
                    h('div', { className: 'mw-desc' }, it.summary || it.usage || it.origin || '（还没写内容）'),
                  ),
                  h('div', { style: { display: 'flex', gap: '6px' } },
                    h('button', { className: 'mw-btn', onClick: function () { 编辑(it) } }, '改'),
                    h('button', {
                      className: 'mw-btn',
                      onClick: function () { 上传(it) },
                      disabled: 上传中 === it.title,
                    }, 上传中 === it.title ? '传…' : '上传'),
                    h('button', { className: 'mw-btn danger', onClick: function () { 删除(it) } }, '删'),
                  ),
                )
              }),
        ),

        页数 > 1
          ? h('div', { className: 'mw-pager' },
              h('button', { className: 'mw-btn', disabled: busy || offset === 0, onClick: function () { load(q, Math.max(0, offset - PAGE)) } }, '上一页'),
              h('span', null, 第几页 + ' / ' + 页数 + ' 页 · 共 ' + total + ' 条'),
              h('button', { className: 'mw-btn', disabled: busy || offset + PAGE >= total, onClick: function () { load(q, offset + PAGE) } }, '下一页'),
            )
          : null,
      )

      return h('div', { className: 'mw-root' },
        h('div', { className: 'mw-top' },
          h('div', null,
            h('div', { className: 'mw-title' }, '梗百科' + (版本 ? ' · v' + 版本 : '')),
            h('div', { className: 'mw-sub' },
              '词库 ' + 共 + ' 条' + (stats && stats.builtAt ? ' · 建于 ' + stats.builtAt : '') +
              (stats && stats.writable === false ? ' · 只读' : '') +
              ' · 新加的词条下一轮对话就能查到'),
          ),
        ),

        h('div', { className: 'mw-tabs' },
          h('button', {
            className: 'mw-tab' + (视图 === 'list' ? ' active' : ''),
            onClick: function () { set视图('list') },
          }, '词条库'),
          h('button', {
            className: 'mw-tab' + (视图 === 'feedback' ? ' active' : ''),
            onClick: function () { set视图('feedback') },
          }, '反馈'),
          h('button', {
            className: 'mw-tab' + (视图 === 'about' ? ' active' : ''),
            onClick: function () { set视图('about') },
          }, '关于'),
        ),

        // 搜索框和动作按钮都在页签下面，一行排开（只在词条库页显示）
        视图 === 'list'
          ? h('div', { className: 'mw-search' },
              h('input', {
                className: 'mw-input',
                value: q,
                placeholder: '搜标题 / 标签 / 摘要…',
                onChange: function (e) { setQ(e.target.value) },
                onKeyDown: function (e) { if (e.key === 'Enter') 搜索() },
              }),
              h('button', { className: 'mw-btn', onClick: 搜索, disabled: busy }, '搜'),
              h('button', { className: 'mw-btn primary', onClick: 新建 }, '＋ 新建词条'),
              h('button', {
                className: 'mw-btn',
                onClick: 更新词库,
                disabled: !!(同步 && 同步.状态 === 'running'),
                title: '从梗维基拉最新词条（只加新，不动你手改过的）',
              }, 同步 && 同步.状态 === 'running' ? '同步中…' : '更新词库'),
              h('button', { className: 'mw-btn', onClick: 检查更新, disabled: 查更新中 }, 查更新中 ? '查…' : '检查更新'),
              h('a', {
                className: 'mw-btn',
                href: 'http://127.0.0.1:3917/',
                target: '_blank',
                rel: 'noopener noreferrer',
                title: '本地管理页：批量补别名、逐条审核站点改动、导出备份。先运行 node scripts/wiki-server.mjs（或双击 scripts/open-wiki.cmd）',
              }, '管理页 ↗'),
            )
          : null,

        视图 === 'about'
          ? h(About, {
              版本: 版本,
              词条数: 共,
              builtAt: stats && stats.builtAt,
            })
          : 视图 === 'feedback'
            ? 反馈区
            : 列表区,
      )
    }

    function Editor(props) {
      var v = props.value
      function 改(k) {
        return function (e) {
          var next = Object.assign({}, v)
          next[k] = e.target.value
          props.onChange(next)
        }
      }
      return h('div', { className: 'mw-edit' },
        h('div', { className: 'mw-field' },
          h('label', null, '标题（梗名 / 黑话；改名会同时更新索引）'),
          h('input', {
            className: 'mw-input',
            value: v.title,
            placeholder: '比如：去码头整点薯条',
            onChange: 改('title'),
          }),
        ),
        h('div', { className: 'mw-field' },
          h('label', null, '标签（空格或逗号隔开都行）'),
          h('input', { className: 'mw-input', value: v.tags, placeholder: '比如：海鸥 人生意义', onChange: 改('tags') }),
        ),
        h('div', { className: 'mw-field' },
          h('label', null, '别名（逗号隔开，打这个词也能查到；缩写就填这儿）'),
          h('input', { className: 'mw-input', value: v.aliases, placeholder: '比如：kskbl,zdjd,wkzkbl', onChange: 改('aliases') }),
        ),
        h('div', { className: 'mw-field' },
          h('label', null, '怎么用 / 怎么接（模型优先看这一段）'),
          h('textarea', { className: 'mw-area', value: v.usage, onChange: 改('usage') }),
        ),
        h('div', { className: 'mw-field' },
          h('label', null, '出处 / 来历'),
          h('textarea', { className: 'mw-area', value: v.origin, onChange: 改('origin') }),
        ),
        h('div', { className: 'mw-field' },
          h('label', null, '摘要（列表里显示的一行解释）'),
          h('textarea', { className: 'mw-area', style: { minHeight: '44px' }, value: v.summary, onChange: 改('summary') }),
        ),
        h('div', { className: 'mw-actions' },
          h('button', { className: 'mw-btn', onClick: props.onCancel, disabled: props.busy }, '取消'),
          h('button', { className: 'mw-btn primary', onClick: props.onSave, disabled: props.busy }, props.busy ? '存着…' : '保存'),
        ),
      )
    }

    /** 设置页错误边界：崩了也要看得见原因，别整块白屏。 */
    class ErrorBoundary extends Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
      }
      componentDidCatch(error) {
        console.error('[dsh-memewiki] 设置页渲染失败：', error)
      }
      render() {
        if (this.state.error) {
          var msg = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)
          return h('div', { className: 'mw-root' },
            h('div', { className: 'mw-note err' }, '这个设置页渲染时出错了：' + msg),
          )
        }
        return this.props.children
      }
    }

    // ---- 注册 -------------------------------------------------------------

    function apply(ctx) {
      ctx.effect(function () {
        var id = 'dsh-memewiki-styles'
        if (document.getElementById(id) === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS
          document.head.appendChild(style)
        }
        return function () {
          var el = document.getElementById(id)
          if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el)
        }
      }, 'dsh-memewiki: styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'memewiki',
          order: 47,
          label: function () { return '梗百科' },
        }, function (props) {
          var p = props !== null && props !== undefined ? props : {}
          return h(ErrorBoundary, null, h(Section, p))
        })
      })
    }

    module.exports = {
      name: 'memewiki',
      inject: ['slots'],
      apply: apply,
    }
    return module.exports
  },
})
