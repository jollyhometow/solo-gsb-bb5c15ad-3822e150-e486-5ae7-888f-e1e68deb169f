'use strict';

/**
 * 净化管道（声明式 Shadow DOM）集成验证：依赖可选的 jsdom。
 * 从 public/app.js 源码中切出「净化」相关纯函数在 jsdom 环境执行，
 * 校验：DSD 属性中性化 / 还原、closed 宿主标记、shadow 内部脚本与事件属性剥离。
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// 切出从 SOURCE 常量到「渲染与重算」分节之前的净化代码段
const start = appSrc.indexOf("var SOURCE = 'focus-lab';");
const end = appSrc.indexOf('/* ---------------- 渲染与重算 ---------------- */');
if (start < 0 || end < 0) throw new Error('无法定位净化代码段');
const segment = appSrc.slice(start, end);

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only' });
const factory = new Function(
  'window', 'document', 'DOMParser',
  segment + '\nreturn { neutralizeDsd, sanitizeHtml, restoreDsdTokens, buildSrcdoc, CLOSED_MARKER };'
);
const api = factory(dom.window, dom.window.document, dom.window.DOMParser);

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { failures++; console.error('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

const input = [
  '<x-card>',
  '  <template shadowrootmode="open">',
  '    <button onclick="alert(1)">x</button>',
  '    <script>alert(2)</' + 'script>',
  '    <slot></slot>',
  '    <template shadowrootmode="closed"><b>nested</b></template>',
  '  </template>',
  '  <button slot="x" onclick="alert(3)">slotted</button>',
  '</x-card>',
  '<x-secret><template SHADOWROOTMODE=\'closed\' shadowrootdelegatesfocus><slot></slot></template></x-secret>',
  '<a href=" javascript:alert(4)" onclick="x">danger</a>'
].join('');

const neutral = api.neutralizeDsd(input);
check('中性化后不含真 shadowrootmode（仅 data-frl- 替身）',
  !/(?<!data-frl-)\bshadowrootmode/i.test(neutral) &&
  !/(?<!data-frl-)\bshadowrootdelegatesfocus/i.test(neutral));
check('中性化使用 data-frl-shadowrootmode 替身', neutral.includes('data-frl-shadowrootmode="open"'));
check('大写属性也被中性化（closed + delegates）',
  neutral.includes('data-frl-shadowrootmode="closed"') &&
  neutral.includes('data-frl-shadowrootdelegatesfocus=""'));

const out = api.buildSrcdoc(input, 'body{}', '/*analyzer*/');
check('最终 srcdoc 还原 open', out.includes('shadowrootmode="open"'));
check('最终 srcdoc 还原 closed（含嵌套）',
  (out.match(/shadowrootmode="closed"/g) || []).length >= 2,
  String((out.match(/shadowrootmode="closed"/g) || []).length));
check('delegatesFocus 还原（大写模板属性）',
  /<template[^>]*shadowrootmode="closed"[^>]*shadowrootdelegatesfocus/.test(out));
check('closed 声明式根的宿主带不可检查标记', /<x-secret[^>]*data-focus-lab-closed-shadow/.test(out));
check('shadow 内部 <script> 被剥离', !out.includes('alert(2)'));
check('shadow 内部 onclick 被剥离', !/onclick="alert\(1\)"/.test(out));
check('轻 DOM onclick 被剥离', !/onclick="alert\(3\)"/.test(out));
check('javascript: 协议 href 被移除', !/href=" javascript:alert/.test(out));
check('无残留中性化 token', !out.includes('data-frl-'));
check('分析脚本被注入 srcdoc', out.includes('/*analyzer*/'));
check('slotted 轻 DOM 按钮保留', out.includes('slot="x"'));
check('嵌套 DSD 模板内容保留', out.includes('<b>nested</b>'));
check('template 标签本身保留', (out.match(/<template/g) || []).length >= 3);

// 无 DSD 的普通输入不受影响
const plain = api.buildSrcdoc('<button>ok</button>', '', '');
check('普通 HTML 不含 token / 标记',
  !plain.includes('data-frl-') && !plain.includes('data-focus-lab-closed-shadow') && plain.includes('<button>ok</button>'));

if (failures) { console.error('\n净化管道验证存在 ' + failures + ' 个失败'); process.exit(1); }
console.log('\n净化管道验证全部通过');
