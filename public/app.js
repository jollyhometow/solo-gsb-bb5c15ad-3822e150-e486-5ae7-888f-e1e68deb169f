/*
 * app.js —— 父页面主逻辑（原生 JavaScript）
 *
 * 流程：
 *  1. 读取用户 HTML / CSS，剥离用户脚本与危险属性（DOMParser，不执行脚本）；
 *  2. 把「净化后的 HTML + 用户 CSS + 分析脚本 analyzer.js」拼成 srcdoc，
 *     装入 sandbox="allow-scripts"（无 allow-same-origin）的 iframe；
 *  3. 通过 postMessage 接收焦点路线，渲染顺序列表与诊断；
 *  4. 步进高亮（Tab / Shift+Tab）；编辑重算后按稳定选择器恢复当前位置；
 *  5. 基线对比（diff.js）：钉住当前结果为基线，重算后按节点身份
 *     （唯一 id + 结构/属性指纹）匹配前后路线，展示新增 / 移除 / 移位 /
 *     状态切换与未匹配项，点击差异项联动预览高亮；
 *  6. 模态焦点陷阱审计：展示活动模态身份、模态内焦点循环路线、模态外
 *     泄漏节点与审计诊断，点击循环 / 泄漏节点联动预览高亮；
 *  7. 汇总报告（含基线摘要、匹配结果与差异、模态审计）经 POST /api/export
 *     导出为 JSON 附件。
 */
(function () {
  'use strict';

  var SOURCE = 'focus-lab';

  // 与 analyzer.js 中一致：净化时给 closed shadow root 宿主打的标记。
  // closed 根在解析后无法从 JS 探测（el.shadowRoot === null），
  // 只能在声明式模板被浏览器接管前于宿主上留下记号。
  var CLOSED_MARKER = 'data-focus-lab-closed-shadow';
  // DSD 属性在「净化 / 二次解析」阶段使用的中性替身（避免模板提前被接管），
  // 最终写入 srcdoc 前再还原为 shadowrootmode / shadowrootdelegatesfocus。
  var DSD_MODE_TOKEN = 'data-frl-shadowrootmode';
  var DSD_DELEGATES_TOKEN = 'data-frl-shadowrootdelegatesfocus';

  var els = {
    html: document.getElementById('html-input'),
    css: document.getElementById('css-input'),
    autoApply: document.getElementById('auto-apply'),
    applyBtn: document.getElementById('apply-btn'),
    frame: document.getElementById('preview-frame'),
    status: document.getElementById('preview-status'),
    prevBtn: document.getElementById('prev-btn'),
    nextBtn: document.getElementById('next-btn'),
    captureBtn: document.getElementById('step-capture'),
    stepIndicator: document.getElementById('step-indicator'),
    restoreHint: document.getElementById('restore-hint'),
    exportBtn: document.getElementById('export-btn'),
    tabOrder: document.getElementById('tab-order'),
    tabExcluded: document.getElementById('tab-excluded'),
    orderList: document.getElementById('order-list'),
    orderCount: document.getElementById('order-count'),
    excludedPanel: document.getElementById('excluded-panel'),
    excludedList: document.getElementById('excluded-list'),
    excludedCount: document.getElementById('excluded-count'),
    diagnosticsList: document.getElementById('diagnostics-list'),
    tabBaseline: document.getElementById('tab-baseline'),
    baselinePanel: document.getElementById('baseline-panel'),
    baselineCount: document.getElementById('baseline-count'),
    pinBaselineBtn: document.getElementById('pin-baseline-btn'),
    clearBaselineBtn: document.getElementById('clear-baseline-btn'),
    baselineMeta: document.getElementById('baseline-meta'),
    diffSummary: document.getElementById('diff-summary'),
    diffList: document.getElementById('diff-list'),
    diffHint: document.getElementById('diff-hint'),
    tabModal: document.getElementById('tab-modal'),
    modalPanel: document.getElementById('modal-panel'),
    modalCount: document.getElementById('modal-count'),
    modalHead: document.getElementById('modal-head'),
    modalCycleList: document.getElementById('modal-cycle-list'),
    modalCycleWrap: document.getElementById('modal-cycle-wrap'),
    modalLeakList: document.getElementById('modal-leak-list'),
    modalDiagnosticsList: document.getElementById('modal-diagnostics-list'),
    modalHint: document.getElementById('modal-hint')
  };

  var state = {
    analyzerSrc: null,   // analyzer.js 源码文本
    entries: [],         // 最近一次路线节点
    order: [],           // selector 数组（Tab 顺序）
    diagnostics: [],
    stats: null,
    currentStep: -1,     // 当前高亮在顺序中的下标
    restoreSelector: null, // 待恢复的稳定选择器
    routeTimer: null,    // 路线响应超时计时器
    baseline: null,      // 已钉住的基线快照 { pinnedAt, stats, entries }
    diff: null,          // 最近一次基线对比结果（FocusDiff.diffRoutes 返回值）
    modalAudit: null,    // 最近一次模态焦点陷阱审计结果
    highlightOrigin: null // 最近一次 highlight-node 请求来源（'diff' / 'modal'），用于定位高亮失败提示
  };

  /* ---------------- 示例输入 ---------------- */

  var SAMPLE_HTML = [
    '<h1>示例：注册表单 + Shadow DOM 组件</h1>',
    '<button>第一个按钮</button>',
    '<a href="#">普通链接</a>',
    '',
    '<!-- open Shadow Root：slot 分配的轻 DOM 进入组合树；未分配 slot 用 fallback -->',
    '<x-card>',
    '  <template shadowrootmode="open">',
    '    <style>:host{display:block;border:2px solid #4f8cff;border-radius:8px;padding:8px;margin:8px 0;background:#eef4ff}</style>',
    '    <h3><slot name="title"></slot></h3>',
    '    <slot></slot>',
    '    <slot name="footer"><button>未分配 footer 时的 fallback 按钮</button></slot>',
    '    <button>shadow 内部按钮</button>',
    '  </template>',
    '  <span slot="title">卡片标题（slotted span，不可聚焦）</span>',
    '  <a slot="footer" href="#">footer 槽分配的链接</a>',
    '  <button slot="footer">同样分配到 footer 槽的按钮</button>',
    '  <button>分配到默认槽的按钮</button>',
    '  <button data-unassigned>未被任何 slot 分配的宿主按钮（不渲染、不计数）</button>',
    '</x-card>',
    '',
    '<!-- open + delegatesFocus：宿主停靠焦点委托给 shadow 内部 -->',
    '<x-delegate tabindex="0">',
    '  <template shadowrootmode="open" shadowrootdelegatesfocus>',
    '    <button>delegatesFocus：内部首个可聚焦节点</button>',
    '  </template>',
    '</x-delegate>',
    '',
    '<!-- closed Shadow Root：内部不可检查，宿主轻 DOM 标为「不可确定」 -->',
    '<x-secret>',
    '  <template shadowrootmode="closed">',
    '    <button>closed 根内部按钮（实验室无法看到）</button>',
    '    <slot></slot>',
    '  </template>',
    '  <button>closed 宿主轻 DOM 按钮（slot 分配不可知）</button>',
    '</x-secret>',
    '',
    '<input type="text" placeholder="用户名">',
    '<button tabindex="3">正数 tabindex=3</button>',
    '<button tabindex="1">正数 tabindex=1（插队到最前）</button>',
    '<div tabindex="0">可聚焦的 div</div>',
    '<button disabled>禁用按钮</button>',
    '<input type="hidden" value="secret">',
    '<p hidden>隐藏段落 <a href="#">其中的链接</a></p>',
    '<div inert>',
    '  <button>inert 容器内的按钮</button>',
    '</div>',
    '<div class="gone"><button>display:none 内的按钮</button></div>',
    '<button tabindex="-1">仅脚本可聚焦</button>',
    '<details>',
    '  <summary>详情摘要</summary>',
    '  <button>闭合 details 内的按钮</button>',
    '</details>',
    '<fieldset disabled>',
    '  <legend>整组禁用</legend>',
    '  <input type="text" placeholder="被 fieldset 禁用">',
    '</fieldset>',
    '<a>没有 href 的链接（不可聚焦）</a>',
    '<div aria-hidden="true"><button>aria-hidden 内的可聚焦按钮</button></div>',
    '<div role="dialog" aria-modal="true" aria-label="订阅确认" class="demo-modal">',
    '  <p><strong>模态对话框</strong>：打开时模态外的节点即为「泄漏」</p>',
    '  <input type="email" placeholder="邮箱地址">',
    '  <button>确认订阅</button>',
    '  <button>取消</button>',
    '</div>',
    '<script>alert("这段用户脚本会被剥离，不会执行")<' + '/script>'
  ].join('\n');

  var SAMPLE_CSS = [
    'body { font-family: sans-serif; padding: 12px; }',
    'button, a, input, summary, div[tabindex] { display: inline-block; margin: 4px; padding: 4px 8px; }',
    'x-card, x-secret, x-delegate { display: block; }',
    '.gone { display: none; }',
    '.demo-modal { display: block; margin: 8px 0; padding: 10px; border: 2px solid #4f8cff; border-radius: 6px; background: #eef4ff; }',
    ':focus { outline: 2px dashed #4f8cff; }'
  ].join('\n');

  /* ---------------- 净化：剥离用户脚本（保留声明式 Shadow DOM） ---------------- */

  /**
   * 把 <template> 开标签中的 DSD 属性改为中性替身（大小写不敏感）：
   *  - shadowrootmode                          → data-frl-shadowrootmode="open|closed"
   *  - shadowrootdelegatesfocus                → data-frl-shadowrootdelegatesfocus=""
   * 这样经 DOMParser 解析时模板只是普通元素（保留在宿主轻 DOM 中，可被遍历净化），
   * 最终拼装 srcdoc 时再由 restoreDsdTokens 还原，浏览器才真正创建 shadow root。
   */
  function neutralizeDsd(html) {
    var TAG_RE = /<template\b[^>]*>/gi;
    function neutralizeTag(tag) {
      if (!/\bshadowrootmode\b/i.test(tag) && !/\bshadowrootdelegatesfocus\b/i.test(tag)) return tag;
      var out = tag.replace(/\bshadowrootmode\s*(?:=\s*("[^"]*"|'[^']*'|[^\s>]+))?/i, function (_, val) {
        var mode = 'open';
        if (val) {
          var v = val.replace(/^['"]|['"]$/g, '').toLowerCase();
          if (v === 'closed') mode = 'closed';
        }
        return DSD_MODE_TOKEN + '="' + mode + '"';
      });
      out = out.replace(/\bshadowrootdelegatesfocus(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/i,
        DSD_DELEGATES_TOKEN + '=""');
      return out;
    }
    return html.replace(TAG_RE, neutralizeTag);
  }

  /** 遍历 <template> 内容（含嵌套），补充净化脚本与事件属性（覆盖 shadow 子树） */
  function sanitizeTemplates(doc) {
    var templates = doc.querySelectorAll('template');
    for (var t = 0; t < templates.length; t++) {
      var content = templates[t].content;
      if (!content) continue;
      var kill = content.querySelectorAll('script, base, meta[http-equiv]');
      for (var i = 0; i < kill.length; i++) kill[i].remove();
      var inner = content.querySelectorAll('*');
      for (var j = 0; j < inner.length; j++) stripDangerousAttrs(inner[j]);
    }
  }

  /** 移除单个元素上的 on* / srcdoc / 危险协议属性 */
  function stripDangerousAttrs(el) {
    var attrs = Array.prototype.slice.call(el.attributes);
    for (var k = 0; k < attrs.length; k++) {
      var name = attrs[k].name.toLowerCase();
      var compact = String(attrs[k].value).replace(/[\s\x00-\x1F]+/g, '').toLowerCase();
      if (name.indexOf('on') === 0) {
        el.removeAttribute(attrs[k].name);
      } else if (name === 'srcdoc') {
        el.removeAttribute(attrs[k].name);
      } else if (
        (name === 'href' || name === 'src' || name === 'xlink:href' ||
         name === 'formaction' || name === 'action' || name === 'poster') &&
        (compact.indexOf('javascript:') === 0 || compact.indexOf('data:text/html') === 0)
      ) {
        el.removeAttribute(attrs[k].name);
      }
    }
  }

  /**
   * 用 DOMParser 解析（不会执行脚本），移除：
   *  - <script>、<base>、<meta http-equiv>（如 refresh 跳转）
   *  - 所有 on* 事件属性
   *  - javascript: / data:text/html 协议的链接类属性
   *  - srcdoc（防止注入未净化的嵌套文档）
   * 同时保留（并净化其内容）声明式 Shadow DOM 模板。
   */
  function sanitizeHtml(html) {
    var doc = new DOMParser().parseFromString(neutralizeDsd(html), 'text/html');
    var kill = doc.querySelectorAll('script, base, meta[http-equiv]');
    for (var i = 0; i < kill.length; i++) kill[i].remove();

    var all = doc.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      stripDangerousAttrs(all[j]);
      // closed 声明式根：在宿主上留下标记（供 analyzer 明确「不可检查」）
      if (all[j].hasAttribute(DSD_MODE_TOKEN) && all[j].getAttribute(DSD_MODE_TOKEN) === 'closed') {
        var parent = all[j].parentElement;
        if (parent && !parent.hasAttribute(CLOSED_MARKER)) parent.setAttribute(CLOSED_MARKER, '');
      }
    }
    sanitizeTemplates(doc);
    return doc.documentElement.outerHTML;
  }

  /**
   * 最终序列化前把中性替身还原为真实 DSD 属性（字符串层替换；
   * 替身在正常用户内容中不会出现，避免提前被 DOMParser 接管成真 shadow root）。
   */
  function restoreDsdTokens(serialized) {
    return serialized
      .split(DSD_MODE_TOKEN + '="open"').join('shadowrootmode="open"')
      .split(DSD_MODE_TOKEN + '="closed"').join('shadowrootmode="closed"')
      .split(DSD_DELEGATES_TOKEN + '=""').join('shadowrootdelegatesfocus');
  }

  /** 拼装 srcdoc：净化 HTML + 用户 CSS + 分析脚本 */
  function buildSrcdoc(html, css, analyzerSrc) {
    var doc = new DOMParser().parseFromString(sanitizeHtml(html), 'text/html');
    var style = doc.createElement('style');
    style.textContent = css;
    (doc.head || doc.documentElement).appendChild(style);
    var script = doc.createElement('script');
    script.textContent = analyzerSrc;
    (doc.body || doc.documentElement).appendChild(script);
    // 先序列化再还原 DSD：若在 DOM 中改名，序列化结果里的模板不会带 shadowrootmode
    return '<!DOCTYPE html>\n' + restoreDsdTokens(doc.documentElement.outerHTML);
  }

  /* ---------------- 渲染与重算 ---------------- */

  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function applyAndRecompute() {
    if (!state.analyzerSrc) return;
    // 记录当前高亮节点的稳定选择器，供重算后恢复位置
    if (state.currentStep >= 0 && state.order[state.currentStep]) {
      state.restoreSelector = state.order[state.currentStep];
    }
    setStatus('渲染中…');
    clearTimeout(state.routeTimer);
    state.routeTimer = setTimeout(function () {
      setStatus('预览脚本未响应（可能存在语法错误）', 'err');
    }, 5000);
    els.frame.srcdoc = buildSrcdoc(els.html.value, els.css.value, state.analyzerSrc);
  }

  var debounceTimer = null;
  function scheduleApply() {
    if (!els.autoApply.checked) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(applyAndRecompute, 600);
  }

  /* ---------------- 消息处理 ---------------- */

  window.addEventListener('message', function (ev) {
    if (ev.source !== els.frame.contentWindow) return; // 只接受预览 iframe 的消息
    var d = ev.data || {};
    if (d.source !== SOURCE) return;

    if (d.type === 'route') {
      clearTimeout(state.routeTimer);
      onRoute(d.payload);
    } else if (d.type === 'highlighted') {
      state.currentStep = d.step;
      updateStepUI();
    } else if (d.type === 'highlight-miss') {
      var missText = '未能在当前预览中定位该节点（可能刚被移除或选择器已变化）。';
      if (state.highlightOrigin === 'modal') setModalHint(missText);
      else setDiffHint(missText);
      state.highlightOrigin = null;
    } else if (d.type === 'error') {
      clearTimeout(state.routeTimer);
      setStatus('分析脚本错误：' + d.message, 'err');
    }
  });

  function onRoute(payload) {
    state.entries = payload.entries || [];
    state.order = payload.order || [];
    state.diagnostics = payload.diagnostics || [];
    state.modalAudit = payload.modalAudit || null;
    state.stats = payload.stats || null;
    state.currentStep = -1;
    renderResults();
    refreshDiff();
    var shNote = '';
    if (state.stats && state.stats.shadow) {
      var sh = state.stats.shadow;
      var parts = [];
      if (sh.openRoots > 0) parts.push(sh.openRoots + ' 个 open 根');
      if (sh.closedRoots.length > 0) parts.push(sh.closedRoots.length + ' 个 closed（不可检查）');
      if (sh.slottedCandidates > 0) parts.push(sh.slottedCandidates + ' 个经 slot 分配');
      if (sh.fallbackCandidates > 0) parts.push(sh.fallbackCandidates + ' 个 fallback');
      if (parts.length > 0) shNote = ' · 组合树：' + parts.join('，');
    }
    setStatus('已计算：' + state.order.length + ' 个可聚焦节点' + shNote, 'ok');

    // 按稳定选择器恢复编辑前的位置
    if (state.restoreSelector) {
      var idx = state.order.indexOf(state.restoreSelector);
      if (idx >= 0) {
        els.restoreHint.textContent = '已按分段选择器恢复到位置 ' + (idx + 1) + '：' + state.restoreSelector;
        sendToFrame({ type: 'highlight', step: idx });
      } else {
        els.restoreHint.textContent = '原节点（' + state.restoreSelector + '）已不在 Tab 顺序中（或位于 closed 根内），未恢复。';
        updateStepUI();
      }
      state.restoreSelector = null;
    } else {
      updateStepUI();
    }
  }

  function sendToFrame(msg) {
    msg.target = SOURCE;
    if (els.frame.contentWindow) els.frame.contentWindow.postMessage(msg, '*');
  }

  /* ---------------- 结果渲染 ---------------- */

  function entryBySelector(selector) {
    for (var i = 0; i < state.entries.length; i++) {
      if (state.entries[i].selector === selector) return state.entries[i];
    }
    return null;
  }

  /**
   * 在节点项上追加 Shadow DOM 组合位置徽章与说明：
   * 宿主链（跨边界深度）、slot 来源（分配 / fallback）、未分配、closed 不可确定。
   */
  function appendShadowBadges(container, e) {
    var sh = e.shadow;
    if (!sh) return;
    var reasonCodes = (e.reasons || []).map(function (r) { return r.code; });
    var undetermined = reasonCodes.indexOf('shadow-closed-undetermined') >= 0;

    if (undetermined) {
      var bClosed = document.createElement('span');
      bClosed.className = 'badge shadow-closed';
      bClosed.textContent = 'closed · 不可检查';
      bClosed.title = '位于 closed Shadow Root 宿主轻 DOM 中，slot 分配与内部组合树不可检查，不猜测是否进入 Tab 顺序';
      container.appendChild(bClosed);
    }

    (sh.hosts || []).forEach(function (h, i) {
      var b = document.createElement('span');
      b.className = 'badge shadow-host';
      b.textContent = '▣ ' + h.label;
      b.title = '宿主链第 ' + (i + 1) + ' 层：' + h.selector;
      container.appendChild(b);
    });

    (sh.slots || []).forEach(function (ev) {
      var b = document.createElement('span');
      b.className = 'badge slot-' + ev.via;
      b.textContent = (ev.via === 'fallback' ? '↲ fallback ' : (ev.via === 'forward' ? '⇢ 转发槽 ' : '⇥ slot ')) + ev.label;
      b.title = ev.via === 'fallback'
        ? '该 slot 未分配节点，当前节点是其 fallback 内容：' + ev.selector
        : '经 <slot> 分配进入组合树（' + (ev.name ? 'name="' + ev.name + '"' : '默认槽') + '）：' + ev.selector;
      container.appendChild(b);
    });

    if (reasonCodes.indexOf('shadow-unassigned') >= 0) {
      var bU = document.createElement('span');
      bU.className = 'badge slot-unassigned';
      bU.textContent = '未分配 · 不渲染';
      container.appendChild(bU);
    }
  }

  function renderResults() {
    // Tab 顺序列表
    els.orderList.innerHTML = '';
    els.orderCount.textContent = String(state.order.length);
    if (state.order.length === 0) {
      var tip = document.createElement('li');
      tip.className = 'empty-tip';
      tip.textContent = '没有可 Tab 聚焦的元素。';
      els.orderList.appendChild(tip);
    }
    state.order.forEach(function (selector, i) {
      var e = entryBySelector(selector) || { label: selector, selector: selector };
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'node-item';
      btn.dataset.step = String(i);

      var line = document.createElement('span');
      var no = document.createElement('span');
      no.className = 'step-no';
      no.textContent = String(i + 1);
      line.appendChild(no);
      line.appendChild(document.createTextNode(' ' + e.label));
      if (e.tabIndex > 0) {
        var b = document.createElement('span');
        b.className = 'badge positive';
        b.textContent = 'tabindex=' + e.tabIndex;
        line.appendChild(b);
      } else if (e.hasTabindexAttr) {
        var b0 = document.createElement('span');
        b0.className = 'badge';
        b0.textContent = 'tabindex=0';
        line.appendChild(b0);
      }
      btn.appendChild(line);

      appendShadowBadges(btn, e);

      var sel = document.createElement('span');
      sel.className = 'sel';
      sel.textContent = e.selector;
      btn.appendChild(sel);

      if (e.text) {
        var t = document.createElement('span');
        t.className = 'text';
        t.textContent = '“' + e.text + '”';
        btn.appendChild(t);
      }

      btn.addEventListener('click', function () {
        sendToFrame({ type: 'highlight', step: i });
      });
      li.appendChild(btn);
      els.orderList.appendChild(li);
    });

    // 排除列表（含 tabindex<0 的“仅编程聚焦”节点）
    els.excludedList.innerHTML = '';
    var excluded = state.entries.filter(function (e) {
      return e.status === 'excluded' || e.status === 'programmatic' ||
        (e.warnings && e.warnings.length > 0);
    });
    els.excludedCount.textContent = String(excluded.length);
    if (excluded.length === 0) {
      var li0 = document.createElement('li');
      li0.className = 'empty-tip';
      li0.textContent = '没有被排除的候选元素。';
      els.excludedList.appendChild(li0);
    }
    excluded.forEach(function (e) {
      var li = document.createElement('li');
      var box = document.createElement('div');
      box.className = 'node-item';

      var title = document.createElement('span');
      title.textContent = e.label + ' ';
      var tag = document.createElement('span');
      tag.className = 'badge';
      var closedUndetermined = (e.reasons || []).some(function (r) { return r.code === 'shadow-closed-undetermined'; });
      tag.textContent = closedUndetermined ? '不可确定' :
        (e.status === 'programmatic' ? 'tabindex<0' :
        (e.status === 'excluded' ? '已排除' : '提示'));
      title.appendChild(tag);
      box.appendChild(title);

      appendShadowBadges(box, e);

      (e.reasons || []).forEach(function (r) {
        var rEl = document.createElement('span');
        rEl.className = 'reason';
        rEl.textContent = r.message;
        box.appendChild(rEl);
      });
      (e.warnings || []).forEach(function (w) {
        var wEl = document.createElement('span');
        wEl.className = 'reason';
        wEl.textContent = '⚠ ' + w.message;
        box.appendChild(wEl);
      });

      var sel2 = document.createElement('span');
      sel2.className = 'sel';
      sel2.textContent = e.selector;
      box.appendChild(sel2);

      li.appendChild(box);
      els.excludedList.appendChild(li);
    });

    // 全局诊断
    els.diagnosticsList.innerHTML = '';
    if (state.diagnostics.length === 0) {
      var liD = document.createElement('li');
      liD.className = 'empty-tip';
      liD.textContent = '暂无诊断信息。';
      els.diagnosticsList.appendChild(liD);
    }
    state.diagnostics.forEach(function (dg) {
      var li = document.createElement('li');
      li.className = 'diag ' + (dg.level === 'warn' ? 'warn' : 'info');
      li.textContent = (dg.level === 'warn' ? '⚠ ' : 'ℹ ') + dg.message;
      els.diagnosticsList.appendChild(li);
    });

    renderModalAudit();
  }

  /* ---------------- 模态焦点陷阱审计 ---------------- */

  function setModalHint(text) {
    els.modalHint.textContent = text || '';
  }

  function clearModalActive() {
    var all = els.modalPanel.querySelectorAll('.node-item.active');
    for (var i = 0; i < all.length; i++) all[i].classList.remove('active');
  }

  /** 模态审计列表项（循环 / 泄漏共用）：序号 + 标签 + 徽章 + 选择器 + 文本，点击联动高亮 */
  function modalNodeButton(opts) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'node-item';

    var line = document.createElement('span');
    var no = document.createElement('span');
    no.className = 'step-no';
    no.textContent = opts.no;
    line.appendChild(no);
    line.appendChild(document.createTextNode(' ' + opts.label));
    (opts.badges || []).forEach(function (b) {
      var s = document.createElement('span');
      s.className = 'badge' + (b.cls ? ' ' + b.cls : '');
      s.textContent = b.text;
      line.appendChild(s);
    });
    btn.appendChild(line);

    var sel = document.createElement('span');
    sel.className = 'sel';
    sel.textContent = opts.selector;
    btn.appendChild(sel);

    if (opts.text) {
      var t = document.createElement('span');
      t.className = 'text';
      t.textContent = '“' + opts.text + '”';
      btn.appendChild(t);
    }

    btn.addEventListener('click', function () {
      clearModalActive();
      btn.classList.add('active');
      opts.onClick();
    });
    return btn;
  }

  function renderModalAudit() {
    var audit = state.modalAudit;
    els.modalHead.innerHTML = '';
    els.modalCycleList.innerHTML = '';
    els.modalLeakList.innerHTML = '';
    els.modalDiagnosticsList.innerHTML = '';
    els.modalCycleWrap.textContent = '';
    setModalHint('');

    // 角标计数 = 泄漏节点数 + 警告级诊断数
    var issueCount = 0;
    if (audit && audit.activeModal) {
      issueCount = audit.leaks.length +
        audit.diagnostics.filter(function (d) { return d.level === 'warn'; }).length;
    }
    els.modalCount.textContent = String(issueCount);

    if (!audit || !audit.activeModal) {
      var tip = document.createElement('p');
      tip.className = 'empty-tip';
      tip.textContent = '未检测到可见的 dialog[open] 或 aria-modal="true" 模态容器，无需审计。';
      els.modalHead.appendChild(tip);
      return;
    }

    var am = audit.activeModal;

    // 活动模态头部：类型 + 身份 + 可访问名称（点击高亮模态容器本身）
    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'node-item modal-head-item';
    var hline = document.createElement('span');
    var kind = document.createElement('span');
    kind.className = 'badge kind';
    kind.textContent = am.kind === 'dialog' ? '<dialog open>' : 'aria-modal';
    hline.appendChild(kind);
    hline.appendChild(document.createTextNode(' ' + am.label));
    head.appendChild(hline);
    var nameLine = document.createElement('span');
    nameLine.className = 'modal-name' + (am.accessibleName ? '' : ' missing');
    nameLine.textContent = am.accessibleName
      ? '可访问名称：“' + am.accessibleName + '”（' + am.nameSource + '）'
      : '⚠ 缺少可访问名称（aria-label / aria-labelledby / title）';
    head.appendChild(nameLine);
    var hsel = document.createElement('span');
    hsel.className = 'sel';
    hsel.textContent = am.selector;
    head.appendChild(hsel);
    head.addEventListener('click', function () {
      clearModalActive();
      head.classList.add('active');
      setModalHint('');
      state.highlightOrigin = 'modal';
      sendToFrame({ type: 'highlight-node', selector: am.selector, badge: '活动模态', solid: true });
    });
    els.modalHead.appendChild(head);

    // 焦点循环路线：模态内可 Tab 节点按全局顺序形成的首尾循环
    if (audit.cycle.length === 0) {
      var liE = document.createElement('li');
      liE.className = 'empty-tip';
      liE.textContent = '模态内没有可 Tab 聚焦的元素，无法形成焦点循环。';
      els.modalCycleList.appendChild(liE);
    }
    audit.cycle.forEach(function (node, i) {
      var li = document.createElement('li');
      var badges = [];
      if (i === 0) badges.push({ cls: 'endpoint', text: audit.cycle.length === 1 ? '首/尾' : '首' });
      if (i === audit.cycle.length - 1 && audit.cycle.length > 1) badges.push({ cls: 'endpoint', text: '尾' });
      if (node.tabIndex > 0) badges.push({ cls: 'positive', text: 'tabindex=' + node.tabIndex });
      var btn = modalNodeButton({
        no: String(node.cycleStep),
        label: node.label,
        badges: badges,
        selector: node.selector,
        text: node.text,
        onClick: function () {
          setModalHint('');
          state.highlightOrigin = 'modal';
          sendToFrame({
            type: 'highlight-node',
            selector: node.selector,
            badge: '循环 ' + node.cycleStep + ' / ' + audit.cycle.length,
            solid: true
          });
        }
      });
      li.appendChild(btn);
      els.modalCycleList.appendChild(li);
    });
    if (audit.cycle.length > 0) {
      els.modalCycleWrap.textContent =
        '↩ 循环闭合：末项按 Tab 应回到首项（第 1 项），首项按 Shift+Tab 应回到末项（第 ' +
        audit.cycle.length + ' 项）。';
    }

    // 泄漏节点：模态外仍可 Tab 到达
    if (audit.leaks.length === 0) {
      var liL = document.createElement('li');
      liL.className = 'empty-tip';
      liL.textContent = '未发现泄漏：模态外没有可 Tab 到达的节点。';
      els.modalLeakList.appendChild(liL);
    }
    audit.leaks.forEach(function (node) {
      var li = document.createElement('li');
      var btn = modalNodeButton({
        no: String(node.step),
        label: node.label,
        badges: [{ cls: 'leak', text: '泄漏' }],
        selector: node.selector,
        text: node.text,
        onClick: function () {
          setModalHint('');
          state.highlightOrigin = 'modal';
          sendToFrame({
            type: 'highlight-node',
            selector: node.selector,
            badge: '泄漏 · Tab ' + node.step + ' / ' + state.order.length
          });
        }
      });
      li.appendChild(btn);
      els.modalLeakList.appendChild(li);
    });

    // 审计诊断
    if (audit.diagnostics.length === 0) {
      var liD = document.createElement('li');
      liD.className = 'empty-tip';
      liD.textContent = '暂无审计诊断。';
      els.modalDiagnosticsList.appendChild(liD);
    }
    audit.diagnostics.forEach(function (dg) {
      var li = document.createElement('li');
      li.className = 'diag ' + (dg.level === 'warn' ? 'warn' : 'info');
      li.textContent = (dg.level === 'warn' ? '⚠ ' : 'ℹ ') + dg.message;
      els.modalDiagnosticsList.appendChild(li);
    });
  }

  function updateStepUI() {
    var total = state.order.length;
    els.stepIndicator.textContent = (state.currentStep >= 0 ? state.currentStep + 1 : '–') + ' / ' + total;
    var items = els.orderList.querySelectorAll('.node-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('current', Number(items[i].dataset.step) === state.currentStep);
    }
    els.prevBtn.disabled = total === 0;
    els.nextBtn.disabled = total === 0;
  }

  /* ---------------- 基线对比 ---------------- */

  var DIFF_TYPE_META = {
    added: { label: '新增', cls: 'added' },
    removed: { label: '移除', cls: 'removed' },
    moved: { label: '移位', cls: 'moved' },
    status: { label: '状态', cls: 'status' },
    unmatched: { label: '未匹配', cls: 'unmatched' }
  };

  function setDiffHint(text) {
    els.diffHint.textContent = text || '';
  }

  /** 当前结果的精简快照（与基线同构，供 FocusDiff 匹配） */
  function currentSnapshot() {
    return {
      stats: state.stats,
      entries: state.entries.map(function (e) {
        return {
          identity: e.identity || null,
          selector: e.selector,
          label: e.label,
          text: e.text,
          tag: e.tag,
          status: e.status,
          step: e.step,
          tabIndex: e.tabIndex,
          domIndex: e.domIndex,
          shadow: e.shadow || null
        };
      })
    };
  }

  /** 有基线时，每次重算后自动对比并刷新面板 */
  function refreshDiff() {
    if (typeof FocusDiff === 'undefined') return;
    state.diff = state.baseline ? FocusDiff.diffRoutes(state.baseline, currentSnapshot()) : null;
    renderBaselinePanel();
  }

  function pinBaseline() {
    if (typeof FocusDiff === 'undefined') return;
    if (!state.stats) {
      setDiffHint('尚无分析结果，无法钉为基线。');
      return;
    }
    var snap = currentSnapshot();
    state.baseline = {
      pinnedAt: new Date().toISOString(),
      stats: snap.stats,
      entries: snap.entries
    };
    refreshDiff();
    setDiffHint('已钉为基线（' + snap.entries.length + ' 个节点）。后续重算将自动与基线对比。');
  }

  function clearBaseline() {
    state.baseline = null;
    state.diff = null;
    setDiffHint('');
    renderBaselinePanel();
  }

  function formatTime(iso) {
    try {
      return new Date(iso).toLocaleString();
    } catch (err) {
      return iso;
    }
  }

  /** 差异项的说明文字 */
  function diffDetailText(item) {
    switch (item.type) {
      case 'added': {
        var c = item.current;
        return c.step ? '进入 Tab 顺序：第 ' + c.step + ' 位' : '新增节点（' + c.statusLabel + '）';
      }
      case 'removed': {
        var b = item.baseline;
        return (b.step ? '原第 ' + b.step + ' 位' : '原状态：' + b.statusLabel) + '，当前已不存在';
      }
      case 'moved':
        return '第 ' + item.fromStep + ' 位 → 第 ' + item.toStep + ' 位';
      case 'status': {
        var from = item.fromStep ? item.fromStatusLabel + '（第 ' + item.fromStep + ' 位）' : item.fromStatusLabel;
        var to = item.toStep ? item.toStatusLabel + '（第 ' + item.toStep + ' 位）' : item.toStatusLabel;
        return from + ' → ' + to;
      }
      case 'unmatched':
        return (item.side === 'baseline' ? '基线侧' : '当前侧') + '节点无法唯一确定对应关系：' +
          (item.reason === 'ambiguous-uid'
            ? '唯一 id 在一侧出现多次'
            : '结构/属性指纹在两侧均不唯一（存在多个相同节点）');
      default:
        return '';
    }
  }

  /** 点击差异项：联动当前预览高亮 */
  function onDiffItemClick(item) {
    var cur = item.current;
    state.highlightOrigin = 'diff';
    if (cur && cur.step) {
      setDiffHint('');
      sendToFrame({ type: 'highlight', step: cur.step - 1 }); // step 为 1 基序号
    } else if (cur && cur.selector) {
      setDiffHint('');
      sendToFrame({ type: 'highlight-node', selector: cur.selector }); // 非顺序节点：虚线框
    } else {
      setDiffHint('「' + (item.label || '') + '」仅存在于基线中，当前预览没有可高亮的节点。');
    }
  }

  function renderBaselinePanel() {
    var hasBaseline = !!state.baseline;
    els.clearBaselineBtn.hidden = !hasBaseline;
    els.pinBaselineBtn.textContent = hasBaseline ? '📌 重新钉当前为基线' : '📌 钉当前为基线';
    els.diffSummary.innerHTML = '';
    els.diffList.innerHTML = '';

    if (!hasBaseline || !state.diff) {
      els.baselineMeta.textContent = '尚未固定基线。钉住当前分析结果后，后续重算将按节点身份（唯一 id + 结构/属性指纹）自动对比前后路线。';
      els.baselineCount.textContent = '0';
      var li0 = document.createElement('li');
      li0.className = 'empty-tip';
      li0.textContent = '暂无基线可对比。';
      els.diffList.appendChild(li0);
      return;
    }

    var d = state.diff;
    var s = d.summary;
    els.baselineMeta.textContent =
      '基线钉于 ' + formatTime(d.baseline.pinnedAt) +
      ' · 基线 ' + d.baseline.nodeCount + ' 节点 / ' + d.baseline.orderCount + ' 在顺序中' +
      ' · 当前 ' + d.current.nodeCount + ' / ' + d.current.orderCount;

    var total = s.added + s.removed + s.moved + s.statusChanged + s.unmatched;
    els.baselineCount.textContent = String(total);

    var chips = [
      ['added', '+' + s.added + ' 新增'],
      ['removed', '−' + s.removed + ' 移除'],
      ['moved', '⇄' + s.moved + ' 移位'],
      ['status', '⚠' + s.statusChanged + ' 状态'],
      ['unmatched', '◆' + s.unmatched + ' 未匹配'],
      ['unchanged', '=' + s.unchanged + ' 不变']
    ];
    chips.forEach(function (c) {
      var chip = document.createElement('span');
      chip.className = 'diff-chip ' + c[0];
      chip.textContent = c[1];
      els.diffSummary.appendChild(chip);
    });

    if (d.diffs.length === 0) {
      var liE = document.createElement('li');
      liE.className = 'empty-tip';
      liE.textContent = '与基线一致，未发现差异。';
      els.diffList.appendChild(liE);
      return;
    }

    d.diffs.forEach(function (item) {
      var meta = DIFF_TYPE_META[item.type] || { label: item.type, cls: '' };
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'diff-item ' + meta.cls;

      var line = document.createElement('span');
      var badge = document.createElement('span');
      badge.className = 'type-badge ' + meta.cls;
      badge.textContent = meta.label;
      line.appendChild(badge);
      line.appendChild(document.createTextNode(' ' + (item.label || '(未命名节点)')));
      btn.appendChild(line);

      var detail = document.createElement('span');
      detail.className = 'diff-detail';
      detail.textContent = diffDetailText(item);
      btn.appendChild(detail);

      var node = item.current || item.baseline;
      if (node && node.selector) {
        var sel = document.createElement('span');
        sel.className = 'sel';
        sel.textContent = node.selector;
        btn.appendChild(sel);
      }

      btn.addEventListener('click', function () {
        var all = els.diffList.querySelectorAll('.diff-item');
        for (var i = 0; i < all.length; i++) all[i].classList.remove('active');
        btn.classList.add('active');
        onDiffItemClick(item);
      });
      li.appendChild(btn);
      els.diffList.appendChild(li);
    });
  }

  els.pinBaselineBtn.addEventListener('click', pinBaseline);
  els.clearBaselineBtn.addEventListener('click', clearBaseline);

  /* ---------------- 步进（Tab / Shift+Tab） ---------------- */

  function stepNext() {
    if (state.order.length === 0) return;
    var next = state.currentStep < 0 ? 0 : (state.currentStep + 1) % state.order.length;
    sendToFrame({ type: 'highlight', step: next });
  }

  function stepPrev() {
    if (state.order.length === 0) return;
    var prev = state.currentStep < 0 ? state.order.length - 1
      : (state.currentStep - 1 + state.order.length) % state.order.length;
    sendToFrame({ type: 'highlight', step: prev });
  }

  els.nextBtn.addEventListener('click', stepNext);
  els.prevBtn.addEventListener('click', stepPrev);

  // “捕获 Tab”按钮：聚焦后按 Tab / Shift+Tab 即步进，不移动真实焦点
  els.captureBtn.addEventListener('keydown', function (ev) {
    if (ev.key === 'Tab') {
      ev.preventDefault();
      if (ev.shiftKey) stepPrev(); else stepNext();
    }
  });
  els.captureBtn.addEventListener('focus', function () {
    els.captureBtn.classList.add('armed');
  });
  els.captureBtn.addEventListener('blur', function () {
    els.captureBtn.classList.remove('armed');
  });

  /* ---------------- 导出 ---------------- */

  function buildReport() {
    return {
      tool: 'focus-route-lab',
      generatedAt: new Date().toISOString(),
      stats: state.stats,
      order: state.order.map(function (selector, i) {
        var e = entryBySelector(selector) || {};
        return {
          step: i + 1,
          selector: selector,
          label: e.label || null,
          tabIndex: e.tabIndex === undefined ? null : e.tabIndex,
          text: e.text || ''
        };
      }),
      nodes: state.entries.map(function (e) {
        return {
          selector: e.selector,
          label: e.label,
          tag: e.tag,
          status: e.status,
          step: e.step,
          tabIndex: e.tabIndex,
          domIndex: e.domIndex,
          // 组合树位置：宿主链（hosts）/ slot 来源（slots，分配·转发·fallback）/
          // 是否处于 fallback 子树 / 是否位于 closed 宿主轻 DOM
          shadow: e.shadow || null,
          reasons: (e.reasons || []).map(function (r) { return { code: r.code, message: r.message }; }),
          warnings: (e.warnings || []).map(function (w) { return { code: w.code, message: w.message }; })
        };
      }),
      diagnostics: state.diagnostics,
      // Shadow DOM / slot 组合树分析汇总（open/closed 根、分配/fallback/未分配计数）
      shadowDom: (state.stats && state.stats.shadow) ? state.stats.shadow : null,
      // 模态焦点陷阱审计：活动模态身份 / 循环顺序 / 泄漏节点 / 审计诊断（无活动模态时为 null）
      modalAudit: state.modalAudit ? {
        activeModal: state.modalAudit.activeModal,
        cycle: state.modalAudit.cycle,
        leaks: state.modalAudit.leaks,
        diagnostics: state.modalAudit.diagnostics,
        candidates: state.modalAudit.candidates
      } : null,
      // 基线对比：基线摘要 + 匹配结果 + 差异（未钉基线时为 null）
      baselineComparison: state.diff ? {
        baseline: state.diff.baseline,
        current: state.diff.current,
        summary: state.diff.summary,
        matches: state.diff.matches,
        diffs: state.diff.diffs
      } : null
    };
  }

  els.exportBtn.addEventListener('click', function () {
    var report = buildReport();
    // 优先走服务端导出接口；失败时退化为浏览器本地下载
    fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report)
    }).then(function (res) {
      if (!res.ok) throw new Error('export failed: ' + res.status);
      return res.blob();
    }).catch(function () {
      return new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'focus-route-report.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
  });

  /* ---------------- 标签页切换 ---------------- */

  function switchTab(which) {
    var tabs = {
      order: [els.tabOrder, els.orderList],
      excluded: [els.tabExcluded, els.excludedPanel],
      modal: [els.tabModal, els.modalPanel],
      baseline: [els.tabBaseline, els.baselinePanel]
    };
    Object.keys(tabs).forEach(function (name) {
      var active = name === which;
      tabs[name][0].classList.toggle('active', active);
      tabs[name][0].setAttribute('aria-selected', String(active));
      tabs[name][1].hidden = !active;
    });
  }
  els.tabOrder.addEventListener('click', function () { switchTab('order'); });
  els.tabExcluded.addEventListener('click', function () { switchTab('excluded'); });
  els.tabModal.addEventListener('click', function () { switchTab('modal'); });
  els.tabBaseline.addEventListener('click', function () { switchTab('baseline'); });

  /* ---------------- 启动 ---------------- */

  els.applyBtn.addEventListener('click', applyAndRecompute);
  els.html.addEventListener('input', scheduleApply);
  els.css.addEventListener('input', scheduleApply);

  els.html.value = SAMPLE_HTML;
  els.css.value = SAMPLE_CSS;
  renderBaselinePanel();

  fetch('/analyzer.js')
    .then(function (res) {
      if (!res.ok) throw new Error('analyzer.js 加载失败');
      return res.text();
    })
    .then(function (src) {
      state.analyzerSrc = src;
      applyAndRecompute();
    })
    .catch(function (err) {
      setStatus(String(err.message || err), 'err');
    });
})();
