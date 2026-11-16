# CubeCity AI 持续托管与 Agent 接入指南

本文档说明 CubeCity 为大模型 Agent 与持续自动化游玩设计的核心架构、无头模拟引擎、浏览器桥接接口，以及动态城市等级与成就系统。

---

## 1. 设计原则：零视觉状态机与持续托管

CubeCity 本质上是 `17 × 17` 离散网格上的确定性模拟经营系统。相比低效且易受 3D 透视遮挡影响的“截图 + 鼠标点击”，项目提供两层结构化接口：

1. **纯逻辑模拟引擎（[cityEngine.js](../src/simulation/cityEngine.js)）**：零 DOM / Three.js 依赖，在浏览器与 Node.js 双端复用同一套造价、邻路、协同加成、供电、人口、污染与稳定度公式。
2. **持续实时 AI 市长（[autonomousMayor.js](../src/simulation/autonomousMayor.js)）**：非预设静态脚本回放，而是每周期实时读取 `gameState` 执行 `感知 → 诊断 → 决策 → 同步 → 城市更新` 闭环：
   - **有机路网与分区**：路网按需从中心广场延伸，建筑按空间功能区场强（中央纪念碑/CBD 核心圈、西北工业集群、东南/东北花园住宅、外圈风能带）动态选址并面朝邻近道路。
   - **持续城市更新（Urban Renewal）**：全图建设完成后不会停摆，资金充裕时会自动淘汰早期低效普通工厂等建筑并转型升级为高产出 3 级商务中心、化学工厂或生态公园。
   - **支持随时人工干预**：人类玩家在 AI 托管期间手动拆建任何地块，AI 会在下一个周期立刻感知并重新平衡电网、住房与污染。

---

## 2. 核心模块与 API

### 2.1 `window.__CUBECITY_AGENT__`（[agentBridge.js](../src/js/agent/agentBridge.js)）

页面加载完成后，[experience.js](../src/js/experience.js) 会挂载全局桥接实例 `window.__CUBECITY_AGENT__`：

- `getState()`：返回精简指标、`achievements`、可升级列表与 `17 × 17` ASCII 棋盘。
- `getRules()`：返回 `BUILDING_DATA`、`BUILDING_INTERACTIONS`、`STABILITY_CONFIG` 与免邻路规则。
- `executeAction(action)` / `executePlan(actions)`：事务性执行建造、升级、拆除、搬迁、旋转或跨天推进，并严格同步 Pinia 与 Three.js 场景。
- `simulatePlan(actions)`：克隆状态做无副作用预演。
- `startAutonomousAI({ speed, freshStart })` / `stopAutonomousAI()` / `setAISpeed(speed)`：启动、暂停持续实时 AI 托管并切换倍速（`1x` / `3x` / `10x`）。
- `stepDays(days)` / `setAutoTick(enabled, intervalMs)` / `reset()`：可控时间步进与重置。

### 2.2 前端入口与界面交互

- **URL 直达开演**：访问 `http://localhost:5173/?showcase=1`（或 `?demo=1`）会自动以 3x 倍速从空地开启实时 AI 托管建设。
- **顶部操作栏（[TopBar.vue](../src/components/TopBar.vue)）**：提供 `🤖 AI 托管` / `⏸️ 暂停 AI` 开关及 `1x / 3x / 10x` 倍速切换。
- **左上角决策条（[ModeIndicator.vue](../src/components/ModeIndicator.vue)）**：AI 运行期间实时显示当前阶段决策原因。
- **默认中文与无遮挡视图**：默认语言为中文（`zh`），[GuideModal.vue](../src/components/GuideModal.vue) 与 [RestorePrompt.vue](../src/components/RestorePrompt.vue) 不再在首屏自动弹出遮挡 3D 视野，[ToastContainer.vue](../src/components/ToastContainer.vue) 提示自动 `2.8s` 淡出。

---

## 3. 动态城市等级与实时成就系统

### 3.1 城市等级（`Lv.1 ~ Lv.8`，[cityEngine.js](../src/simulation/cityEngine.js)）

随 `buildingCount`、`population`、`dailyIncome`、`pollution` 与 `stability` 实时计算并在 [useGameState.js](../src/stores/useGameState.js) 中自动同步：

| 等级 | 核心解锁条件 |
| :--- | :--- |
| `Lv.1` | 初始聚落 |
| `Lv.2` | 建筑 `>= 8` 且人口 `>= 40` |
| `Lv.3` | 建筑 `>= 22`、人口 `>= 150`、日收入 `>= 250` |
| `Lv.4` | 建筑 `>= 45`、人口 `>= 400`、日收入 `>= 800` |
| `Lv.5` | 建筑 `>= 75`、人口 `>= 900`、日收入 `>= 2,200` |
| `Lv.6` | 建筑 `>= 105`、人口 `>= 1,500`、日收入 `>= 4,500` |
| `Lv.7` | 建筑 `>= 130`、人口 `>= 2,200`、日收入 `>= 7,500`、稳定度 `>= 90%` |
| `Lv.8` | 建筑 `>= 150`、人口 `>= 2,800`、日收入 `>= 10,000`、污染 `<= 25`、稳定度 `>= 98%` |

### 3.2 实时成就与系统状态（[DashboardFooter.vue](../src/components/DashboardFooter.vue)）

- **5 项实时成就**：`第一座工厂`、`工业大亨`（日入 `5,000`）、`繁荣都会`（人口 `2,500`）、`绿色生态城`（`>= 80` 建筑且污染 `<= 0`、稳定度 `>= 95%`）、`天际线大师`（`>= 40` 座 Lv.3 建筑）。
- **4 项实时系统状态**：电网、交通、安全、环境均绑定 Pinia 真实指标实时变化。

---

## 4. 本地运行与命令行验证

```bash
# 1. Node 无头实时 AI 托管推演（默认 160 天，输出等级/成就解锁与 ASCII 城市图）
node scripts/agent-play.mjs

# 2. 启动前端开发服务器（默认中文、无遮挡界面）
pnpm dev

# 3. 浏览器观看持续实时 AI 托管（也可在页面右上角点击 "🤖 AI 托管"）
# http://localhost:5173/?showcase=1
```
