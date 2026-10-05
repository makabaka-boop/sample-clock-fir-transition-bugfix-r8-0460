// FIR 系数组线性过渡（页面 Worklet 与 Node 对拍测试共用，无环境依赖）。
//
// 规则：
// - duration == 0：立即换组，计算目标样本前一次性整体替换。
// - duration == N（>=1）：自目标样本起，本轮样本时钟相对起点计数
//   q = sample - start + 1 ∈ [1, N]，权重 w = q/N；
//   每个抽头都按 b_eff[k] = (1-w)·b_from[k] + w·b_to[k] 混合，
//   长度差异按零补齐（两侧滤波器共用引擎里同一份真实输入历史）。
// - 过渡严格在本轮样本时钟上推进，与渲染分块无关：任何块长序列都得到同一波形。
// - 重叠过渡：新命令在计算目标样本之前起步，起点是“上一已生成样本的有效系数”，
//   即当前已混合出的完整系数组，而不是任何已被取代的旧命令。
// - 重置由引擎构造一个全新 KernelTransition 完成，过渡状态不残留。

export class KernelTransition {
  constructor() {
    // 上一已生成样本使用的有效系数组（无命令时为空组 => 输出 0）。
    this.current = new Float64Array(0);
    this.ramp = null; // { from:Float64Array, to:Float64Array, start, duration }
  }

  // 在计算样本 start 之前调用：调度一条换组（duration 为 0 立即生效）。
  schedule(target, start, duration) {
    const to = Float64Array.from(target);
    if (!duration) {
      this.current = to;
      this.ramp = null;
      return;
    }
    // 重叠过渡承接上一已生成样本的有效状态（含上一条 ramp 已混合出的系数）。
    this.ramp = {
      from: Float64Array.from(this.current),
      to,
      start,
      duration,
    };
  }

  // 返回计算样本 sample 时使用的完整有效系数组（须在 schedule 之后调用）。
  advance(sample) {
    const r = this.ramp;
    if (!r) return this.current;

    // 本轮样本时钟：目标样本权重 1/N，第 N 个样本权重 1（过渡恰为 N 个样本）。
    const q = sample - r.start + 1;
    const w = Math.min(1, q / r.duration);
    const L = Math.max(r.from.length, r.to.length);
    const out = new Float64Array(L); // 长度差异按零补齐
    for (let k = 0; k < L; k++) {
      const a = k < r.from.length ? r.from[k] : 0;
      const b = k < r.to.length ? r.to[k] : 0;
      out[k] = a + (b - a) * w;
    }
    this.current = out;
    if (w === 1) {
      // 过渡完成：有效组收敛为目标组（裁掉零补齐尾部）。
      this.current = r.to;
      this.ramp = null;
    }
    return this.current;
  }
}
