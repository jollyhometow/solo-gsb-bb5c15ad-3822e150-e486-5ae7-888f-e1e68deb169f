'use strict';

/**
 * 键盘焦点路线实验室 —— Express 服务端
 *
 * 职责：
 *  1. 托管前端静态资源（public/）；
 *  2. 提供健康检查接口；
 *  3. 提供导出接口：把前端汇总好的「节点 / 顺序 / 诊断」报告
 *     以 JSON 附件形式返回下载。
 *
 * 焦点顺序的计算发生在浏览器端（sandbox iframe 内注入的分析脚本），
 * 因为只有真实浏览器引擎才能给出准确的计算样式（getComputedStyle）。
 */

const path = require('path');
const express = require('express');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));

// 基础安全响应头（应用外壳；预览内容本身运行在 sandbox iframe 中）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// 静态资源
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'index.html' }));

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'focus-route-lab', time: new Date().toISOString() });
});

// 导出报告：接收前端 JSON，作为附件返回
app.post('/api/export', (req, res) => {
  const report = req.body && typeof req.body === 'object' ? req.body : { error: 'empty report' };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="focus-route-report-${stamp}.json"`);
  res.send(JSON.stringify(report, null, 2));
});

// 兜底 404（API）
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

app.listen(PORT, HOST, () => {
  console.log(`[focus-route-lab] listening on http://${HOST}:${PORT}`);
});
