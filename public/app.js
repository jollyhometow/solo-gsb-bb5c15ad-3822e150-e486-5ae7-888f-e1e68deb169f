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
    order: [],           // selector 数组（Tab 顺序，跨边界为分段选择器）
    diagnostics: [],
    stats: null,
    shadow: null,        // 最近一次 Shadow DOM 组合树信息
    currentStep: -1,     // 当前高亮在顺序中的下标
    restoreSelector: null, // 待恢复的分段选择器
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
    '<!-- 声明式 open Shadow Root：Tab 路线按组合树展开，slot 分配节点参与，未分配的轻 DOM 不计入 -->',
    '<my-card id="card">',
    '  <template shadowrootmode="open">',
    '    <style>div { padding: 8px; border: 2px solid #16a34a; border-radius: 8px; }</style>',
    '    <h3>卡片（shadow 内部标题）</h3>',
    '    <label>shadow 内输入框 <input type="text" placeholder="shadow input"></label>',
    '    <slot name="actions"><button>slot fallback 按钮（未分配时使用）</button></slot>',
    '    <p>下面是没有对应 slot 的默认槽：</p>',
    '  </template>',
    '  <button slot="actions">被分配到 name=actions 的按钮（slotted）</button>',
    '  <a href="#" slot="actions">另一个被分配的链接</a>',
    '  <button>未分配的轻 DOM 按钮（无对应 slot，不渲染、不计入）</button>',
    '</my-card>',
    '<!-- 声明式闭合 Shadow Root：内部不可检查，明确标注而非猜测 -->',
    '<my-secret data-note="closed-host">',
    '  <template shadowrootmode="closed">',
    '    <button>闭合 root 内部按钮（实验室无法检查）</button>',
    '  </template>',
    '  <button>闭合宿主的轻 DOM 按钮（仍正常分析）</button>',
    '</my-secret>',
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
    '.gone { display: none; }',
    '.demo-modal { display: block; margin: 8px 0; padding: 10px; border: 2px solid #4f8cff; border-radius: 6px; background: #eef4ff; }',
    'my-card, my-secret { display: block; margin: 8px 0; }',
    'my-secret { padding: 8px; border: 2px dashed #b91c1c; border-radius: 8px; }',
    ':focus { outline: 2px dashed #4f8cff; }'
  ].join('\n');

  /* ---------------- 净化：剥离用户脚本 ---------------- */

  /**
   * 净化单个元素上的危险属性：所有 on* 事件属性、srcdoc、危险协议链接。
   */
  function stripDangerousAttributes(el) {
    var attrs = Array.prototype.slice.call(el.attributes);
    for (var k = 0; k < attrs.length; k++) {
      var attrName = attrs[k].name.toLowerCase();
      var compact = String(attrs[k].value).replace(/[\s\x00-\x1F]+/g, '').toLowerCase();
      if (attrName.indexOf('on') === 0) {
        el.removeAttribute(attrs[k].name);
      } else if (attrName === 'srcdoc') {
        el.removeAttribute(attrs[k].name);
      } else if (
        (attrName === 'href' || attrName === 'src' || attrName === 'xlink:href' ||
         attrName === 'formaction' || attrName === 'action' || attrName === 'poster') &&
        (compact.indexOf('javascript:') === 0 || compact.indexOf('data:text/html') === 0)
      ) {
        el.removeAttribute(attrs[k].name);
      }
    }
  }

  /**
   * 递归净化一棵已解析的 DOM 树（容器本身之外的全部元素）：
   *  - 移除 <script>、<base>、<meta http-equiv>；
   *  - 进入 open Shadow Root（含声明式 shadowrootmode="open" 升级产生的 root）
   *    与尚未被解析器消费的 <template>.content，确保 shadow 内部的脚本同样被剥离。
   * 闭合 Shadow Root 无法经 DOM API 访问，其内部净化在字符串阶段完成
   * （见 sanitizeHtml 中的 FocusShdom 扫描）。
   */
  function stripTree(root) {
    var kill = root.querySelectorAll('script, base, meta[http-equiv]');
    for (var i = 0; i < kill.length; i++) kill[i].remove();

    var all = root.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      stripDangerousAttributes(el);
      // querySelectorAll 不进入 shadow root，需手动递归
      if (el.shadowRoot) stripTree(el.shadowRoot);
      // 未被消费的 <template shadowrootmode>（引擎不支持 DSD 时）或普通模板
      if (el.tagName === 'TEMPLATE' && el.content) stripTree(el.content);
    }
  }

  /**
   * 净化闭合 DSD 模板【内部】片段：包进一个普通 <template> 后用 DOMParser 解析
   * （内部不会执行任何脚本），递归净化后返回内部 HTML 文本。
   */
  function sanitizeClosedFragment(innerHtml) {
    var wrap = new DOMParser().parseFromString(
      '<!DOCTYPE html><html><body><template>' + innerHtml + '</template></body></html>',
      'text/html'
    );
    var tpl = wrap.querySelector('template');
    if (!tpl) return '';
    stripTree(tpl.content);
    return tpl.innerHTML;
  }

  /**
   * 用户 HTML 净化总入口：
   *  1. 字符串阶段（解析前）：定位全部 <template shadowrootmode="closed">——
   *     它们解析后无法访问——给其宿主注入 data-focus-lab-closed-root 标注
   *     （analyzer 据此把闭合 root 明确标为「不可检查」），并对其内部 HTML 做净化；
   *  2. DOM 阶段（DOMParser，不执行脚本）：剥离脚本/危险属性，并递归进入
   *     open shadow root 与 <template>.content。
   */
  function sanitizeHtml(html) {
    var closed = FocusShdom.findClosedShadowRoots(html);

    // 建立闭合模板区间的嵌套关系（嵌套 closed DSD 也可能出现在 closed 内部）
    var spans = closed.spans.map(function (sp, idx) {
      sp.children = [];
      sp.parent = null;
      for (var p = 0; p < idx; p++) {
        var cand = closed.spans[p];
        // 用【内部区间】判定包含：外层模板的 start 早于内层 start，不能用 start 比较
        if (sp.innerStart >= cand.innerStart && sp.innerEnd <= cand.innerEnd && sp !== cand) {
          // 取最近的祖先（内部起点最大者）
          if (!sp.parent || cand.innerStart > sp.parent.innerStart) sp.parent = cand;
        }
      }
      if (sp.parent) sp.parent.children.push(sp);
      return sp;
    });

    // 自内而外生成各 span 的净化文本（子区间偏移相对当前内部）
    function cleanSpan(sp) {
      var inner = html.slice(sp.innerStart, sp.innerEnd);
      sp.children.slice().sort(function (a, b) { return b.start - a.start; }).forEach(function (ch) {
        var from = ch.innerStart - sp.innerStart;
        var to = ch.innerEnd - sp.innerStart;
        inner = inner.slice(0, from) + cleanSpan(ch) + inner.slice(to);
      });
      return sanitizeClosedFragment(inner);
    }

    // 按位置从后往前应用编辑，避免偏移失效；宿主标注与顶层闭合模板替换互不重叠。
    // 注意：位于某个闭合区间【内部】的宿主标记不注入属性——该宿主整个子树都在闭合
    // root 内、解析后不可访问；其内部内容仍会经由区间净化处理。
    function insideClosedSpan(pos) {
      for (var i = 0; i < spans.length; i++) {
        if (pos > spans[i].tagEnd && pos < spans[i].innerEnd) return true;
      }
      return false;
    }
    var edits = [];
    closed.markers.slice().sort(function (a, b) { return a.pos - b.pos; }).forEach(function (m) {
      if (!insideClosedSpan(m.pos)) {
        edits.push({ pos: m.pos, end: null, text: ' ' + FocusShdom.CLOSED_ROOT_ATTR + '=""' });
      }
    });
    spans.filter(function (sp) { return !sp.parent; }).forEach(function (sp) {
      edits.push({ pos: sp.innerStart, end: sp.innerEnd, text: cleanSpan(sp) });
    });
    edits.sort(function (a, b) { return b.pos - a.pos; });
    var out = html;
    edits.forEach(function (ed) {
      out = out.slice(0, ed.pos) + ed.text + (ed.end ? out.slice(ed.end) : out.slice(ed.pos));
    });

    var doc = new DOMParser().parseFromString(out, 'text/html');
    stripTree(doc);
    return doc.documentElement.outerHTML;
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
    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
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
    state.shadow = payload.shadow || null;
    state.stats = payload.stats || null;
    state.currentStep = -1;
    renderResults();
    refreshDiff();
    var sh = (state.shadow && state.shadow.stats) || null;
    setStatus('已计算：' + state.order.length + ' 个可聚焦节点' +
      (sh && sh.openRoots ? '（' + sh.openRoots + ' 个 open shadow root' +
        (sh.closedRoots ? '，' + sh.closedRoots + ' 个闭合不可检查' : '') + '）' : ''), 'ok');

    // 按分段选择器恢复编辑前的位置（跨 shadow 边界也可往返定位）
    if (state.restoreSelector) {
      var idx = state.order.indexOf(state.restoreSelector);
      if (idx >= 0) {
        els.restoreHint.textContent = '已按分段选择器恢复到位置 ' + (idx + 1) + '：' + state.restoreSelector;
        sendToFrame({ type: 'highlight', step: idx });
      } else {
        els.restoreHint.textContent = '原节点（' + state.restoreSelector + '）已不在 Tab 顺序中，未恢复。';
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

  /* ---------------- 组合树信息展示（Shadow DOM / slot） ---------------- */

  /** 节点的组合徽章：shadow 内 / slotted / fallback */
  function compositionBadges(e) {
    var out = [];
    var c = e.composition;
    if (!c) return out;
    if (c.tree === 'shadow') {
      var sh = document.createElement('span');
      sh.className = 'badge comp-badge shadow';
      sh.textContent = 'shadow #' + c.depth;
      out.push(sh);
    } else if (c.tree === 'slotted') {
      var sl = document.createElement('span');
      sl.className = 'badge comp-badge slotted';
      sl.textContent = 'slotted';
      out.push(sl);
    }
    if (c.slot && c.slot.mode === 'fallback') {
      var fb = document.createElement('span');
      fb.className = 'badge comp-badge fallback';
      fb.textContent = 'slot fallback';
      out.push(fb);
    }
    return out;
  }

  /** 节点的组合来源文字：宿主链 + slot 来源 */
  function compositionText(e) {
    var c = e.composition;
    if (!c) return '';
    var bits = [];
    if (c.hostChain && c.hostChain.length) {
      bits.push('宿主链：' + c.hostChain.map(function (h) { return h.label; }).join(' › '));
    }
    if (c.slot) {
      var slotName = c.slot.name ? '<slot name="' + c.slot.name + '">' : '<slot>（默认）';
      bits.push(c.slot.mode === 'slotted'
        ? '经 slot 分配：' + slotName
        : '未分配，使用 fallback：' + slotName);
    }
    return bits.join(' · ');
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
      compositionBadges(e).forEach(function (b) { line.appendChild(b); });
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

      var sel = document.createElement('span');
      sel.className = 'sel';
      sel.textContent = e.selector;
      btn.appendChild(sel);

      var compText = compositionText(e);
      if (compText) {
        var cEl = document.createElement('span');
        cEl.className = 'comp';
        cEl.textContent = compText;
        btn.appendChild(cEl);
      }

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
      compositionBadges(e).forEach(function (b) { title.appendChild(b); });
      var tag = document.createElement('span');
      tag.className = 'badge';
      tag.textContent = e.status === 'programmatic' ? 'tabindex<0' :
        (e.status === 'excluded' ? '已排除' : '提示');
      title.appendChild(tag);
      box.appendChild(title);

      (e.reasons || []).forEach(function (r) {
        var rEl = document.createElement('span');
        rEl.className = 'reason' + (r.code === 'slot-unassigned' ? ' slot-unassigned' : '');
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

      var compText = compositionText(e);
      if (compText) {
        var cEl = document.createElement('span');
        cEl.className = 'comp';
        cEl.textContent = compText;
        box.appendChild(cEl);
      }

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
          composition: e.composition || null
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
          text: e.text || '',
          // 组合树定位：宿主链 / slot 来源（跨 open shadow 边界节点 selector 为分段形式）
          composition: e.composition || null
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
          composition: e.composition || null,
          reasons: (e.reasons || []).map(function (r) { return { code: r.code, message: r.message }; }),
          warnings: (e.warnings || []).map(function (w) { return { code: w.code, message: w.message }; })
        };
      }),
      diagnostics: state.diagnostics,
      // Shadow DOM / slot 组合树分析：open root 展开、闭合边界、slot 分配与未分配统计
      shadowDom: state.shadow ? {
        stats: state.shadow.stats,
        openRoots: state.shadow.openRoots,
        closedRoots: state.shadow.closedRoots,
        unassigned: state.shadow.unassigned,
        declarativeShadowDomSupported: state.shadow.dsdSupported,
        leftoverTemplates: state.shadow.leftoverTemplates
      } : null,
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
