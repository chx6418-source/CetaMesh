/* 鲸桥控制台 Demo · 共享交互层（Mock，无任何真实请求） */
(function () {
  'use strict';
  var CFG = window.DEMO_CONFIG || { themes: [], palette: false };
  var M = window.MOCK;

  /* ---------- 小工具 ---------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(html) { var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function hhmmss(d) {
    d = d || new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /* ---------- Toast ---------- */
  function toast(msg, opts) {
    opts = opts || {};
    var box = $('#toasts');
    var t = el('<div class="toast ' + (opts.type || 'ok') + '"><span>' + msg + '</span>' +
      (opts.undo ? '<button class="undo">' + (opts.undoLabel || '撤销') + '</button>' : '') + '</div>');
    var timer = setTimeout(dismiss, opts.undo ? 6000 : 3400);
    function dismiss() { clearTimeout(timer); t.classList.add('out'); setTimeout(function () { t.remove(); }, 260); }
    if (opts.undo) t.querySelector('.undo').addEventListener('click', function () { opts.undo(); dismiss(); });
    box.appendChild(t);
    while (box.children.length > 4) box.firstChild.remove();
    return dismiss;
  }

  /* ---------- 防误触：连点两次确认（代替弹窗） ---------- */
  function bindArm(btn, fn, armedText) {
    var t = null;
    btn.addEventListener('click', function () {
      if (btn.classList.contains('armed')) {
        clearTimeout(t); btn.classList.remove('armed'); btn.textContent = btn.dataset.orig; fn();
      } else {
        btn.dataset.orig = btn.textContent;
        btn.classList.add('armed'); btn.textContent = armedText || '再点一次确认';
        t = setTimeout(function () { btn.classList.remove('armed'); btn.textContent = btn.dataset.orig; }, 2800);
      }
    });
  }

  /* ---------- 复制 ---------- */
  function copyText(text) {
    function ok() { toast('已复制到剪贴板'); }
    function fail() { toast('复制失败（浏览器限制），内容：' + esc(text), { type: 'warn' }); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, function () { legacy(); });
    } else legacy();
    function legacy() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta); ta.select();
        var r = document.execCommand('copy'); ta.remove();
        r ? ok() : fail();
      } catch (e) { fail(); }
    }
  }
  $$('[data-copy]').forEach(function (b) { b.addEventListener('click', function () { copyText(b.dataset.copy); }); });

  /* ---------- 主题 ---------- */
  var themeBox = $('#themeSwitch');
  function setTheme(id, silent) {
    document.documentElement.dataset.theme = id;
    try { localStorage.setItem('qqbd-theme-' + CFG.demoId, id); } catch (e) {}
    $$('button', themeBox).forEach(function (b) { b.classList.toggle('active', b.dataset.theme === id); });
    if (!silent) toast('主题已切换：' + (CFG.themes.find(function (t) { return t.id === id; }) || {}).label);
  }
  CFG.themes.forEach(function (t) {
    var b = el('<button role="tab" data-theme="' + t.id + '"><span class="sw-dot" style="--sw:' + t.sw + '"></span>' + t.label + '</button>');
    b.addEventListener('click', function () { setTheme(t.id); });
    themeBox.appendChild(b);
  });
  var savedTheme = null;
  try { savedTheme = localStorage.getItem('qqbd-theme-' + CFG.demoId); } catch (e) {}
  if (savedTheme && CFG.themes.some(function (t) { return t.id === savedTheme; })) setTheme(savedTheme, true);
  else setTheme(document.documentElement.dataset.theme, true);

  /* ---------- 模块导航 ---------- */
  function go(module, silent) {
    $$('.module').forEach(function (m) { m.hidden = m.dataset.module !== module; });
    $$('.nav-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.module === module); });
    if (!silent) { try { history.replaceState(null, '', '#' + module); } catch (e) {} }
    window.scrollTo({ top: 0, behavior: silent ? 'auto' : 'smooth' });
  }
  $$('.nav-btn').forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.module); }); });
  var h = (location.hash || '').replace('#', '');
  go(['models', 'agents', 'logs', 'settings'].indexOf(h) >= 0 ? h : 'models', true);

  /* ---------- 模型配置 ---------- */
  var modelList = $('#modelList');
  M.models.forEach(function (m) {
    var item = el('<label class="model-item' + (m.tag === '当前' ? ' checked' : '') + '">' +
      '<input type="radio" name="model" value="' + m.id + '"' + (m.tag === '当前' ? ' checked' : '') + '>' +
      '<span class="radio"></span><div><b>' + esc(m.id) + '</b><small>' + esc(m.desc) + '</small></div>' +
      (m.tag ? '<span class="pill' + (m.tag === '当前' ? ' pill-accent' : '') + '">' + esc(m.tag) + '</span>' : '') + '</label>');
    item.querySelector('input').addEventListener('change', function () {
      $$('.model-item', modelList).forEach(function (x) { x.classList.remove('checked'); });
      item.classList.add('checked');
      toast('模型已切换为 <b>' + esc(m.id) + '</b>，对新回合生效');
    });
    modelList.appendChild(item);
  });
  $$('#effortSeg button').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('#effortSeg button').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active'); M.effort = b.dataset.v;
      toast('推理强度 → ' + b.textContent);
    });
  });
  $('#dshCheck').addEventListener('click', function () {
    var pill = $('#dshState');
    pill.className = 'pill pill-warn'; pill.innerHTML = '<span class="dot pulse"></span>检测中…';
    setTimeout(function () {
      M.dsh.latency = 35 + Math.floor(Math.random() * 30);
      pill.className = 'pill pill-ok'; pill.innerHTML = '<span class="dot pulse"></span>在线 · ' + M.dsh.latency + 'ms';
      $('#pillDsh').textContent = 'DSH 在线 · ' + M.dsh.latency + 'ms';
      toast('DSH 连通正常 · ' + M.dsh.latency + 'ms');
    }, 700);
  });
  $('#dshUrl').addEventListener('change', function () { toast('DSH 地址已保存（Mock）'); });

  var bindBox = $('#modeBind');
  function renderBind() {
    bindBox.innerHTML = '';
    M.modes.forEach(function (md) {
      var opts = M.presets.map(function (p) {
        return '<option value="' + p.id + '"' + (p.id === md.preset ? ' selected' : '') + '>' + p.id + '</option>';
      }).join('');
      var row = el('<div class="row"><b class="mono" style="min-width:96px">' + md.id + '</b>' +
        '<small style="flex:1;min-width:150px">' + esc(md.desc) + '</small>' +
        '<select data-mode="' + md.id + '">' + opts + '</select>' +
        '<span class="pill">' + esc(md.scene) + '</span>' +
        (md.id === M.currentMode ? '<span class="pill pill-ok"><span class="dot"></span>当前</span>' : '') + '</div>');
      row.querySelector('select').addEventListener('change', function (e) {
        md.preset = e.target.value;
        toast('<b>' + md.id + '</b> 的预设已改为 <b>' + e.target.value + '</b>，即时生效');
        renderPresets();
      });
      bindBox.appendChild(row);
    });
  }

  /* ---------- 发送参数 ---------- */
  $('#sendDelay').addEventListener('input', function () { $('#sendDelayOut').textContent = this.value + 'ms'; });
  $('#sendDelay').addEventListener('change', function () { M.settings.sendDelayMs = +this.value; toast('发送间隔 → ' + this.value + 'ms'); });
  $('#volumeGain').addEventListener('input', function () { $('#volumeGainOut').textContent = (this.value / 100).toFixed(2) + '×'; });
  $('#volumeGain').addEventListener('change', function () { M.settings.volumeGain = this.value / 100; toast('音量增益 → ' + (this.value / 100).toFixed(2) + '×'); });
  $('#ackMessage').addEventListener('change', function () { M.settings.ackMessage = this.value; toast(this.value ? '投递回执已开启' : '投递回执已关闭'); });
  $('#splitSend').addEventListener('change', function () { M.settings.splitSend = this.checked; toast('分句发送：' + (this.checked ? '开' : '关')); });

  /* ---------- Agent 预设库 ---------- */
  var presetRows = $('#presetRows');
  function renderPresets() {
    presetRows.innerHTML = '';
    M.presets.forEach(function (p) {
      var row = el('<div class="row"><div class="grow"><b class="mono">' + esc(p.name) + '</b>' +
        '<small>' + esc(p.desc) + '</small></div>' +
        '<span class="pill">' + esc(p.model) + '</span><span class="pill">' + p.tools + ' 个工具</span>' +
        (M.modes.some(function (md) { return md.preset === p.id; }) ? '<span class="pill pill-accent">使用中</span>' : '') +
        '<div class="acts"><button class="btn sm ghost" data-act="edit">编辑</button>' +
        '<button class="btn sm ghost" data-act="copy">复制</button></div></div>');
      row.querySelector('[data-act=edit]').addEventListener('click', function () { openDrawer(p); });
      row.querySelector('[data-act=copy]').addEventListener('click', function () {
        var cp = JSON.parse(JSON.stringify(p)); cp.id = p.id + '-copy'; cp.name = p.name + '-copy'; cp.desc = '（副本）' + p.desc;
        M.presets.push(cp); renderPresets(); renderBind();
        toast('已复制为 <b>' + esc(cp.name) + '</b>', { undoLabel: '删除', undo: function () { M.presets.pop(); renderPresets(); renderBind(); } });
      });
      presetRows.appendChild(row);
    });
  }

  /* ---------- 抽屉 ---------- */
  var drawer = $('#drawer'), backdrop = $('#drawerBackdrop');
  var editingPreset = null;
  function openDrawer(p) {
    editingPreset = p;
    $('#drawerTitle').textContent = '编辑预设 · ' + p.name;
    $('#pName').value = p.name;
    var sel = $('#pModel');
    sel.innerHTML = M.models.map(function (m) { return '<option' + (m.id === p.model ? ' selected' : '') + '>' + m.id + '</option>'; }).join('');
    $('#pPrompt').value = p.prompt;
    drawer.hidden = false; backdrop.hidden = false;
  }
  function closeDrawer() { drawer.hidden = true; backdrop.hidden = true; editingPreset = null; }
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerCancel').addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', closeDrawer);
  $('#drawerSave').addEventListener('click', function () {
    if (!editingPreset) return closeDrawer();
    editingPreset.name = $('#pName').value.trim() || editingPreset.name;
    editingPreset.model = $('#pModel').value;
    editingPreset.prompt = $('#pPrompt').value;
    renderPresets(); renderBind(); closeDrawer();
    toast('预设 <b>' + esc(editingPreset.name) + '</b> 已保存并生效');
  });

  /* ---------- 角色扮演 ---------- */
  var roleChips = $('#roleChips');
  function renderRoles() {
    roleChips.innerHTML = '';
    M.roles.forEach(function (r, i) {
      var active = r.name === M.currentRole;
      var chip = el('<span class="chip' + (active ? ' active' : '') + '" title="' + esc(r.content || '关闭角色扮演') + '">' + esc(r.name) +
        (i > 0 ? '<i class="x" data-x title="删除">×</i>' : '') + '</span>');
      chip.addEventListener('click', function (e) {
        if (e.target.hasAttribute('data-x')) {
          var removed = { r: r, i: i };
          M.roles.splice(i, 1);
          if (M.currentRole === r.name) M.currentRole = M.roles[0].name;
          renderRoles(); updateRolePill();
          toast('角色 <b>' + esc(r.name) + '</b> 已删除', { undoLabel: '撤销', undo: function () { M.roles.splice(removed.i, 0, removed.r); renderRoles(); updateRolePill(); } });
          return;
        }
        M.currentRole = r.name; renderRoles(); updateRolePill();
        toast(i === 0 ? '已关闭角色扮演' : '角色已切换为 <b>' + esc(r.name) + '</b>');
      });
      roleChips.appendChild(chip);
    });
  }
  function updateRolePill() { $('#currentRole').textContent = '当前：' + M.currentRole; }
  $('#roleCreate').addEventListener('click', function () {
    var n = $('#roleNameInput').value.trim(), c = $('#roleContentInput').value.trim();
    if (!n) return toast('先给角色起个名字', { type: 'warn' });
    M.roles.push({ name: n, content: c });
    $('#roleNameInput').value = ''; $('#roleContentInput').value = '';
    $('#roleNew').open = false;
    renderRoles(); updateRolePill();
    toast('角色 <b>' + esc(n) + '</b> 已创建并启用');
  });

  /* ---------- 黑话库 ---------- */
  var slangBox = $('#slangChips');
  function renderSlang() {
    slangBox.innerHTML = '';
    M.slang.forEach(function (s, i) {
      var chip = el('<span class="chip" title="' + esc(s.meaning) + '">' + esc(s.term) + ' <small style="color:var(--text-3)">' + esc(s.meaning) + '</small><i class="x" data-x>×</i></span>');
      chip.querySelector('.x').addEventListener('click', function () {
        var removed = { s: s, i: i };
        M.slang.splice(i, 1); renderSlang();
        toast('已移除 <b>' + esc(s.term) + '</b>', { undoLabel: '撤销', undo: function () { M.slang.splice(removed.i, 0, removed.s); renderSlang(); } });
      });
      slangBox.appendChild(chip);
    });
  }
  function addSlang() {
    var v = $('#slangInput').value.trim();
    if (!v) return;
    var parts = v.split(/[=：:]/);
    var term = (parts[0] || '').trim(), meaning = (parts[1] || '').trim() || '…';
    M.slang.push({ term: term, meaning: meaning });
    $('#slangInput').value = ''; renderSlang();
    toast('词条 <b>' + esc(term) + '</b> 已加入用语库');
  }
  $('#slangAdd').addEventListener('click', addSlang);
  $('#slangInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') addSlang(); });

  /* ---------- 会话记忆 ---------- */
  var memBox = $('#memoryRows');
  function renderMemory() {
    memBox.innerHTML = '';
    M.memories.forEach(function (m) {
      var row = el('<div class="row"><div class="grow"><b>' + esc(m.name) + '</b><small>' + esc(m.text) + '</small></div>' +
        '<span class="pill">' + m.n + ' 条</span><div class="acts"><button class="btn sm ghost" data-act="clear">清理</button></div></div>');
      bindArm(row.querySelector('[data-act=clear]'), function () {
        var old = m.text;
        m.text = '（已清理，将重新积累）'; m.n = 0; renderMemory();
        toast('<b>' + esc(m.name) + '</b> 的会话记忆已清理', { undoLabel: '撤销', undo: function () { m.text = old; renderMemory(); } });
      }, '确认清理？');
      memBox.appendChild(row);
    });
  }

  /* ---------- 会话状态 ---------- */
  var sessBox = $('#sessionRows');
  function renderSessions() {
    sessBox.innerHTML = '';
    M.sessions.forEach(function (s) {
      var cls = { busy: 'busy', sleep: 'sleep', ok: 'ok', wait: 'busy' }[s.state] || 'sleep';
      var row = el('<div class="row">' +
        '<span class="avatar" style="background:' + s.color + '">' + esc(s.name.slice(0, 1)) + '</span>' +
        '<div class="grow"><b>' + esc(s.name) + '</b><small>' + esc(s.type) + ' · ' + esc(s.key) + '</small></div>' +
        '<span class="state-lab ' + cls + '">' + (s.state === 'busy' ? '<span class="dot pulse"> </span>' : '') + esc(s.stateText) + '</span>' +
        (s.unread ? '<span class="unread">' + s.unread + '</span>' : '') +
        '<div class="acts">' +
        (s.state !== 'ok' ? '<button class="btn sm" data-act="wake">唤醒</button>' : '') +
        '<button class="btn sm ghost" data-act="reset">重置</button></div></div>');
      var wake = row.querySelector('[data-act=wake]');
      if (wake) wake.addEventListener('click', function () {
        s.state = 'ok'; s.stateText = '空闲'; s.unread = 0; renderSessions();
        toast('<b>' + esc(s.name) + '</b> 已唤醒，将立即检查未读');
      });
      bindArm(row.querySelector('[data-act=reset]'), function () {
        s.unread = 0; renderSessions();
        toast('<b>' + esc(s.name) + '</b> 会话上下文已重置（Mock）');
      }, '确认重置？');
      sessBox.appendChild(row);
    });
  }

  /* ---------- 挂起审批 ---------- */
  var pendBox = $('#pendingRows');
  function renderPending() {
    pendBox.innerHTML = '';
    M.pending.forEach(function (p, i) {
      var row = el('<div class="row"><div class="grow"><b>' + esc(p.title) + '</b><small>' + esc(p.detail) +
        (p.timeout ? ' · ' + esc(p.timeout) : '') + '</small></div>' +
        '<div class="approve-acts"><button class="btn sm primary" data-act="ok">通过</button>' +
        '<button class="btn sm danger" data-act="no">拒绝</button>' +
        (p.kind === 'ask' ? '<button class="btn sm ghost" data-act="ans">回答</button>' : '') + '</div></div>');
      function done(text, type) {
        var backup = p;
        M.pending.splice(i, 1); renderPending(); updatePendingPill();
        toast(text, { type: type, undoLabel: '撤销', undo: function () { M.pending.splice(i, 0, backup); renderPending(); updatePendingPill(); } });
      }
      row.querySelector('[data-act=ok]').addEventListener('click', function () { done('已<b>通过</b>：' + esc(p.title)); });
      row.querySelector('[data-act=no]').addEventListener('click', function () { done('已<b>拒绝</b>：' + esc(p.title), 'warn'); });
      var ans = row.querySelector('[data-act=ans]');
      if (ans) ans.addEventListener('click', function () {
        var form = el('<div class="inline-answer"><input type="text" placeholder="输入回答，回车发送…" value="先不开，周末再说"><button class="btn sm primary">发送</button></div>');
        row.querySelector('.approve-acts').replaceWith(form);
        var input = form.querySelector('input'); input.focus(); input.select();
        function submit() { done('回答已发送给 Agent：<b>' + esc(input.value) + '</b>'); }
        form.querySelector('button').addEventListener('click', submit);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
      });
      pendBox.appendChild(row);
    });
    if (!M.pending.length) pendBox.appendChild(el('<div class="row" style="color:var(--text-3)">全部处理完毕，没有待办 ✨</div>'));
  }
  function updatePendingPill() {
    var n = M.pending.length, pill = $('#pendingCount');
    pill.hidden = !n;
    if (n) pill.innerHTML = '<span class="dot pulse"></span>' + n + ' 条待处理';
  }

  /* ---------- 工具调用 ---------- */
  var toolBox = $('#toolRows');
  M.tools.forEach(function (t) {
    toolBox.appendChild(el('<div class="tool-line"><span class="t-name">' + esc(t.name) + '</span>' +
      '<span class="t-args" title="' + esc(t.args) + '">' + esc(t.args) + '</span>' +
      '<span class="t-dur">' + t.dur + '</span>' +
      '<span class="pill ' + (t.ok ? 'pill-ok' : 'pill-err') + '">' + (t.ok ? '完成' : '超时') + '</span></div>'));
  });

  /* ---------- 实时日志 ---------- */
  var logList = $('#logList'), logs = [], paused = false, logDir = 'all', logQuery = '';
  var seedTime = new Date(Date.now() - 1000 * 60 * 6);
  function makeLog(dir, msg, t) { return { dir: dir, msg: msg, t: t || new Date(seedTime.getTime() + logs.length * 21000) }; }
  window.LOG_POOL.forEach(function (l) { logs.push(makeLog(l.dir, l.msg)); });
  function dirLabel(d) { return { in: '收', out: '发', sys: '系', err: '错' }[d]; }
  function logText(l) { return l.msg.replace(/<[^>]+>/g, ''); }
  function renderLogs() {
    logList.innerHTML = '';
    logs.filter(function (l) {
      if (logDir !== 'all' && l.dir !== logDir) return false;
      if (logQuery && logText(l).indexOf(logQuery) < 0) return false;
      return true;
    }).forEach(function (l) {
      logList.appendChild(el('<div class="log-line' + (l.dir === 'err' ? ' is-err' : '') + '">' +
        '<span class="log-time">' + hhmmss(l.t) + '</span>' +
        '<span class="log-dir ' + l.dir + '">' + dirLabel(l.dir) + '</span>' +
        '<span class="log-msg">' + l.msg + '</span></div>'));
    });
    logList.scrollTop = logList.scrollHeight;
  }
  function pushLog(l) {
    logs.push(l); if (logs.length > 80) logs.shift();
    var pass = (logDir === 'all' || l.dir === logDir) && (!logQuery || logText(l).indexOf(logQuery) >= 0);
    if (!pass) return;
    var stick = logList.scrollHeight - logList.scrollTop - logList.clientHeight < 60;
    var line = el('<div class="log-line fade-in' + (l.dir === 'err' ? ' is-err' : '') + '">' +
      '<span class="log-time">' + hhmmss(l.t) + '</span>' +
      '<span class="log-dir ' + l.dir + '">' + dirLabel(l.dir) + '</span>' +
      '<span class="log-msg">' + l.msg + '</span></div>');
    logList.appendChild(line);
    if (stick) logList.scrollTop = logList.scrollHeight;
  }
  setInterval(function () {
    if (paused) return;
    var pool = window.LOG_POOL;
    var l = pool[Math.floor(Math.random() * pool.length)];
    pushLog(makeLog(l.dir, l.msg, new Date()));
  }, 3600);
  $$('#logFilter button').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('#logFilter button').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active'); logDir = b.dataset.v; renderLogs();
    });
  });
  $('#logSearch').addEventListener('input', function () { logQuery = this.value.trim(); renderLogs(); });
  $('#logPause').addEventListener('click', function () {
    paused = !paused;
    this.textContent = paused ? '继续' : '暂停';
    var pill = $('#livePill');
    pill.className = paused ? 'pill pill-warn' : 'pill pill-ok';
    pill.innerHTML = paused ? '已暂停' : '<span class="dot pulse"></span>实时';
  });
  $('#logClear').addEventListener('click', function () {
    var backup = logs.slice(); logs = []; renderLogs();
    toast('日志已清空', { type: 'warn', undoLabel: '撤销', undo: function () { logs = backup; renderLogs(); } });
  });

  /* ---------- 系统设置：模式 / 白名单 / 开关 ---------- */
  var tileBox = $('#modeTiles');
  function renderModeTiles() {
    tileBox.innerHTML = '';
    M.modes.forEach(function (md) {
      var tile = el('<button class="mode-tile' + (md.id === M.currentMode ? ' active' : '') + '">' +
        '<b>' + esc(md.id) + (md.id === M.currentMode ? ' <span class="pill pill-ok" style="margin-left:4px"><span class="dot"></span>当前</span>' : '') + '</b>' +
        '<small>' + esc(md.desc) + '</small><small style="color:var(--accent)">预设 ' + esc(md.preset) + '</small></button>');
      tile.addEventListener('click', function () {
        if (M.currentMode === md.id) return;
        M.currentMode = md.id; renderModeTiles(); renderBind();
        $('#pillMode').textContent = md.id;
        toast('运行模式 → <b>' + esc(md.id) + '</b>，桥接已热切换（Mock）');
      });
      tileBox.appendChild(tile);
    });
  }

  function renderChipsInto(boxId, list, placeholder) {
    var box = $(boxId);
    function draw() {
      box.innerHTML = '';
      list.forEach(function (c, i) {
        var chip = el('<span class="chip">' + esc(c.v) + (c.note ? ' <small style="color:var(--text-3)">' + esc(c.note) + '</small>' : '') + '<i class="x" data-x>×</i></span>');
        chip.querySelector('.x').addEventListener('click', function () {
          var removed = { c: c, i: i };
          list.splice(i, 1); draw();
          toast('已移出名单：<b>' + esc(c.v) + '</b>', { undoLabel: '撤销', undo: function () { list.splice(removed.i, 0, removed.c); draw(); } });
        });
        box.appendChild(chip);
      });
      var inputWrap = el('<span class="chip-input"><input type="text" placeholder="' + placeholder + '"><button class="btn sm ghost">＋</button></span>');
      var input = inputWrap.querySelector('input');
      function add() {
        var v = input.value.trim(); if (!v) return;
        list.push({ v: v }); draw();
        toast('已加入名单：<b>' + esc(v) + '</b>');
      }
      inputWrap.querySelector('button').addEventListener('click', add);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') add(); });
      box.appendChild(inputWrap);
    }
    draw();
  }
  renderChipsInto('#allowPrivate', M.whitelist.private, 'QQ 号');
  renderChipsInto('#allowGroups', M.whitelist.groups, '群号');
  renderChipsInto('#denyList', M.whitelist.deny, 'QQ 号 / 群号');

  function bindSwitch(id, get, set, label) {
    var input = $(id);
    input.checked = get();
    input.addEventListener('change', function () {
      set(input.checked);
      toast(label + '：' + (input.checked ? '已开启' : '已关闭'));
      if (id === '#swSilent') {
        var pill = $('#pillBridge');
        if (input.checked) { pill.className = 'pill pill-warn'; pill.innerHTML = '<span class="dot"></span>静默中 · 只收不发'; }
        else { pill.className = 'pill pill-ok'; pill.innerHTML = '<span class="dot pulse"></span>桥接运行中'; }
      }
    });
  }
  bindSwitch('#swSilent', function () { return M.settings.silent; }, function (v) { M.settings.silent = v; }, '静默模式');
  bindSwitch('#swIntercept', function () { return M.settings.intercept; }, function (v) { M.settings.intercept = v; }, '安全拦截');
  bindSwitch('#swNotify', function () { return M.settings.notifyOwner; }, function (v) { M.settings.notifyOwner = v; }, '拦截通知 Owner');
  bindSwitch('#swBilibili', function () { return M.settings.bilibili; }, function (v) { M.settings.bilibili = v; }, 'B站视频解析');
  bindSwitch('#swFileSend', function () { return M.settings.fileSend; }, function (v) { M.settings.fileSend = v; }, '文件 / 音频发送');
  bindSwitch('#swSearch', function () { return M.settings.search; }, function (v) { M.settings.search = v; }, '联网搜索');

  /* 酷狗 / 测试发送 / 维护 */
  bindArm($('#kugouLogout'), function () {
    M.kugou.loggedIn = false;
    var pill = $('#kugouState');
    pill.className = 'pill pill-warn'; pill.textContent = '未登录';
    toast('酷狗已退出登录', { type: 'warn' });
  }, '确认退出？');

  $('#testSend').addEventListener('click', function () {
    var btn = this; btn.disabled = true; btn.textContent = '发送中…';
    setTimeout(function () {
      btn.disabled = false; btn.textContent = '发送';
      var target = $('#testTarget');
      var res = $('#testResult'); res.hidden = false;
      $('#testResultText').textContent = '→ ' + target.options[target.selectedIndex].text + ' · "' + ($('#testMessage').value || '（空）') + '"';
      toast('测试消息已投递 · 延迟 ' + (600 + Math.floor(Math.random() * 500)) + 'ms');
    }, 650);
  });

  bindArm($('#tokenRegen'), function () {
    var hex = '0123456789abcdef', s = '';
    for (var i = 0; i < 8; i++) s += hex[Math.floor(Math.random() * 16)];
    M.token = 'qkb-' + s + '••••••••' + s.split('').reverse().join('');
    $('#tokenCode').textContent = M.token;
    toast('控制台令牌已重新生成，旧令牌立即失效', { type: 'warn' });
  }, '确认重新生成？');

  bindArm($('#btnRestart'), function () { toast('桥接进程重启中… 预计 3s 恢复（Mock）', { type: 'warn' }); }, '确认重启？');
  bindArm($('#btnResetWs'), function () { toast('DSH「QQ 聊天」工作区已重置（Mock）', { type: 'warn' }); }, '确认重置？');
  $('#openGuide').addEventListener('click', function () { toast('后台控制端：closed-agent 模式下私聊 Owner 发指令即可（Demo 说明）'); });

  /* ---------- 命令面板 ---------- */
  var palette = $('#palette'), pBackdrop = $('#paletteBackdrop'), pInput = $('#paletteInput'), pList = $('#paletteList');
  var pSel = 0, pFiltered = [];
  function paletteActions() {
    var acts = [];
    [{ k: 'models', n: '模型配置' }, { k: 'agents', n: 'Agent 预设' }, { k: 'logs', n: '请求日志' }, { k: 'settings', n: '系统设置' }]
      .forEach(function (m) { acts.push({ label: '前往 · ' + m.n, hint: '模块', run: function () { go(m.k); } }); });
    CFG.themes.forEach(function (t) { acts.push({ label: '主题 · ' + t.label, hint: '外观', run: function () { setTheme(t.id); } }); });
    M.modes.forEach(function (md) { acts.push({ label: '模式 → ' + md.id, hint: '运行', run: function () { M.currentMode = md.id; renderModeTiles(); renderBind(); $('#pillMode').textContent = md.id; toast('运行模式 → <b>' + esc(md.id) + '</b>'); } }); });
    acts.push({ label: (M.settings.silent ? '关闭' : '开启') + '静默模式', hint: '开关', run: function () { var sw = $('#swSilent'); sw.checked = !sw.checked; sw.dispatchEvent(new Event('change')); } });
    acts.push({ label: '清空实时日志', hint: '日志', run: function () { go('logs'); $('#logClear').click(); } });
    acts.push({ label: '复制控制台令牌', hint: '维护', run: function () { copyText('qkb-9f3e-mock-token-d21c'); } });
    acts.push({ label: '重启桥接进程', hint: '危险', run: function () { go('settings'); $('#btnRestart').click(); } });
    return acts;
  }
  function renderPalette() {
    var q = pInput.value.trim().toLowerCase();
    pFiltered = paletteActions().filter(function (a) { return !q || a.label.toLowerCase().indexOf(q) >= 0; });
    pSel = Math.min(pSel, Math.max(0, pFiltered.length - 1));
    pList.innerHTML = '';
    if (!pFiltered.length) { pList.innerHTML = '<div class="palette-empty">没有匹配的命令</div>'; return; }
    pFiltered.forEach(function (a, i) {
      var item = el('<div class="palette-item' + (i === pSel ? ' sel' : '') + '">' + esc(a.label) + '<small>' + a.hint + '</small></div>');
      item.addEventListener('click', function () { closePalette(); a.run(); });
      pList.appendChild(item);
    });
  }
  function openPalette() {
    palette.hidden = false; pBackdrop.hidden = false;
    pInput.value = ''; pSel = 0; renderPalette(); pInput.focus();
  }
  function closePalette() { palette.hidden = true; pBackdrop.hidden = true; }
  pBackdrop.addEventListener('click', closePalette);
  pInput.addEventListener('input', function () { pSel = 0; renderPalette(); });
  pInput.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { pSel = Math.min(pSel + 1, pFiltered.length - 1); renderPalette(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { pSel = Math.max(pSel - 1, 0); renderPalette(); e.preventDefault(); }
    else if (e.key === 'Enter') { var a = pFiltered[pSel]; if (a) { closePalette(); a.run(); } e.preventDefault(); }
    else if (e.key === 'Escape') closePalette();
  });
  if (CFG.palette) {
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); palette.hidden ? openPalette() : closePalette(); }
      if (e.key === 'Escape' && !palette.hidden) closePalette();
    });
  } else { palette.remove(); pBackdrop.remove(); }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !drawer.hidden) closeDrawer();
  });

  /* ---------- 启动 ---------- */
  renderBind(); renderPresets(); renderRoles(); updateRolePill(); renderSlang();
  renderMemory(); renderSessions(); renderPending(); updatePendingPill(); renderModeTiles();
  renderLogs();
  window.__appReady = true;
})();
