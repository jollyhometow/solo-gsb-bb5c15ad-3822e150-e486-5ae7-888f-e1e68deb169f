/*
 * analyzer.js —— 注入到 sandbox 预览 iframe 内执行的分析脚本。
 *
 * 职责：
 *  1. 依据【组合树（composed tree / flat tree）】推导 Tab（Shift+Tab 为其逆序）顺序：
 *     按文档序遍历，遇到挂有 open Shadow Root 的宿主时进入其 shadowRoot；
 *     遇到 <slot> 时展开被分配节点（assignedNodes），无分配时使用 fallback 内容；
 *     宿主自身先于 shadow 内容计入，未被任何 slot 分配的轻 DOM 节点不渲染、不计入；
 *  2. 为跨 shadow 边界的节点生成可往返定位的【分段选择器】（边界用 ' >> ' 表示），
 *     使步进、列表点击、编辑后位置恢复都能正确高亮；
 *  3. 为每个节点生成稳定节点身份（跨边界唯一 id + 组合祖先链指纹，供基线对比），
 *     并在诊断中给出宿主链、slot 来源（assigned / fallback）等组合信息；
 *  4. 闭合 Shadow Root（宿主带 data-focus-lab-closed-root 标注，由父页面在解析前
 *     注入）明确标为「不可检查」，绝不猜测其内部焦点路线；
 *  5. 模态焦点陷阱审计（支持组合树包含关系）；
 *  6. 通过 postMessage 与父页面通信：上报路线、接收高亮指令、绘制高亮框。
 *
 * 文件顶部的纯函数（parseTabIndexValue / computeOrder / buildDiagnostics /
 * pickActiveModal / computeModalCycle / buildModalDiagnostics / buildShadowDiagnostics）
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
   *  1. tabindex 为正整数的元素，按数值升序，平局按组合树（flat tree）先后；
   *  2. 其余（tabindex=0 或天然可聚焦）按组合树先后。
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
            byValue[v].join('，') + '），平局按组合树先后排序。'
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

  /* ---------------- Shadow DOM / slot 组合树诊断（纯函数） ---------------- */

  /**
   * 汇总 Shadow DOM / slot 组合树相关诊断。
   * @param {{
   *   dsdSupported:boolean,
   *   openRoots:Array<{label:string, selector:string, slotted:number, fallback:number, delegatesFocus:boolean}>,
   *   closedRoots:Array<{label:string, selector:string}>,
   *   unassigned:Array<{label:string}>,
   *   leftoverTemplates:number,
   *   crossScopePositives:number
   * }} info
   * @returns {Array<{level:string, code:string, message:string}>}
   */
  function buildShadowDiagnostics(info) {
    var diags = [];
    if (!info) return diags;

    var open = info.openRoots || [];
    var closed = info.closedRoots || [];
    var unassigned = info.unassigned || [];

    if (open.length > 0) {
      var parts = open.map(function (r) {
        var bits = [];
        if (r.slotted > 0) bits.push(r.slotted + ' 个 slotted');
        if (r.fallback > 0) bits.push(r.fallback + ' 个 fallback');
        if (r.delegatesFocus) bits.push('delegatesFocus');
        return r.label + (bits.length ? '（' + bits.join('，') + '）' : '');
      });
      diags.push({
        level: 'info',
        code: 'open-shadow-root',
        message: '检测到 ' + open.length + ' 个 open Shadow Root：' + parts.join('，') +
          '。Tab 路线已按组合树展开其 shadowRoot 与 slot 分配节点。'
      });
    }

    closed.forEach(function (r) {
      diags.push({
        level: 'warn',
        code: 'closed-shadow-root',
        message: '宿主 ' + r.label + ' 挂有【闭合 Shadow Root】：闭合边界内部无法经任何 DOM API ' +
          '检查，实验室不猜测其内部焦点路线（其轻 DOM 子节点仍正常分析）。'
      });
    });

    if (unassigned.length > 0) {
      var labels = unassigned.slice(0, 5).map(function (x) { return x.label; }).join('，');
      diags.push({
        level: 'info',
        code: 'slot-unassigned',
        message: unassigned.length + ' 个轻 DOM 候选节点未被任何 <slot> 分配（' + labels +
          (unassigned.length > 5 ? ' 等' : '') +
          '）：组合树中不渲染，已从 Tab 路线排除（宿主轻 DOM 不重复计入）。'
      });
    }

    if (!info.dsdSupported && (info.leftoverTemplates || 0) > 0) {
      diags.push({
        level: 'warn',
        code: 'dsd-unsupported',
        message: '检测到 ' + info.leftoverTemplates + ' 个 <template shadowrootmode>，但当前预览引擎' +
          '未升级声明式 Shadow DOM（DSD），这些模板保持为普通模板、其内部不参与组合树。'
      });
    }

    if ((info.crossScopePositives || 0) > 0) {
      diags.push({
        level: 'info',
        code: 'tabindex-cross-scope',
        message: '有 ' + info.crossScopePositives + ' 个正值 tabindex 分布在不同 shadow tree 中：' +
          '本实验室按组合树序统一排序展示；浏览器对跨树正值 tabindex 的精确处理以各 tree 的 ' +
          'tabindex 排序域为准，细微先后请以真实浏览器为准。'
      });
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
        buildShadowDiagnostics: buildShadowDiagnostics,
        pickActiveModal: pickActiveModal,
        computeModalCycle: computeModalCycle,
        buildModalDiagnostics: buildModalDiagnostics
      };
    }
    return;
  }

  /* ===================== 浏览器环境：组合树 DOM 分析 ===================== */

  var SOURCE = 'focus-lab'; // 消息来源标记，父子双方据此过滤消息
  var CLOSED_ROOT_ATTR = 'data-focus-lab-closed-root'; // 父页面在解析前注入的闭根宿主标注

  var entries = [];    // 全部候选节点（含被排除者）
  var order = [];      // entries 下标组成的 Tab 顺序
  var overlay = null;  // 高亮框
  var badge = null;    // 高亮框上的序号角标
  var currentStep = -1;

  // 组合树遍历状态
  var visited = null;          // WeakSet：组合树中实际「渲染」到的元素
  var provenance = null;       // WeakMap：element → {type:'slotted'|'fallback', slotName, slotSelector}
  var openRootsInfo = [];      // {root, host, label, selector, slotted, fallback, delegatesFocus}
  var closedRootsInfo = [];    // {host, label, selector}
  var roots = [];              // 遍历过程中遇到的全部树根（document + open shadowRoot）
  var idCounts = Object.create(null); // 跨全部树根的 id 出现次数（用于判定全局唯一 id）
  var flatCounter = 0;         // 组合树序计数（domIndex）

  function post(msg) {
    msg.source = SOURCE;
    parent.postMessage(msg, '*'); // sandbox 下源为 opaque origin，父页面用 event.source 校验
  }

  /** 是否为可被 disabled 禁用的表单控件 */
  function isFormControl(el) {
    return /^(BUTTON|INPUT|SELECT|TEXTAREA|OPTGROUP|OPTION)$/.test(el.tagName);
  }

  /** details 的第一个 summary 子元素（同一棵树内） */
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

  /* ---------------- 组合树（跨 shadow 边界）祖先链工具 ---------------- */

  /**
   * 组合树意义上的父节点：
   *  - 被分配节点（slotted）的组合父是其所在的 <slot>；
   *  - shadow root 内顶层节点的组合父是宿主元素；
   *  - 其余即普通父元素。
   */
  function composedParent(node) {
    if (!node) return null;
    if (node.assignedSlot) return node.assignedSlot;
    if (node.parentElement) return node.parentElement;
    var root = node.getRootNode && node.getRootNode();
    if (root && root.nodeType === 11) return root.host || null; // ShadowRoot.DOCUMENT_FRAGMENT_NODE
    return null;
  }

  /** 沿组合祖先链向上寻找首个匹配选择器的元素（跨 open shadow 边界） */
  function composedClosest(el, selector) {
    var node = el;
    while (node && node.nodeType === 1) {
      try {
        if (node.matches && node.matches(selector)) return node;
      } catch (err) { /* 选择器非法时忽略 */ }
      node = composedParent(node);
    }
    return null;
  }

  /** container 在组合树中是否包含 target（支持 slot 分配与嵌套 shadow root） */
  function composedContains(container, target) {
    var node = target;
    while (node && node.nodeType === 1) {
      if (node === container) return true;
      node = composedParent(node);
    }
    return false;
  }

  /** 元素是否处于「disabled 的 fieldset」中（首个 legend 内部除外；保守地只在同一棵树内判定） */
  function disabledFieldsetAncestor(el) {
    var node = el.parentElement;
    while (node) {
      if (node.tagName === 'FIELDSET' && node.hasAttribute('disabled')) {
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

  /** 收集元素被排除出 Tab 顺序的全部原因（组合树感知） */
  function exclusionReasons(el) {
    var reasons = [];
    var node, cs;

    if (el.tagName === 'INPUT' && el.type === 'hidden') {
      reasons.push({ code: 'input-hidden', message: 'input[type=hidden] 不参与聚焦' });
    }
    // <slot> 本身不渲染为可交互控件
    if (el.tagName === 'SLOT') {
      reasons.push({ code: 'slot-element', message: '<slot> 是组合占位元素，自身不可 Tab 聚焦（其分配 / fallback 节点单独参与）' });
    }
    // hidden 属性：组合树自身或祖先（跨 shadow 边界）
    var hiddenHit = composedClosest(el, '[hidden]');
    if (hiddenHit) {
      reasons.push({
        code: 'hidden-attr',
        message: hiddenHit === el ? '带有 hidden 属性，未渲染' : '组合祖先元素带有 hidden 属性，子树未渲染'
      });
    }

    var inertHit = composedClosest(el, '[inert]');
    if (inertHit) {
      reasons.push({
        code: 'inert',
        message: inertHit === el ? '元素自身带有 inert 属性' : '组合祖先元素带有 inert 属性，子树整体不可聚焦'
      });
    }

    if (isFormControl(el) && el.hasAttribute('disabled')) {
      reasons.push({ code: 'disabled', message: '表单控件带有 disabled 属性' });
    }
    var fs = disabledFieldsetAncestor(el);
    if (fs && isFormControl(el)) {
      reasons.push({ code: 'fieldset-disabled', message: '位于 disabled 的 fieldset 内（且不在其第一个 legend 中）' });
    }

    // 闭合的 details：除第一个 summary 外，内部内容不可聚焦（保守地只在同一棵树内判定）
    var closedDetails = el.closest('details:not([open])');
    if (closedDetails) {
      var summary = firstSummary(closedDetails);
      if (!(summary && (summary === el || summary.contains(el)))) {
        reasons.push({ code: 'details-closed', message: '处于未展开的 details 内（仅其 summary 可聚焦）' });
      }
    }

    // 计算样式：display:none —— 沿组合祖先链（含宿主与 slot）命中即不渲染
    node = el;
    while (node && node.nodeType === 1) {
      cs = getComputedStyle(node);
      if (cs.display === 'none') {
        reasons.push({
          code: 'display-none',
          message: node === el ? '计算样式 display:none' : '组合祖先 ' + describe(node).css + ' 的计算样式为 display:none'
        });
        break;
      }
      node = composedParent(node);
    }

    // 计算样式：visibility —— 计算值已含继承与覆盖，只需检查自身
    cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') {
      reasons.push({ code: 'visibility-hidden', message: '计算样式 visibility:' + cs.visibility });
    }

    return reasons;
  }

  /** 元素级附加警告（不影响是否可聚焦；跨 shadow 边界） */
  function elementWarnings(el) {
    var warnings = [];
    if (composedClosest(el, '[aria-hidden="true"]')) {
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

  /* ---------------- 跨边界分段选择器 ---------------- */

  /**
   * 在单棵树（Document 或 ShadowRoot）内生成相对路径：
   * 优先树内唯一 #id，否则用 tag + :nth-of-type 逐级回溯到树根。
   * 含位置信息，仅用于定位，不作为跨版本节点身份。
   */
  function rootLocalSelector(el, root) {
    if (el.id) {
      var byId = '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
      try {
        if (root.querySelectorAll(byId).length === 1) return byId;
      } catch (err) { /* 继续走路径方案 */ }
    }
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1) {
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
    return parts.join(' > ');
  }

  /**
   * 生成跨 shadow 边界的分段选择器：
   *   "my-card >> form > input" 表示文档中的 my-card，其 open shadowRoot 内的 form > input；
   * 每一段都可在对应树根内唯一定位，段间用 ' >> ' 表示一次 shadow 跨越。
   * slotted 节点物理上属于轻 DOM，其选择器只包含物理跨越（宿主边界），
   * slot 来源由 composition.slot 单独表达。
   */
  function segmentedSelector(el) {
    var segments = [];
    var node = el;
    while (node && node.nodeType === 1) {
      var root = node.getRootNode();
      segments.unshift(rootLocalSelector(node, root));
      node = root.nodeType === 11 ? root.host : null;
    }
    return segments.join(' >> ');
  }

  /**
   * 按分段选择器往返定位节点：逐段 querySelector 并跨过 open shadowRoot。
   * 闭合边界不可进入（host.shadowRoot === null），无法定位时返回 null。
   */
  function resolveSegmented(selector) {
    var segments = String(selector).split(/\s*>>\s*/).filter(function (s) { return s.length; });
    if (segments.length === 0) return null;
    var root = document;
    var node = null;
    for (var i = 0; i < segments.length; i++) {
      try {
        node = root.querySelector(segments[i]);
      } catch (err) {
        return null;
      }
      if (!node) return null;
      if (i < segments.length - 1) {
        var nextRoot = node.shadowRoot; // 闭合 root 为 null → 下一段返回 null
        if (!nextRoot) return null;
        root = nextRoot;
      }
    }
    return node;
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
   * 结构/属性指纹：标签 + 关键属性 + 归一化文本 +【组合祖先链】（标签 / 祖先 id /
   * slot 名 / shadow 边界标记）。刻意不含 :nth-of-type 等位置信息——兄弟节点
   * 插入/删除不会改变既有节点的指纹。
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

    // 组合祖先链（nearest → farthest）：跨 slot 时记录 slot 名，跨宿主时记录边界
    var chain = [];
    var node = el;
    while (true) {
      var slottedInto = node.assignedSlot;
      if (slottedInto) {
        chain.unshift('slot' + (slottedInto.name ? '[' + escFp(slottedInto.name) + ']' : ''));
        node = slottedInto;
        continue;
      }
      var parent = node.parentElement;
      if (parent) {
        var part = parent.tagName.toLowerCase();
        if (parent.id) part += '#' + parent.id;
        chain.unshift(part);
        node = parent;
        continue;
      }
      var root = node.getRootNode();
      if (root && root.nodeType === 11 && root.host) {
        chain.unshift('::shadow');
        node = root.host;
        continue;
      }
      break;
    }
    s += ' ^' + chain.join('>');
    return s;
  }

  /** 纯 nth-of-type 结构路径（分段，跨边界用 ' >> '）：仅供展示排查，不参与匹配 */
  function domPath(el) {
    var segments = [];
    var node = el;
    while (node && node.nodeType === 1) {
      var root = node.getRootNode();
      var parts = [];
      var cur = node;
      while (cur && cur.nodeType === 1) {
        var part = cur.tagName.toLowerCase();
        var parent = cur.parentElement;
        if (parent) {
          var same = 0, idx = 0;
          for (var i = 0; i < parent.children.length; i++) {
            if (parent.children[i].tagName === cur.tagName) {
              same++;
              if (parent.children[i] === cur) idx = same;
            }
          }
          if (same > 1) part += ':nth-of-type(' + idx + ')';
        }
        parts.unshift(part);
        cur = parent;
      }
      segments.unshift(parts.join(' > '));
      node = root.nodeType === 11 ? root.host : null;
    }
    return segments.join(' >> ');
  }

  /**
   * 节点身份：
   *  - uid ：跨全部树根唯一 id（id 缺失或在任意 shadow tree 间重复时为空）；
   *  - fp  ：组合树结构/属性指纹（位置无关，含宿主链与 slot 信息）；
   *  - path：分段 nth-of-type 结构路径（仅展示用）。
   */
  function computeIdentity(el) {
    var id = el.id ? String(el.id) : null;
    var uid = null;
    if (id && (idCounts[id] || 0) === 1) uid = 'id:' + id;
    return { id: id, uid: uid, fp: fingerprint(el), path: domPath(el) };
  }

  /* ---------------- 组合信息（宿主链 / slot 来源） ---------------- */

  /**
   * 计算节点的组合来源信息，供诊断与导出：
   *  - depth    ：组合树中跨越的 open shadow 边界数（宿主链长度）；
   *  - hostChain：从外到内的宿主链（label / 分段选择器 / 是否闭合边界）；
   *  - slot     ：直接被分配（slotted）或经 fallback 渲染时的 slot 信息。
   *
   * 宿主链沿【组合祖先】构建：被分配节点（及其后代）经 assignedSlot 跨越到 slot
   * 所在的 shadow tree，因此即使节点物理上位于轻 DOM，也能正确报告其渲染所在的宿主。
   */
  function computeComposition(el) {
    var hostChain = [];
    var seenHosts = [];
    var node = el;

    function addHost(host) {
      if (seenHosts.indexOf(host) >= 0) return; // 同一边界不重复（slot 上溯后会再次经过）
      seenHosts.push(host);
      hostChain.unshift({
        label: describe(host).css,
        selector: segmentedSelector(host),
        closed: false
      });
    }

    while (node && node.nodeType === 1) {
      var slot = node.assignedSlot;
      if (slot) {
        var slotRoot = slot.getRootNode();
        if (slotRoot.nodeType === 11 && slotRoot.host) addHost(slotRoot.host);
        node = slot; // 进入 slot 所在的 shadow tree 继续上溯
        continue;
      }
      var parent = node.parentElement;
      if (parent) { node = parent; continue; }
      var root = node.getRootNode();
      if (root.nodeType === 11 && root.host) {
        addHost(root.host);
        node = root.host;
        continue;
      }
      break;
    }

    var slotInfo = null;
    var prov = provenance.get(el);
    if (prov) {
      slotInfo = {
        mode: prov.type, // 'slotted'（被分配）| 'fallback'（未分配，使用兜底内容）
        name: prov.slotName || '',
        selector: prov.slotSelector || null
      };
    }
    var physicalInShadow = el.getRootNode().nodeType === 11;
    return {
      depth: hostChain.length,
      hostChain: hostChain,
      slot: slotInfo,
      // 物理在 shadow 树（shadow / fallback）→ shadow；物理在轻 DOM 但经 slot
      // 渲染（hostChain 非空）→ slotted；其余为文档轻 DOM
      tree: physicalInShadow ? 'shadow' : (hostChain.length > 0 ? 'slotted' : 'document')
    };
  }

  /* ---------------- 组合树遍历与候选收集 ---------------- */

  /** 声明式 Shadow DOM（DSD）在当前引擎中是否可用（只探测一次） */
  var dsdSupported = (function () {
    try {
      var probe = document.createElement('div');
      probe.innerHTML = '<template shadowrootmode="open"></template>';
      return !!(probe.firstElementChild && probe.firstElementChild.shadowRoot);
    } catch (err) {
      return false;
    }
  })();

  /** 为一个候选元素生成 entry（渲染到组合树中的节点走这里） */
  function addEntry(el, domIndex) {
    var ti = parseTabIndexValue(el.hasAttribute('tabindex') ? el.getAttribute('tabindex') : null);
    var natural = naturallyFocusable(el);
    var hasValidTabindex = ti.has && ti.valid;
    var candidate = natural || hasValidTabindex || el.tagName === 'SLOT';

    var nodeWarnings = elementWarnings(el);
    if (ti.has && !ti.valid) {
      nodeWarnings.push({
        code: 'invalid-tabindex',
        level: 'warn',
        message: 'tabindex="' + ti.raw + '" 不是合法整数，该属性被忽略'
      });
    }
    if (!natural && !hasValidTabindex && el.tagName !== 'SLOT') {
      // 非候选元素：仅当有值得报告的警告（如非法 tabindex / aria-hidden）时才记录，
      // 保持与原版一致（status = not-focusable）
      if (nodeWarnings.length > 0) {
        var d0 = describe(el);
        entries.push({
          el: el,
          status: 'not-focusable',
          tag: el.tagName.toLowerCase(),
          label: d0.css,
          text: d0.text,
          selector: segmentedSelector(el),
          identity: computeIdentity(el),
          composition: computeComposition(el),
          tabIndex: null,
          domIndex: domIndex,
          interactive: false,
          hasTabindexAttr: ti.has,
          reasons: [],
          warnings: nodeWarnings
        });
      }
      return;
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
      selector: segmentedSelector(el),
      identity: computeIdentity(el),
      composition: computeComposition(el),
      tabIndex: effective,
      domIndex: domIndex,
      interactive: natural,
      hasTabindexAttr: ti.has,
      reasons: reasons,
      warnings: nodeWarnings
    });
  }

  /** 未被任何 slot 分配的轻 DOM 候选：补充为「excluded / 未分配」节点 */
  function addUnassignedEntry(el, domIndex) {
    var ti = parseTabIndexValue(el.hasAttribute('tabindex') ? el.getAttribute('tabindex') : null);
    var natural = naturallyFocusable(el);
    var warnings = elementWarnings(el);
    if (ti.has && !ti.valid) {
      warnings.push({
        code: 'invalid-tabindex',
        level: 'warn',
        message: 'tabindex="' + ti.raw + '" 不是合法整数，该属性被忽略'
      });
    }
    // 非候选（非天然可聚焦且无有效 tabindex）：仅在有警告时以 not-focusable 记录
    if (!natural && !ti.valid) {
      if (warnings.length > 0) {
        var dNf = describe(el);
        entries.push({
          el: el, status: 'not-focusable', tag: el.tagName.toLowerCase(),
          label: dNf.css, text: dNf.text, selector: segmentedSelector(el),
          identity: computeIdentity(el), composition: computeComposition(el),
          tabIndex: null, domIndex: domIndex, interactive: false,
          hasTabindexAttr: ti.has, reasons: [], warnings: warnings
        });
      }
      return;
    }

    var reasons = exclusionReasons(el);
    reasons.push({
      code: 'slot-unassigned',
      message: '宿主存在 shadow root，但该轻 DOM 节点未被任何 <slot> 分配，组合树中不渲染'
    });
    var d = describe(el);
    entries.push({
      el: el,
      status: 'excluded',
      tag: el.tagName.toLowerCase(),
      label: d.css,
      text: d.text,
      selector: segmentedSelector(el),
      identity: computeIdentity(el),
      composition: computeComposition(el),
      tabIndex: ti.valid ? ti.value : 0,
      domIndex: domIndex,
      interactive: natural,
      hasTabindexAttr: ti.has,
      reasons: reasons,
      warnings: warnings
    });
  }

  /**
   * 遍历 <slot> 的 flatten 展开结果。仅用于「被直接分配的节点本身又是 slot」
   * 的 slot 链场景；flatten 已把整条链解析为最终节点。
   */
  function walkSlotChildren(slot, provSlot) {
    var flat = slot.assignedNodes ? slot.assignedNodes({ flatten: true }) : [];
    for (var i = 0; i < flat.length; i++) {
      var node = flat[i];
      if (node.nodeType !== 1) continue;
      if (node.tagName === 'SLOT') {
        walkSlotChildren(node, provSlot);
      } else {
        walkElement(node, provSlot);
      }
    }
  }

  /**
   * 组合树 DFS：
   *  - 宿主元素自身先计入，再进入其 open shadowRoot；
   *  - slot 展开分配 / fallback 节点；
   *  - 挂 open root 的宿主，其轻 DOM 子节点【不直接遍历】（由 slot 决定渲染），
   *    未分配者稍后按「未分配」补录，避免重复计入。
   *
   * @param provSlot 非 null 时表示经某个 slot 渲染：{mode:'slotted'|'fallback', slotEl}
   */
  function walkElement(el, provSlot) {
    if (visited.has(el)) return;
    visited.add(el);
    flatCounter++;

    // 模板元素本身不渲染、不参与
    if (el.tagName === 'TEMPLATE') return;

    // 记录 provenance（直接分配 slotted / 兜底 fallback；仅记录直接进入点）
    if (provSlot && !provenance.has(el)) {
      provenance.set(el, {
        type: provSlot.mode,
        slotName: provSlot.slotEl.name || '',
        slotSelector: segmentedSelector(provSlot.slotEl)
      });
    }

    // 先计入宿主 / 元素自身
    addEntry(el, flatCounter);

    // 统计 id（跨全部树根）
    if (el.id) idCounts[el.id] = (idCounts[el.id] || 0) + 1;

    // shadow 边界
    if (el.shadowRoot) {
      var sr = el.shadowRoot; // open root 可访问；闭合 root 为 null 不会进入此分支
      var info = {
        root: sr, host: el, label: describe(el).css, selector: segmentedSelector(el),
        slotted: 0, fallback: 0, delegatesFocus: !!sr.delegatesFocus
      };
      openRootsInfo.push(info);
      roots.push(sr);
      for (var s = 0; s < sr.children.length; s++) walkElement(sr.children[s], null);
      return; // 轻 DOM 子节点交给 slot 展开；未分配者稍后补录
    }

    // 闭合 Shadow Root 宿主：内部不可检查；轻 DOM 照常遍历（无法判断分配，保守视为渲染）
    if (el.hasAttribute && el.hasAttribute(CLOSED_ROOT_ATTR)) {
      closedRootsInfo.push({ host: el, label: describe(el).css, selector: segmentedSelector(el) });
      for (var c = 0; c < el.children.length; c++) walkElement(el.children[c], null);
      return;
    }

    // slot：展开分配节点（无分配时 assignedNodes(flatten) 即 fallback 内容）
    if (el.tagName === 'SLOT') {
      var direct = el.assignedNodes ? el.assignedNodes({ flatten: false }) : [];
      var assignedElements = direct.filter(function (n) { return n.nodeType === 1; });
      var ri = currentRootInfo(el);
      if (assignedElements.length > 0) {
        if (ri) ri.slotted += assignedElements.length;
        assignedElements.forEach(function (node) {
          // 被直接分配的节点本身又是 <slot>（slot 链）：继续按 flatten 展开
          if (node.tagName === 'SLOT') {
            walkSlotChildren(node, { mode: 'slotted', slotEl: el });
          } else {
            walkElement(node, { mode: 'slotted', slotEl: el });
          }
        });
      } else {
        // 无分配：fallback 直接子节点数（嵌套 shadow 内部不在此计数）
        if (ri) ri.fallback += el.children.length;
        for (var f = 0; f < el.children.length; f++) {
          walkElement(el.children[f], { mode: 'fallback', slotEl: el });
        }
      }
      return;
    }

    // 普通元素：继续轻 DOM 子树（经 slot 进入的子树也走这里，provenance 只记直接进入点）
    for (var k = 0; k < el.children.length; k++) walkElement(el.children[k], null);
  }

  /** 找到 slot 所属 open shadow root 的统计对象 */
  function currentRootInfo(slotEl) {
    var root = slotEl.getRootNode();
    for (var i = 0; i < openRootsInfo.length; i++) {
      if (openRootsInfo[i].root === root) return openRootsInfo[i];
    }
    return null;
  }

  /** 扫描文档，构建候选节点数组（组合树遍历 + 未分配补录） */
  function buildEntries() {
    entries = [];
    visited = new WeakSet();
    provenance = new WeakMap();
    openRootsInfo = [];
    closedRootsInfo = [];
    roots = [document];
    idCounts = Object.create(null);
    flatCounter = 0;

    // 1) 组合树 DFS（html → shadow root → slot 分配 / fallback）
    walkElement(document.documentElement, null);

    // 2) 每棵树根内未被遍历到的元素 = 挂 open root 宿主中「未分配」的轻 DOM 节点
    roots.forEach(function (root) {
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (visited.has(el)) continue;
        if (el.tagName === 'TEMPLATE' || el.tagName === 'SLOT') continue;
        flatCounter++;
        visited.add(el);
        if (el.id) idCounts[el.id] = (idCounts[el.id] || 0) + 1;
        addUnassignedEntry(el, flatCounter);
      }
    });

    // 3) id 可能在步骤 2 才补录：用最终计数重算 uid
    entries.forEach(function (e) {
      e.identity = computeIdentity(e.el);
    });
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
        composition: e.composition,
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

  /* ---------------- 模态焦点陷阱审计（组合树 DOM） ---------------- */

  /** 容器可见性：组合祖先 hidden / inert、display:none、自身 visibility */
  function isVisibleContainer(el) {
    if (composedClosest(el, '[hidden]')) return false;
    if (composedClosest(el, '[inert]')) return false;
    var node = el;
    while (node && node.nodeType === 1) {
      if (getComputedStyle(node).display === 'none') return false;
      node = composedParent(node);
    }
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
  }

  /** 模态的可访问名称：aria-labelledby → aria-label → title（id 在同一棵树内解析） */
  function accessibleNameOf(el) {
    var ids = (el.getAttribute('aria-labelledby') || '').trim();
    if (ids) {
      var root = el.getRootNode();
      var text = ids.split(/\s+/).map(function (id) {
        var t = root.getElementById ? root.getElementById(id) : null;
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
   * 模态焦点陷阱审计（跨全部 open shadow root 收集候选，组合包含关系拆分循环/泄漏）。
   */
  function computeModalAudit() {
    var found = [];
    roots.forEach(function (root) {
      var list = root.querySelectorAll('dialog[open], [aria-modal="true"]');
      for (var i = 0; i < list.length; i++) found.push(list[i]);
    });

    var candidates = [];
    var i, a, b;
    for (i = 0; i < found.length; i++) {
      var el = found[i];
      if (!isVisibleContainer(el)) continue;
      candidates.push({ el: el, kind: el.tagName === 'DIALOG' ? 'dialog' : 'aria-modal' });
    }
    for (a = 0; a < candidates.length; a++) {
      candidates[a].containsCandidate = false;
      for (b = 0; b < candidates.length; b++) {
        if (a !== b && composedContains(candidates[a].el, candidates[b].el)) {
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
          selector: segmentedSelector(c.el),
          audited: i2 === activeIdx
        };
      })
    };
    if (activeIdx < 0) return audit;

    var active = candidates[activeIdx];
    var flagged = entries.map(function (e) {
      return { status: e.status, inModal: !!(e.el && composedContains(active.el, e.el)) };
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
      selector: segmentedSelector(active.el),
      identity: computeIdentity(active.el),
      composition: computeComposition(active.el),
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

  /** 统计 Shadow DOM 组合树信息并生成对应诊断 */
  function computeShadowInfo() {
    // 未被引擎升级的 <template shadowrootmode>：仅当引擎不支持 DSD 时它们才会以
    // 普通模板残留（支持 DSD 时 open 被消费、closed 不可访问，都不会在此残留）
    var leftover = 0;
    if (!dsdSupported) {
      roots.forEach(function (root) {
        var tpls = root.querySelectorAll('template[shadowrootmode], template[shadowroot]');
        leftover += tpls.length;
      });
    }
    var unassignedLabels = entries
      .filter(function (e) {
        return e.reasons.some(function (r) { return r.code === 'slot-unassigned'; });
      })
      .map(function (e) { return { label: e.label }; });

    // 跨 shadow tree 的正值 tabindex 计数（用于提示排序域差异）
    var scopes = Object.create(null);
    entries.forEach(function (e) {
      if (e.status === 'ordered' && e.tabIndex > 0) {
        var root = e.el.getRootNode();
        var key = root === document ? '#document' : segmentedSelector(root.host);
        scopes[key] = (scopes[key] || 0) + 1;
      }
    });
    var cross = Object.keys(scopes).filter(function (k) { return scopes[k] > 0; }).length > 1
      ? entries.filter(function (e) { return e.status === 'ordered' && e.tabIndex > 0; }).length
      : 0;

    return {
      stats: {
        openRoots: openRootsInfo.length,
        closedRoots: closedRootsInfo.length,
        slotted: entries.filter(function (e) { return e.composition.slot && e.composition.slot.mode === 'slotted'; }).length,
        fallback: entries.filter(function (e) { return e.composition.slot && e.composition.slot.mode === 'fallback'; }).length,
        unassigned: unassignedLabels.length
      },
      openRoots: openRootsInfo.map(function (r) {
        return {
          label: r.label, selector: r.selector,
          slotted: r.slotted, fallback: r.fallback, delegatesFocus: r.delegatesFocus
        };
      }),
      closedRoots: closedRootsInfo.map(function (r) {
        return { label: r.label, selector: r.selector };
      }),
      unassigned: unassignedLabels,
      dsdSupported: dsdSupported,
      leftoverTemplates: leftover,
      crossScopePositives: cross
    };
  }

  function computeAndSend() {
    try {
      buildEntries();
      order = computeOrder(entries);
      var serialized = serializeEntries();
      for (var s = 0; s < order.length; s++) {
        serialized[order[s]].step = s + 1;
      }
      var shadowInfo = computeShadowInfo();
      var diagnostics = buildDiagnostics(entries, order)
        .concat(buildShadowDiagnostics(shadowInfo));
      post({
        type: 'route',
        payload: {
          entries: serialized,
          order: order.map(function (idx) { return serialized[idx].selector; }),
          diagnostics: diagnostics,
          modalAudit: computeModalAudit(),
          shadow: shadowInfo,
          stats: {
            candidates: entries.length,
            ordered: order.length,
            excluded: entries.filter(function (e) { return e.status === 'excluded'; }).length,
            programmatic: entries.filter(function (e) { return e.status === 'programmatic'; }).length,
            shadow: shadowInfo.stats
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
   * 按分段选择器高亮任意候选节点（含被排除 / 仅编程聚焦者，虚线框展示）。
   * 供父页面「基线对比」差异项与「模态审计」条目点击联动；支持跨 open shadow 边界定位，
   * 闭合边界内的节点无法定位（明确回 miss，而不是猜测）。
   */
  function highlightNodeBySelector(selector, opts) {
    opts = opts || {};
    var entry = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].selector === selector) { entry = entries[i]; break; }
    }
    var el = entry && entry.el;
    if (!el || !el.isConnected) {
      el = resolveSegmented(selector);
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
