'use strict';

/**
 * analyzer.js Shadow DOM / slot 组合树相关纯函数单元测试（Node 环境，无 DOM）。
 * 重点：分段选择器的序列化 / 解析可往返；组合树诊断对 open / closed /
 * 未分配 / fallback 抑制的区分。
 * 运行：npm test
 */

const assert = require('assert');
const {
  parseRoute,
  formatRoute,
  buildShadowDiagnostics
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

console.log('formatRoute / parseRoute（分段选择器往返）');
test('空值 → 空段数组', () => {
  assert.deepStrictEqual(parseRoute(null), []);
  assert.deepStrictEqual(parseRoute(''), []);
  assert.strictEqual(formatRoute([]), '');
});
test('纯轻树单段（L）', () => {
  const segs = [{ t: 'L', css: 'html > body > button:nth-of-type(2)' }];
  const str = formatRoute(segs);
  assert.strictEqual(str, 'L:html > body > button:nth-of-type(2)');
  assert.deepStrictEqual(parseRoute(str), segs);
});
test('跨 open shadow：L → S 多段', () => {
  const segs = [
    { t: 'L', css: 'html > body > x-list' },
    { t: 'S', css: 'ul > li:nth-of-type(2) > button' }
  ];
  const str = formatRoute(segs);
  assert.strictEqual(str,
    'L:html > body > x-list >> S:ul > li:nth-of-type(2) > button');
  assert.deepStrictEqual(parseRoute(str), segs);
});
test('经 slot 分配：L → S → T 多段', () => {
  const segs = [
    { t: 'L', css: 'x-card' },
    { t: 'S', css: 'div > slot[name="items"]' },
    { t: 'T', css: 'li:nth-of-type(2) > button' }
  ];
  const str = formatRoute(segs);
  assert.ok(str.indexOf(' >> ') > 0);
  assert.deepStrictEqual(parseRoute(str), segs);
});
test('嵌套 shadow + 转发链的多段往返', () => {
  const segs = [
    { t: 'L', css: 'x-a' },
    { t: 'S', css: 'x-b' },
    { t: 'S', css: 'slot' },
    { t: 'T', css: 'x-c' },
    { t: 'S', css: 'button' }
  ];
  assert.deepStrictEqual(parseRoute(formatRoute(segs)), segs);
});
test('段内可包含合法 CSS（#id、>、属性选择器）', () => {
  const segs = [{ t: 'S', css: '#main > a[href="#x"]' }];
  const parsed = parseRoute(formatRoute(segs));
  assert.strictEqual(parsed[0].css, '#main > a[href="#x"]');
});
test('非法段类型被忽略', () => {
  assert.deepStrictEqual(parseRoute('L:a >> X:b >> S:c'), [
    { t: 'L', css: 'a' },
    { t: 'S', css: 'c' }
  ]);
});

console.log('buildShadowDiagnostics');
test('无 shadow 信息 → 无诊断', () => {
  assert.deepStrictEqual(buildShadowDiagnostics(null), []);
  assert.deepStrictEqual(buildShadowDiagnostics({ openCount: 0 }), []);
});
test('open 根：信息级，说明已按组合树展开', () => {
  const diags = buildShadowDiagnostics({ openCount: 2, closed: [] });
  const d = diags.find(x => x.code === 'shadow-open');
  assert.ok(d && d.level === 'info');
  assert.ok(d.message.includes('2'));
  assert.ok(d.message.includes('slot'));
});
test('closed 根：警告级且明确「不可检查、不猜测」', () => {
  const diags = buildShadowDiagnostics({ openCount: 0, closed: [{ label: 'x-secret' }] });
  const d = diags.find(x => x.code === 'shadow-closed');
  assert.ok(d && d.level === 'warn');
  assert.ok(d.message.includes('x-secret'));
  assert.ok(d.message.includes('不可检查'));
  assert.ok(d.message.includes('不猜测'));
});
test('未分配与 fallback 抑制分别计数提示', () => {
  const diags = buildShadowDiagnostics({
    openCount: 1, closed: [], unassignedCount: 3, suppressedFallbackCount: 2
  });
  const un = diags.find(x => x.code === 'shadow-unassigned');
  const fb = diags.find(x => x.code === 'slot-fallback-suppressed');
  assert.ok(un && un.message.includes('3'));
  assert.ok(fb && fb.message.includes('2'));
});

console.log('\n' + passed + ' 个断言组通过' + (process.exitCode ? '（存在失败）' : ''));
