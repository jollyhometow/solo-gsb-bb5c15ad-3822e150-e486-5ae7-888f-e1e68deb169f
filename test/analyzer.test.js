'use strict';

/**
 * analyzer.js 纯函数单元测试（Node 环境，无 DOM）。
 * 运行：npm test
 */

const assert = require('assert');
const {
  parseTabIndexValue,
  computeOrder,
  buildDiagnostics,
  pickActiveModal,
  computeModalCycle,
  buildModalDiagnostics
} = require('../public/analyzer.js');

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

console.log('parseTabIndexValue');
test('无属性 → has=false', () => {
  const r = parseTabIndexValue(null);
  assert.strictEqual(r.has, false);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.value, null);
});
test('合法整数（含正负与空白）', () => {
  assert.strictEqual(parseTabIndexValue('0').value, 0);
  assert.strictEqual(parseTabIndexValue(' 3 ').value, 3);
  assert.strictEqual(parseTabIndexValue('-1').value, -1);
  assert.strictEqual(parseTabIndexValue('+2').value, 2);
});
test('非法值 → valid=false 且 value=null', () => {
  const r = parseTabIndexValue('abc');
  assert.strictEqual(r.has, true);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.value, null);
  assert.strictEqual(parseTabIndexValue('1.5').valid, false);
  assert.strictEqual(parseTabIndexValue('').valid, false);
});

console.log('computeOrder');
function entry(status, tabIndex, domIndex) {
  return { status, tabIndex, domIndex };
}
test('正值 tabindex 优先，按值升序，平局按 DOM 序', () => {
  const entries = [
    entry('ordered', 0, 0),   // 0
    entry('ordered', 2, 1),   // 1
    entry('ordered', 1, 2),   // 2
    entry('ordered', 2, 3),   // 3（与 1 号同为 2，DOM 更靠后）
    entry('ordered', 0, 4)    // 4
  ];
  assert.deepStrictEqual(computeOrder(entries), [2, 1, 3, 0, 4]);
});
test('excluded 与 programmatic 不进入顺序', () => {
  const entries = [
    entry('excluded', 0, 0),
    entry('programmatic', -1, 1),
    entry('ordered', 0, 2)
  ];
  assert.deepStrictEqual(computeOrder(entries), [2]);
});
test('空数组 → 空顺序', () => {
  assert.deepStrictEqual(computeOrder([]), []);
});

console.log('buildDiagnostics');
test('正值 tabindex 产生 warn 诊断', () => {
  const entries = [
    { status: 'ordered', tabIndex: 5, domIndex: 0, label: 'button#a', warnings: [], interactive: true, hasTabindexAttr: true },
    { status: 'ordered', tabIndex: 0, domIndex: 1, label: 'button#b', warnings: [], interactive: true, hasTabindexAttr: false }
  ];
  const diags = buildDiagnostics(entries, computeOrder(entries));
  assert.ok(diags.some(d => d.code === 'positive-tabindex' && d.level === 'warn'));
});
test('重复正值 tabindex 产生提示', () => {
  const entries = [
    { status: 'ordered', tabIndex: 2, domIndex: 0, label: 'a', warnings: [], interactive: true, hasTabindexAttr: true },
    { status: 'ordered', tabIndex: 2, domIndex: 1, label: 'b', warnings: [], interactive: true, hasTabindexAttr: true }
  ];
  const diags = buildDiagnostics(entries, computeOrder(entries));
  assert.ok(diags.some(d => d.code === 'duplicate-tabindex'));
});
test('空顺序产生 empty-order 警告', () => {
  const diags = buildDiagnostics([], []);
  assert.ok(diags.some(d => d.code === 'empty-order'));
});
test('节点级 warning 透传到全局诊断', () => {
  const entries = [
    { status: 'ordered', tabIndex: 0, domIndex: 0, label: 'button', interactive: true, hasTabindexAttr: false,
      warnings: [{ code: 'aria-hidden-focusable', level: 'warn', message: '位于 aria-hidden 子树' }] }
  ];
  const diags = buildDiagnostics(entries, computeOrder(entries));
  assert.ok(diags.some(d => d.code === 'aria-hidden-focusable'));
});

console.log('pickActiveModal');
test('无候选 → -1；单个候选 → 0', () => {
  assert.strictEqual(pickActiveModal([]), -1);
  assert.strictEqual(pickActiveModal([{ containsCandidate: false }]), 0);
});
test('嵌套时只取最内层（包含其他候选者被跳过）', () => {
  const candidates = [{ containsCandidate: true }, { containsCandidate: false }];
  assert.strictEqual(pickActiveModal(candidates), 1);
});
test('同级并列取 DOM 序最后者', () => {
  const candidates = [
    { containsCandidate: false },
    { containsCandidate: false },
    { containsCandidate: false }
  ];
  assert.strictEqual(pickActiveModal(candidates), 2);
});
test('外层嵌套 + 更靠后的独立模态：后者胜出', () => {
  const candidates = [
    { containsCandidate: true },  // 外层（含内层）
    { containsCandidate: false }, // 内层
    { containsCandidate: false }  // 同级独立模态，DOM 序最后
  ];
  assert.strictEqual(pickActiveModal(candidates), 2);
});

console.log('computeModalCycle');
test('模态内外拆分且保持全局 Tab 顺序', () => {
  const entries = [
    { status: 'ordered', inModal: false }, // 0 → 泄漏
    { status: 'ordered', inModal: true },  // 1 → 循环
    { status: 'ordered', inModal: true },  // 2 → 循环
    { status: 'ordered', inModal: false }  // 3 → 泄漏
  ];
  const r = computeModalCycle(entries, [0, 1, 2, 3]);
  assert.deepStrictEqual(r.cycle, [1, 2]);
  assert.deepStrictEqual(r.leaks, [0, 3]);
});
test('非 ordered 状态不进入循环或泄漏', () => {
  const entries = [
    { status: 'excluded', inModal: true },
    { status: 'programmatic', inModal: false },
    { status: 'ordered', inModal: true }
  ];
  const r = computeModalCycle(entries, [0, 1, 2]);
  assert.deepStrictEqual(r.cycle, [2]);
  assert.deepStrictEqual(r.leaks, []);
});
test('空顺序 → 循环与泄漏均为空', () => {
  const r = computeModalCycle([], []);
  assert.deepStrictEqual(r.cycle, []);
  assert.deepStrictEqual(r.leaks, []);
});

console.log('buildModalDiagnostics');
function modalInfo(overrides) {
  return Object.assign({
    hasModal: true,
    kind: 'aria-modal',
    label: 'div.modal',
    cycleCount: 2,
    leakCount: 0,
    leakLabels: [],
    hasAccessibleName: true,
    candidateCount: 1
  }, overrides);
}
test('无活动模态 → 无诊断', () => {
  assert.deepStrictEqual(buildModalDiagnostics({ hasModal: false }), []);
  assert.deepStrictEqual(buildModalDiagnostics(null), []);
});
test('健康模态 → 仅 modal-active 摘要信息', () => {
  const diags = buildModalDiagnostics(modalInfo());
  assert.strictEqual(diags.length, 1);
  assert.strictEqual(diags[0].code, 'modal-active');
  assert.strictEqual(diags[0].level, 'info');
});
test('模态内无可聚焦项 → modal-no-focusable 警告', () => {
  const diags = buildModalDiagnostics(modalInfo({ cycleCount: 0 }));
  assert.ok(diags.some(d => d.code === 'modal-no-focusable' && d.level === 'warn'));
});
test('缺少可访问名称 → modal-no-name 警告', () => {
  const diags = buildModalDiagnostics(modalInfo({ hasAccessibleName: false }));
  assert.ok(diags.some(d => d.code === 'modal-no-name' && d.level === 'warn'));
});
test('泄漏节点 → modal-leak 警告且含数量与标签', () => {
  const diags = buildModalDiagnostics(modalInfo({ leakCount: 3, leakLabels: ['a', 'b', 'c'] }));
  const leak = diags.find(d => d.code === 'modal-leak');
  assert.ok(leak && leak.level === 'warn');
  assert.ok(leak.message.includes('3') && leak.message.includes('a，b，c'));
});
test('dialog 泄漏提示 showModal 与静态分析的差异', () => {
  const diags = buildModalDiagnostics(modalInfo({ kind: 'dialog', leakCount: 1, leakLabels: ['a'] }));
  assert.ok(diags.find(d => d.code === 'modal-leak').message.includes('showModal'));
});
test('多个候选模态 → modal-multiple 提示', () => {
  const diags = buildModalDiagnostics(modalInfo({ candidateCount: 3 }));
  assert.ok(diags.some(d => d.code === 'modal-multiple' && d.level === 'info'));
});

console.log('\n' + passed + ' 个断言组通过' + (process.exitCode ? '（存在失败）' : ''));
