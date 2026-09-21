'use strict';

/**
 * diff.js 纯函数单元测试（Node 环境，无 DOM）。
 * 重点验证：节点身份匹配（唯一 id + 结构/属性指纹）在兄弟节点插入时
 * 不发生全量误判，且歧义场景被明确标记为「未匹配」。
 * 运行：npm test
 */

const assert = require('assert');
const { matchNodes, diffRoutes } = require('../public/diff.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error('  ✗ ' + name);
    console.error(err);
    process.exitCode = 1;
  }
}

/** 构造测试节点：uid 传裸 id（自动加 id: 前缀），fp 为指纹串 */
function node(uid, fp, status, step, label) {
  return {
    identity: { uid: uid ? 'id:' + uid : null, fp: fp },
    status,
    step: step || null,
    selector: (uid ? '#' + uid : 'auto-' + fp),
    label: label || uid || fp,
    tabIndex: 0,
    domIndex: 0
  };
}

function snapshot(entries) {
  return { pinnedAt: '2026-09-21T00:00:00.000Z', stats: null, entries };
}

console.log('matchNodes');
test('唯一 id 匹配：指纹（文本）变化仍可识别同一节点', () => {
  const b = [node('save', 'button "保存"', 'ordered', 1)];
  const c = [node('save', 'button "立即保存"', 'ordered', 1)];
  const m = matchNodes(b, c);
  assert.strictEqual(m.matches.length, 1);
  assert.strictEqual(m.matches[0].via, 'uid');
  assert.strictEqual(m.unmatchedBaseline.length, 0);
  assert.strictEqual(m.unmatchedCurrent.length, 0);
});

test('uid 优先于指纹：id 相同的节点先配对，指纹相同者另行处理', () => {
  const b = [node('a', 'fp-1', 'ordered', 1)];
  const c = [node('a', 'fp-2', 'ordered', 1), node(null, 'fp-1', 'ordered', 2)];
  const m = matchNodes(b, c);
  assert.strictEqual(m.matches.length, 1);
  assert.strictEqual(m.matches[0].via, 'uid');
  assert.strictEqual(m.unmatchedCurrent.length, 1); // fp-1 成为新增
});

test('id 被移除后回退到指纹匹配', () => {
  const b = [node('x', 'fp-x', 'ordered', 1)];
  const c = [node(null, 'fp-x', 'ordered', 1)];
  const m = matchNodes(b, c);
  assert.strictEqual(m.matches.length, 1);
  assert.strictEqual(m.matches[0].via, 'fp');
});

test('指纹歧义（两侧各有多个相同节点）→ 明确不匹配', () => {
  const b = [node(null, 'same', 'ordered', 1, 'A1'), node(null, 'same', 'ordered', 2, 'A2')];
  const c = [node(null, 'same', 'ordered', 1, 'B1'), node(null, 'same', 'ordered', 2, 'B2')];
  const m = matchNodes(b, c);
  assert.strictEqual(m.matches.length, 0);
  assert.strictEqual(m.unmatchedBaseline.length, 2);
  assert.strictEqual(m.unmatchedCurrent.length, 2);
  assert.ok(m.unmatchedBaseline.every(u => u.reason === 'ambiguous-fingerprint'));
});

console.log('diffRoutes · 兄弟节点插入（nth-of-type 反例）');
test('头部插入兄弟节点：既有节点不失身份，仅记移位而非移除+新增', () => {
  const base = snapshot([
    node(null, 'fp-a', 'ordered', 1),
    node(null, 'fp-b', 'ordered', 2),
    node(null, 'fp-c', 'ordered', 3)
  ]);
  const cur = snapshot([
    node(null, 'fp-new', 'ordered', 1),
    node(null, 'fp-a', 'ordered', 2),
    node(null, 'fp-b', 'ordered', 3),
    node(null, 'fp-c', 'ordered', 4)
  ]);
  const d = diffRoutes(base, cur);
  assert.strictEqual(d.summary.removed, 0, '不应有误判的移除');
  assert.strictEqual(d.summary.added, 1, '仅插入节点计为新增');
  assert.strictEqual(d.summary.moved, 3, '既有三个节点序号后移');
  assert.strictEqual(d.summary.unmatched, 0);
  const moved = d.diffs.filter(x => x.type === 'moved');
  assert.deepStrictEqual(moved.map(x => [x.fromStep, x.toStep]), [[1, 2], [2, 3], [3, 4]]);
});

test('重排顺序：移位项携带前后序号', () => {
  const base = snapshot([
    node('a', 'fp-a', 'ordered', 1),
    node('b', 'fp-b', 'ordered', 2),
    node('c', 'fp-c', 'ordered', 3)
  ]);
  const cur = snapshot([
    node('c', 'fp-c', 'ordered', 1),
    node('a', 'fp-a', 'ordered', 2),
    node('b', 'fp-b', 'ordered', 3)
  ]);
  const d = diffRoutes(base, cur);
  assert.strictEqual(d.summary.moved, 3);
  const movedC = d.diffs.find(x => x.type === 'moved' && x.label === 'c');
  assert.strictEqual(movedC.fromStep, 3);
  assert.strictEqual(movedC.toStep, 1);
});

console.log('diffRoutes · 状态切换');
test('进入顺序 ↔ 被排除：记为状态变化并保留两侧序号', () => {
  const base = snapshot([
    node('x', 'fp-x', 'ordered', 2),
    node('y', 'fp-y', 'excluded', null)
  ]);
  const cur = snapshot([
    node('x', 'fp-x', 'excluded', null),
    node('y', 'fp-y', 'ordered', 1)
  ]);
  const d = diffRoutes(base, cur);
  assert.strictEqual(d.summary.statusChanged, 2);
  const sx = d.diffs.find(x => x.type === 'status' && x.label === 'x');
  assert.strictEqual(sx.fromStatus, 'ordered');
  assert.strictEqual(sx.toStatus, 'excluded');
  assert.strictEqual(sx.fromStep, 2);
  assert.strictEqual(sx.toStep, null);
  const sy = d.diffs.find(x => x.type === 'status' && x.label === 'y');
  assert.strictEqual(sy.fromStatus, 'excluded');
  assert.strictEqual(sy.toStatus, 'ordered');
  assert.strictEqual(sy.toStep, 1);
});

test('ordered ↔ programmatic（tabindex 变负）同样记为状态切换', () => {
  const base = snapshot([node('p', 'fp-p', 'ordered', 1)]);
  const cur = snapshot([node('p', 'fp-p', 'programmatic', null)]);
  const d = diffRoutes(base, cur);
  assert.strictEqual(d.summary.statusChanged, 1);
  assert.strictEqual(d.diffs[0].toStatus, 'programmatic');
});

console.log('diffRoutes · 新增 / 移除 / 未匹配');
test('纯新增与纯移除', () => {
  const base = snapshot([node('keep', 'fp-k', 'ordered', 1), node('gone', 'fp-g', 'ordered', 2)]);
  const cur = snapshot([node('keep', 'fp-k', 'ordered', 1), node(null, 'fp-n', 'ordered', 2)]);
  const d = diffRoutes(base, cur);
  assert.strictEqual(d.summary.removed, 1);
  assert.strictEqual(d.summary.added, 1);
  const removed = d.diffs.find(x => x.type === 'removed');
  assert.strictEqual(removed.baseline.step, 2);
  assert.strictEqual(removed.current, null);
  const added = d.diffs.find(x => x.type === 'added');
  assert.strictEqual(added.current.step, 2);
  assert.strictEqual(added.baseline, null);
});

test('一侧新增导致指纹不再唯一 → 全部标记未匹配，不计新增/移除', () => {
  const base = snapshot([node(null, 'same', 'ordered', 1)]);
  const cur = snapshot([node(null, 'same', 'ordered', 1), node(null, 'same', 'ordered', 2)]);
  const d = diffRoutes(base, cur);
  assert.strictEqual(d.summary.added, 0);
  assert.strictEqual(d.summary.removed, 0);
  assert.strictEqual(d.summary.unmatched, 3); // 基线 1 + 当前 2
  assert.ok(d.diffs.every(x => x.type === 'unmatched'));
  assert.ok(d.diffs.some(x => x.side === 'baseline') && d.diffs.some(x => x.side === 'current'));
});

test('完全一致 → unchanged，无差异项', () => {
  const entries = [node('a', 'fp-a', 'ordered', 1), node(null, 'fp-b', 'excluded', null)];
  const d = diffRoutes(snapshot(entries), snapshot(entries.map(e => ({ ...e }))));
  assert.strictEqual(d.summary.unchanged, 2);
  assert.strictEqual(d.diffs.length, 0);
});

test('空基线 → 全部计为新增；导出结构包含摘要/匹配/差异', () => {
  const d = diffRoutes(snapshot([]), snapshot([node('a', 'fp-a', 'ordered', 1)]));
  assert.strictEqual(d.summary.added, 1);
  assert.ok(d.baseline && d.current && d.summary && Array.isArray(d.matches) && Array.isArray(d.diffs));
  assert.strictEqual(d.baseline.nodeCount, 0);
  assert.strictEqual(d.current.orderCount, 1);
});

console.log('\n' + passed + ' 个断言组通过' + (process.exitCode ? '（存在失败）' : ''));
