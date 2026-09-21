# 键盘焦点路线实验室（Focus Route Lab）

粘贴 HTML 与 CSS，在**剥离用户脚本**、**禁止同源权限**的 sandbox iframe 中预览；
预览支持粘贴**声明式 Shadow DOM**（`<template shadowrootmode="open">`）。
系统依据 `tabindex`、`disabled`、`hidden`、`inert`、计算样式（`display` / `visibility`）、
DOM 嵌套（`details`、`fieldset[disabled]` 等）与 **Shadow DOM / slot 组合树**推导
**Tab / Shift+Tab 焦点顺序**——展开 open `shadowRoot`、按 `<slot>` 分配渲染轻 DOM 节点、
未分配时使用 fallback，并跳过宿主未分配的轻 DOM；逐步高亮节点，并解释元素被排除或顺序异常的原因。
编辑内容后按**可跨边界往返的分段选择器**恢复当前位置并重算路线，
可将当前结果**钉为基线**，后续重算自动按**含宿主链的节点身份**对比前后路线
（新增 / 移除 / 移位 / 状态切换），并对可见的 `dialog[open]` / `aria-modal="true"`
容器（含位于 shadow 内部 / 经 slot 分配者）做**模态焦点陷阱审计**
（活动模态身份、模态内焦点循环、模态外泄漏节点、无可聚焦项 / 缺少可访问名称诊断），
可一键导出「节点（含宿主链 / slot 来源）/ 顺序 / 诊断 / 基线对比 / 模态审计 / 组合树汇总」JSON 报告。
**closed shadow root 明确标记为不可检查，实验室不猜测其内部焦点顺序。**

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
- **预览区**：`sandbox="allow-scripts"`（不含 `allow-same-origin`）的 iframe。
  用户 HTML 先经 DOMParser 净化：移除 `<script>`、`<base>`、`<meta http-equiv>`、
  所有 `on*` 事件属性、`javascript:` / `data:text/html` 链接与 `srcdoc` 属性
  （净化覆盖 `<template>` 内容，即 shadow 子树内部）；声明式 Shadow DOM 模板的
  `shadowrootmode` / `shadowrootdelegatesfocus` 在净化 / 二次解析阶段以中性替身保留，
  写入 srcdoc 前还原，浏览器据此创建真实 shadow root；再注入实验室自身的分析脚本
  （`public/analyzer.js`）。
- **Shadow DOM / slot 组合树**：
  - 粘贴 `<template shadowrootmode="open">` 即可预览真实 open 组件（支持嵌套）；
  - Tab 路线按**组合树**展开：`shadowRoot` 内部节点、经 `<slot>` **分配**到组合位置的
    轻 DOM 节点（含转发链）计入；slot 未被占用时计入其 **fallback** 内容；
  - 宿主轻 DOM 中**未被任何 slot 分配**的子树不渲染、不计数（列入「排除与诊断」，
    原因 `shadow-unassigned`），避免与分配节点重复计入；slot 已分配时其 fallback
    子树以 `slot-fallback-suppressed` 标记为不渲染；
  - `shadowrootdelegatesfocus`：宿主自身是 Tab 停靠点且 shadow 内存在可聚焦节点时，
    宿主不单独停留焦点（标记 `delegates-focus`）；
  - **分段选择器（可往返）**：跨边界定位路径由 `L:`（文档轻树）/ `S:`（进入 open
    shadowRoot）/ `T:`（经 slot 分配的轻 DOM）三段组成，以 ` >> ` 连接，例如
    `L:html > body > x-list >> S:ul > slot[name=items] >> T:li:nth-of-type(2) > button`。
    步进、顺序 / 模态 / 基线列表点击、编辑后位置恢复均通过它精确高亮，closed 根
    内部必然无法定位（不猜测）；
  - **closed shadow root**：解析后 JS 不可达（`el.shadowRoot === null`），净化阶段
    在宿主上留下标记；实验室在诊断中明确警告「内部不可检查」，其宿主轻 DOM 候选
    节点标为「不可确定（`shadow-closed-undetermined`）」，既不计入顺序也不臆测；
  - 节点项展示**宿主链**（穿过的 shadow 宿主）与 **slot 来源**（分配 / 转发 /
    fallback，含具名 / 默认槽）徽章。
- **焦点路线**：按 HTML 顺序聚焦导航模型计算（组合树序作为平局决胜）——
  正值 `tabindex` 升序优先（平局按 DOM 序），其余按 DOM 序；
  `tabindex < 0` 仅可编程聚焦，不进入顺序。
- **逐步高亮**：「Tab ⇥ / ⇤ Shift+Tab」按钮，或聚焦「捕获 Tab」按钮后直接按
  `Tab` / `Shift+Tab` 步进；点击顺序列表中的节点亦可定位。
- **排除与诊断**：解释每个候选节点被排除的原因（`disabled`、`hidden`、`inert`、
  `display:none`、`visibility:hidden`、`input[type=hidden]`、闭合 `details`、
  `fieldset[disabled]` 等），并汇总顺序异常（正值 `tabindex`、撞号、
  非交互元素进入 Tab 顺序、`aria-hidden` 内可聚焦等）。
- **位置恢复**：编辑重算后，按当前节点的稳定选择器（唯一 `#id` 或
  `tag:nth-of-type` 路径）在新路线中定位并恢复高亮。
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
  1. **唯一 id**：文档内唯一的 `id`（`id:xxx`）——最强身份，文本等变化仍可识别；
  2. **结构/属性指纹**：标签 + 关键属性（`type`/`name`/`role`/`href`/`placeholder`/
     `aria-label`/`title`）+ 归一化文本 + 组合祖先链（标签与祖先 id，并在穿过
     shadow 边界处插入 `::shadow`、经 slot 分配处插入 `::slotted(name)`），
     **不含 `:nth-of-type`**，因此兄弟节点插入 / 删除不影响既有节点的身份，
     不同组件内部的同构节点也不会互相误配；
     `tabindex` / `disabled` / `hidden` 等也不参与指纹，其变化会被识别为
     「移位 / 状态切换」而非「移除 + 新增」。
  - **id 唯一性按整棵组合树判定**：同一 id 出现在不同 shadow root 中时不视为唯一
    （uid 留空），匹配回退到带宿主链的指纹。

  某类身份在两侧各出现恰好一次才视为匹配；在任一侧出现多次即为**歧义**，
  对应节点被明确标记为「未匹配」，不计入新增 / 移除。
  （`identity.path` 仍会导出 nth-of-type 结构路径，仅供排查展示，不参与匹配。）
- **模态焦点陷阱审计**：自动识别预览中**可见**的 `dialog[open]` 与
  `aria-modal="true"` 容器（`hidden` / `inert` / `display:none` / `visibility:hidden`
  的容器不参与）；**嵌套时只审计最内层**活动模态，同级并列时取 DOM 序最后者。
  「模态审计」标签页展示：
  - **活动模态身份**：类型（`<dialog open>` / `aria-modal`）、稳定选择器、节点身份
    （与基线对比同构的 uid / 指纹）与可访问名称（`aria-labelledby` → `aria-label` →
    `title`），点击可高亮模态容器本身；
  - **焦点循环路线**：模态内可 Tab 节点按全局 Tab 顺序形成的首尾循环，
    标注「首 / 尾」节点并提示循环闭合方向，点击任一节点联动预览高亮
    （实线框 + 「循环 i / n」角标）；
  - **泄漏节点**：模态打开时仍可从模态外 Tab 到达的节点，点击以虚线框高亮；
  - **审计诊断**：模态内无可聚焦项（无法形成循环）、缺少可访问名称、
    焦点泄漏、多模态并存等。
- **导出 JSON**：`POST /api/export` 返回 `Content-Disposition: attachment` 的报告文件；
  接口不可用时退化为浏览器本地下载。已钉基线时，报告包含
  `baselineComparison` 字段：`baseline` / `current` 摘要（时间、统计、节点数）、
  `summary`（各类差异计数）、`matches`（匹配结果及所用身份层级 `uid`/`fp`）与
  `diffs`（逐条差异）。存在活动模态时，报告包含 `modalAudit` 字段：
  `activeModal`（活动模态身份与可访问名称）、`cycle`（模态内循环顺序）、
  `leaks`（泄漏节点）、`diagnostics`（审计诊断）与 `candidates`（全部可见模态候选）。
  检测到 Shadow DOM 时，报告包含 `shadowDom` 字段（open/closed 根宿主、
  经 slot 分配 / fallback / 未分配 / fallback 抑制计数，closed 根含宿主选择器）；
  每个节点的 `shadow` 对象保留 `hosts`（宿主链：label + 分段选择器）、
  `slots`（slot 来源：名称、`slotted`/`forward`/`fallback`、label、分段选择器）、
  `fallback` 与 `closed` 标志，`identity.path` 同样为分段选择器。

## 架构

```
server.js                 Express：静态托管 + /api/health + /api/export
public/index.html         应用外壳（编辑器 / 预览 / 结果三栏）
public/app.js             父页面：DSD 感知净化、srcdoc 装配、postMessage 通信、渲染、
                          shadow 徽章（宿主链 / slot 来源）、基线面板、模态审计视图、导出
public/analyzer.js        注入 sandbox iframe：组合树遍历（open shadow / slot 分配 /
                          fallback / 未分配）、焦点模型、分段选择器、节点身份（含宿主链）、
                          closed 根「不可检查」标记、跨边界模态审计、高亮绘制
public/diff.js            基线对比纯函数：节点身份匹配（uid → 指纹 → 歧义未匹配）与差异计算
test/analyzer.test.js     纯函数单元测试（tabindex 解析 / 排序 / 诊断 / 模态审计）
test/shadow.test.js       Shadow 纯函数单元测试（分段选择器往返 / 组合树诊断）
test/diff.test.js         基线对比单元测试（身份匹配 / 移位 / 状态切换 / 歧义）
test/shadow-integration.js jsdom 集成：组合树遍历 / slot / closed / 跨边界模态（需可选 jsdom）
test/sanitize-dsd.js      jsdom 集成：声明式 Shadow DOM 净化 / 还原（需可选 jsdom）
test/smoke.js             冒烟测试
Dockerfile                node:20-alpine，npm install --omit=dev
docker-compose.yml        单服务，ports 3000:3000
```

> 零依赖单元测试：`npm test`（不安装 jsdom）。jsdom 集成验证为可选：
> `npm install --no-save jsdom && node test/shadow-integration.js && node test/sanitize-dsd.js`
> （jsdom 不支持声明式 `shadowrootmode` 的解析，集成测试用 `attachShadow` 等价构造运行时结构；
> DSD 模板的保留 / 还原由 `sanitize-dsd.js` 在字符串与 DOMParser 层验证。）

### 为什么计算放在 iframe 内？

焦点可聚焦性依赖**计算样式**（`display:none`、`visibility:hidden` 等），
只有真实浏览器引擎结合用户 CSS 才能给出准确结果；声明式 Shadow DOM 也必须由
浏览器解析才会创建真实的 `shadowRoot` / slot 分配关系。分析脚本随 srcdoc 注入
sandbox iframe，在文档加载后按组合树计算并通过 `postMessage` 把路线回传父页面；
父页面只接受来自该 iframe `contentWindow` 且带来源标记的消息。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查，返回 `{ ok: true, ... }` |
| `POST` | `/api/export` | 请求体为报告 JSON，响应为同名 JSON 附件下载 |
