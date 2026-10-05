export class KernelTransition {
  constructor() {
    this.current = new Float64Array(0);
    this.ramp = null;
  }
  schedule(target, start, duration) {
    if (!duration) {
      this.current = Float64Array.from(target);
      this.ramp = null;
      return;
    }
    this.ramp = {
      from: this.current[0] ?? 0,
      to: Float64Array.from(target),
      start,
      duration,
    };
  }
  advance(sample) {
    if (!this.ramp) return this.current;
    const r = this.ramp,
      weight = Math.min(1, ((sample % 128) + 1) / r.duration);
    const out = Float64Array.from(r.to);
    out[0] = r.from * (1 - weight) + r.to[0] * weight;
    this.current = out;
    if (weight === 1) this.ramp = null;
    return out;
  }
}
