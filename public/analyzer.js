/*
 * analyzer.js —— 注入到 sandbox 预览 iframe 内执行的分析脚本。
 *
 * 职责：
 *  1. 依据 tabindex / disabled / hidden / inert / 计算样式 / DOM 嵌套，
 *     按「组合树（composed tree）」推导文档中所有候选可聚焦元素的 Tab
 *     （Shift+Tab 为其逆序）顺序：展开 open shadowRoot、按 <slot> 分配
 *     渲染轻 DOM 节点、未分配时使用 fallback，并跳过未分配的宿主轻 DOM；
 *  2. 为每个节点生成可往返定位的「分段选择器」（跨 shadow 边界 / slot
 *     分配）与节点身份（唯一 id + 含宿主链的结构/属性指纹），供步进、
 *     列表点击、编辑后位置恢复与「基线对比」使用；
 *  3. closed shadow root 明确标记为「不可检查」：不猜测其内部焦点顺序，
 *     宿主轻 DOM 节点列为「不可确定」，并给出诊断；
 *  4. 模态焦点陷阱审计：在组合树范围内识别可见 dialog[open] /
 *     aria-modal="true" 容器，拆分「模态内循环」与「模态外泄漏」；
 *  5. 通过 postMessage 与父页面通信：上报路线、接收高亮指令、绘制高亮框。
 *
 * 文件顶部的纯函数（parseTabIndexValue / computeOrder / buildDiagnostics /
 * pickActiveModal / computeModalCycle / buildModalDiagnostics /
 * parseRoute / formatRoute / buildShadowDiagnostics）
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
   *  1. tabindex 为正整数的元素，按数值升序，平局按组合树先后；
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

    // 正值 tabindex 撞号：按组合树顺序决胜
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

  /* ---------------- 分段选择器（跨边界、可往返） ---------------- */

  /**
   * 跨 shadow 边界 / slot 分配的定位路径由若干「段」组成：
   *  - { t:'L', css } 在文档轻树内按 css 定位（首段，css 从 html 起）；
   *  - { t:'S', css } 进入上一元素的 open shadowRoot，在其中按 css 定位；
   *  - { t:'T', css } 上一元素为 <slot>：取其分配的轻 DOM 节点，
   *    css 相对于宿主（host.querySelector 作用域）。
   * 序列化形式（作为 selector 字符串在父页面 / 基线 / 导出中原样往返）：
   *   "L:html > body > x-list >> S:ul > slot[name=items] >> T:li:nth-of-type(2) > button"
   * 分隔符 " >> " 不是合法 CSS，可无歧义切分。
   */
  function formatRoute(segments) {
    return (segments || []).map(function (s) { return s.t + ':' + s.css; }).join(' >> ');
  }

  function parseRoute(str) {
    if (!str) return [];
    var out = [];
    String(str).split(' >> ').forEach(function (part) {
      var t = part.charAt(0);
      if (t === 'L' || t === 'S' || t === 'T') {
        out.push({ t: t, css: part.slice(2) });
      }
    });
    return out;
  }

  /* ---------------- Shadow DOM 诊断（纯函数） ---------------- */

  /**
   * @param {{openCount:number, closed:Array<{label:string}>, unassignedCount:number,
   *          suppressedFallbackCount:number}} info
   */
  function buildShadowDiagnostics(info) {
    var diags = [];
    if (!info) return diags;
    if (info.openCount > 0) {
      diags.push({
        level: 'info',
        code: 'shadow-open',
        message: '检测到 ' + info.openCount + ' 个 open Shadow Root：Tab 路线已按组合树展开 ' +
          '（shadow 内部节点、slot 分配节点与未分配 slot 的 fallback 内容均计入，宿主轻 DOM 不重复计算）。'
      });
    }
    (info.closed || []).forEach(function (c) {
      diags.push({
        level: 'warn',
        code: 'shadow-closed',
        message: '检测到 closed Shadow Root（宿主 ' + c.label +
          '）：闭合边界内部（slot 分配、内部焦点）不可检查，实验室不猜测其内部 Tab 顺序；' +
          '其轻 DOM 子节点在列表中标记为「不可确定」。'
      });
    });
    if (info.unassignedCount > 0) {
      diags.push({
        level: 'info',
        code: 'shadow-unassigned',
        message: info.unassignedCount + ' 个宿主轻 DOM 候选节点未被任何 <slot> 分配，' +
          '不进入组合树渲染，因此不参与 Tab 顺序（见「排除与诊断」）。'
      });
    }
    if (info.suppressedFallbackCount > 0) {
      diags.push({
        level: 'info',
        code: 'slot-fallback-suppressed',
        message: info.suppressedFallbackCount + ' 个 slot fallback 候选节点因该 slot 已分配其他节点而不渲染。'
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
        parseRoute: parseRoute,
        formatRoute: formatRoute,
        buildShadowDiagnostics: buildShadowDiagnostics,
        pickActiveModal: pickActiveModal,
        computeModalCycle: computeModalCycle,
        buildModalDiagnostics: buildModalDiagnostics
      };
    }
    return;
  }

  /* ===================== 浏览器环境：组合树分析 ===================== */

  var SOURCE = 'focus-lab'; // 消息来源标记，父子双方据此过滤消息

  // 父页面净化阶段给 closed shadow root 宿主打的标记（closed 根无法从 JS 探测，
  // 只能在声明式模板被解析前于宿主元素上留下记号）。
  var CLOSED_MARKER = 'data-focus-lab-closed-shadow';

  var entries = [];   // 全部候选节点（含被排除者）
  var order = [];     // entries 下标组成的 Tab 顺序
  var overlay = null; // 高亮框
  var badge = null;   // 高亮框上的序号角标
  var currentStep = -1;

  var allElements = [];        // 物理树全量元素（跨 open 边界，不含 closed 内部）
  var idCounts = Object.create(null);
  var openHosts = [];          // open shadow root 宿主
  var closedHosts = [];        // closed shadow root 宿主
  var unassignedSet = new Set();   // 未被任何 slot 分配的宿主轻 DOM 节点
  var undeterminedSet = new Set(); // closed 根宿主轻 DOM 中「不可确定」节点
  var suppressedFallbackSet = new Set(); // slot 已分配而不渲染的 fallback 节点
  var routeCache = new WeakMap();

  function post(msg) {
    msg.source = SOURCE;
    parent.postMessage(msg, '*'); // sandbox 下源为 opaque origin，父页面用 event.source 校验
  }

  function childrenOf(el) {
    return Array.prototype.slice.call(el.children || []);
  }

  function rootChildren(root) {
    if (root === document) return document.documentElement ? [document.documentElement] : [];
    return Array.prototype.slice.call(root.children || []);
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

  /* ---------------- 组合树祖先遍历 ---------------- */

  /**
   * 沿物理父链向上（跨 shadow 边界时接续到宿主元素）的元素迭代。
   * slot 分配的节点物理上仍位于轻 DOM，其父链天然正确。
   */
  function forEachPhysicalAncestor(el, fn) {
    var node = el.parentElement;
    while (node) {
      fn(node);
      var parent = node.parentElement;
      if (!parent) {
        var rt = node.getRootNode();
        if (rt instanceof ShadowRoot) {
          node = rt.host;
          continue;
        }
        break;
      }
      node = parent;
    }
  }

  /** 跨边界的 closest：物理祖先链（含 shadow 宿主）上首个匹配选择器者 */
  function composedClosest(el, selector) {
    var hit = null;
    forEachPhysicalAncestor(el, function (anc) {
      if (!hit && anc.matches && anc.matches(selector)) hit = anc;
    });
    return hit;
  }

  /**
   * 组合树包含关系（供模态审计）：container 在 target 的物理祖先链上，
   * 或 target（及其祖先）经 slot 分配后，container 位于该 slot 的祖先链上。
   */
  function containsComposed(container, target) {
    var node = target;
    while (node && node.nodeType === 1) {
      if (node === container) return true;
      // slotted 分支：该节点被分配到某个 slot，则 slot 侧的组合祖先也算
      if (node.assignedSlot && containsComposed(container, node.assignedSlot)) return true;
      var parent = node.parentElement;
      if (!parent) {
        var rt = node.getRootNode();
        if (rt instanceof ShadowRoot) {
          if (rt.host === container) return true;
          node = rt.host;
          continue;
        }
        break;
      }
      node = parent;
    }
    return false;
  }

  /** 元素是否处于 disabled fieldset（跨 shadow 边界；首个 legend 内部除外） */
  function disabledFieldsetAncestor(el) {
    var hit = null;
    forEachPhysicalAncestor(el, function (node) {
      if (hit || node.tagName !== 'FIELDSET' || !node.hasAttribute('disabled')) return;
      var legend = null;
      for (var i = 0; i < node.children.length; i++) {
        if (node.children[i].tagName === 'LEGEND') { legend = node.children[i]; break; }
      }
      // legend.contains 不跨 shadow 边界：跨边界时 legend 不可能包含 el，视为命中
      if (!legend || !legend.contains(el)) hit = node;
    });
    return hit;
  }

  /** 收集元素被排除出 Tab 顺序的全部原因（沿组合树祖先链判断） */
  function exclusionReasons(el) {
    var reasons = [];
    var node, cs;

    if (el.tagName === 'INPUT' && el.type === 'hidden') {
      reasons.push({ code: 'input-hidden', message: 'input[type=hidden] 不参与聚焦' });
    }
    var hiddenHit = composedClosest(el, '[hidden]');
    if (hiddenHit) {
      reasons.push({
        code: 'hidden-attr',
        message: hiddenHit === el ? '带有 hidden 属性，未渲染' : '祖先元素带有 hidden 属性，子树未渲染'
      });
    }

    var inertHit = composedClosest(el, '[inert]');
    if (inertHit) {
      reasons.push({
        code: 'inert',
        message: inertHit === el ? '元素自身带有 inert 属性' : '祖先元素带有 inert 属性，子树（含 shadow 内部）整体不可聚焦'
      });
    }

    if (isFormControl(el) && el.hasAttribute('disabled')) {
      reasons.push({ code: 'disabled', message: '表单控件带有 disabled 属性' });
    }
    var fs = disabledFieldsetAncestor(el);
    if (fs && isFormControl(el)) {
      reasons.push({ code: 'fieldset-disabled', message: '位于 disabled 的 fieldset 内（且不在其第一个 legend 中）' });
    }

    // 闭合的 details：除第一个 summary 外，内部内容不可聚焦（沿组合树祖先链）
    var closedDetails = null;
    forEachPhysicalAncestor(el, function (anc) {
      if (!closedDetails && anc.tagName === 'DETAILS' && !anc.hasAttribute('open')) closedDetails = anc;
    });
    if (closedDetails) {
      var summary = firstSummary(closedDetails);
      if (!(summary && (summary === el || summary.contains(el)))) {
        reasons.push({ code: 'details-closed', message: '处于未展开的 details 内（仅其 summary 可聚焦）' });
      }
    }

    // 计算样式：display:none —— 自身或任一组合祖先（含 shadow 宿主）命中即不渲染
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
      var p = node.parentElement;
      if (!p) {
        var rt = node.getRootNode();
        if (rt instanceof ShadowRoot) { node = rt.host; continue; }
        break;
      }
      node = p;
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
    if (composedClosest(el, '[aria-hidden="true"]')) {
      warnings.push({
        code: 'aria-hidden-focusable',
        level: 'warn',
        message: '可聚焦元素位于 aria-hidden="true" 的子树中（含跨 shadow 边界），屏幕阅读器与键盘体验不一致'
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

  function slotLabel(slot) {
    return slot.name ? 'slot[name=' + slot.name + ']' : 'slot（默认）';
  }

  /* ---------------- 分段选择器构造与解析 ---------------- */

  function cssEscapeIdent(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
  }

  /**
   * 在单个树作用域内的 nth-of-type 相对路径（id 唯一时短路）。
   * @param {Element} el 目标元素
   * @param {Document|ShadowRoot|Element} scope id 唯一性查询作用域
   * @param {Element?} stopAt 路径到此元素为止（不含），用于 T 段相对宿主
   */
  function localPath(el, scope, stopAt) {
    if (el.id) {
      var byId = '#' + cssEscapeIdent(el.id);
      try {
        if (scope.querySelectorAll(byId).length === 1) return byId;
      } catch (err) { /* 继续走路径方案 */ }
    }
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== stopAt) {
      var part = node.tagName.toLowerCase();
      // <slot> 常多个同标签并存：把 name 写入路径以保证可往返唯一定位
      if (node.tagName === 'SLOT') {
        part += node.name ? '[name="' + escFp(node.name) + '"]' : ':not([name])';
      }
      if (node.id) {
        parts.unshift('#' + cssEscapeIdent(node.id));
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
      if (!parent) break; // shadow root 的直接子元素
      node = parent;
    }
    return parts.join(' > ');
  }

  /**
   * 为任意节点（含 shadow 内部、slotted、fallback 节点）构造可往返的分段选择器。
   * 思路：从节点沿物理树向上；若节点（或祖先）经 assignedSlot 分配，则插入 T 段
   * 并改从对应 slot 继续；跨 shadow root 插入 S 段；文档轻树为 L 段。
   */
  function stableRoute(el) {
    if (routeCache.has(el)) return routeCache.get(el);
    var segments = [];
    var cur = el;
    var guard = 0;
    while (cur && guard++ < 1000) {
      var root = cur.getRootNode();

      // 在当前物理树内寻找「被 slot 分配」的祖先（含自身）
      var assigned = null;
      for (var n = cur; n && n.nodeType === 1; n = n.parentElement) {
        if (n.assignedSlot) { assigned = n; break }
      }
      if (assigned) {
        var slot = assigned.assignedSlot;
        // T 段：相对宿主轻 DOM 的路径（宿主本身不含）
        segments.unshift({ t: 'T', css: localPath(cur, slot.getRootNode().host, slot.getRootNode().host) });
        cur = slot;
        continue;
      }

      if (root instanceof ShadowRoot) {
        segments.unshift({ t: 'S', css: localPath(cur, root, null) });
        cur = root.host;
        continue;
      }

      segments.unshift({ t: 'L', css: localPath(cur, document, null) });
      break;
    }
    var out = formatRoute(segments);
    routeCache.set(el, out);
    return out;
  }

  /** slot 的扁平化分配元素（转发链 <slot> 递归展开） */
  function flattenAssigned(slot, seen) {
    seen = seen || new Set();
    if (seen.has(slot)) return [];
    seen.add(slot);
    var out = [];
    var assigned = typeof slot.assignedElements === 'function' ? slot.assignedElements() : [];
    assigned.forEach(function (n) {
      if (n.tagName === 'SLOT') {
        out.push.apply(out, flattenAssigned(n, seen));
      } else {
        out.push(n);
      }
    });
    return out;
  }

  /** 校验 target 确实经该 slot（含转发链）分配，或为某分配节点的后代 */
  function assignedThrough(slot, target) {
    return flattenAssigned(slot).some(function (m) {
      return m === target || m.contains(target);
    });
  }

  /** 分段选择器 → 真实元素（closed 根 / 已移除节点时返回 null） */
  function resolveRoute(str) {
    var segs = parseRoute(str);
    if (segs.length === 0) return null;
    var el = null;
    for (var i = 0; i < segs.length; i++) {
      var sg = segs[i];
      try {
        if (sg.t === 'L') {
          el = document.querySelector(sg.css);
        } else if (sg.t === 'S') {
          if (!el) return null;
          var sr = el.shadowRoot; // closed 根返回 null：明确不可定位
          if (!sr) return null;
          el = sr.querySelector(sg.css);
        } else if (sg.t === 'T') {
          if (!el || el.tagName !== 'SLOT') return null;
          var host = el.getRootNode().host;
          if (!host) return null;
          var found = host.querySelector(sg.css);
          if (!found || !assignedThrough(el, found)) return null;
          el = found;
        }
      } catch (err) {
        return null;
      }
      if (!el) return null;
    }
    return el;
  }

  /* ---------------- 节点身份（供基线对比匹配） ---------------- */

  /** 指纹字符串中的值转义，避免拼接歧义 */
  function escFp(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ').trim();
  }

  /** 参与指纹的关键属性（不含 tabindex/disabled/hidden 等会影响顺序或状态的属性） */
  var FP_ATTRS = ['type', 'name', 'role', 'href', 'placeholder', 'aria-label', 'title'];

  function fpTag(node) {
    var part = node.tagName.toLowerCase();
    if (node.id) part += '#' + node.id;
    return part;
  }

  /** 当前节点在本物理树内（不含自身）的祖先指纹段 */
  function fpAncestors(cur) {
    var chain = [];
    var n = cur.parentElement;
    while (n) {
      chain.unshift(fpTag(n));
      if (!n.parentElement) break;
      n = n.parentElement;
    }
    return chain;
  }

  /**
   * 结构/属性指纹：标签 + 关键属性 + 归一化文本 + 组合祖先链。
   * 祖先链带 shadow / slot 边界标记，因此不同组件内部的同构节点不会误配；
   * 刻意不含 :nth-of-type 等位置信息。
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

    var parts = [];
    var cur = el;
    var prevSlot = null; // 转发链：上一跳到达的 slot，遍历其内部时不再把它算作一次分配
    var guard = 0;
    while (cur && guard++ < 1000) {
      var root = cur.getRootNode();
      // 自身 / 祖先被 slot 分配：插入 ::slotted(name) 边界标记。
      var assigned = null;
      for (var n = cur; n && n.nodeType === 1; n = n.parentElement) {
        if (n.assignedSlot && n.assignedSlot !== prevSlot) { assigned = n; break; }
      }
      if (assigned) {
        var sl = assigned.assignedSlot;
        parts.push.apply(parts, fpAncestors(assigned));
        parts.push('::slotted(' + (sl.name || '#default') + ')');
        prevSlot = sl; // 下一跳从 sl 起；忽略 sl 自身被外层再分配那一跳之外的回边
        cur = sl;
        continue;
      }
      if (root instanceof ShadowRoot) {
        parts.push.apply(parts, fpAncestors(cur));
        parts.push('::shadow');
        prevSlot = null;
        cur = root.host;
        continue;
      }
      parts.push.apply(parts, fpAncestors(cur));
      break;
    }
    s += ' ^' + parts.join('>');
    return s;
  }

  /**
   * 节点身份：
   *  - uid ：整棵组合树内唯一 id（id 缺失或跨树重复时为空）；
   *  - fp  ：含宿主链 / slot 边界的结构/属性指纹（位置无关）；
   *  - path：分段选择器（仅展示 / 排查 / 导出，不参与匹配）。
   */
  function computeIdentity(el) {
    var id = el.id ? String(el.id) : null;
    var uid = null;
    if (id && idCounts[id] === 1) uid = 'id:' + id;
    return { id: id, uid: uid, fp: fingerprint(el), path: stableRoute(el) };
  }

  /* ---------------- 组合树遍历与候选收集 ---------------- */

  function isClosedHost(el) {
    return el.hasAttribute(CLOSED_MARKER);
  }

  /** 物理树全量收集（跨 open shadow 边界；closed 内部不可达，自然停止） */
  function collectPhysical() {
    allElements = [];
    openHosts = [];
    function walkElement(el) {
      allElements.push(el);
      var sr = el.shadowRoot;
      if (sr) {
        openHosts.push(el);
        rootChildren(sr).forEach(walkElement);
      }
      childrenOf(el).forEach(walkElement);
    }
    rootChildren(document).forEach(walkElement);

    idCounts = Object.create(null);
    allElements.forEach(function (el) {
      if (el.id) idCounts[String(el.id)] = (idCounts[String(el.id)] || 0) + 1;
    });
  }

  /** 跨任意根按 id 查找（aria-labelledby 可指向 shadow 内部节点） */
  function getElementByIdAnywhere(id) {
    for (var i = 0; i < allElements.length; i++) {
      if (allElements[i].id === id) return allElements[i];
    }
    return null;
  }

  /**
   * 遍历上下文：
   *  hosts    已穿过的 shadow 宿主（外→内）
   *  slots    已穿过的 slot 事件 {slot, via:'slotted'|'forward'|'fallback'}
   *  fallback 当前是否位于某未分配 slot 的 fallback 子树中
   */
  function ctxWith(ctx, patch) {
    return {
      hosts: patch.hosts || ctx.hosts,
      slots: patch.slots || ctx.slots,
      fallback: patch.fallback !== undefined ? patch.fallback : ctx.fallback
    };
  }

  function shadowInfo(ctx, closed) {
    return {
      depth: ctx.hosts.length,
      inShadow: ctx.hosts.length > 0,
      hosts: ctx.hosts.map(function (h) {
        return { label: describe(h).css, selector: stableRoute(h) };
      }),
      slots: ctx.slots.map(function (ev) {
        return {
          name: ev.slot.name || null,
          via: ev.via,
          label: slotLabel(ev.slot),
          selector: stableRoute(ev.slot)
        };
      }),
      fallback: ctx.fallback,
      closed: !!closed
    };
  }

  /** 构建候选节点条目；forceReason 非空时强制排除（组合树状态类原因） */
  function makeEntry(el, ctx, domIndex, forceReason, closed) {
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
    if (!candidate && nodeWarnings.length === 0) return null;

    var reasons;
    if (forceReason) {
      reasons = [forceReason];
    } else {
      reasons = exclusionReasons(el);
    }
    var effective = hasValidTabindex ? ti.value : 0;
    var status;
    if (reasons.length > 0) status = 'excluded';
    else if (effective < 0) status = 'programmatic';
    else status = 'ordered';

    var d = describe(el);
    return {
      el: el,
      status: status,
      tag: el.tagName.toLowerCase(),
      label: d.css,
      text: d.text,
      selector: stableRoute(el),
      identity: computeIdentity(el),
      tabIndex: forceReason ? null : effective,
      domIndex: domIndex,
      interactive: natural,
      hasTabindexAttr: ti.has,
      reasons: reasons,
      warnings: nodeWarnings,
      shadow: shadowInfo(ctx, closed)
    };
  }

  var domIndexSeq = 0;

  function emit(el, ctx, forceReason, closed) {
    var entry = makeEntry(el, ctx, domIndexSeq++, forceReason, closed);
    if (entry) entries.push(entry);
  }

  /** 物理子树强制标记（跨 open shadow）；用于未分配轻 DOM / fallback / closed 收集 */
  function markSubtree(el, ctx, reason, setObj, closed) {
    function walk(n, cctx) {
      setObj.add(n);
      emit(n, cctx, reason, closed);
      var sr = n.shadowRoot;
      if (sr) {
        var hctx = ctxWith(cctx, { hosts: cctx.hosts.concat([n]) });
        rootChildren(sr).forEach(function (ch) { walk(ch, hctx); });
      }
      childrenOf(n).forEach(function (ch) { walk(ch, cctx); });
    }
    walk(el, ctx);
  }

  var REASON_UNASSIGNED = {
    code: 'shadow-unassigned',
    message: 'shadow 宿主的轻 DOM 节点未被任何 <slot> 分配，不进入组合树渲染，不参与 Tab 顺序'
  };
  var REASON_FALLBACK = {
    code: 'slot-fallback-suppressed',
    message: '所在 <slot> 已分配其他节点，其 fallback 内容不渲染'
  };
  var REASON_CLOSED = {
    code: 'shadow-closed-undetermined',
    message: '位于 closed Shadow Root 宿主的轻 DOM 中：slot 分配与内部组合树不可检查，是否进入 Tab 顺序无法确定（不猜测）'
  };

  /**
   * slot 展开（可跨 shadow 边界的转发链）：
   *  - 分配节点是普通元素：在组合位置渲染它（visit 会继续其轻 DOM 子树）；
   *  - 分配节点是另一个 <slot>：
   *      · 同根转发：继续展开该 slot；
   *      · 跨 shadow 转发（内层 slot 被分配到外层 slot）：进入其所在
   *        shadowRoot，继续展开该 slot；
   *  - 无分配：渲染 fallback 子树。
   */
  function expandSlot(slot, ctx) {
    var assigned = typeof slot.assignedElements === 'function' ? slot.assignedElements() : [];
    if (assigned.length > 0) {
      assigned.forEach(function (n) {
        if (n.tagName === 'SLOT') {
          var sctx = ctxWith(ctx, { slots: ctx.slots.concat([{ slot: slot, via: 'forward' }]) });
          if (n.getRootNode() === slot.getRootNode()) {
            expandSlot(n, sctx); // 同根转发
          } else {
            // 跨 shadow 转发（内层 slot 被分配到外层 slot）：
            // n 位于已穿过的内层 shadow root，直接在同上下文继续展开 n，
            // 不再重复压入宿主。
            expandSlot(n, sctx);
          }
        } else {
          visit(n, ctxWith(ctx, { slots: ctx.slots.concat([{ slot: slot, via: 'slotted' }]) }));
        }
      });
      // slot 已占用：其 fallback 子树不渲染，登记为强制排除
      childrenOf(slot).forEach(function (ch) {
        markSubtree(ch, ctx, REASON_FALLBACK, suppressedFallbackSet, false);
      });
    } else {
      var fctx = ctxWith(ctx, {
        slots: ctx.slots.concat([{ slot: slot, via: 'fallback' }]),
        fallback: true
      });
      childrenOf(slot).forEach(function (ch) { visit(ch, fctx); });
    }
  }

  /**
   * 沿「节点 → 接收 slot → 该 slot 又被分配到外层 slot」链扁平化，
   * 返回最终接收节点所在的 slot（无则 null）。
   */
  function resolveAssignedSlot(el) {
    var node = el;
    var seen = new Set();
    while (node && node.assignedSlot && !seen.has(node)) {
      seen.add(node);
      var slot = node.assignedSlot;
      // 该 slot 自身是否又被分配到外层 slot
      if (slot.assignedSlot) { node = slot; continue; }
      return slot;
    }
    return null;
  }

  /**
   * 轻 DOM 子树是否已经在当前 shadow root 的 slot 展开阶段访问过：
   * 最终接收 slot 位于本 shadow root 即视为已访问（含转发链回到本根）；
   * 最终 slot 位于祖先根（整个宿主被转发出去）或未分配则不属于本根。
   */
  function renderedViaThisRoot(child, root) {
    var finalSlot = resolveAssignedSlot(child);
    return !!finalSlot && finalSlot.getRootNode() === root;
  }

  /** 组合树递归访问 */
  function visit(el, ctx) {
    emit(el, ctx, null, false);

    var sr = el.shadowRoot; // open 根可访问；closed 根为 null
    if (sr) {
      var hctx = ctxWith(ctx, { hosts: ctx.hosts.concat([el]) });
      rootChildren(sr).forEach(function (ch) { visit(ch, hctx); });
      // 宿主轻 DOM：经本 shadow root 内 slot（含转发链回到本根）渲染的子树已在
      // slot 展开阶段访问过；未分配 / 转发到祖先根以外的子树不渲染，登记为强制排除。
      childrenOf(el).forEach(function (ch) {
        if (renderedViaThisRoot(ch, sr)) return;
        markSubtree(ch, hctx, REASON_UNASSIGNED, unassignedSet, false);
      });
      return;
    }

    if (isClosedHost(el)) {
      if (closedHosts.indexOf(el) < 0) closedHosts.push(el);
      // 不进入闭合根；宿主轻 DOM 的 slot 分配无从得知，一律标「不可确定」
      var cctx = ctxWith(ctx, { hosts: ctx.hosts.concat([el]) });
      childrenOf(el).forEach(function (ch) {
        markSubtree(ch, cctx, REASON_CLOSED, undeterminedSet, true);
      });
      return;
    }

    if (el.tagName === 'SLOT') {
      expandSlot(el, ctx);
      return;
    }
    childrenOf(el).forEach(function (ch) { visit(ch, ctx); });
  }

  /** 宿主是否声明焦点委托：优先运行时标志（浏览器解析 DSD 后有值），
   *  回退识别宿主上的 DSD 属性 / 残留模板声明。 */
  function hostDelegatesFocus(el, sr) {
    if (sr && sr.delegatesFocus === true) return true;
    if (el.hasAttribute && el.hasAttribute('shadowrootdelegatesfocus')) return true;
    var tmpl = el.firstElementChild;
    return !!(tmpl && tmpl.tagName === 'TEMPLATE' && tmpl.hasAttribute('shadowrootdelegatesfocus'));
  }

  /** delegatesFocus 修正：宿主自身是 Tab 停靠点且 shadow 内存在有序焦点时，焦点委托 */
  function applyDelegatesFocus() {
    entries.forEach(function (en) {
      var sr = en.el.shadowRoot;
      if (!sr || !hostDelegatesFocus(en.el, sr) || en.status !== 'ordered') return;
      var hasInner = entries.some(function (o) {
        if (o === en || o.status !== 'ordered') return false;
        var rt = o.el.getRootNode();
        while (rt instanceof ShadowRoot) {
          if (rt === sr) return true;
          rt = rt.host.getRootNode();
        }
        return false;
      });
      if (hasInner) {
        en.status = 'excluded';
        en.tabIndex = null;
        en.reasons.push({
          code: 'delegates-focus',
          message: '宿主启用 delegatesFocus 且 shadow 内存在可聚焦节点：Tab 停靠位置的焦点直接委托给内部首个可聚焦节点，宿主本身不停留焦点'
        });
      }
    });
  }

  /** 扫描文档（按组合树），构建候选节点数组 */
  function buildEntries() {
    entries = [];
    unassignedSet = new Set();
    undeterminedSet = new Set();
    suppressedFallbackSet = new Set();
    closedHosts = [];
    domIndexSeq = 0;
    collectPhysical();
    visit(document.documentElement, { hosts: [], slots: [], fallback: false });
    applyDelegatesFocus();
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
        shadow: e.shadow,
        step: null // 稍后填充
      };
    });
  }

  /* ---------------- 模态焦点陷阱审计（DOM，跨边界） ---------------- */

  /** 容器可见性：hidden / inert 属性、display:none（组合祖先）、visibility */
  function isVisibleContainer(el) {
    if (composedClosest(el, '[hidden]')) return false;
    if (composedClosest(el, '[inert]')) return false;
    var node = el;
    while (node && node.nodeType === 1) {
      if (getComputedStyle(node).display === 'none') return false;
      var p = node.parentElement;
      if (!p) {
        var rt = node.getRootNode();
        if (rt instanceof ShadowRoot) { node = rt.host; continue; }
        break;
      }
      node = p;
    }
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
  }

  /** 模态的可访问名称：aria-labelledby → aria-label → title（id 查找跨 shadow 边界） */
  function accessibleNameOf(el) {
    var ids = (el.getAttribute('aria-labelledby') || '').trim();
    if (ids) {
      var text = ids.split(/\s+/).map(function (id) {
        var t = getElementByIdAnywhere(id);
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
   * 模态焦点陷阱审计（组合树范围）：
   *  1. 在全部 open 树中找出可见的 dialog[open] / [aria-modal="true"] 容器
   *     （未分配 / closed 不可确定子树中的容器不参与）；
   *  2. 嵌套时仅取最内层、同级并列取 DOM 序最后者作为活动模态；
   *  3. 按组合包含关系拆分「循环路线」与「泄漏」。
   */
  function computeModalAudit() {
    var candidates = [];
    var i, a, b;
    for (i = 0; i < allElements.length; i++) {
      var el = allElements[i];
      if (unassignedSet.has(el) || undeterminedSet.has(el) || suppressedFallbackSet.has(el)) continue;
      var isDialog = el.tagName === 'DIALOG' && el.hasAttribute('open');
      if (!isDialog && el.getAttribute('aria-modal') !== 'true') continue;
      if (!isVisibleContainer(el)) continue;
      candidates.push({ el: el, kind: isDialog ? 'dialog' : 'aria-modal' });
    }
    // 嵌套标记：组合树中包含其他候选的容器不是「最内层」
    for (a = 0; a < candidates.length; a++) {
      candidates[a].containsCandidate = false;
      for (b = 0; b < candidates.length; b++) {
        if (a !== b && containsComposed(candidates[a].el, candidates[b].el)) {
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
          selector: stableRoute(c.el),
          audited: i2 === activeIdx
        };
      })
    };
    if (activeIdx < 0) return audit;

    var active = candidates[activeIdx];
    var flagged = entries.map(function (e) {
      return { status: e.status, inModal: !!(e.el && containsComposed(active.el, e.el)) };
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
      selector: stableRoute(active.el),
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

  function shadowStats() {
    var slotted = 0, fallback = 0;
    entries.forEach(function (e) {
      if (e.shadow.slots.some(function (ev) { return ev.via === 'slotted' || ev.via === 'forward'; })) slotted++;
      if (e.shadow.fallback) fallback++;
    });
    return {
      openRoots: openHosts.length,
      closedRoots: closedHosts.map(function (h) {
        return { label: describe(h).css, selector: stableRoute(h) };
      }),
      slottedCandidates: slotted,
      fallbackCandidates: fallback,
      unassignedCandidates: entries.filter(function (e) {
        return e.reasons.some(function (r) { return r.code === 'shadow-unassigned'; });
      }).length,
      suppressedFallbackCandidates: suppressedFallbackSet.size
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
      var diagnostics = buildDiagnostics(entries, order);
      var sd = shadowStats();
      buildShadowDiagnostics({
        openCount: sd.openRoots,
        closed: sd.closedRoots,
        unassignedCount: sd.unassignedCandidates,
        suppressedFallbackCount: sd.suppressedFallbackCandidates
      }).forEach(function (d2) { diagnostics.push(d2); });

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
            programmatic: entries.filter(function (e) { return e.status === 'programmatic'; }).length,
            shadow: sd
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
   * 按分段选择器高亮任意候选节点（含被排除 / 仅编程聚焦 / shadow 内部节点，
   * 虚线框展示）。供父页面「基线对比」差异项与「模态审计」条目点击联动。
   * 目标不是候选节点时，回退为按分段选择器直接定位（closed 根内部必然失败）。
   */
  function highlightNodeBySelector(selector, opts) {
    opts = opts || {};
    var entry = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].selector === selector) { entry = entries[i]; break; }
    }
    var el = entry && entry.el;
    if (!el || !el.isConnected) {
      el = resolveRoute(selector);
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
