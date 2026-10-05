import { KernelTransition } from "./transition.js";
// 因果 FIR 核心引擎（页面 Worklet 与 Node 对拍测试共用）。
//
// 约束：
// - 单声道 Float32；直接型（卷积定义）实现，无 FFT、无 ConvolverNode。
// - 系数最多 MAX_TAPS 个；每次换参下发完整系数组。
// - 时钟 clock 只随 processBlock() 实际处理的样本数增长，不存在任何计时器。
// - 渲染块之间受理指令；目标样本 < 本块起点即“迟到”，明确拒绝，不回写。
// - 同一目标下标按命令序号 seq 裁决（高者胜），裁决同时整体替换系数与过渡时长。
// - 换组在“计算该样本之前”一次性完成；duration>0 时自该样本起按本轮样本时钟
//   做 N 样本线性过渡，过渡推进只取决于实际处理的样本数（与分块方式无关）。
// - 重叠过渡承接上一已生成样本的有效系数；重置（新 KernelTransition）清除过渡。

export const MAX_TAPS = 128;

export function isValidCoeffGroup(coeffs) {
  if (!coeffs || typeof coeffs.length !== "number") return false;
  const n = coeffs.length;
  if (n < 1 || n > MAX_TAPS) return false;
  for (let i = 0; i < n; i++) {
    const v = coeffs[i];
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  return true;
}

export class FirEngine {
  constructor() {
    this.reset(null);
  }

  // 显式重置：开始新代号，清空时钟、当前系数组与全部输入历史。
  reset(runId) {
    this.runId = runId;
    this._transition = new KernelTransition();
    this.clock = 0; // 本轮已处理样本数 = 下一样本的绝对下标
    this.coeffs = new Float32Array(0); // 当前生效组（空组 => 输出全 0）
    this._hist = new Float32Array(MAX_TAPS); // 环形输入历史，容量恰好 MAX_TAPS
    this._hpos = 0; // 最新样本所在槽
    this._pending = new Map(); // target -> { seq, coeffs }
    this.events = []; // processBlock 产生的 applied 事件
  }

  get pendingCount() {
    return this._pending.size;
  }

  // 在一个渲染块开始前受理一条换参指令。
  // 返回裁决：{ accepted, reason, at, superseded }
  ingest(runId, seq, target, coeffs, duration = 0) {
    const at = this.clock;
    if (runId !== this.runId) {
      return { accepted: false, reason: "run-mismatch", at, superseded: null };
    }
    if (!Number.isInteger(target) || target < this.clock) {
      // 目标已经在已生成的样本里：拒绝，不回写任何样本。
      return { accepted: false, reason: "late", at, superseded: null };
    }
    if (!Number.isInteger(seq) || seq < 0) {
      return { accepted: false, reason: "bad-seq", at, superseded: null };
    }
    if (!isValidCoeffGroup(coeffs)) {
      return { accepted: false, reason: "bad-coeffs", at, superseded: null };
    }
    if (!Number.isInteger(duration) || duration < 0 || duration > 4096) {
      return { accepted: false, reason: "bad-duration", at, superseded: null };
    }
    const group = Float32Array.from(coeffs); // 完整拷贝，避免外部别名
    const old = this._pending.get(target);
    if (old) {
      if (seq <= old.seq) {
        // 同一下标：序号不占优（重复或更低），拒绝。
        return { accepted: false, reason: "stale-seq", at, superseded: null };
      }
      const oldSeq = old.seq;
      // 同目标裁决同时约束系数与过渡时长：整体替换为新命令。
      this._pending.set(target, { seq, coeffs: group, duration });
      return { accepted: true, reason: null, at, superseded: oldSeq };
    }
    this._pending.set(target, { seq, coeffs: group, duration });
    return { accepted: true, reason: null, at, superseded: null };
  }

  // 处理一块真实输入。块长任意（Worklet 中为渲染量子长度，测试中可变）。
  // 返回新分配的 Float32Array（Worklet 端可零拷贝转移给主线程）。
  processBlock(input) {
    this.events = [];
    const n = input.length;
    const out = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const t = this.clock + i;

      // 计算样本 t 之前：若该下标有待生效指令，一次性换成该组。
      const cmd = this._pending.get(t);
      if (cmd) {
        this._transition.schedule(cmd.coeffs, t, cmd.duration);
        this._pending.delete(t);
        this.events.push({
          type: "applied",
          runId: this.runId,
          seq: cmd.seq,
          duration: cmd.duration,
          target: t,
          at: t, // 实际生效位置
        });
      }

      // 新输入入环（先移位再写入，未写入的槽保持 0，即因果零初始历史）。
      const p = (this._hpos + 1) % MAX_TAPS;
      this._hpos = p;
      this._hist[p] = input[i];

      // 直接型因果卷积：y[t] = Σ_{k=0..L-1} b[k]·x[t-k]
      const b = this._transition.advance(t);
      this.coeffs = b;
      const L = b.length;
      let acc = 0;
      for (let k = 0; k < L; k++) {
        acc += b[k] * this._hist[(p - k + MAX_TAPS) % MAX_TAPS];
      }
      out[i] = acc;
    }

    this.clock += n; // 时钟仅由实际处理样本数推进
    return out;
  }
}
