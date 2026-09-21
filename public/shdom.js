/*
 * shdom.js —— 声明式 Shadow DOM（Declarative Shadow DOM）字符串侧工具（纯函数，不依赖 DOM）。
 *
 * 为什么需要这个模块？
 *  解析后，闭合（shadowrootmode="closed"）的 Shadow Root 无法经任何 DOM API 访问：
 *  host.shadowRoot === null，<template> 标签也已被解析器消费——既无法检查其内部，
 *  也无法在解析后定位「哪个宿主挂着闭合 root」。因此对闭合 DSD 的定位、宿主标注与
 *  内部净化必须在【解析之前】的原始 HTML 字符串上完成。
 *
 *  本模块用一个克制的 HTML 标记扫描器（识别注释 / DOCTYPE / 引号 / raw-text 元素 /
 *  void 元素）完成两件事：
 *   1. findClosedShadowRoots(html)：找出全部闭合 DSD 模板的源码区间（支持嵌套 <template>）
 *      与其宿主开始标签的标注位置；
 *   2. 跨边界「分段选择器」的拼装 / 拆分（shadow 边界用 ' >> ' 表示）。
 *
 * app.js 负责：按区间从后往前替换（闭合模板内部经 DOMParser 包进 <template> 后做
 * DOM 净化）、给宿主开始标签注入 data-focus-lab-closed-root 标注属性。
 *
 * 浏览器环境挂载为 window.FocusShdom；Node 环境经 module.exports 导出（供单元测试）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FocusShdom = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** 实验室注入到「闭合 Shadow Root 宿主」上的标注属性（analyzer.js 据此识别不可检查边界） */
  var CLOSED_ROOT_ATTR = 'data-focus-lab-closed-root';

  /** 分段选择器中「跨越一个 open shadow 边界」的分隔符 */
  var BOUNDARY = ' >> ';

  var VOID_TAGS = {
    area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
    link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1
  };

  // 这些元素的内容是 raw text：内部出现的 <tag> 不是标签，扫描栈必须整体跳过
  var RAW_TEXT_TAGS = {
    script: 1, style: 1, textarea: 1, title: 1, xmp: 1, iframe: 1, noembed: 1, noframes: 1
  };

  /**
   * 判断一个模板开始标签的属性串是否声明了【闭合】模式。
   * 同时识别现行 shadowrootmode 与早期提案的 shadowroot 属性；
   * 支持双引号 / 单引号 / 无引号三种写法。
   */
  function isClosedTemplateAttrs(attrs) {
    var re = /(?:^|\s)(?:shadowrootmode|shadowroot)\s*=\s*(?:"closed"|'closed'|closed)(?=\s|$)/i;
    return re.test(attrs);
  }

  /**
   * 从开始标签起点 '<' 开始，找到该标签的结束位置（'>' 的下标）；
   * 跳过引号内的 '>'，属性值中允许出现 '>'。
   * @returns {number} 结束 '>' 的下标；找不到时返回 -1
   */
  function findTagEnd(html, lt) {
    var n = html.length;
    var i = lt + 1;
    var quote = null;
    while (i < n) {
      var ch = html[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        return i;
      }
      i++;
    }
    return -1;
  }

  /**
   * 扫描 HTML 字符串，定位全部【闭合 DSD 模板】及其宿主。
   *
   * @param {string} html 原始（未解析）HTML
   * @returns {{
   *   markers: Array<{pos:number, name:string}>,   注入点：宿主开始标签名之后的位置（+ 宿主标签名）
   *   spans: Array<{start:number, tagEnd:number, innerStart:number, innerEnd:number,
   *                 end:number, name:string, attrs:string}>  闭合模板的完整源码区间
   * }}
   * 同一宿主存在多个闭合模板（浏览器只会升级第一个）时只标注一次宿主，但每个模板区间
   * 都会返回（其内部仍需净化）。
   */
  function findClosedShadowRoots(html) {
    var markers = [];
    var spans = [];
    var markedHosts = Object.create(null);
    var stack = []; // {name, start, nameEnd}

    // 进行中的闭合模板区间栈（支持嵌套 closed DSD）
    // 每项：{start, tagEnd, innerStart, depth, attrs, children}
    var spanStack = [];

    var n = html.length;
    var i = 0;

    function pushTag(name, start, nameEnd) {
      if (!VOID_TAGS[name]) stack.push({ name: name, start: start, nameEnd: nameEnd });
    }

    function popTag(name) {
      for (var k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name === name) {
          stack.length = k; // 弹出它及其上方（容忍未闭合标签）
          return;
        }
      }
    }

    while (i < n) {
      var lt = html.indexOf('<', i);
      if (lt < 0) break;
      var c = html.charAt(lt + 1);

      // 注释 / CDATA / 处理指令 / DOCTYPE：整体跳过
      if (c === '!' || c === '?') {
        if (html.substr(lt, 4) === '<!--') {
          var ce = html.indexOf('-->', lt + 4);
          i = ce < 0 ? n : ce + 3;
        } else {
          var de = findTagEnd(html, lt);
          i = de < 0 ? n : de + 1;
        }
        continue;
      }

      // 闭合标签
      if (c === '/') {
        var te = findTagEnd(html, lt);
        if (te < 0) break;
        var cm = /^<\/\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt, te + 1));
        var cname = cm ? cm[1].toLowerCase() : null;
        if (cname === 'template' && spanStack.length) {
          // 最内层区间的嵌套 <template>（含 open DSD / 普通模板）深度计数：
          // 只有与其开标签配对的那个 </template> 才结束区间
          var top = spanStack[spanStack.length - 1];
          top.depth--;
          if (top.depth > 0) { i = te + 1; continue; }
          spanStack.pop();
          stack.length = top.stackDepth;
          spans.push({
            start: top.start, tagEnd: top.tagEnd,
            innerStart: top.innerStart, innerEnd: lt, end: te + 1,
            name: 'template', attrs: top.attrs
          });
          i = te + 1;
          continue;
        }
        // 所有闭合模板区间之外的闭合标签才影响宿主栈
        if (cname && spanStack.length === 0) popTag(cname);
        i = te + 1;
        continue;
      }

      // 开始标签
      var nm = /^<\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt, lt + 80));
      if (!nm) { i = lt + 1; continue; }
      var tagEnd = findTagEnd(html, lt);
      if (tagEnd < 0) break;
      var name = nm[1].toLowerCase();
      var raw = html.slice(lt, tagEnd + 1);
      var nameEnd = lt + nm[0].length;
      var selfClosing = raw.charAt(raw.length - 2) === '/';
      var attrs = raw.slice(nm[0].length, raw.length - (selfClosing ? 2 : 1));

      if (name === 'template' && isClosedTemplateAttrs(attrs)) {
        // 闭合 DSD 模板：宿主栈顶即其宿主（区间内部标签的压栈在区间关闭时丢弃，
        // 因此嵌套 closed 模板看到的栈顶正是其直接宿主元素）
        var host = stack.length ? stack[stack.length - 1] : null;
        if (host && !markedHosts[host.start + ':' + host.name]) {
          markedHosts[host.start + ':' + host.name] = true;
          markers.push({ pos: host.nameEnd, name: host.name });
        }
        spanStack.push({
          start: lt, tagEnd: tagEnd + 1, innerStart: tagEnd + 1,
          attrs: attrs, stackDepth: stack.length, depth: 1
        });
        i = tagEnd + 1;
        continue;
      }

      if (name === 'template') {
        // open DSD 或普通模板（无论是否在闭合区间内）：不是宿主；
        // 若位于区间内，计入最内层区间的嵌套深度（等其 </template> 抵消）
        if (spanStack.length) spanStack[spanStack.length - 1].depth++;
        i = tagEnd + 1;
        continue;
      }

      // raw-text 元素（script/style/…）：整体跳过其纯文本内容，伪标签不影响栈
      if (RAW_TEXT_TAGS[name]) {
        var closeRe = new RegExp('</' + name + '\\s*>', 'i');
        var closeM = closeRe.exec(html.slice(tagEnd + 1));
        i = closeM ? html.indexOf('>', tagEnd + 1 + closeM.index) + 1 : n;
        continue;
      }

      if (!selfClosing && !VOID_TAGS[name]) pushTag(name, lt, nameEnd);
      i = tagEnd + 1;
    }

    // 文档结束仍有未闭合的区间：尽力给出区间（内部仍要净化），自内而外弹出
    while (spanStack.length) {
      var sp2 = spanStack.pop();
      stack.length = sp2.stackDepth;
      spans.push({
        start: sp2.start, tagEnd: sp2.tagEnd,
        innerStart: sp2.innerStart, innerEnd: n, end: n,
        name: 'template', attrs: sp2.attrs
      });
    }
    // 嵌套区间在内层闭合时先入栈，最终按文档序排序，方便消费方建立嵌套关系
    spans.sort(function (a, b) { return a.start - b.start; });
    return { markers: markers, spans: spans };
  }

  /** 拆分分段选择器为「每棵树内一段」的 CSS 选择器数组 */
  function splitSegments(selector) {
    return String(selector).split(/\s*>>\s*/).filter(function (s) { return s.length > 0; });
  }

  /** 拼装分段选择器 */
  function joinSegments(segments) {
    return (segments || []).join(BOUNDARY);
  }

  return {
    CLOSED_ROOT_ATTR: CLOSED_ROOT_ATTR,
    BOUNDARY: BOUNDARY,
    isClosedTemplateAttrs: isClosedTemplateAttrs,
    findClosedShadowRoots: findClosedShadowRoots,
    splitSegments: splitSegments,
    joinSegments: joinSegments
  };
});
