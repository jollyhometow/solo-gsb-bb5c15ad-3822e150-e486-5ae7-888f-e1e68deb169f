/*
 * analyzer.js —— 注入到 sandbox 预览 iframe 内执行的分析脚本。
 *
 * 职责：
 *  1. 依据 tabindex / disabled / hidden / inert / 计算样式 / DOM 嵌套，
 *     推导文档中所有「候选可聚焦元素」的 Tab（Shift+Tab 为其逆序）顺序；
 *  2. 为每个节点生成稳定选择器与节点身份（唯一 id + 结构/属性指纹，
 *     供父页面「基线对比」跨版本匹配），并解释被排除或顺序异常的原因；
 *  3. 模态焦点陷阱审计：识别可见的 dialog[open] / aria-modal="true" 容器
 *     （嵌套时只取最内层活动模态），把全局 Tab 顺序拆分为「模态内循环路线」
 *     与「模态外泄漏节点」，并诊断无可聚焦项、缺少可访问名称等问题；
 *  4. 通过 postMessage 与父页面通信：上报路线、接收高亮指令、绘制高亮框。
 *
 * 文件顶部的纯函数（parseTabIndexValue / computeOrder / buildDiagnostics /
 * pickActiveModal / computeModalCycle / buildModalDiagnostics）
 * 不依赖 DOM，会在 Node 环境下导出，供单元测试使用。
 */
(function () {
  'use strict';

  /* ===================== 纯函数（可单测） ===================== */

  /**
   * 解析 tabindex 属性原始值。
   * @param {string|null} raw 属性原始值（无属性时传 null）
   * @returns {{has:boolean, valid:boolean, value:(number|null), raw:(string|null)}}
   */
  function parseTabIndexValue(raw) {
    if (raw === null || raw === undefined) {
      return { has: false, valid: false, value: null, raw: null };
    }
    var trimmed = String(raw).trim();
    var valid = /^[+-]?\d+$/.test(trimmed);
    return {
      has: true,
      valid: valid,
      value: valid ? parseInt(trimmed, 10) : null,
      raw: String(raw)
    };
  }

  /**
   * 依据 HTML 顺序聚焦导航模型计算 Tab 顺序：
   *  1. tabindex 为正整数的元素，按数值升序，平局按 DOM 先后；
   *  2. 其余（tabindex=0 或天然可聚焦）按 DOM 先后。
   * status 为 'excluded' / 'programmatic'（tabindex<0）的节点不进入顺序。
   *
   * @param {Array<{status:string, tabIndex:number, domIndex:number}>} entries
   * @returns {number[]} entries 的下标数组，即 Tab 顺序
   */
  function computeOrder(entries) {
    var positives = [];
    var zeros = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.status !== 'ordered') continue;
      if (e.tabIndex > 0) positives.push(i);
      else zeros.push(i);
    }
    positives.sort(function (a, b) {
      return entries[a].tabIndex - entries[b].tabIndex || entries[a].domIndex - entries[b].domIndex;
    });
    zeros.sort(function (a, b) {
      return entries[a].domIndex - entries[b].domIndex;
    });
    return positives.concat(zeros);
  }

  /**
   * 汇总全局诊断信息（顺序异常与可访问性提示）。
   * @param {Array} entries 节点数组（含 status/tabIndex/reasons/warnings/tag/interactive）
   * @param {number[]} order computeOrder 的结果
   * @returns {Array<{level:string, code:string, message:string}>}
   */
  function buildDiagnostics(entries, order) {
    var diags = [];
    var i, e;

    // 正值 tabindex：顺序异常的主要来源
    var positives = entries.filter(function (x) { return x.status === 'ordered' && x.tabIndex > 0; });
    if (positives.length > 0) {
      diags.push({
        level: 'warn',
        code: 'positive-tabindex',
        message: '检测到 ' + positives.length + ' 个元素使用正值 tabindex（' +
          positives.map(function (x) { return x.label + '=' + x.tabIndex; }).join('，') +
          '）。它们会被排到所有自然顺序元素之前，通常应改用合理的 DOM 顺序。'
      });
    }

    // 正值 tabindex 撞号：按 DOM 顺序决胜
    var byValue = {};
    positives.forEach(function (x) {
      byValue[x.tabIndex] = byValue[x.tabIndex] || [];
      byValue[x.tabIndex].push(x.label);
    });
    Object.keys(byValue).forEach(function (v) {
      if (byValue[v].length > 1) {
        diags.push({
          level: 'info',
          code: 'duplicate-tabindex',
          message: 'tabindex=' + v + ' 被 ' + byValue[v].length + ' 个元素共用（' +
            byValue[v].join('，') + '），平局按 DOM 先后排序。'
        });
      }
    });

    // tabindex<0：可编程聚焦但不在 Tab 顺序中
    var programmatic = entries.filter(function (x) { return x.status === 'programmatic'; });
    if (programmatic.length > 0) {
      diags.push({
        level: 'info',
        code: 'negative-tabindex',
        message: programmatic.length + ' 个元素 tabindex 为负数（' +
          programmatic.map(function (x) { return x.label; }).join('，') +
          '）：可通过脚本 / 点击聚焦，但不会出现在 Tab 顺序中。'
      });
    }

    // 被排除节点统计
    var excluded = entries.filter(function (x) { return x.status === 'excluded'; });
    if (excluded.length > 0) {
      diags.push({
        level: 'info',
        code: 'excluded-count',
        message: excluded.length + ' 个候选元素被排除在 Tab 顺序之外，原因见「排除与诊断」列表。'
      });
    }

    // 非交互元素设置 tabindex
    var nonInteractive = entries.filter(function (x) {
      return x.status === 'ordered' && x.hasTabindexAttr && !x.interactive;
    });
    if (nonInteractive.length > 0) {
      diags.push({
        level: 'info',
        code: 'non-interactive-tabindex',
        message: nonInteractive.length + ' 个非交互元素（' +
          nonInteractive.map(function (x) { return x.label; }).join('，') +
          '）通过 tabindex 进入 Tab 顺序，请确认它们确实需要键盘聚焦。'
      });
    }

    // 节点级 warning 透传
    for (i = 0; i < entries.length; i++) {
      e = entries[i];
      var ws = e.warnings || [];
      for (var j = 0; j < ws.length; j++) {
        diags.push({ level: ws[j].level || 'warn', code: ws[j].code, message: e.label + '：' + ws[j].message });
      }
    }

    if (order.length === 0) {
      diags.push({ level: 'warn', code: 'empty-order', message: '当前文档没有任何可 Tab 聚焦的元素。' });
    }
    return diags;
  }

  /* ---------------- 模态焦点陷阱审计（纯函数） ---------------- */

  /**
   * 从可见模态候选中选出「活动模态」的下标。
   * 规则：嵌套时只取最内层（不包含其他候选者）；同级并列时取 DOM 序最后者
   * （后出现的模态通常位于顶层）。候选数组须按文档序排列。
   * @param {Array<{containsCandidate:boolean}>} candidates
   * @returns {number} 活动模态下标，无可用候选时为 -1
   */
  function pickActiveModal(candidates) {
    var pick = -1;
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] && candidates[i].containsCandidate) continue;
      pick = i;
    }
    return pick;
  }

  /**
   * 依据全局 Tab 顺序拆分「模态内循环」与「模态外泄漏」。
   * @param {Array<{status:string, inModal:boolean}>} entries 节点（仅需 status 与 inModal 字段）
   * @param {number[]} order computeOrder 的结果（entries 下标数组）
   * @returns {{cycle:number[], leaks:number[]}} 两组 entries 下标，均保持全局 Tab 顺序
   */
  function computeModalCycle(entries, order) {
    var cycle = [];
    var leaks = [];
    for (var i = 0; i < order.length; i++) {
      var idx = order[i];
      var e = entries[idx];
      if (!e || e.status !== 'ordered') continue;
      if (e.inModal) cycle.push(idx); else leaks.push(idx);
    }
    return { cycle: cycle, leaks: leaks };
  }

  /**
   * 模态焦点陷阱审计诊断（纯函数）。
   * @param {{hasModal:boolean, kind:string, label:string, cycleCount:number,
   *          leakCount:number, leakLabels:string[], hasAccessibleName:boolean,
   *          candidateCount:number}} info
   * @returns {Array<{level:string, code:string, message:string}>}
   */
  function buildModalDiagnostics(info) {
    var diags = [];
    if (!info || !info.hasModal) return diags;
    var kindLabel = info.kind === 'dialog' ? '<dialog open>' : 'aria-modal="true"';

    diags.push({
      level: 'info',
      code: 'modal-active',
      message: '活动模态 ' + info.label + '（' + kindLabel + '）：模态内循环 ' +
        info.cycleCount + ' 个节点，模态外泄漏 ' + info.leakCount + ' 个。'
    });

    if (info.cycleCount === 0) {
      diags.push({
        level: 'warn',
        code: 'modal-no-focusable',
        message: '活动模态内没有任何可 Tab 聚焦的元素，焦点陷阱无法形成循环，键盘用户将无法操作模态内容。'
      });
    }

    if (!info.hasAccessibleName) {
      diags.push({
        level: 'warn',
        code: 'modal-no-name',
        message: '活动模态缺少可访问名称：请添加 aria-label 或 aria-labelledby（至少提供 title），否则屏幕阅读器用户无法理解该模态的用途。'
      });
    }

    if (info.leakCount > 0) {
      var labels = (info.leakLabels || []).slice(0, 5).join('，');
      diags.push({
        level: 'warn',
        code: 'modal-leak',
        message: info.leakCount + ' 个模态外节点仍可 Tab 到达（' + labels +
          (info.leakCount > 5 ? ' 等' : '') + '），焦点可从模态中泄漏；' +
          '应对模态外内容设置 inert 或移除其 Tab 可达性。' +
          (info.kind === 'dialog'
            ? '（若该 <dialog> 以 showModal() 打开，浏览器会自动屏蔽外部节点；此处按静态可聚焦性列出。）'
            : '')
      });
    }

    if (info.candidateCount > 1) {
      diags.push({
        level: 'info',
        code: 'modal-multiple',
        message: '检测到 ' + info.candidateCount + ' 个可见模态容器：嵌套时仅审计最内层，同级并列时取 DOM 序最后者。'
      });
    }
    return diags;
  }

  // Node 环境：导出纯函数供测试，随后退出（不触碰 DOM）。
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        parseTabIndexValue: parseTabIndexValue,
        computeOrder: computeOrder,
        buildDiagnostics: buildDiagnostics,
        pickActiveModal: pickActiveModal,
        computeModalCycle: computeModalCycle,
        buildModalDiagnostics: buildModalDiagnostics
      };
    }
    return;
  }

  /* ===================== 浏览器环境：DOM 分析 ===================== */

  var SOURCE = 'focus-lab'; // 消息来源标记，父子双方据此过滤消息

  var entries = [];   // 全部候选节点（含被排除者）
  var order = [];     // entries 下标组成的 Tab 顺序
  var overlay = null; // 高亮框
  var badge = null;   // 高亮框上的序号角标
  var currentStep = -1;

  function post(msg) {
    msg.source = SOURCE;
    parent.postMessage(msg, '*'); // sandbox 下源为 opaque origin，父页面用 event.source 校验
  }

  /** 是否为可被 disabled 禁用的表单控件 */
  function isFormControl(el) {
    return /^(BUTTON|INPUT|SELECT|TEXTAREA|OPTGROUP|OPTION)$/.test(el.tagName);
  }

  /** details 的第一个 summary 子元素 */
  function firstSummary(details) {
    for (var i = 0; i < details.children.length; i++) {
      if (details.children[i].tagName === 'SUMMARY') return details.children[i];
    }
    return null;
  }

  /** 元素是否属于「天然可聚焦」集合（未考虑 disabled/hidden 等排除项） */
  function naturallyFocusable(el) {
    switch (el.tagName) {
      case 'A':
      case 'AREA':
        return el.hasAttribute('href');
      case 'BUTTON':
      case 'SELECT':
      case 'TEXTAREA':
        return true;
      case 'INPUT':
        return el.type !== 'hidden';
      case 'IFRAME':
        return true;
      case 'AUDIO':
      case 'VIDEO':
        return el.hasAttribute('controls');
      case 'SUMMARY': {
        var p = el.parentElement;
        return !!(p && p.tagName === 'DETAILS' && firstSummary(p) === el);
      }
      default:
        break;
    }
    // contenteditable（空串 / true / plaintext-only 等，isContentEditable 已排除 "false"）
    if (el.isContentEditable) return true;
    return false;
  }

  /** 元素是否处于「disabled 的 fieldset」中（首个 legend 内部除外） */
  function disabledFieldsetAncestor(el) {
    var node = el.parentElement;
    while (node) {
      if (node.tagName === 'FIELDSET' && node.hasAttribute('disabled')) {
        // HTML 规则：第一个 legend 子元素内部的控件不受 fieldset[disabled] 影响
        var legend = null;
        for (var i = 0; i < node.children.length; i++) {
          if (node.children[i].tagName === 'LEGEND') { legend = node.children[i]; break; }
        }
        if (!legend || !legend.contains(el)) return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  /** 收集元素被排除出 Tab 顺序的全部原因 */
  function exclusionReasons(el) {
    var reasons = [];
    var node, cs;

    if (el.tagName === 'INPUT' && el.type === 'hidden') {
      reasons.push({ code: 'input-hidden', message: 'input[type=hidden] 不参与聚焦' });
    }
    // hidden 属性：自身或祖先（UA 样式表虽映射为 display:none，但可被作者样式覆盖，故直接检测属性）
    var hiddenHit = el.closest('[hidden]');
    if (hiddenHit) {
      reasons.push({
        code: 'hidden-attr',
        message: hiddenHit === el ? '带有 hidden 属性，未渲染' : '祖先元素带有 hidden 属性，子树未渲染'
      });
    }

    var inertHit = el.closest('[inert]');
    if (inertHit) {
      reasons.push({
        code: 'inert',
        message: inertHit === el ? '元素自身带有 inert 属性' : '祖先元素带有 inert 属性，子树整体不可聚焦'
      });
    }

    if (isFormControl(el) && el.hasAttribute('disabled')) {
      reasons.push({ code: 'disabled', message: '表单控件带有 disabled 属性' });
    }
    var fs = disabledFieldsetAncestor(el);
    if (fs && isFormControl(el)) {
      reasons.push({ code: 'fieldset-disabled', message: '位于 disabled 的 fieldset 内（且不在其第一个 legend 中）' });
    }

    // 闭合的 details：除第一个 summary 外，内部内容不可聚焦
    var closedDetails = el.closest('details:not([open])');
    if (closedDetails) {
      var summary = firstSummary(closedDetails);
      if (!(summary && (summary === el || summary.contains(el)))) {
        reasons.push({ code: 'details-closed', message: '处于未展开的 details 内（仅其 summary 可聚焦）' });
      }
    }

    // 计算样式：display:none —— 自身或任一祖先命中即不渲染
    node = el;
    while (node && node.nodeType === 1) {
      cs = getComputedStyle(node);
      if (cs.display === 'none') {
        reasons.push({
          code: 'display-none',
          message: node === el ? '计算样式 display:none' : '祖先 ' + describe(node).css + ' 的计算样式为 display:none'
        });
        break;
      }
      node = node.parentElement;
    }

    // 计算样式：visibility —— 计算值已含继承与覆盖，只需检查自身
    cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') {
      reasons.push({ code: 'visibility-hidden', message: '计算样式 visibility:' + cs.visibility });
    }

    return reasons;
  }

  /** 元素级附加警告（不影响是否可聚焦） */
  function elementWarnings(el) {
    var warnings = [];
    if (el.closest('[aria-hidden="true"]')) {
      warnings.push({
        code: 'aria-hidden-focusable',
        level: 'warn',
        message: '可聚焦元素位于 aria-hidden="true" 的子树中，屏幕阅读器与键盘体验不一致'
      });
    }
    return warnings;
  }

  /** 生成简短描述：标签 + id/class + 文本片段 */
  function describe(el) {
    var css = el.tagName.toLowerCase();
    if (el.id) {
      css += '#' + el.id;
    } else if (el.classList && el.classList.length) {
      css += '.' + Array.prototype.slice.call(el.classList, 0, 2).join('.');
    }
    if (el.tagName === 'INPUT') css += '[type=' + el.type + ']';
    var text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return { css: css, text: text };
  }

  /**
   * 生成稳定选择器：优先唯一 #id，否则用 tag + :nth-of-type 逐级回溯。
   * 用于编辑重算后「恢复当前位置」。
   * 注意：该选择器含位置信息，仅用于定位，不作为跨版本节点身份（见 computeIdentity）。
   */
  function stableSelector(el) {
    if (el.id) {
      var byId = '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
      try {
        if (document.querySelectorAll(byId).length === 1) return byId;
      } catch (err) { /* 继续走路径方案 */ }
    }
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        part = '#' + (window.CSS && CSS.escape ? CSS.escape(node.id) : node.id);
        parts.unshift(part);
        break;
      }
      var parent = node.parentElement;
      if (parent) {
        var sameTag = [];
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === node.tagName) sameTag.push(parent.children[i]);
        }
        if (sameTag.length > 1) {
          part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(part);
      node = parent;
    }
    var selector = parts.join(' > ');
    // 校验唯一性；不唯一时退回完整路径（含 html、body）
    try {
      if (document.querySelectorAll(selector).length !== 1) {
        selector = 'html > body ' + selector.replace(/^.*?body( > )?/, '');
      }
    } catch (err) { /* 保留原样 */ }
    return selector;
  }

  /* ---------------- 节点身份（供基线对比匹配） ---------------- */

  function cssEscapeIdent(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
  }

  /** 指纹字符串中的值转义，避免拼接歧义 */
  function escFp(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ').trim();
  }

  /** 参与指纹的关键属性（不含 tabindex/disabled/hidden 等会影响顺序或状态的属性） */
  var FP_ATTRS = ['type', 'name', 'role', 'href', 'placeholder', 'aria-label', 'title'];

  /**
   * 结构/属性指纹：标签 + 关键属性 + 归一化文本 + 祖先链（标签与祖先 id）。
   * 刻意不含 :nth-of-type 等位置信息——兄弟节点插入/删除不会改变既有节点的指纹。
   */
  function fingerprint(el) {
    var s = el.tagName.toLowerCase();
    for (var i = 0; i < FP_ATTRS.length; i++) {
      var name = FP_ATTRS[i];
      if (el.hasAttribute(name)) {
        s += '[' + name + '="' + escFp(String(el.getAttribute(name)).slice(0, 24)) + '"]';
      }
    }
    if (el.tagName === 'INPUT' && !el.hasAttribute('type')) s += '[type="text"]';
    var text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (text) s += ' "' + escFp(text) + '"';
    var chain = [];
    var node = el.parentElement;
    while (node && node.nodeType === 1) {
      var part = node.tagName.toLowerCase();
      if (node.id) part += '#' + node.id;
      chain.unshift(part);
      node = node.parentElement;
    }
    s += ' ^' + chain.join('>');
    return s;
  }

  /** 纯 nth-of-type 结构路径：仅供展示与排查，不参与匹配（位置敏感，兄弟插入即漂移） */
  function domPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var part = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (parent) {
        var same = 0;
        var idx = 0;
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === node.tagName) {
            same++;
            if (parent.children[i] === node) idx = same;
          }
        }
        if (same > 1) part += ':nth-of-type(' + idx + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  /**
   * 节点身份：
   *  - uid ：文档内唯一 id（id 缺失或不唯一时为空）；
   *  - fp  ：结构/属性指纹（位置无关）；
   *  - path：nth-of-type 结构路径（仅展示用）。
   */
  function computeIdentity(el) {
    var id = el.id ? String(el.id) : null;
    var uid = null;
    if (id) {
      try {
        if (document.querySelectorAll('#' + cssEscapeIdent(id)).length === 1) uid = 'id:' + id;
      } catch (err) { /* 选择器非法时放弃 uid */ }
    }
    return { id: id, uid: uid, fp: fingerprint(el), path: domPath(el) };
  }

  /** 扫描文档，构建候选节点数组 */
  function buildEntries() {
    entries = [];
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var ti = parseTabIndexValue(el.hasAttribute('tabindex') ? el.getAttribute('tabindex') : null);
      var natural = naturallyFocusable(el);
      var hasValidTabindex = ti.has && ti.valid;
      var candidate = natural || hasValidTabindex;

      var nodeWarnings = elementWarnings(el);
      if (ti.has && !ti.valid) {
        nodeWarnings.push({
          code: 'invalid-tabindex',
          level: 'warn',
          message: 'tabindex="' + ti.raw + '" 不是合法整数，该属性被忽略'
        });
      }
      if (!candidate) {
        // 非候选元素：仅当有值得报告的警告时才记录（如非法 tabindex）
        if (nodeWarnings.length > 0) {
          var d0 = describe(el);
          entries.push({
            el: el,
            status: 'not-focusable',
            tag: el.tagName.toLowerCase(),
            label: d0.css,
            text: d0.text,
            selector: stableSelector(el),
            identity: computeIdentity(el),
            tabIndex: null,
            domIndex: i,
            interactive: false,
            hasTabindexAttr: ti.has,
            reasons: [],
            warnings: nodeWarnings
          });
        }
        continue;
      }

      var reasons = exclusionReasons(el);
      var effective = hasValidTabindex ? ti.value : 0;
      var status;
      if (reasons.length > 0) status = 'excluded';
      else if (effective < 0) status = 'programmatic';
      else status = 'ordered';

      var d = describe(el);
      entries.push({
        el: el,
        status: status,
        tag: el.tagName.toLowerCase(),
        label: d.css,
        text: d.text,
        selector: stableSelector(el),
        identity: computeIdentity(el),
        tabIndex: effective,
        domIndex: i,
        interactive: natural,
        hasTabindexAttr: ti.has,
        reasons: reasons,
        warnings: nodeWarnings
      });
    }
  }

  /** 序列化（去掉 DOM 引用）后上报给父页面 */
  function serializeEntries() {
    return entries.map(function (e) {
      return {
        status: e.status,
        tag: e.tag,
        label: e.label,
        text: e.text,
        selector: e.selector,
        identity: e.identity,
        tabIndex: e.tabIndex,
        domIndex: e.domIndex,
        interactive: e.interactive,
        hasTabindexAttr: e.hasTabindexAttr,
        reasons: e.reasons,
        warnings: e.warnings,
        step: null // 稍后填充
      };
    });
  }

  /* ---------------- 模态焦点陷阱审计（DOM） ---------------- */

  /** 容器可见性：hidden / inert 属性、display:none（自身或祖先）、visibility */
  function isVisibleContainer(el) {
    if (el.closest('[hidden]')) return false;
    if (el.closest('[inert]')) return false;
    var node = el;
    while (node && node.nodeType === 1) {
      if (getComputedStyle(node).display === 'none') return false;
      node = node.parentElement;
    }
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
  }

  /** 模态的可访问名称：aria-labelledby → aria-label → title */
  function accessibleNameOf(el) {
    var ids = (el.getAttribute('aria-labelledby') || '').trim();
    if (ids) {
      var text = ids.split(/\s+/).map(function (id) {
        var t = document.getElementById(id);
        return t ? (t.textContent || '') : '';
      }).join(' ').replace(/\s+/g, ' ').trim();
      if (text) return { name: text.slice(0, 80), source: 'aria-labelledby' };
    }
    var label = (el.getAttribute('aria-label') || '').trim();
    if (label) return { name: label.slice(0, 80), source: 'aria-label' };
    var title = (el.getAttribute('title') || '').trim();
    if (title) return { name: title.slice(0, 80), source: 'title' };
    return { name: null, source: null };
  }

  /**
   * 模态焦点陷阱审计：
   *  1. 找出可见的 dialog[open] / [aria-modal="true"] 容器；
   *  2. 嵌套时仅取最内层、同级并列取 DOM 序最后者作为活动模态；
   *  3. 模态内可 Tab 节点按全局顺序形成「循环路线」，模态外仍可 Tab 到达的
   *     节点记为「泄漏」；并诊断「无可聚焦项」「缺少可访问名称」等问题。
   */
  function computeModalAudit() {
    var found = document.querySelectorAll('dialog[open], [aria-modal="true"]');
    var candidates = [];
    var i, a, b;
    for (i = 0; i < found.length; i++) {
      var el = found[i];
      if (!isVisibleContainer(el)) continue;
      candidates.push({ el: el, kind: el.tagName === 'DIALOG' ? 'dialog' : 'aria-modal' });
    }
    // 嵌套标记：包含其他候选的容器不是「最内层」
    for (a = 0; a < candidates.length; a++) {
      candidates[a].containsCandidate = false;
      for (b = 0; b < candidates.length; b++) {
        if (a !== b && candidates[a].el.contains(candidates[b].el)) {
          candidates[a].containsCandidate = true;
          break;
        }
      }
    }
    var activeIdx = pickActiveModal(candidates);
    var audit = {
      activeModal: null,
      cycle: [],
      leaks: [],
      diagnostics: [],
      candidates: candidates.map(function (c, i2) {
        return {
          kind: c.kind,
          label: describe(c.el).css,
          selector: stableSelector(c.el),
          audited: i2 === activeIdx
        };
      })
    };
    if (activeIdx < 0) return audit;

    var active = candidates[activeIdx];
    var flagged = entries.map(function (e) {
      return { status: e.status, inModal: !!(e.el && active.el.contains(e.el)) };
    });
    var cl = computeModalCycle(flagged, order);
    var stepOf = {};
    for (i = 0; i < order.length; i++) stepOf[order[i]] = i + 1;
    var nameInfo = accessibleNameOf(active.el);
    var d = describe(active.el);

    audit.activeModal = {
      kind: active.kind,
      label: d.css,
      text: d.text,
      selector: stableSelector(active.el),
      identity: computeIdentity(active.el),
      accessibleName: nameInfo.name,
      nameSource: nameInfo.source
    };
    audit.cycle = cl.cycle.map(function (idx, i3) {
      var e = entries[idx];
      return {
        cycleStep: i3 + 1,
        step: stepOf[idx],
        selector: e.selector,
        label: e.label,
        text: e.text,
        tabIndex: e.tabIndex
      };
    });
    audit.leaks = cl.leaks.map(function (idx) {
      var e = entries[idx];
      return {
        step: stepOf[idx],
        selector: e.selector,
        label: e.label,
        text: e.text,
        tabIndex: e.tabIndex
      };
    });
    audit.diagnostics = buildModalDiagnostics({
      hasModal: true,
      kind: active.kind,
      label: d.css,
      cycleCount: audit.cycle.length,
      leakCount: audit.leaks.length,
      leakLabels: audit.leaks.map(function (l) { return l.label; }),
      hasAccessibleName: !!nameInfo.name,
      candidateCount: candidates.length
    });
    return audit;
  }

  function computeAndSend() {
    try {
      buildEntries();
      order = computeOrder(entries);
      var serialized = serializeEntries();
      for (var s = 0; s < order.length; s++) {
        serialized[order[s]].step = s + 1;
      }
      var diagnostics = buildDiagnostics(entries, order);
      // Shadow DOM 提示
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        if (all[i].shadowRoot) {
          diagnostics.push({
            level: 'info',
            code: 'shadow-root',
            message: '检测到 open Shadow Root（' + describe(all[i]).css + '），其实验室未展开其内部焦点顺序。'
          });
        }
      }
      post({
        type: 'route',
        payload: {
          entries: serialized,
          order: order.map(function (idx) { return serialized[idx].selector; }),
          diagnostics: diagnostics,
          modalAudit: computeModalAudit(),
          stats: {
            candidates: entries.length,
            ordered: order.length,
            excluded: entries.filter(function (e) { return e.status === 'excluded'; }).length,
            programmatic: entries.filter(function (e) { return e.status === 'programmatic'; }).length
          }
        }
      });
    } catch (err) {
      post({ type: 'error', message: String(err && err.message || err) });
    }
  }

  /* ---------------- 高亮 ---------------- */

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return;
    overlay = document.createElement('div');
    overlay.setAttribute('data-focus-lab', 'overlay');
    overlay.style.cssText =
      'position:absolute;pointer-events:none;z-index:2147483647;display:none;' +
      'border:3px solid #ff2d78;border-radius:4px;' +
      'box-shadow:0 0 0 3px rgba(255,45,120,.25);transition:all .12s ease;';
    badge = document.createElement('div');
    badge.style.cssText =
      'position:absolute;top:-26px;left:-3px;background:#ff2d78;color:#fff;' +
      'font:12px/18px ui-monospace,monospace;padding:0 8px;border-radius:3px;white-space:nowrap;';
    overlay.appendChild(badge);
    (document.body || document.documentElement).appendChild(overlay);
  }

  function highlightStep(step) {
    if (step < 0 || step >= order.length) return;
    var entry = entries[order[step]];
    var el = entry.el;
    if (!el || !el.isConnected) return;
    ensureOverlay();
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* 忽略 */ }
    var r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.borderStyle = 'solid';
    overlay.style.left = (r.left + window.pageXOffset - 3) + 'px';
    overlay.style.top = (r.top + window.pageYOffset - 3) + 'px';
    overlay.style.width = Math.max(r.width, 4) + 6 + 'px';
    overlay.style.height = Math.max(r.height, 4) + 6 + 'px';
    badge.textContent = 'Tab ' + (step + 1) + ' / ' + order.length;
    currentStep = step;
    post({ type: 'highlighted', step: step, selector: entry.selector, label: entry.label });
  }

  function clearHighlight() {
    if (overlay) overlay.style.display = 'none';
    currentStep = -1;
  }

  /**
   * 按稳定选择器高亮任意候选节点（含被排除 / 仅编程聚焦者，虚线框展示）。
   * 供父页面「基线对比」差异项与「模态审计」条目点击联动：差异节点可能不在
   * Tab 顺序中，无法按步进序号定位。
   * opts.badge 自定义角标文本；opts.solid 使用实线框（默认虚线）。
   * 目标不是候选节点时（如模态容器本身），回退为按选择器直接定位。
   */
  function highlightNodeBySelector(selector, opts) {
    opts = opts || {};
    var entry = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].selector === selector) { entry = entries[i]; break; }
    }
    var el = entry && entry.el;
    if (!el || !el.isConnected) {
      el = null;
      try { el = document.querySelector(selector); } catch (err) { el = null; }
    }
    if (!el || !el.isConnected) {
      post({ type: 'highlight-miss', selector: selector });
      return;
    }
    ensureOverlay();
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* 忽略 */ }
    var r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.borderStyle = opts.solid ? 'solid' : 'dashed';
    overlay.style.left = (r.left + window.pageXOffset - 3) + 'px';
    overlay.style.top = (r.top + window.pageYOffset - 3) + 'px';
    overlay.style.width = Math.max(r.width, 4) + 6 + 'px';
    overlay.style.height = Math.max(r.height, 4) + 6 + 'px';
    if (opts.badge) {
      badge.textContent = opts.badge;
    } else if (entry) {
      var oi = order.indexOf(entries.indexOf(entry));
      if (oi >= 0) {
        badge.textContent = 'Tab ' + (oi + 1) + ' / ' + order.length;
      } else {
        var STATUS_BADGE = { excluded: '已排除', programmatic: '仅编程聚焦', 'not-focusable': '不可聚焦' };
        badge.textContent = STATUS_BADGE[entry.status] || entry.status;
      }
    } else {
      badge.textContent = '元素';
    }
    currentStep = -1;
    post({ type: 'highlighted', step: -1, selector: selector });
  }

  /* ---------------- 通信 ---------------- */

  window.addEventListener('message', function (ev) {
    var d = ev.data || {};
    if (d.target !== SOURCE) return;
    if (d.type === 'highlight') {
      highlightStep(d.step);
    } else if (d.type === 'highlight-node') {
      highlightNodeBySelector(d.selector, { badge: d.badge, solid: d.solid });
    } else if (d.type === 'clear') {
      clearHighlight();
    } else if (d.type === 'recompute') {
      computeAndSend();
    }
  });

  // DOM 与样式就绪后执行首次计算
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(computeAndSend, 0); });
  } else {
    setTimeout(computeAndSend, 0);
  }
})();
