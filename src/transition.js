// 系数组线性过渡。
//
// 语义（与 README 约定一致）：
// - duration = 0：在目标样本计算前立即换组。
// - duration = N > 0：自目标样本起，第 k 个过渡样本（k 从 0 计）以权重
//   w = (k+1)/N 线性混合“上一已生成样本的有效系数”与目标完整系数组；
//   第 start+N-1 个样本 w=1，过渡按本轮样本时钟恰好 N 个样本完成。
// - 前后两组长度不一致时短组零补齐；两组始终卷积同一份真实输入历史
//   （引擎侧只有一条输入历史环，混合的是系数而非输入）。
// - 重叠过渡：新过渡登记时，from 承接上一已生成样本实际使用的有效系数组
//   （this.current 在每个样本计算后更新），从该有效状态重新起步。

export class KernelTransition {
  constructor() {
    this.current = new Float64Array(0); // 上一已生成样本实际使用的有效系数
    this.ramp = null; // { from, to, start, duration }
  }

  // 在计算样本 start 之前调用：立即换组，或登记一段线性过渡。
  schedule(target, start, duration) {
    const to = Float64Array.from(target); // 完整拷贝，避免外部别名
    if (!duration) {
      this.current = to;
      this.ramp = null;
      return;
    }
    this.ramp = {
      from: Float64Array.from(this.current), // 承接上一已生成样本的有效组
      to,
      start,
      duration,
    };
  }

  // 返回计算样本 sample 应使用的有效系数（无过渡时零开销直返当前组）。
  advance(sample) {
    const r = this.ramp;
    if (!r) return this.current;
    // 权重只由“样本下标 - 过渡起点”决定，与渲染块边界无关。
    const w = Math.min(1, (sample - r.start + 1) / r.duration);
    const L = Math.max(r.from.length, r.to.length); // 长度差异零补齐
    const out = new Float64Array(L);
    for (let k = 0; k < L; k++) {
      const a = k < r.from.length ? r.from[k] : 0;
      const b = k < r.to.length ? r.to[k] : 0;
      out[k] = a * (1 - w) + b * w;
    }
    this.current = out;
    if (w === 1) this.ramp = null; // 已到达目标组，过渡完成
    return out;
  }
}
