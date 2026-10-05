# AudioWorklet 因果 FIR 换参实验页

对一条**确定性单声道测试信号**执行真实 **AudioWorklet** 因果 FIR 滤波的本地实验页。
不使用 `ConvolverNode`、不做 FFT、不多轨、不采集麦克风；换参指令按
**运行代号 (runId) + 命令序号 (seq) + 目标样本下标 (target)** 下发，处理器在
计算该样本之前一次性换组。

## 运行

```bash
node test/serve.mjs        # 然后浏览器打开 http://127.0.0.1:8080/
```

（AudioWorklet 模块必须经 HTTP 加载，不能直接双击 `index.html`。）

## 页面能做什么

1. **开始 / 暂停 / 恢复 / 显式重置**
   - 开始与显式重置都会生成新的运行代号并清空时钟、系数组、输入历史与待生效队列。
   - 暂停 = `AudioContext.suspend()`：`process()` 不再被调用，**处理器时钟冻结、输入历史保留**；
     恢复后从同一 `clock` 与同一历史继续。
2. **编辑完整系数组**：1–128 个有限数值，逗号/换行分隔；每次指令下发整组（含零抽头）。
   内置直通、滑动平均、梳状、128 抽头 Hann 窗低通等预设。
3. **发送换参指令**：`{runId, seq, target, coeffs}`。
   - 处理器在渲染块开始前受理指令；`target < 当前时钟` 即**迟到 → 拒绝，不回写已生成样本**。
   - 同一 `target` 以更大的 `seq` 裁决；序号较小/重复 → 拒绝（`stale-seq`），胜出时回执带 `superseded`。
   - 旧代号指令 → `run-mismatch`。
4. **绘制与下载只使用处理器回传数据**：
   - 每个渲染量子（128 样本）处理器把**实际输出块**经 `postMessage` Transferable 回传，
     页面只画这些块；下载的 32-bit float 单声道 WAV 逐样本就是回传块，没有另做离线卷积。
   - 图上橙色竖线为处理器上报的**实际生效位置**（`applied.at`）。
   - 另可下载裁决/生效日志 JSONL。

## 关键语义

| 规则 | 实现位置 |
| --- | --- |
| 时钟只随处理器**实际处理样本数**增长（无页面计时器调度） | `src/fir-engine.js` `processBlock()` |
| 换组发生在计算样本 `t` **之前**，一份输出不混用两组系数 | `FirEngine.processBlock()` 循环顶部 |
| 跨渲染块保留输入历史（128 槽环形缓冲，因果零初始历史） | `FirEngine` 构造 / `processBlock` |
| 迟到指令明确拒绝，不回写 | `FirEngine.ingest()` 的 `target < clock` |
| 同下标按序号裁决 | `FirEngine.ingest()` 的 `stale-seq` 分支 |
| 暂停/恢复保持时钟与历史；显式重置才换代号清空 | `fir-processor.js` + `AudioContext.suspend/resume` |
| 旧代号指令不影响新一轮 | `runId !== this.runId` → `run-mismatch` |

## 测试

```bash
npm test          # 核心对拍（node --test，无需浏览器）
npm run e2e       # 真实 Chromium + AudioWorklet 端到端（Playwright）
```

- **核心对拍** `test/fir-core.test.js`：以逐样本参考卷积为基准，用块长
  1 / 7 / 127 / 128 / 129 / 256 / 300 / 333 / 400 及不规则块序列喂同一引擎，覆盖
  静态系数、**块内换参**（含相邻样本连换）、**系数长度 1↔128 突变**、
  **迟到拒绝且不回写**、**同下标序号裁决**、**暂停/恢复等价连续运行**、
  **显式重置后旧代号失效**、系数组校验。
- **真实浏览器流程** `test/browser-e2e.mjs`：启动真实 AudioWorklet 图（静音 GainNode
  挂到 destination 拉动渲染），验证：
  - `started / ack / applied / block` 消息链路；每块长度 128、连续无缺口；
  - seq 裁决、late / run-mismatch 回执及 `ack.at` 时钟；
  - **真实 worklet 输出与逐样本参考卷积逐样本一致（maxErr = 0）**，换组边界不混用两组；
  - suspend 后时钟冻结、resume 后在预定下标生效且直通段等于确定性信号；
  - 下载 WAV 与静止时回传数据严格一致；
  - 重置后新代号块从样本 0 计数，旧代号指令被拒；
  - 源码约束自检（无 ConvolverNode / FFT / Analyser / 麦克风 / 处理器侧计时器）。

## 文件

- `src/fir-engine.js` — 与环境无关的因果 FIR 引擎（页面 Worklet 与 Node 测试共用）。
- `src/fir-processor.js` — `AudioWorkletProcessor`：确定性信号生成 + 引擎驱动 + 消息协议。
- `index.html` / `page.js` / `style.css` — 实验页。
- `test/fir-core.test.js` — 核心对拍；`test/browser-e2e.mjs` — 浏览器 E2E；
  `test/serve.mjs` — 本地静态服务。


新增 FIR 系数线性过渡：set 消息的 duration 为 0～4096 整数，缺省 0 沿用立即换组。非零 N 在目标样本起使用 (k+1)/N 的权重混合前后完整系数组；长度差异按零补齐，两个滤波器都使用同一份真实输入历史。重叠过渡从上一已生成样本的有效系数重新起步。同目标高序号命令必须整体替换系数及 duration；应用事件带 duration。暂停不推进样本，reset 清除过渡。
