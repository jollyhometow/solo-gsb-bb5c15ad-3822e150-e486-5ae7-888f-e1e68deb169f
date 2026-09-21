'use strict';

/**
 * shdom.js 纯函数单元测试（Node 环境，无 DOM）。
 * 重点验证：闭合 DSD 模板在【解析前】字符串上的定位（嵌套 template / raw text /
 * 引号 / 无引号属性）、宿主标注位置，以及分段选择器的拼装与拆分。
 * 运行：npm test
 */

const assert = require('assert');
const S = require('../public/shdom.js');

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

console.log('isClosedTemplateAttrs');
test('识别双引号 / 单引号 / 无引号的 closed', () => {
  assert.strictEqual(S.isClosedTemplateAttrs(' shadowrootmode="closed"'), true);
  assert.strictEqual(S.isClosedTemplateAttrs(" shadowrootmode='closed'"), true);
  assert.strictEqual(S.isClosedTemplateAttrs(' shadowrootmode=closed'), true);
  assert.strictEqual(S.isClosedTemplateAttrs(' shadowroot=closed'), true);
});
test('open / 无属性 / 子串误匹配 → false', () => {
  assert.strictEqual(S.isClosedTemplateAttrs(' shadowrootmode="open"'), false);
  assert.strictEqual(S.isClosedTemplateAttrs(' id="t"'), false);
  // 不能把 closedxxx 当作 closed
  assert.strictEqual(S.isClosedTemplateAttrs(' shadowrootmode="closedness"'), false);
});

console.log('findClosedShadowRoots');
test('开放 DSD 不产生 span / marker', () => {
  const html = '<my-card><template shadowrootmode="open"><slot></slot></template></my-card>';
  const r = S.findClosedShadowRoots(html);
  assert.strictEqual(r.spans.length, 0);
  assert.strictEqual(r.markers.length, 0);
});

test('闭合 DSD：定位区间并标注宿主', () => {
  const html = '<my-secret data-x="1"><template shadowrootmode="closed"><button>x</button></template></my-secret>';
  const r = S.findClosedShadowRoots(html);
  assert.strictEqual(r.spans.length, 1);
  assert.strictEqual(r.markers.length, 1);
  const sp = r.spans[0];
  assert.strictEqual(html.slice(sp.start, sp.tagEnd), '<template shadowrootmode="closed">');
  assert.strictEqual(html.slice(sp.innerStart, sp.innerEnd), '<button>x</button>');
  assert.strictEqual(html.slice(sp.end), '</my-secret>');
  // 标注点位于宿主开始标签名之后（属性之前）
  assert.strictEqual(html.slice(r.markers[0].pos, r.markers[0].pos + 10), ' data-x="1');
});

test('内部含引号中的尖括号不破坏定位', () => {
  const html = '<host><template shadowrootmode="closed"><style>a{content:">"}</style></template></host>';
  const r = S.findClosedShadowRoots(html);
  assert.strictEqual(r.spans.length, 1);
  assert.ok(r.spans[0].innerStart > 0 && r.spans[0].end > r.spans[0].innerStart);
});

test('raw text（script/style）内部的伪标签不影响栈与区间', () => {
  const html = '<host><template shadowrootmode="closed">' +
    '<script>var x = "</template><button>evil</button>";</' + 'script>' +
    '<style>.a > .b { color: red; }</style>' +
    '</template></host>';
  const r = S.findClosedShadowRoots(html);
  assert.strictEqual(r.spans.length, 1, '只有最外层 closed 模板，script 内的伪 </template> 不应误判');
  assert.strictEqual(r.markers.length, 1);
  assert.strictEqual(r.markers[0].name, 'host');
});

test('闭合模板内部嵌套 <template>（含开放 DSD）：深度正确，仍为一个闭合区间', () => {
  const html = '<host><template shadowrootmode="closed">' +
    '<button>a</button><template shadowrootmode="open"><slot></slot></template>' +
    '</template></host>';
  const r = S.findClosedShadowRoots(html);
  assert.strictEqual(r.spans.length, 1);
  assert.ok(r.spans[0].innerEnd > html.indexOf('</template>', html.indexOf('shadowrootmode="open"')));
});

test('嵌套闭合 DSD：两个 span，宿主分别为外层 host 与内部 host2', () => {
  const html = '<host1><template shadowrootmode="closed">' +
    '<host2><template shadowrootmode="closed"><i></i></template></host2>' +
    '</template></host1>';
  const r = S.findClosedShadowRoots(html);
  assert.strictEqual(r.spans.length, 2);
  assert.strictEqual(r.markers.length, 2);
  const names = r.markers.map(m => m.name).sort();
  assert.deepStrictEqual(names, ['host1', 'host2']);
});

test('同一宿主两个闭合模板：宿主只标注一次，区间有两个', () => {
  const html = '<host><template shadowrootmode="closed"><b>1</b></template>' +
    '<template shadowrootmode="closed"><b>2</b></template></host>';
  const r = S.findClosedShadowRoots(html);
  assert.strictEqual(r.markers.length, 1);
  assert.strictEqual(r.spans.length, 2);
});

test('注释中的伪标签被跳过', () => {
  const html = '<!-- <template shadowrootmode="closed"> --><host></host>';
  const r = S.findClosedShadowRoots(html);
  assert.strictEqual(r.spans.length, 0);
  assert.strictEqual(r.markers.length, 0);
});

test('无闭合模板时返回空集合', () => {
  const r = S.findClosedShadowRoots('<div><p>hi</p></div>');
  assert.deepStrictEqual(r.spans, []);
  assert.deepStrictEqual(r.markers, []);
});

console.log('分段选择器');
test('拆分与拼装：边界为 >>，允许两侧无空格的写法', () => {
  assert.deepStrictEqual(S.splitSegments('my-card >> form > input'), ['my-card', 'form > input']);
  assert.deepStrictEqual(S.splitSegments('a>>b>>c'), ['a', 'b', 'c']);
  assert.deepStrictEqual(S.splitSegments('div > p'), ['div > p']);
  assert.strictEqual(S.joinSegments(['my-card', 'form > input']), 'my-card >> form > input');
});
test('往返一致', () => {
  const sel = 'x-host#h >> section:nth-of-type(2) >> button.go';
  assert.strictEqual(S.joinSegments(S.splitSegments(sel)), sel);
});

console.log('\n' + passed + ' 个断言组通过' + (process.exitCode ? '（存在失败）' : ''));
