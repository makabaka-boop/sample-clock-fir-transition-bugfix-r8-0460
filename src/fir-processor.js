// 实时 AudioWorklet 处理器：把 fir-engine 接到 Web Audio 渲染线程。
// 不用 ConvolverNode、不做 FFT；输出 = 对确定性单声道测试信号做因果 FIR。
// 测试信号在处理器内按“绝对样本下标”即时生成（单声道）。
//
// 消息（主线程 -> 处理器）：
//   { kind: 'start', runId }                      开始新代号（清空时钟/历史/待生效队列）
//   { kind: 'set', runId, seq, target, coeffs, duration? } 换参指令（完整系数组，<=128；
//                                                          duration 0~4096，缺省 0 = 立即换组）
//   { kind: 'reset', runId }                      显式重置 -> 新代号并清空
//
// 回传（处理器 -> 主线程）：
//   { kind: 'started' | 'reset-done', runId }
//   { kind: 'ack', ...指令字段, accepted, reason, at, superseded }
//   { kind: 'block', runId, from, length, output(Transferable), applied:[...] }
//
// AudioContext.suspend() 时 process() 不会被调用：时钟（实际处理样本数）冻结，
// 输入历史保留；resume() 后从同一 clock、同一历史继续。

import { FirEngine } from "./fir-engine.js";

class FirProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = new FirEngine();
    this.runCounter = 0;
    this.port.onmessage = (e) => this._handle(e.data);
  }

  _fallbackRunId() {
    this.runCounter += 1;
    return (
      "run-" +
      (typeof currentFrame === "number" ? currentFrame : 0) +
      "-" +
      this.runCounter
    );
  }

  _handle(msg) {
    if (!msg || typeof msg !== "object") return;
    const eng = this.engine;

    if (msg.kind === "start" || msg.kind === "reset") {
      // 显式开始/重置：新代号 + 清空时钟、系数组、输入历史、待生效队列。
      const runId =
        typeof msg.runId === "string" && msg.runId
          ? msg.runId
          : this._fallbackRunId();
      eng.reset(runId);
      this.port.postMessage({
        kind: msg.kind === "start" ? "started" : "reset-done",
        runId,
      });
      return;
    }

    if (msg.kind === "set") {
      const verdict = eng.ingest(
        msg.runId,
        msg.seq,
        msg.target,
        msg.coeffs,
        msg.duration ?? 0,
      );
      this.port.postMessage({
        kind: "ack",
        runId: msg.runId,
        seq: msg.seq,
        target: msg.target,
        duration: msg.duration ?? 0, // 回显过渡样本数：裁决同时约束系数与时长
        accepted: verdict.accepted,
        reason: verdict.reason,
        at: verdict.at, // 处理器收到指令时本轮时钟（已实际处理样本数）
        superseded: verdict.superseded,
      });
    }
  }

  // 确定性单声道测试信号，按绝对样本下标 t 生成；与页面端公式一致。
  static signal(t, fs) {
    const w = 2 * Math.PI;
    return (
      0.5 * Math.sin(w * 440 * (t / fs)) +
      0.3 * Math.sin(w * 1000 * (t / fs) + 0.7) +
      0.2 * (Math.sin(w * 3.1 * t) > 0 ? 1 : -1)
    );
  }

  process(_inputs, outputs) {
    const eng = this.engine;
    const outCh = outputs[0][0];
    const n = outCh.length;

    const generated = new Float32Array(n);
    for (let i = 0; i < n; i++)
      generated[i] = FirProcessor.signal(eng.clock + i, sampleRate);

    const block = eng.processBlock(generated); // 时钟按本轮实际处理样本数推进
    outCh.set(block);
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(block);

    this.port.postMessage(
      {
        kind: "block",
        runId: eng.runId,
        from: eng.clock - n,
        length: n,
        output: block, // 实际输出块转移给主线程，页面直接绘制/下载，不另做离线卷积
        applied: eng.events,
      },
      [block.buffer],
    );

    return true;
  }
}

registerProcessor("fir-processor", FirProcessor);
