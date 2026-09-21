'use strict';

/**
 * 冒烟测试：假设服务已启动（默认 http://localhost:3000），
 * 校验静态页面、分析脚本与导出接口。
 * 运行：node server.js &  →  npm run smoke
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function check(name, fn) {
  try {
    await fn();
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error('  ✗ ' + name + ' → ' + err.message);
    process.exitCode = 1;
  }
}

(async () => {
  await check('GET / 返回页面', async () => {
    const res = await fetch(BASE + '/');
    if (!res.ok) throw new Error('status ' + res.status);
    const body = await res.text();
    if (!body.includes('键盘焦点路线实验室')) throw new Error('缺少页面标题');
    if (!body.includes('模态审计')) throw new Error('缺少模态审计标签页');
  });

  await check('GET /analyzer.js 可加载', async () => {
    const res = await fetch(BASE + '/analyzer.js');
    if (!res.ok) throw new Error('status ' + res.status);
    const body = await res.text();
    if (!body.includes('computeOrder')) throw new Error('分析脚本内容异常');
    if (!body.includes('computeModalCycle')) throw new Error('缺少模态审计逻辑');
    if (!body.includes('buildShadowDiagnostics')) throw new Error('缺少 Shadow DOM 诊断逻辑');
    if (!body.includes('assignedElements')) throw new Error('缺少 slot 组合树展开');
    if (!body.includes('shadow-closed-undetermined')) throw new Error('缺少 closed 根不可检查标记');
  });

  await check('GET /app.js 包含声明式 Shadow DOM 净化', async () => {
    const res = await fetch(BASE + '/app.js');
    if (!res.ok) throw new Error('status ' + res.status);
    const body = await res.text();
    if (!body.includes('neutralizeDsd') || !body.includes('restoreDsdTokens')) {
      throw new Error('缺少 DSD 属性中性化 / 还原');
    }
    if (!body.includes('shadowrootmode')) throw new Error('未保留 shadowrootmode 支持');
  });

  await check('GET /diff.js 可加载', async () => {
    const res = await fetch(BASE + '/diff.js');
    if (!res.ok) throw new Error('status ' + res.status);
    const body = await res.text();
    if (!body.includes('diffRoutes')) throw new Error('基线对比脚本内容异常');
  });

  await check('GET /api/health', async () => {
    const res = await fetch(BASE + '/api/health');
    if (!res.ok) throw new Error('status ' + res.status);
    const json = await res.json();
    if (!json.ok) throw new Error('ok !== true');
  });

  await check('POST /api/export 返回 JSON 附件', async () => {
    const res = await fetch(BASE + '/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'focus-route-lab', order: [], nodes: [], diagnostics: [] })
    });
    if (!res.ok) throw new Error('status ' + res.status);
    const cd = res.headers.get('content-disposition') || '';
    if (!cd.includes('attachment')) throw new Error('缺少 Content-Disposition 附件头');
    const json = await res.json();
    if (json.tool !== 'focus-route-lab') throw new Error('回显内容不符');
  });

  console.log(process.exitCode ? '\n冒烟测试存在失败' : '\n冒烟测试全部通过');
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
