# 键盘焦点路线实验室（Focus Route Lab）

粘贴 HTML 与 CSS，在**剥离用户脚本**、**禁止同源权限**的 sandbox iframe 中预览；
预览支持粘贴**声明式 Shadow DOM**（`<template shadowrootmode="open|closed">`）。
系统依据 `tabindex`、`disabled`、`hidden`、`inert`、计算样式（`display` / `visibility`）与
DOM 嵌套（`details`、`fieldset[disabled]` 等）推导 **Tab / Shift+Tab 焦点顺序**；
计算按**组合树（composed / flat tree）**展开 open `shadowRoot` 与 `<slot>` 分配节点
（无分配时使用 fallback，宿主轻 DOM 不重复计入），逐步高亮跨 shadow 边界的节点，
并解释元素被排除或顺序异常的原因。编辑内容后按**跨边界分段选择器**恢复当前位置并重算路线，
可将当前结果**钉为基线**，后续重算自动按**节点身份**对比前后路线（新增 / 移除 / 移位 / 状态切换），
并对可见的 `dialog[open]` / `aria-modal="true"` 容器做**模态焦点陷阱审计**
（活动模态身份、模态内焦点循环、模态外泄漏节点、无可聚焦项 / 缺少可访问名称诊断），
可一键导出「节点 / 顺序 / 诊断 / 基线对比 / 模态审计」JSON 报告。

## 快速开始（Docker）

```bash
docker compose up --build
```

然后访问：**http://localhost:3000**

### 配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 容器内服务监听端口（在 `docker-compose.yml` 的 `environment` 中修改，并同步调整 `ports` 映射） |
| `HOST` | `0.0.0.0` | 监听地址 |

修改宿主机端口映射示例：`ports: ["8080:3000"]` 后访问 http://localhost:8080 。

## 本地开发（不用 Docker）

```bash
npm install
npm start          # http://localhost:3000
npm test           # 焦点顺序核心算法 + 基线对比单元测试
npm run smoke      # 冒烟测试（需服务已启动）
```

## 功能说明

- **输入区**：粘贴 HTML / CSS；开启「自动重算」后编辑即防抖重算，也可点「应用并重算」。
  支持声明式 Shadow DOM：`<template shadowrootmode="open">` 由浏览器升级为 open Shadow Root，
  `<template shadowrootmode="closed">` 升级为闭合 Shadow Root。
- **预览区**：`sandbox="allow-scripts"`（不含 `allow-same-origin`）的 iframe。
  用户 HTML 先经 DOMParser 净化：移除 `<script>`、`<base>`、`<meta http-equiv>`、
  所有 `on*` 事件属性、`javascript:` / `data:text/html` 链接与 `srcdoc` 属性；
  净化会递归进入 **open shadow root 与 `<template>.content`**。闭合 Shadow Root 在解析后
  无法经任何 API 访问，因此其内部净化与**宿主标注**在【解析前的原始字符串】上完成
  （`public/shdom.js` 扫描 `<template shadowrootmode="closed">` 区间，给其宿主注入
  `data-focus-lab-closed-root` 标注，并对其内部做独立净化），再注入实验室自身的分析脚本
  （`public/analyzer.js`）。
- **焦点路线（组合树）**：按 HTML 顺序聚焦导航模型、沿**组合树（flat tree）**遍历——
  遇到 open Shadow Root 宿主时进入其 `shadowRoot`；遇到 `<slot>` 时展开被分配节点
  （`assignedNodes`），**无分配时使用 slot 的 fallback 内容**；挂 open root 宿主的轻 DOM
  子节点只在被某个 slot 分配时计入，**未分配节点不渲染、不进入 Tab 顺序**（在排除列表中以
  「未被任何 slot 分配」说明，避免宿主轻 DOM 与 slot 展开重复计入）。正值 `tabindex`
  升序优先（平局按组合树序），其余按组合树序；`tabindex < 0` 仅可编程聚焦，不进入顺序。
  节点上的 `shadow #n` / `slotted` / `slot fallback` 徽章标明其组合位置，下方文字给出
  **宿主链**与 **slot 来源**（直接分配 / fallback、slot 名）。
- **跨边界分段选择器**：每个节点的定位串按其物理归属拆段，shadow 边界用 ` >> ` 表示，
  例如 `my-card#card >> form > button#go`。每段都能在对应树根（Document / ShadowRoot）内
  唯一定位，因此**步进、列表点击、模态/基线联动高亮、编辑后位置恢复**都能正确跨越 open
  shadow 边界往返定位。slotted 节点物理上属于轻 DOM，其选择器为轻 DOM 路径，slot 来源由
  组合信息单独表达。
- **闭合 Shadow Root**：解析后 `host.shadowRoot === null`，内部无法检查。实验室**明确把
  宿主标为「闭合 Shadow Root：内部不可检查」**（全局诊断 warn + 统计），绝不猜测其内部焦点
  路线；宿主的轻 DOM 子节点仍正常分析。
- **逐步高亮**：「Tab ⇥ / ⇤ Shift+Tab」按钮，或聚焦「捕获 Tab」按钮后直接按
  `Tab` / `Shift+Tab` 步进；点击顺序列表中的节点亦可定位（含 shadow 内部节点）。
- **排除与诊断**：解释每个候选节点被排除的原因（`disabled`、`hidden`、`inert`、
  `display:none`、`visibility:hidden`、`input[type=hidden]`、闭合 `details`、
  `fieldset[disabled]` 等），并汇总顺序异常（正值 `tabindex`、撞号、
  非交互元素进入 Tab 顺序、`aria-hidden` 内可聚焦等）。
- **位置恢复**：编辑重算后，按当前节点的跨边界分段选择器（每棵树内优先唯一 `#id`，
  否则 `tag:nth-of-type` 路径，段间以 ` >> ` 连接）在新路线中定位并恢复高亮。
- **基线对比**：在「基线对比」标签页点击「📌 钉当前为基线」固定当前分析结果；
  之后每次重算（手动或自动）都会与基线对比，列出：
  - **新增 / 移除**：仅出现在一侧的节点；
  - **移位**：仍在 Tab 顺序中但序号变化，展示前后序号（如「第 2 位 → 第 5 位」）；
  - **状态**：「在顺序中 / 被排除 / 仅编程聚焦 / 不可聚焦」之间的切换（含前后序号）；
  - **未匹配**：身份存在歧义（见下），无法确定对应关系的节点，明确列出而不臆测。

  点击差异项可联动预览高亮：在顺序中的节点按序号高亮，被排除 / 仅编程聚焦的
  节点以虚线框高亮；仅存在于基线中的节点会给出提示。
- **节点身份与匹配规则**：为避免仅凭 `nth-of-type` 在兄弟节点插入后全量误判，
  跨版本匹配不使用位置信息，而是按优先级结合两类身份：
  1. **唯一 id**：**跨全部树根**（文档 + 各 open shadow tree）唯一的 `id`（`id:xxx`）
     ——最强身份，文本等变化仍可识别；同一 id 在不同 shadow tree 重复时不视为唯一；
  2. **结构/属性指纹**：标签 + 关键属性（`type`/`name`/`role`/`href`/`placeholder`/
     `aria-label`/`title`）+ 归一化文本 + **组合祖先链**（标签、祖先 id、`slot[name]`
     与 `::shadow` 边界标记），**不含 `:nth-of-type`**，因此兄弟节点插入 / 删除不影响
     既有节点的身份；`tabindex` / `disabled` / `hidden` 等也不参与指纹，其变化会被识别为
     「移位 / 状态切换」而非「移除 + 新增」。

  某类身份在两侧各出现恰好一次才视为匹配；在任一侧出现多次即为**歧义**，
  对应节点被明确标记为「未匹配」，不计入新增 / 移除。
  （`identity.path` 仍会导出分段 nth-of-type 结构路径，仅供排查展示，不参与匹配。）
  每个节点还携带 `composition` 字段：`depth`（跨越的 open shadow 边界数）、
  `hostChain`（从外到内的宿主 label / 分段选择器）、`slot`（`slotted` / `fallback`、
  slot 名与 slot 分段选择器）与 `tree`（`shadow` / `slotted` / `document`），
  随节点、差异快照与导出 JSON 一起保留。
- **模态焦点陷阱审计**：自动识别预览中**可见**的 `dialog[open]` 与
  `aria-modal="true"` 容器（`hidden` / `inert` / `display:none` / `visibility:hidden`
  的容器不参与）；候选在**所有 open shadow tree 中收集**，可见性与包含关系均按组合树
  （跨 slot / shadow 边界）判定；**嵌套时只审计最内层**活动模态，同级并列时取组合树序最后者。
  「模态审计」标签页展示：
  - **活动模态身份**：类型（`<dialog open>` / `aria-modal`）、分段选择器、节点身份
    （与基线对比同构的 uid / 指纹）、组合宿主链与可访问名称（`aria-labelledby` →
    `aria-label` → `title`），点击可高亮模态容器本身（含 shadow 内部容器）；
  - **焦点循环路线**：模态内可 Tab 节点按全局 Tab 顺序形成的首尾循环，
    标注「首 / 尾」节点并提示循环闭合方向，点击任一节点联动预览高亮
    （实线框 + 「循环 i / n」角标，跨 shadow 边界也能定位）；
  - **泄漏节点**：模态打开时仍可从模态外 Tab 到达的节点（含其它 shadow tree 中的节点），
    点击以虚线框高亮；
  - **审计诊断**：模态内无可聚焦项（无法形成循环）、缺少可访问名称、
    焦点泄漏、多模态并存等。
- **导出 JSON**：`POST /api/export` 返回 `Content-Disposition: attachment` 的报告文件；
  接口不可用时退化为浏览器本地下载。报告的每个节点都含分段 `selector` 与 `composition`
  （宿主链 / slot 来源）；另有顶层 `shadowDom` 字段：`stats`（open / closed root、
  slotted / fallback / 未分配计数）、`openRoots`、`closedRoots`、`unassigned` 与
  `declarativeShadowDomSupported`。已钉基线时，报告包含
  `baselineComparison` 字段：`baseline` / `current` 摘要（时间、统计、节点数）、
  `summary`（各类差异计数）、`matches`（匹配结果及所用身份层级 `uid`/`fp`）与
  `diffs`（逐条差异，差异节点保留 `composition`）。存在活动模态时，报告包含 `modalAudit` 字段：
  `activeModal`（活动模态身份与可访问名称）、`cycle`（模态内循环顺序）、
  `leaks`（泄漏节点）、`diagnostics`（审计诊断）与 `candidates`（全部可见模态候选）。

## 架构

```
server.js                 Express：静态托管 + /api/health + /api/export
public/index.html         应用外壳（编辑器 / 预览 / 结果三栏）
public/shdom.js           纯函数字符串扫描：解析前定位闭合 DSD 区间 / 宿主标注点 + 分段选择器拼装
public/app.js             父页面：净化（含闭合 DSD 字符串阶段）、srcdoc 装配、postMessage、渲染、组合信息展示、基线 / 模态视图、导出
public/analyzer.js        注入 sandbox iframe：组合树遍历、slot 展开、跨边界分段选择器 / 身份、诊断、模态审计、高亮
public/diff.js            基线对比纯函数：节点身份匹配（uid → 指纹 → 歧义未匹配）与差异计算
test/analyzer.test.js     纯函数单元测试（tabindex / 排序 / 诊断 / Shadow DOM 诊断 / 模态审计）
test/shdom.test.js        闭合 DSD 字符串扫描与分段选择器单元测试
test/diff.test.js         基线对比单元测试（身份匹配 / 移位 / 状态切换 / 歧义）
test/smoke.js             冒烟测试
Dockerfile                node:20-alpine，npm install --omit=dev
docker-compose.yml        单服务，ports 3000:3000
```

### 为什么计算放在 iframe 内？

焦点可聚焦性依赖**计算样式**（`display:none`、`visibility:hidden` 等），
只有真实浏览器引擎结合用户 CSS 才能给出准确结果。分析脚本随 srcdoc 注入
sandbox iframe，在文档加载后计算并通过 `postMessage` 把路线回传父页面；
父页面只接受来自该 iframe `contentWindow` 且带来源标记的消息。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查，返回 `{ ok: true, ... }` |
| `POST` | `/api/export` | 请求体为报告 JSON，响应为同名 JSON 附件下载 |
