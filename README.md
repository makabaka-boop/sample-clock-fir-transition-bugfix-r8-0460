# AudioWorklet 因果 FIR 换参实验页

对一条**确定性单声道测试信号**执行真实 **AudioWorklet** 因果 FIR 滤波的本地实验页。
不使用 `ConvolverNode`、不做 FFT、不多轨、不采集麦克风；换参指令按
**运行代号 (runId) + 命令序号 (seq) + 目标样本下标 (target) + 过渡样本数 (duration)** 下发，
处理器在计算该样本之前换组（duration=0 立即整体换组，duration>0 自该样本起 N 样本线性过渡）。

## 运行

```bash
node test/serve.mjs        # 然后浏览器打开 http://127.0.0.1:8080/
```

（AudioWorklet 模块必须经 HTTP 加载，不能直接双击 `index.html`。）

## 页面能做什么

1. **开始 / 暂停 / 恢复 / 显式重置**
   - 开始与显式重置都会生成新的运行代号并清空时钟、系数组、输入历史、**过渡状态**与待生效队列。
   - 暂停 = `AudioContext.suspend()`：`process()` 不再被调用，**处理器时钟冻结、输入历史与过渡进度保留**；
     恢复后从同一 `clock`、同一历史与同一过渡进度继续。
2. **编辑完整系数组**：1–128 个有限数值，逗号/换行分隔；每次指令下发整组（含零抽头）。
   内置直通、滑动平均、梳状、128 抽头 Hann 窗低通等预设。
3. **发送换参指令**：`{runId, seq, target, coeffs, duration}`。
   - `duration` 为 0～4096 的整数，缺省 0 = 在目标样本计算前立即整体换组（`1` = 单样本过渡）。
   - `duration = N > 0`：自目标样本起 **N 样本线性过渡**，第 q 个样本（q=1..N）
     每个抽头都取 `(1-q/N)·b_from[k] + (q/N)·b_to[k]`；前后是两个**完整滤波组**，
     长度差异按零补齐，两组对**同一份真实输入历史**卷积后线性混合。
   - 权重只按本轮样本时钟 `q = sample - target + 1` 推进，与渲染分块无关：
     同一输入换任何分块方式都得到同一波形；过渡恰占 N 个样本。
   - 过渡完成前再次下发（不同目标的）新命令时，新过渡从上一已生成样本的**有效系数**
     （当时已混合出的整组）重新起步，不会回退到任何已被取代的旧命令。
   - 处理器在渲染块开始前受理指令；`target < 当前时钟` 即**迟到 → 拒绝，不回写已生成样本**。
   - 同一 `target` 以更大的 `seq` 裁决，裁决**同时整体替换系数与过渡时长**；
     序号较小/重复（即便 duration 不同）→ 拒绝（`stale-seq`），胜出回执带 `superseded`。
   - 旧代号指令 → `run-mismatch`；非法 duration → `bad-duration`。
4. **绘制与下载只使用处理器回传数据**：
   - 每个渲染量子（128 样本）处理器把**实际输出块**经 `postMessage` Transferable 回传，
     页面只画这些块；下载的 32-bit float 单声道 WAV 逐样本就是回传块，没有另做离线卷积。
   - 图上橙色竖线为处理器上报的**实际生效位置**（`applied.at`），
     橙色横带标出 `applied.duration` 对应的实际过渡区间；标签带 `N=` 时长。
   - 另可下载裁决/生效日志 JSONL（ack 与 applied 均带 duration）。

## 关键语义

| 规则 | 实现位置 |
| --- | --- |
| 时钟只随处理器**实际处理样本数**增长（无页面计时器调度） | `src/fir-engine.js` `processBlock()` |
| 换组发生在计算样本 `t` **之前**；duration=0 一份输出不混用两组 | `FirEngine.processBlock()` 循环顶部 |
| duration=N 线性过渡按**本轮样本时钟** q=t-target+1 取权重，分块无关 | `src/transition.js` `advance()` |
| 过渡逐抽头混合两个完整组，长度差零补齐，共用同一份环形输入历史 | `KernelTransition` + `processBlock` 卷积 |
| 重叠过渡承接**上一已生成样本的有效系数**（不回退到被取代命令） | `KernelTransition.schedule()` |
| 跨渲染块保留输入历史（128 槽环形缓冲，因果零初始历史） | `FirEngine` 构造 / `processBlock` |
| 迟到指令明确拒绝，不回写 | `FirEngine.ingest()` 的 `target < clock` |
| 同下标按序号裁决，**系数与 duration 整体替换** | `FirEngine.ingest()` 的 `stale-seq`/superseded 分支 |
| duration 校验（0..4096 整数） | `FirEngine.ingest()` 的 `bad-duration` |
| 暂停/恢复保持时钟、历史与过渡进度；显式重置才换代号清空 | `fir-processor.js` + `AudioContext.suspend/resume` |
| 旧代号指令不影响新一轮 | `runId !== this.runId` → `run-mismatch` |

## 测试

```bash
npm test          # 核心对拍（node --test，无需浏览器）
npm run e2e       # 真实 Chromium + AudioWorklet 端到端（Playwright）
```

- **核心对拍** `test/fir-core.test.js`：以支持过渡的逐样本参考模型为基准，用块长
  1 / 7 / 127 / 128 / 129 / 256 / 300 / 333 / 400 及不规则块序列喂同一引擎，覆盖
  静态系数、**块内换参**（含相邻样本连换）、**系数长度 1↔128 突变**、
  **迟到拒绝且不回写**、**同下标序号裁决**、**暂停/恢复等价连续运行**、
  **显式重置后旧代号失效**、系数组校验，以及线性过渡：
  **按本轮样本时钟混合全部抽头且与分块方式无关**（含单样本过渡）、
  **权重 1/N…1 逐抽头直接核验**、**长度差零补齐**、
  **重叠过渡承接上一已生成样本有效系数**、
  **同目标高序号整体替换系数与时长（实际时长属于新命令）**、
  **暂停跨过过渡保持进度/历史**、**重置清除过渡**、duration 0..4096 边界。
- **真实浏览器流程** `test/browser-e2e.mjs`：启动真实 AudioWorklet 图（静音 GainNode
  挂到 destination 拉动渲染），验证：
  - `started / ack / applied / block` 消息链路；每块长度 128、连续无缺口；
  - seq 裁决（含不同 duration）、late / run-mismatch / bad-duration 回执及 `ack.at` 时钟；
  - **真实 worklet 输出与逐样本参考模型逐样本一致（maxErr = 0）**：覆盖立即换组、
    800/300/128 样本过渡、128 抽头长度突变、**过渡中段重叠再换组**、单样本过渡；
  - 同目标高序号命令的**实际过渡时长属于新命令**（applied.duration 与输出双重证据）；
  - suspend 后时钟冻结（含过渡中暂停）、resume 后过渡继续收敛、直通段等于确定性信号；
  - 下载 WAV 与静止时回传数据严格一致；
  - 重置后新代号块从样本 0 计数，旧代号指令被拒；
  - 源码约束自检（无 ConvolverNode / FFT / Analyser / 麦克风 / 处理器侧计时器）。

## 文件

- `src/fir-engine.js` — 与环境无关的因果 FIR 引擎（页面 Worklet 与 Node 测试共用）。
- `src/transition.js` — 与环境无关的线性过渡状态机（本轮样本时钟、零补齐、重叠承接）。
- `src/fir-processor.js` — `AudioWorkletProcessor`：确定性信号生成 + 引擎驱动 + 消息协议。
- `index.html` / `page.js` / `style.css` — 实验页。
- `test/fir-core.test.js` — 核心对拍；`test/browser-e2e.mjs` — 浏览器 E2E；
  `test/serve.mjs` — 本地静态服务。
