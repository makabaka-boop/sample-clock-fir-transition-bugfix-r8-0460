// 页面逻辑：所有绘制/下载的数据均来自处理器回传的 block 消息（实际输出块），
// 绝不在页面端重算/离线卷积冒充结果。无任何页面计时器参与调度，
// 重绘仅由处理器回传消息驱动（暂停时无消息，画面自然静止，时钟冻结）。

import { isValidCoeffGroup, MAX_TAPS } from "./src/fir-engine.js";

const $ = (id) => document.getElementById(id);

const runs = new Map(); // runId -> { blocks: Map(from -> {from,data}), length, acks, applied, fs }
let currentRunId = null;
let ctx = null;
let node = null;

// ---------- 系数编辑 ----------
function parseCoeffs() {
  const parts = $("coeffs")
    .value.split(/[\s,]+/)
    .filter((s) => s.length > 0);
  const arr = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) arr[i] = Number(parts[i]);
  return arr;
}
function refreshCoeffInfo() {
  const arr = parseCoeffs();
  const ok = isValidCoeffGroup(arr);
  $("coeffInfo").textContent = ok
    ? `将发送完整 ${arr.length} 个系数（含前导/尾随 0，逐字下发）`
    : `非法：需要 1–${MAX_TAPS} 个有限数值，当前 ${arr.length} 个（${arr.some((v) => !Number.isFinite(v)) ? "含非数值" : "数量越界"}）`;
  $("coeffInfo").style.color = ok ? "var(--ok)" : "var(--bad)";
}
$("coeffs").addEventListener("input", refreshCoeffInfo);

function preset(coeffs) {
  $("coeffs").value = coeffs.join(", ");
  refreshCoeffInfo();
}
$("btnPresetIdentity").onclick = () => preset([1]);
$("btnPresetAvg").onclick = () => preset(new Array(8).fill(1 / 8));
$("btnPresetComb").onclick = () => {
  const c = new Array(16).fill(0);
  c[0] = 0.7;
  c[15] = 0.3;
  preset(c);
};
$("btnPresetLong").onclick = () => {
  // 128 抽头 Hann 窗低通（覆盖“长度变化到上限”）
  const c = new Array(128);
  for (let i = 0; i < 128; i++)
    c[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 127);
  const s = c.reduce((a, b) => a + b, 0);
  preset(c.map((v) => v / s));
};
$("btnPresetShort").onclick = () => preset([0.3, 0.4, 0.3]);
refreshCoeffInfo();

// ---------- AudioContext / Worklet ----------
async function ensureContext() {
  if (ctx) return;
  ctx = new AudioContext({ sinkId: { type: "none" } });
  await ctx.audioWorklet.addModule("./src/fir-processor.js");
  node = new AudioWorkletNode(ctx, "fir-processor", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  // 静音增益挂到 destination：真实拉动渲染图，但不向扬声器发声。
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);
  node.port.onmessage = (e) => onProcessorMessage(e.data);
  $("sampleRate").textContent = ctx.sampleRate;
  $("quantum").textContent = "128（每次回传 length 即本轮实际处理样本数）";
  ctx.addEventListener("statechange", renderState);
}

function newRunId() {
  if (window.crypto && crypto.randomUUID)
    return "run-" + crypto.randomUUID().slice(0, 8);
  return (
    "run-" +
    Math.floor(performance.now() * 1000).toString(36) +
    "-" +
    Math.floor(Math.random() * 1e6).toString(36)
  );
}

function ensureRun(runId, fs) {
  let r = runs.get(runId);
  if (!r) {
    r = { blocks: new Map(), length: 0, acks: [], applied: [], fs };
    runs.set(runId, r);
    const opt = document.createElement("option");
    opt.value = runId;
    opt.textContent = runId;
    $("runSelect").appendChild(opt);
  }
  return r;
}

$("btnStart").onclick = async () => {
  await ensureContext();
  if (ctx.state === "suspended") await ctx.resume();
  const runId = newRunId();
  node.port.postMessage({ kind: "start", runId });
  setButtonsRunning(true);
};

$("btnSuspend").onclick = async () => {
  await ctx.suspend(); // process() 停止被调用：时钟冻结、历史保留
  renderState();
};
$("btnResume").onclick = async () => {
  await ctx.resume(); // 从同一 clock、同一输入历史继续
  renderState();
};
$("btnReset").onclick = () => {
  // 显式重置：处理器换代号并清空；旧 run 的捕获仍保留可查看，但旧指令不再生效。
  const runId = newRunId();
  node.port.postMessage({ kind: "reset", runId });
  $("seq").value = 1;
};

$("btnTargetNow").onclick = () => {
  const r = currentRunId && runs.get(currentRunId);
  $("target").value = r ? r.length : 0;
};

$("btnSend").onclick = () => {
  if (!node || !currentRunId) return;
  const coeffs = parseCoeffs();
  if (!isValidCoeffGroup(coeffs)) return;
  const seq = Number($("seq").value);
  const target = Number($("target").value);
  const duration = Number($("transitionSamples").value);
  // 与处理器同一约束：0..4096 整数（0 = 立即换组，1 = 单样本过渡）。
  if (!Number.isInteger(duration) || duration < 0 || duration > 4096) return;
  node.port.postMessage({
    kind: "set",
    runId: currentRunId,
    seq,
    target,
    duration,
    coeffs: Float32Array.from(coeffs), // 完整系数组
  });
  $("seq").value = String(seq + 1); // 同一下标再发须用更大序号
};

$("runSelect").onchange = () => {
  currentRunId = $("runSelect").value;
  redraw();
};

// ---------- 处理器回传 ----------
function onProcessorMessage(msg) {
  if (msg.kind === "started" || msg.kind === "reset-done") {
    currentRunId = msg.runId;
    ensureRun(msg.runId, ctx ? ctx.sampleRate : 48000);
    $("runId").textContent = msg.runId;
    $("runSelect").value = msg.runId;
    $("btnReset").disabled = false;
    $("btnSend").disabled = false;
    logLine(
      msg.kind === "started" ? "applied" : "acks",
      `${msg.kind}: 新代号 ${msg.runId}，时钟与输入历史已清空`,
      "warn",
    );
    return;
  }

  if (msg.kind === "ack") {
    const r = ensureRun(msg.runId, ctx ? ctx.sampleRate : 48000);
    r.acks.push(msg);
    const tag = msg.accepted ? "ACCEPT" : `REJECT:${msg.reason}`;
    const cls = msg.accepted ? "ok" : "bad";
    logLine(
      "acks",
      `[${msg.runId}] seq=${msg.seq} target=${msg.target} duration=${msg.duration ?? 0} 处理器时钟=${msg.at} => ${tag}` +
        (msg.superseded != null ? `（取代 seq=${msg.superseded}，系数与时长整体替换）` : ""),
      cls,
    );
    return;
  }

  if (msg.kind === "block") {
    const r = ensureRun(msg.runId, ctx ? ctx.sampleRate : 48000);
    const data = msg.output; // Transferable，已是主线程拥有的实际输出
    if (!r.blocks.has(msg.from)) {
      r.blocks.set(msg.from, { from: msg.from, data });
      r.length = Math.max(r.length, msg.from + data.length);
    }
    for (const ev of msg.applied || []) {
      r.applied.push(ev);
      logLine(
        "applied",
        ev.duration
          ? `[${msg.runId}] seq=${ev.seq} 在样本 ${ev.at} 计算前起步 ${ev.duration} 样本线性过渡（按本轮样本时钟）`
          : `[${msg.runId}] seq=${ev.seq} 在样本 ${ev.at} 计算前立即换组`,
        "ok",
      );
    }
    if (msg.runId === currentRunId) {
      $("clock").textContent = r.length;
      $("blockCount").textContent = r.blocks.size;
      schedulePlot();
    }
    return;
  }
}

function logLine(boxId, text, cls) {
  const box = $(boxId);
  const d = document.createElement("div");
  d.className = "line " + (cls || "");
  d.textContent = text;
  box.appendChild(d);
  if (box.childNodes.length > 200) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function renderState() {
  const state = ctx ? ctx.state : null;
  $("ctxState").textContent = "context: " + (state || "—");
  if (state) {
    $("btnSuspend").disabled = state !== "running";
    $("btnResume").disabled = state !== "suspended";
  }
}
function setButtonsRunning(running) {
  $("btnStart").disabled = running;
  renderState();
}

// ---------- 绘制（只画处理器回传数据） ----------
const canvas = $("plot");
const g = canvas.getContext("2d");
let plotDirty = false;
function schedulePlot() {
  if (plotDirty) return;
  plotDirty = true;
  // 由浏览器在一帧内合并重绘（非音频调度时钟；暂停时没有新块消息，自然静止）。
  requestAnimationFrame(() => {
    plotDirty = false;
    redraw();
  });
}

function contiguousOutput(run) {
  // 按 from 排序拼接实际块；缺口（理论上不存在）补零以便绘图。
  const out = new Float32Array(run.length);
  const keys = [...run.blocks.keys()].sort((a, b) => a - b);
  for (const from of keys) {
    const { data } = run.blocks.get(from);
    out.set(data, from);
  }
  return { out, keys };
}

function redraw() {
  const runId = $("runSelect").value || currentRunId;
  const run = runId && runs.get(runId);
  const W = canvas.width,
    H = canvas.height;
  g.fillStyle = "#0b0f14";
  g.fillRect(0, 0, W, H);
  g.strokeStyle = "#1b2733";
  g.lineWidth = 1;
  for (let y = 0; y <= 4; y++) {
    const yy = (H * y) / 4;
    g.beginPath();
    g.moveTo(0, yy);
    g.lineTo(W, yy);
    g.stroke();
  }
  if (!run || run.length === 0) {
    g.fillStyle = "#5a6f82";
    g.font = "14px monospace";
    g.fillText("等待处理器回传实际输出块…", 16, 24);
    $("captureInfo").textContent = "";
    $("btnDownloadWav").disabled = true;
    $("btnDownloadLog").disabled = true;
    return;
  }

  const { out } = contiguousOutput(run);
  // 绘图只取最近一段（下载仍用全量），保证长跑后每帧开销恒定。
  const PLOT_WINDOW = 200000;
  const off0 = Math.max(0, out.length - PLOT_WINDOW);
  const view = out.subarray(off0);
  const N = view.length;
  const mid = H / 2;
  const amp = (H / 2) * 0.9;
  const yOf = (v) => mid - v * amp;

  // 桶 min/max 降采样
  const buckets = W;
  const per = Math.max(1, N / buckets);
  g.strokeStyle = "#4fc3f7";
  g.lineWidth = 1;
  g.beginPath();
  let started = false;
  for (let bx = 0; bx < buckets; bx++) {
    const s = Math.floor(bx * per);
    const e = Math.min(N, Math.floor((bx + 1) * per));
    let mn = Infinity,
      mx = -Infinity;
    for (let i = s; i < e; i++) {
      const v = view[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (mn === Infinity) continue;
    const x = bx + 0.5;
    if (!started) {
      g.moveTo(x, yOf(mn));
      started = true;
    }
    g.lineTo(x, yOf(mx));
    g.lineTo(x, yOf(mn));
  }
  g.stroke();

  // 换组生效位置竖线（实际生效位置来自处理器 applied 事件，只画窗口内的）
  // duration>0 的过渡区间用橙色半透明横带标出（起止样本同样来自处理器事件）。
  for (const ev of run.applied) {
    if (ev.duration) {
      const x1 = ((ev.at - off0) / N) * W;
      const x2 = ((ev.at + ev.duration - off0) / N) * W;
      g.fillStyle = "rgba(255,183,77,0.12)";
      g.fillRect(Math.max(0, x1), 0, Math.min(W, x2) - Math.max(0, x1), H);
    }
    if (ev.at < off0) continue;
    const x = ((ev.at - off0) / N) * W;
    g.strokeStyle = "rgba(255,183,77,0.8)";
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, H);
    g.stroke();
    g.fillStyle = "#ffb74d";
    g.font = "11px monospace";
    g.fillText(
      "seq" + ev.seq + "@" + ev.at + (ev.duration ? " N=" + ev.duration : ""),
      Math.min(x + 2, W - 110),
      12,
    );
  }

  g.fillStyle = "#9fb6c9";
  g.font = "13px monospace";
  g.fillText(
    `${runId}  窗口 [${off0}, ${out.length})  实际捕获共 ${out.length} 样本 / ${run.blocks.size} 块 @ ${run.fs} Hz`,
    12,
    H - 10,
  );

  $("captureInfo").textContent =
    `共 ${out.length} 样本 / ${run.acks.length} ack / ${run.applied.length} 次实际换组`;
  $("btnDownloadWav").disabled = false;
  $("btnDownloadLog").disabled = false;
}

// ---------- 下载 ----------
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function writeFloatWav(samples, fs) {
  const n = samples.length;
  const bytes = 44 + n * 4;
  const buf = new ArrayBuffer(bytes);
  const dv = new DataView(buf);
  const wstr = (o, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  dv.setUint32(4, bytes - 8, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 3, true); // IEEE float
  dv.setUint16(22, 1, true); // 单声道
  dv.setUint32(24, fs, true);
  dv.setUint32(28, fs * 4, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 32, true);
  wstr(36, "data");
  dv.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) dv.setFloat32(44 + i * 4, samples[i], true);
  return new Blob([buf], { type: "audio/wav" });
}

$("btnDownloadWav").onclick = () => {
  const run = runs.get($("runSelect").value);
  if (!run) return;
  const { out } = contiguousOutput(run);
  download(
    writeFloatWav(out, run.fs),
    `${$("runSelect").value}-captured-float32.wav`,
  );
};

$("btnDownloadLog").onclick = () => {
  const run = runs.get($("runSelect").value);
  if (!run) return;
  const lines = [];
  for (const a of run.acks) lines.push(JSON.stringify({ kind: "ack", ...a }));
  for (const a of run.applied)
    lines.push(JSON.stringify({ kind: "applied", ...a }));
  download(
    new Blob([lines.join("\n")], { type: "application/x-ndjson" }),
    `${$("runSelect").value}-log.jsonl`,
  );
};

// 测试钩子（浏览器 E2E 用）：直接发消息 / 读取真实捕获状态。
window.__fir = {
  post: (m) => node && node.port.postMessage(m),
  suspend: () => ctx && ctx.suspend(),
  resume: () => ctx && ctx.resume(),
  runs: () => runs,
  currentRunId: () => currentRunId,
  ctxState: () => (ctx ? ctx.state : null),
  listRuns: () => [...runs.keys()],
  allAcks: () => {
    const out = [];
    for (const r of runs.values()) for (const a of r.acks) out.push({ ...a });
    return out;
  },
  status: (runId) => {
    const id = runId || currentRunId;
    const r = runs.get(id);
    if (!r) return null;
    return {
      runId: id,
      fs: r.fs,
      length: r.length,
      blockCount: r.blocks.size,
      ackCount: r.acks.length,
      applied: r.applied.map((a) => ({ ...a })),
      acks: r.acks.map((a) => ({ ...a })),
    };
  },
  snapshot: (runId) => {
    const id = runId || currentRunId;
    const r = runs.get(id);
    if (!r) return null;
    return {
      runId: id,
      fs: r.fs,
      length: r.length,
      acks: r.acks.map((a) => ({ ...a })),
      applied: r.applied.map((a) => ({ ...a })),
      blocks: [...r.blocks.values()]
        .sort((a, b) => a.from - b.from)
        .map((b) => ({ from: b.from, data: Array.from(b.data) })),
    };
  },
};
