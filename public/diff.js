/*
 * diff.js —— 基线对比：节点身份匹配与路线差异计算（纯函数，不依赖 DOM）。
 *
 * 节点身份（identity）由 analyzer.js 在预览 iframe 内生成：
 *  - uid ：文档内唯一 id，形如 "id:xxx"（id 缺失或不唯一时为空）；
 *  - fp  ：结构/属性指纹 = 标签 + 关键属性 + 归一化文本 + 祖先链，
 *          刻意不含 :nth-of-type 等位置信息——兄弟节点插入/删除不会改变
 *          既有节点的指纹，避免全量误判为「移除 + 新增」；
 *  - path：nth-of-type 结构路径，仅供展示与排查，不参与匹配。
 *
 * 匹配规则（按优先级）：
 *  1. uid 在两侧各自唯一且相等 → 匹配；
 *  2. 否则指纹 fp 在两侧各出现恰好一次 → 匹配；
 *  3. 键在任一侧出现多次（歧义）→ 明确标记为「未匹配」，不计入新增/移除。
 *
 * 浏览器环境挂载为 window.FocusDiff；Node 环境经 module.exports 导出（供单元测试）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FocusDiff = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var STATUS_LABELS = {
    'ordered': '在顺序中',
    'excluded': '被排除',
    'programmatic': '仅编程聚焦',
    'not-focusable': '不可聚焦'
  };

  function statusLabel(s) {
    return STATUS_LABELS[s] || s || '未知';
  }

  /** 节点的匹配键集合：uid 优先，其次结构/属性指纹 */
  function keysOf(node) {
    var id = node && node.identity;
    var keys = [];
    if (id && id.uid) keys.push({ tier: 'uid', key: id.uid });
    if (id && id.fp) keys.push({ tier: 'fp', key: id.fp });
    return keys;
  }

  /** 按某一层级的键分组：{ key: [node, ...] }（无该层键的节点不参与） */
  function groupByTier(nodes, tier) {
    var map = Object.create(null);
    nodes.forEach(function (n) {
      var keys = keysOf(n);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].tier !== tier) continue;
        (map[keys[i].key] = map[keys[i].key] || []).push(n);
      }
    });
    return map;
  }

  function countKey(nodes, tier, key) {
    var n = 0;
    nodes.forEach(function (x) {
      var keys = keysOf(x);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].tier === tier && keys[i].key === key) { n++; break; }
      }
    });
    return n;
  }

  /**
   * 未匹配 leftover 的原因：
   * 键在任一侧出现多次 → 歧义（ambiguous-*）；否则为无对应节点（no-counterpart）。
   */
  function leftoverReason(node, ownAll, otherAll) {
    var keys = keysOf(node);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (countKey(ownAll, k.tier, k.key) > 1 || countKey(otherAll, k.tier, k.key) > 1) {
        return k.tier === 'uid' ? 'ambiguous-uid' : 'ambiguous-fingerprint';
      }
    }
    return 'no-counterpart';
  }

  /**
   * 匹配基线与当前节点。
   * @param {Array} bEntries 基线节点
   * @param {Array} cEntries 当前节点
   * @returns {{matches:Array<{b:object,c:object,via:string}>,
   *            unmatchedBaseline:Array<{node:object,reason:string}>,
   *            unmatchedCurrent:Array<{node:object,reason:string}>}}
   */
  function matchNodes(bEntries, cEntries) {
    var matches = [];
    var bLeft = (bEntries || []).slice();
    var cLeft = (cEntries || []).slice();

    ['uid', 'fp'].forEach(function (tier) {
      var bMap = groupByTier(bLeft, tier);
      var cMap = groupByTier(cLeft, tier);
      Object.keys(bMap).forEach(function (key) {
        var bs = bMap[key];
        var cs = cMap[key];
        // 键在任一侧不唯一 → 歧义，留待最终标记；无对应键 → 留给下一层级
        if (!cs || bs.length !== 1 || cs.length !== 1) return;
        matches.push({ b: bs[0], c: cs[0], via: tier });
        bLeft.splice(bLeft.indexOf(bs[0]), 1);
        cLeft.splice(cLeft.indexOf(cs[0]), 1);
      });
    });

    return {
      matches: matches,
      unmatchedBaseline: bLeft.map(function (n) {
        return { node: n, reason: leftoverReason(n, bEntries || [], cEntries || []) };
      }),
      unmatchedCurrent: cLeft.map(function (n) {
        return { node: n, reason: leftoverReason(n, cEntries || [], bEntries || []) };
      })
    };
  }

  /** 导出/展示用的节点快照（不含 DOM 引用） */
  function slimNode(n) {
    if (!n) return null;
    return {
      selector: n.selector || null,
      label: n.label || n.selector || '(未命名节点)',
      status: n.status || null,
      statusLabel: statusLabel(n.status),
      step: n.step || null,
      tabIndex: n.tabIndex === undefined ? null : n.tabIndex,
      identity: n.identity || null
    };
  }

  /** 一侧（基线 / 当前）的摘要 */
  function sideSummary(snapshot) {
    var entries = (snapshot && snapshot.entries) || [];
    var ordered = 0;
    entries.forEach(function (e) { if (e.status === 'ordered') ordered++; });
    return {
      pinnedAt: (snapshot && snapshot.pinnedAt) || null,
      stats: (snapshot && snapshot.stats) || null,
      nodeCount: entries.length,
      orderCount: ordered
    };
  }

  var TYPE_RANK = { status: 0, moved: 1, added: 2, removed: 3, unmatched: 4 };

  function diffStep(d) {
    var n = d.current || d.baseline || {};
    return n.step || 9999;
  }

  /**
   * 计算「基线 → 当前」的路线差异。
   * @param {{pinnedAt?:string, stats?:object, entries:Array}} baseline
   * @param {{stats?:object, entries:Array}} current
   * @returns {{baseline:object, current:object, summary:object, matches:Array, diffs:Array}}
   *
   * diffs 元素类型：
   *  - added     当前新增（current 有、baseline 无对应）
   *  - removed   基线移除（baseline 有、current 无对应）
   *  - moved     仍在顺序中但序号变化（fromStep → toStep）
   *  - status    「进入顺序 / 被排除 / 仅编程聚焦 / 不可聚焦」状态切换
   *  - unmatched 身份歧义，无法确定对应关系（side 指明属于哪一侧）
   */
  function diffRoutes(baseline, current) {
    var bEntries = (baseline && baseline.entries) || [];
    var cEntries = (current && current.entries) || [];
    var m = matchNodes(bEntries, cEntries);

    var diffs = [];
    var summary = { added: 0, removed: 0, moved: 0, statusChanged: 0, unchanged: 0, unmatched: 0 };
    var matches = [];

    m.matches.forEach(function (pair) {
      var b = pair.b;
      var c = pair.c;
      var bStep = b.step || null;
      var cStep = c.step || null;

      matches.push({
        via: pair.via,
        label: c.label || b.label || null,
        status: c.status,
        baselineSelector: b.selector || null,
        currentSelector: c.selector || null,
        baselineStep: bStep,
        currentStep: cStep
      });

      if (b.status !== c.status) {
        summary.statusChanged++;
        diffs.push({
          type: 'status',
          via: pair.via,
          label: c.label || b.label,
          fromStatus: b.status,
          toStatus: c.status,
          fromStatusLabel: statusLabel(b.status),
          toStatusLabel: statusLabel(c.status),
          fromStep: bStep,
          toStep: cStep,
          baseline: slimNode(b),
          current: slimNode(c)
        });
      } else if (b.status === 'ordered' && bStep !== cStep) {
        summary.moved++;
        diffs.push({
          type: 'moved',
          via: pair.via,
          label: c.label || b.label,
          fromStep: bStep,
          toStep: cStep,
          baseline: slimNode(b),
          current: slimNode(c)
        });
      } else {
        summary.unchanged++;
      }
    });

    m.unmatchedBaseline.forEach(function (u) {
      if (u.reason === 'no-counterpart') {
        summary.removed++;
        diffs.push({ type: 'removed', label: u.node.label, baseline: slimNode(u.node), current: null });
      } else {
        summary.unmatched++;
        diffs.push({
          type: 'unmatched', side: 'baseline', reason: u.reason,
          label: u.node.label, baseline: slimNode(u.node), current: null
        });
      }
    });

    m.unmatchedCurrent.forEach(function (u) {
      if (u.reason === 'no-counterpart') {
        summary.added++;
        diffs.push({ type: 'added', label: u.node.label, baseline: null, current: slimNode(u.node) });
      } else {
        summary.unmatched++;
        diffs.push({
          type: 'unmatched', side: 'current', reason: u.reason,
          label: u.node.label, baseline: null, current: slimNode(u.node)
        });
      }
    });

    // 展示排序：状态切换 → 移位 → 新增 → 移除 → 未匹配；组内按序号
    diffs.sort(function (a, b) {
      var ra = TYPE_RANK[a.type];
      var rb = TYPE_RANK[b.type];
      if (ra !== rb) return ra - rb;
      return diffStep(a) - diffStep(b);
    });

    return {
      baseline: sideSummary(baseline),
      current: sideSummary(current),
      summary: summary,
      matches: matches,
      diffs: diffs
    };
  }

  return {
    statusLabel: statusLabel,
    matchNodes: matchNodes,
    diffRoutes: diffRoutes
  };
});
