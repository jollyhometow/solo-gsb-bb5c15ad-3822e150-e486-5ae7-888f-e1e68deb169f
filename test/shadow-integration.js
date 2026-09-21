'use strict';

/**
 * 非 npm 套件的集成验证（依赖可选的 jsdom，仅本地/CI 可用时运行）：
 * 在真实 Shadow DOM API 下验证 analyzer.js 的组合树遍历、分段选择器往返、
 * slot 分配 / fallback、未分配、closed 不可检查与跨边界模态审计。
 * 声明式 shadowrootmode 的解析由浏览器负责（jsdom 不支持 DSD），
 * 这里用 attachShadow 等价构造运行时结构。
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = `<!DOCTYPE html><html><body>
  <button id="light-b">轻树按钮</button>
  <x-card id="card">
    <a slot="footer" id="foot-link" href="#">footer 链接</a>
    <button slot="title" id="title-b">title 槽按钮</button>
    <button id="default-b">默认槽按钮</button>
    <button id="unassigned-b" slot="nowhere">未分配按钮（无对应具名 slot）</button>
  </x-card>
  <x-empty id="empty">
    <button id="empty-b">无 slot 宿主的轻 DOM：全部未分配</button>
  </x-empty>
  <x-fallback id="fb-host"></x-fallback>
  <x-fwd-outer id="fo">
    <x-fwd-inner id="fi" slot="plug"><button id="fwd-b">转发链按钮</button></x-fwd-inner>
  </x-fwd-outer>
  <x-secret id="secret" data-focus-lab-closed-shadow="">
    <button id="secret-light">closed 轻 DOM 按钮</button>
  </x-secret>
  <div id="modal-host"></div>
</body></html>`;

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

// 分析器内 parent.postMessage（sandbox iframe 形态）：让 parent 指向自身窗口
try { Object.defineProperty(window, 'parent', { value: window, configurable: true }); } catch (e) {}

// postMessage 采集（analyzer 经 setTimeout(0) 发消息，必须在 eval 前注册）
let routePayload = null;
window.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'route') routePayload = ev.data.payload;
  if (ev.data && ev.data.type === 'error') console.error('analyzer error:', ev.data.message);
});

// ---- 构造 open shadow root（等价 DSD shadowrootmode="open"） ----
const card = document.getElementById('card');
const sr = card.attachShadow({ mode: 'open' });
sr.innerHTML =
  '<style></style>' +
  '<h3><slot name="title"></slot></h3>' +
  '<slot></slot>' +
  '<slot name="footer"><button id="fb-inner">fallback 按钮</button></slot>' +
  '<button id="inner-b">shadow 内部按钮</button>';

// ---- closed 根（DSD closed 的运行时形态） ----
const secret = document.getElementById('secret');
secret.attachShadow({ mode: 'closed' });

// ---- 无 slot 的 open 根：宿主轻 DOM 全部未分配 ----
document.getElementById('empty').attachShadow({ mode: 'open' });

// ---- 未分配 slot：fallback 内容按组合树位置渲染 ----
const fbsr = document.getElementById('fb-host').attachShadow({ mode: 'open' });
fbsr.innerHTML = '<div><slot name="vacant"><button id="rendered-fb">实际渲染的 fallback 按钮</button></slot></div>';

// ---- 转发链：inner 整体被 outer 的具名槽接收，按钮再经 inner 默认槽渲染 ----
document.getElementById('fo').attachShadow({ mode: 'open' }).innerHTML = '<slot name="plug"></slot>';
document.getElementById('fi').attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>';

// ---- 模态对话框位于另一个 open 根内 ----
const mh = document.getElementById('modal-host');
const msr = mh.attachShadow({ mode: 'open' });
msr.innerHTML =
  '<div role="dialog" aria-modal="true" aria-label="跨边界模态">' +
  '<button id="m-b1">模态内按钮1</button>' +
  '<button id="m-b2">模态内按钮2</button></div>';

const analyzerSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'analyzer.js'), 'utf8');
window.eval(analyzerSrc);

setTimeout(() => {
  let failures = 0;
  function check(name, cond, extra) {
    if (cond) { console.log('  ✓ ' + name); }
    else { failures++; console.error('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
  }

  if (!routePayload) {
    console.error('未收到 route 消息');
    process.exit(1);
  }
  const p = routePayload;
  const labels = {};
  p.entries.forEach(e => { labels[e.tag + (e.text ? ':' + e.text : '') + '#' + (e.identity.id || '')] = e; });
  const findById = id => p.entries.find(e => e.identity.id === id);
  const routeById = id => {
    const order = [];
    p.order.forEach((sel, i) => order.push([i, sel]));
    const e = findById(id);
    return e ? p.order.indexOf(e.selector) : -1;
  };

  console.log('组合树展开与计数');
  const innerB = findById('inner-b');
  check('shadow 内部按钮出现在节点中', !!innerB);
  check('shadow 内部按钮在 Tab 顺序中', innerB && innerB.status === 'ordered', innerB && innerB.status);
  check('内部按钮 selector 跨边界（含 S 段）', innerB && /^L:[^>]*#card >> S:/.test(innerB.selector), innerB && innerB.selector);

  const defaultB = findById('default-b');
  check('默认槽 slotted 按钮被计入（不与宿主轻 DOM 重复）', defaultB && defaultB.status === 'ordered');
  check('slotted 节点带 slot 来源（slotted，默认槽）',
    defaultB && defaultB.shadow.slots.length === 1 &&
    defaultB.shadow.slots[0].via === 'slotted' && defaultB.shadow.slots[0].name === null);
  check('slotted 节点 selector 含 T 段',
    defaultB && / >> T:#default-b$/.test(defaultB.selector), defaultB && defaultB.selector);

  const foot = findById('foot-link');
  check('具名 slot 分配节点带 name', foot && foot.shadow.slots[0].name === 'footer');

  console.log('fallback / 未分配');
  const fb = findById('fb-inner');
  // footer 已被 foot-link 分配 → fallback 被抑制
  check('slot 已分配 → fallback 按钮被强制排除', fb && fb.status === 'excluded' &&
    fb.reasons.some(r => r.code === 'slot-fallback-suppressed'));
  check('被抑制 fallback 不标记为渲染态 fallback（shadow.fallback=false）', fb && fb.shadow.fallback === false);
  const un = findById('unassigned-b');
  check('未分配宿主轻 DOM 按钮被强制排除（shadow-unassigned）', un && un.status === 'excluded' &&
    un.reasons.some(r => r.code === 'shadow-unassigned'));
  check('未分配按钮不进入 order', routeById('unassigned-b') === -1);
  const emptyB = findById('empty-b');
  check('无 slot 宿主的轻 DOM 按钮同样未分配', emptyB && emptyB.status === 'excluded' &&
    emptyB.reasons.some(r => r.code === 'shadow-unassigned'));
  check('未分配节点带宿主链（x-empty）', emptyB && emptyB.shadow.hosts.some(h => /x-empty/.test(h.label)));

  const renderedFb = findById('rendered-fb');
  check('未分配 slot 的 fallback 节点在顺序中', renderedFb && renderedFb.status === 'ordered');
  check('渲染中的 fallback 节点 shadow.fallback=true 且 slots via=fallback',
    renderedFb && renderedFb.shadow.fallback === true &&
    renderedFb.shadow.slots.length === 1 && renderedFb.shadow.slots[0].via === 'fallback' &&
    renderedFb.shadow.slots[0].name === 'vacant',
    JSON.stringify(renderedFb && renderedFb.shadow));

  console.log('slot 转发链（跨 shadow）');
  const fwdB = findById('fwd-b');
  check('转发链按钮在顺序中', fwdB && fwdB.status === 'ordered');
  check('转发链 selector 含两段 S/T',
    fwdB && fwdB.selector === 'L:#fo >> S:slot[name="plug"] >> T:#fi >> S:slot:not([name]) >> T:#fwd-b',
    fwdB && fwdB.selector);
  check('转发链宿主链两层', fwdB && fwdB.shadow.hosts.length === 2 &&
    /x-fwd-outer/.test(fwdB.shadow.hosts[0].label) && /x-fwd-inner/.test(fwdB.shadow.hosts[1].label));

  console.log('closed shadow root');
  const secretLight = findById('secret-light');
  check('closed 宿主轻 DOM 节点存在但被标为不可确定', secretLight && secretLight.status === 'excluded' &&
    secretLight.reasons.some(r => r.code === 'shadow-closed-undetermined'));
  check('closed 节点 shadow.closed=true 且宿主链含 x-secret',
    secretLight && secretLight.shadow.closed === true &&
    secretLight.shadow.hosts.some(h => /x-secret/.test(h.label)));
  // closed 根内部节点对 querySelectorAll('*') 不可达 → 根本不应出现
  check('closed 根内部按钮不可检查（未出现在节点列表）',
    !p.entries.some(e => e.text === 'closed 根内部按钮（实验室无法看到）'));
  check('诊断含 shadow-closed 警告', p.diagnostics.some(d => d.code === 'shadow-closed'));
  check('stats.shadow.openRoots >= 2', p.stats.shadow.openRoots >= 2, String(p.stats.shadow.openRoots));
  check('stats.shadow.closedRoots 含 x-secret',
    p.stats.shadow.closedRoots.some(c => /x-secret/.test(c.label)));

  console.log('分段选择器往返（highlight 解析）');
  let resolved = [];
  function collect(sel) {
    // 通过发送 highlight-node 消息让分析器解析；这里直接复用其 resolveRoute 未暴露，
    // 改为监听 highlighted/highlight-miss 回执
    return new Promise(res => {
      function onMsg(ev) {
        if (ev.data && ev.data.type === 'highlighted' && ev.data.selector === sel) {
          window.removeEventListener('message', onMsg); res(true);
        }
        if (ev.data && ev.data.type === 'highlight-miss' && ev.data.selector === sel) {
          window.removeEventListener('message', onMsg); res(false);
        }
      }
      window.addEventListener('message', onMsg);
      window.postMessage({ target: 'focus-lab', type: 'highlight-node', selector: sel }, '*');
    });
  }
  (async () => {
    check('slotted 选择器可往返高亮', await collect(defaultB.selector));
    check('shadow 内部选择器可往返高亮', await collect(innerB.selector));
    check('渲染中的 fallback 选择器可往返高亮', await collect(renderedFb.selector));
    check('转发链按钮可往返高亮', await collect(findById('fwd-b').selector));
    check('closed 相关选择器为宿主轻 DOM（可定位）', await collect(secretLight.selector));

    // 跨边界模态审计
    console.log('跨边界模态审计');
    const a = p.modalAudit;
    check('活动模态位于 shadow 内部', a.activeModal && /S:.*div/.test(a.activeModal.selector),
      a.activeModal && a.activeModal.selector);
    check('模态内循环 = 2 个内部按钮', a.cycle.length === 2, String(a.cycle.length));
    const cycleIds = a.cycle.map(c => c.selector).join('|');
    check('循环节点为 m-b1/m-b2', /m-b1/.test(cycleIds) && /m-b2/.test(cycleIds), cycleIds);
    check('泄漏节点包含轻树按钮与 slotted 节点（组合包含正确）',
      a.leaks.some(l => l.selector === findById('light-b').selector) &&
      a.leaks.some(l => l.selector === defaultB.selector));
    check('泄漏节点不包含模态内按钮',
      !a.leaks.some(l => /m-b[12]/.test(l.selector)));

    // 指纹宿主链区分：shadow 内按钮与轻树按钮指纹不同
    console.log('节点身份');
    check('内部按钮 fp 含 ::shadow / ::slotted 边界标记',
      /::shadow/.test(innerB.identity.fp));
    check('内部按钮 path 即分段选择器', innerB.identity.path === innerB.selector);
    check('slotted 节点 fp 含 ::slotted(#default)', /::slotted\(#default\)/.test(defaultB.identity.fp),
      defaultB.identity.fp);

    console.log('\n顺序完整性');
    check('order 中每个 selector 唯一', new Set(p.order).size === p.order.length);
    check('order 中 selector 都能在 entries 找到',
      p.order.every(sel => p.entries.some(e => e.selector === sel)));

    if (failures) { console.error('\n集成验证存在 ' + failures + ' 个失败'); process.exit(1); }
    console.log('\n集成验证全部通过');
  })();
}, 400);
