// 核心处理逻辑对拍测试（node --test）：
// 以逐样本参考卷积为基准，在多种分块长度下验证 FirEngine，
// 覆盖块内换参、系数长度变化（1..128）、迟到拒绝、同下标序号裁决、重置与跨块历史。

import test from "node:test";
import assert from "node:assert/strict";
import { FirEngine, MAX_TAPS, isValidCoeffGroup } from "../src/fir-engine.js";

const FS = 48000;

// 确定性单声道测试信号（与处理器公式相同），量化为 Float32。
function makeSignal(N, fs = FS, t0 = 0) {
  const w = 2 * Math.PI;
  const out = new Float32Array(N);
  for (let t = 0; t < N; t++) {
    const tt = t0 + t;
    out[t] =
      0.5 * Math.sin(w * 440 * (tt / fs)) +
      0.3 * Math.sin(w * 1000 * (tt / fs) + 0.7) +
      0.2 * (Math.sin(w * 3.1 * tt) > 0 ? 1 : -1);
  }
  return out;
}

// 逐样本参考卷积：严格按“计算样本 t 之前换组”的因果直接型。
// segments: [{ target, coeffs, duration? }]；duration 缺省/0 为立即换组，
// duration=N>1 时自 target 起按 (q/N) 权重逐抽头线性混合（q 为本轮样本时钟 1..N），
// 长度差异按零补齐；重叠过渡承接上一已生成样本的有效系数。
function referenceConvolve(signal, segments) {
  const N = signal.length;
  const ref = new Float32Array(N);
  let current = new Float64Array(0); // 上一已生成样本的有效系数
  let ramp = null;
  const segMap = new Map(segments.map((s) => [s.target, s]));
  const coeffsAt = (t) => {
    const s = segMap.get(t);
    if (s) {
      const to = Float64Array.from(s.coeffs);
      if (!s.duration) {
        current = to;
        ramp = null;
      } else {
        ramp = {
          from: Float64Array.from(current), // 重叠过渡承接当前有效状态
          to,
          start: t,
          duration: s.duration,
        };
      }
    }
    if (ramp) {
      const q = t - ramp.start + 1; // 本轮样本时钟，与渲染分块无关
      const w = Math.min(1, q / ramp.duration);
      const L = Math.max(ramp.from.length, ramp.to.length);
      const out = new Float64Array(L);
      for (let k = 0; k < L; k++) {
        const a = k < ramp.from.length ? ramp.from[k] : 0;
        const b = k < ramp.to.length ? ramp.to[k] : 0;
        out[k] = a + (b - a) * w;
      }
      current = out;
      if (w === 1) {
        current = ramp.to;
        ramp = null;
      }
    }
    return current;
  };
  for (let t = 0; t < N; t++) {
    const coeffs = coeffsAt(t);
    let acc = 0;
    for (let k = 0; k < coeffs.length; k++) {
      acc += coeffs[k] * (t - k >= 0 ? signal[t - k] : 0);
    }
    ref[t] = acc;
  }
  return ref;
}

// 以给定块长序列把信号喂给引擎；commands: {arriveAt, runId, seq, target, coeffs}
// arriveAt 表示指令在“已处理 arriveAt 个样本后、下一块开始前”受理。
function runEngine(engine, signal, blockSizes, commands, runId) {
  const outputs = [];
  const acks = [];
  const applied = [];
  let pos = 0;
  let ci = 0;
  const sorted = [...commands].sort(
    (a, b) => a.arriveAt - b.arriveAt || a.seq - b.seq,
  );
  for (const size of blockSizes) {
    // 块开始前受理所有到达时刻 <= pos 的指令
    while (ci < sorted.length && sorted[ci].arriveAt <= pos) {
      const c = sorted[ci++];
      acks.push(engine.ingest(c.runId, c.seq, c.target, c.coeffs, c.duration ?? 0));
    }
    const block = engine.processBlock(signal.subarray(pos, pos + size));
    for (const ev of engine.events) applied.push(ev);
    outputs.push(block);
    pos += size;
  }
  while (ci < sorted.length) {
    const c = sorted[ci++];
    acks.push(engine.ingest(c.runId, c.seq, c.target, c.coeffs, c.duration ?? 0));
  }
  return {
    out: Float32Array.from(
      outputs.reduce((acc, b) => {
        const m = new Float32Array(acc.length + b.length);
        m.set(acc);
        m.set(b, acc.length);
        return m;
      }, new Float32Array(0)),
    ),
    acks,
    applied,
    finalClock: pos,
  };
}

function assertClose(a, b, eps, label) {
  assert.equal(a.length, b.length, label + ": length");
  for (let i = 0; i < a.length; i++) {
    assert.ok(
      Math.abs(a[i] - b[i]) <= eps,
      `${label}: sample ${i} got ${a[i]} ref ${b[i]}`,
    );
  }
}

test("静态系数：多种块长（1,7,128,129,300）与逐样本参考一致，且跨块历史正确", () => {
  const N = 1000;
  const sig = makeSignal(N);
  const coeffsList = [
    [1],
    [0.3, 0.4, 0.3],
    new Array(8).fill(1 / 8),
    (() => {
      const c = new Array(128);
      for (let i = 0; i < 128; i++)
        c[i] = ((0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 127)) / 128) * 2;
      return c;
    })(),
  ];
  const blockChoices = [
    [1],
    [7],
    [128],
    [129],
    [300],
    [3, 5, 128, 1, 64, 333],
    Array.from({ length: 40 }, (_, i) => ((i * 37) % 200) + 1),
  ];
  for (const coeffs of coeffsList) {
    // 参考：从 t=0 即生效
    const expected = referenceConvolve(sig, [{ target: 0, coeffs }]);
    for (const bs of blockChoices) {
      const sizes = [];
      let total = 0;
      for (let i = 0; total < N; i++)
        (sizes.push(Math.min(bs[i % bs.length], N - total)),
          (total += sizes[sizes.length - 1]));
      const eng = new FirEngine();
      eng.reset("R");
      eng.ingest("R", 0, 0, coeffs);
      const { out } = runEngine(eng, sig, sizes, [], "R");
      assertClose(
        out,
        expected,
        1e-5,
        `L=${coeffs.length} blocks=${bs.join("/")}`,
      );
    }
  }
});

test("块内换参：换组在目标样本计算前一次性完成，块长不影响结果", () => {
  const N = 1500;
  const sig = makeSignal(N);
  const segments = [
    { target: 0, coeffs: [1] },
    { target: 300, coeffs: new Array(8).fill(1 / 8) }, // 落在不同块内
    { target: 301, coeffs: [0.5, 0.5] }, // 相邻样本再换
    { target: 777, coeffs: [0.3, 0.4, 0.3] },
    {
      target: 1200,
      coeffs: (() => {
        const c = new Array(128);
        for (let i = 0; i < 128; i++) c[i] = 1 / 128;
        return c;
      })(),
    },
  ];
  const expected = referenceConvolve(sig, segments);

  for (const blockSize of [1, 7, 128, 129, 256, 400]) {
    const eng = new FirEngine();
    eng.reset("R");
    const commands = segments.map((s, i) => ({
      arriveAt: 0,
      runId: "R",
      seq: i + 1,
      target: s.target,
      coeffs: s.coeffs,
    }));
    const sizes = [];
    for (let p = 0; p < N; p += blockSize)
      sizes.push(Math.min(blockSize, N - p));
    const { out, applied } = runEngine(eng, sig, sizes, commands, "R");
    assertClose(out, expected, 1e-5, `block=${blockSize}`);
    assert.deepEqual(
      applied.map((e) => e.at),
      [0, 300, 301, 777, 1200],
    );
    // 一份输出不混用两组：每个 applied 边界两侧分别只属于前后组（由逐样本相等保证）
  }
});

test("系数长度变化（含 128 上限）历史不串组", () => {
  const N = 900;
  const sig = makeSignal(N);
  const segs = [
    { target: 0, coeffs: [1] },
    { target: 100, coeffs: new Array(128).fill(1 / 128) }, // 突然变最长
    { target: 400, coeffs: [1] }, // 突然变短：历史槽残留不得影响
    { target: 500, coeffs: [0.25, 0.25, 0.25, 0.25] },
  ];
  const expected = referenceConvolve(sig, segs);
  for (const blockSize of [127, 128, 129, 333]) {
    const eng = new FirEngine();
    eng.reset("R");
    const commands = segs.map((s, i) => ({
      arriveAt: 0,
      runId: "R",
      seq: i + 1,
      target: s.target,
      coeffs: s.coeffs,
    }));
    const sizes = [];
    for (let p = 0; p < N; p += blockSize)
      sizes.push(Math.min(blockSize, N - p));
    const { out } = runEngine(eng, sig, sizes, commands, "R");
    assertClose(out, expected, 1e-5, `len-change block=${blockSize}`);
  }
});

test("迟到指令明确拒绝且不回写已生成样本", () => {
  const N = 600;
  const sig = makeSignal(N);
  const eng = new FirEngine();
  eng.reset("R");
  eng.ingest("R", 1, 0, [1]);
  // 以块长 128 处理到 clock=256
  eng.processBlock(sig.subarray(0, 128));
  eng.processBlock(sig.subarray(128, 256));
  const before = makeSignal(256); // 与输入一致
  assert.equal(eng.clock, 256);

  const lateTargets = [0, 1, 127, 128, 255];
  for (const t of lateTargets) {
    const v = eng.ingest("R", 99, t, [0.5, 0.5]);
    assert.equal(v.accepted, false, `target=${t} 必须拒绝`);
    assert.equal(v.reason, "late");
  }
  // 边界：target == 当前时钟（256）不算迟到
  const onTime = eng.ingest("R", 2, 256, [0.5, 0.5]);
  assert.equal(onTime.accepted, true);

  // 继续处理：前 256 样本已经生成，迟到指令绝不可能改变它们
  const tail = eng.processBlock(sig.subarray(256, 384));
  const refFull = referenceConvolve(sig, [
    { target: 0, coeffs: [1] },
    { target: 256, coeffs: [0.5, 0.5] },
  ]);
  for (let i = 0; i < tail.length; i++) {
    assert.ok(Math.abs(tail[i] - refFull[256 + i]) <= 1e-6);
  }
  // 迟到的 pending 队列为空（拒绝不入队）
  assert.equal(eng.pendingCount, 0);
});

test("同一下标按命令序号裁决（高者胜；后到的低序号拒绝）", () => {
  const N = 400;
  const sig = makeSignal(N);
  const eng = new FirEngine();
  eng.reset("R");
  assert.equal(eng.ingest("R", 5, 100, [1]).accepted, true);
  assert.equal(eng.ingest("R", 3, 100, [0.5, 0.5]).accepted, false); // 低序号
  const dup = eng.ingest("R", 5, 100, [0.9]);
  assert.equal(dup.accepted, false); // 重复序号
  const win = eng.ingest("R", 9, 100, [0.25, 0.25, 0.25, 0.25]);
  assert.equal(win.accepted, true);
  assert.equal(win.superseded, 5);

  eng.ingest("R", 1, 0, [1]);
  const sizes = [128, 128, 144];
  const { out, applied } = runEngine(eng, sig, sizes, [], "R");
  const expected = referenceConvolve(sig, [
    { target: 0, coeffs: [1] },
    { target: 100, coeffs: [0.25, 0.25, 0.25, 0.25] },
  ]);
  assertClose(out, expected, 1e-6, "seq winner");
  assert.deepEqual(
    applied.map((e) => e.seq),
    [1, 9],
  );
});

test("暂停语义：不处理就不推进时钟，输入历史保留；后续输出与连续运行一致", () => {
  const N = 500;
  const sig = makeSignal(N);
  const paused = new FirEngine();
  paused.reset("R");
  paused.ingest("R", 1, 0, new Array(16).fill(1 / 16));
  paused.processBlock(sig.subarray(0, 128));
  const clockAtPause = paused.clock;

  // “暂停期间”发未来指令、什么都不处理
  paused.ingest("R", 2, 300, [0.5, 0.5]);
  assert.equal(paused.clock, clockAtPause);

  // 连续运行的对照引擎
  const cont = new FirEngine();
  cont.reset("R");
  cont.ingest("R", 1, 0, new Array(16).fill(1 / 16));
  cont.ingest("R", 2, 300, [0.5, 0.5]);
  const contOut = [
    cont.processBlock(sig.subarray(0, 128)),
    cont.processBlock(sig.subarray(128, 256)),
    cont.processBlock(sig.subarray(256, 384)),
    cont.processBlock(sig.subarray(384, 500)),
  ];

  // 暂停后恢复：块边界可以与连续时不同，但结果必须一致
  const resumeOut = [
    paused.processBlock(sig.subarray(128, 200)),
    paused.processBlock(sig.subarray(200, 333)),
    paused.processBlock(sig.subarray(333, 500)),
  ];
  const flatCont = (() => {
    const m = new Float32Array(N);
    let p = 0;
    for (const b of contOut) (m.set(b, p), (p += b.length));
    return m;
  })();
  const flatResume = (() => {
    const m = new Float32Array(N);
    let p = 128;
    for (const b of resumeOut) (m.set(b, p), (p += b.length));
    return m;
  })();
  // 只比较恢复点之后的样本
  for (let i = 128; i < N; i++) {
    assert.ok(
      Math.abs(flatResume[i] - flatCont[i]) <= 1e-6,
      `suspend/resume @${i}`,
    );
  }
  assert.equal(paused.clock, 500);
});

test("显式重置：新代号清空时钟/历史/系数/待生效队列，旧代号指令被拒", () => {
  const sig = makeSignal(400);
  const eng = new FirEngine();
  eng.reset("old");
  eng.ingest("old", 1, 0, [1]);
  eng.processBlock(sig.subarray(0, 128));
  eng.ingest("old", 2, 500, [0.5, 0.5]);
  assert.equal(eng.pendingCount, 1);

  eng.reset("new");
  assert.equal(eng.clock, 0);
  assert.equal(eng.coeffs.length, 0);
  assert.equal(eng.pendingCount, 0);

  // 旧代号指令一律拒绝
  const stale = eng.ingest("old", 3, 0, [1]);
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, "run-mismatch");
  // 旧队列里的 future 指令也不会在新一轮生效
  eng.ingest("new", 1, 0, [1]);
  const out = eng.processBlock(makeSignal(128)); // 新一轮信号从 t=0 重新计数
  // 没有任何旧系数痕迹：t<500 且旧指令 target=500，更重要的是引擎里已无该指令
  assert.equal(eng.pendingCount, 0);
  const expected = referenceConvolve(makeSignal(128), [
    { target: 0, coeffs: [1] },
  ]);
  assertClose(out, expected, 1e-6, "fresh run");
});

test("系数组校验：空/超长/非有限值/错误类型拒绝", () => {
  assert.equal(isValidCoeffGroup([]), false);
  assert.equal(isValidCoeffGroup(new Array(129).fill(0.1)), false);
  assert.equal(isValidCoeffGroup(new Array(128).fill(0.1)), true);
  assert.equal(isValidCoeffGroup([1, NaN]), false);
  assert.equal(isValidCoeffGroup([1, Infinity]), false);
  assert.equal(isValidCoeffGroup(["1"]), false);
  assert.equal(isValidCoeffGroup(null), false);
});

// ---------- 线性过渡 ----------

const long128 = (() => {
  const c = new Array(128);
  for (let i = 0; i < 128; i++)
    c[i] = ((0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 127)) / 128) * 2;
  return c;
})();

test("过渡按本轮样本时钟混合全部抽头：结果与分块方式无关（含长度突变、单样本）", () => {
  const N = 2200;
  const sig = makeSignal(N);
  const segs = [
    { target: 0, coeffs: [1] },
    { target: 100, coeffs: new Array(16).fill(1 / 16), duration: 300 },
    { target: 500, coeffs: [0.3, 0.4, 0.3], duration: 1 }, // 单样本过渡
    { target: 700, coeffs: long128, duration: 257 }, // 突然变长到 128，跨块/跨环形缓冲
    { target: 1200, coeffs: [0.5, 0.5], duration: 400 }, // 突然变短，零补齐
    { target: 1900, coeffs: [0.7, 0, 0.3], duration: 0 }, // 立即换组不受影响
  ];
  const expected = referenceConvolve(sig, segs);

  const blockChoices = [
    [1],
    [7],
    [127],
    [128],
    [129],
    [300],
    [3, 5, 128, 1, 64, 333],
    Array.from({ length: 40 }, (_, i) => ((i * 37) % 200) + 1),
  ];
  for (const bs of blockChoices) {
    const sizes = [];
    let total = 0;
    for (let i = 0; total < N; i++)
      (sizes.push(Math.min(bs[i % bs.length], N - total)),
        (total += sizes[sizes.length - 1]));
    const eng = new FirEngine();
    eng.reset("R");
    const commands = segs.map((s, i) => ({
      arriveAt: 0,
      runId: "R",
      seq: i + 1,
      target: s.target,
      coeffs: s.coeffs,
      duration: s.duration ?? 0,
    }));
    const { out, applied } = runEngine(eng, sig, sizes, commands, "R");
    assertClose(out, expected, 1e-6, `transition blocks=${bs.join("/")}`);
    assert.deepEqual(
      applied.map((e) => ({ at: e.at, duration: e.duration })),
      segs.map((s) => ({ at: s.target, duration: s.duration ?? 0 })),
      `applied 事件带正确 duration（blocks=${bs.join("/")}）`,
    );
  }
});

test("过渡权重直接核验：目标样本 1/N、末端全为新组、每个抽头都在混合", () => {
  // 单脉冲放在过渡中的样本 s：输出 y[s+k] 只含有效系数第 k 抽头（脉冲在历史中唯一非零），
  // 该抽头在样本 s+k 的权重 = ((s-t0+1)+k)/N。两个多抽头组无公共零抽头，
  // “只混合第 0 抽头 / 用 sample%128 取权重”类错误会立刻暴露。
  const N = 600;
  const t0 = 100;
  const D = 100;
  const A = [0.6, 0.2, 0.2];
  const B = [0.1, 0.4, 0.5];

  const runWithImpulseAt = (s, blocks) => {
    const sig = new Float32Array(N);
    sig[s] = 1;
    const eng = new FirEngine();
    eng.reset("R");
    eng.ingest("R", 1, 0, A);
    eng.ingest("R", 2, t0, B, D);
    const outs = [];
    let p = 0;
    for (const size of blocks) {
      outs.push(eng.processBlock(sig.subarray(p, p + size)));
      p += size;
    }
    const out = new Float32Array(N);
    p = 0;
    for (const b of outs) (out.set(b, p), (p += b.length));
    return out;
  };
  const expectTap = (s, k) => {
    const w = Math.min(1, (s - t0 + 1 + k) / D);
    return A[k] + (B[k] - A[k]) * w;
  };

  for (const s of [t0, t0 + 1, t0 + 50, t0 + D - 1]) {
    for (const blocks of [
      [N],
      [128, 128, 128, 128, 88],
      [1, 1, N - 2],
      [37, 63, 500],
    ]) {
      const out = runWithImpulseAt(s, blocks);
      for (let k = 0; k < 3; k++) {
        assert.ok(
          Math.abs(out[s + k] - expectTap(s, k)) <= 1e-6,
          `impulse@${s} k=${k} blocks=${blocks.join("/")}: got ${out[s + k]} expect ${expectTap(s, k)}`,
        );
      }
      // 有效组长度恰为 3（两组等长）：脉冲在第 3 抽头之外无贡献
      assert.equal(out[s + 3], 0, `no tap beyond group length (s=${s})`);
    }
  }
  // 过渡完成后：脉冲只产生新组 B
  {
    const out = runWithImpulseAt(t0 + D + 7, [N]);
    const s = t0 + D + 7;
    for (let k = 0; k < 3; k++)
      assert.ok(Math.abs(out[s + k] - B[k]) <= 1e-6, `post-ramp tap ${k}`);
    assert.equal(out[s + 3], 0);
  }
});

test("长度差异零补齐：短->长与长->短过渡的缺失抽头按 0 混合", () => {
  const N = 400;
  // 全程为 1 的输入：任何抽头的有效系数都直接累加进输出，最容易数出长度变化。
  const ones = new Float32Array(N).fill(1);
  const short = [0.6, 0.4]; // 和 1
  const long = [0.2, 0.2, 0.2, 0.2, 0.2]; // 和 1
  const segs = [
    { target: 0, coeffs: short },
    { target: 50, coeffs: long, duration: 10 },
    { target: 200, coeffs: short, duration: 10 },
  ];
  const expected = referenceConvolve(ones, segs);
  for (const bs of [[1], [10], [37], [128], [129], [3, 16, 64]]) {
    const sizes = [];
    let total = 0;
    for (let i = 0; total < N; i++)
      (sizes.push(Math.min(bs[i % bs.length], N - total)),
        (total += sizes[sizes.length - 1]));
    const eng = new FirEngine();
    eng.reset("R");
    const commands = segs.map((s, i) => ({
      arriveAt: 0,
      runId: "R",
      seq: i + 1,
      target: s.target,
      coeffs: s.coeffs,
      duration: s.duration ?? 0,
    }));
    const { out } = runEngine(eng, ones, sizes, commands, "R");
    assertClose(out, expected, 1e-12, `zero-pad blocks=${bs.join("/")}`);
  }
  // 稳态：前 50 样本（历史足够后）输出 = 1，第二次过渡后也回到 1
  const eng = new FirEngine();
  eng.reset("R");
  eng.ingest("R", 1, 0, short);
  eng.ingest("R", 2, 50, long, 10);
  eng.ingest("R", 3, 200, short, 10);
  const out = eng.processBlock(ones);
  for (let t = 2; t < 50; t++) assert.equal(out[t], 1);
  for (let t = 210; t < 300; t++) assert.equal(out[t], 1);
});

test("重叠过渡：新命令从上一已生成样本的有效系数重新起步，分块无关", () => {
  const N = 1200;
  const sig = makeSignal(N);
  const segs = [
    { target: 0, coeffs: [1] },
    { target: 200, coeffs: new Array(16).fill(1 / 16), duration: 400 },
    // 在第一条 ramp 走到一半时再次换组：必须承接 t=399 的有效混合系数
    { target: 400, coeffs: long128, duration: 300 },
    { target: 600, coeffs: [0.5, 0.5], duration: 200 }, // 再次重叠（长 -> 短）
  ];
  const expected = referenceConvolve(sig, segs);
  for (const bs of [[1], [128], [129], [333], [7, 200, 3, 128]]) {
    const sizes = [];
    let total = 0;
    for (let i = 0; total < N; i++)
      (sizes.push(Math.min(bs[i % bs.length], N - total)),
        (total += sizes[sizes.length - 1]));
    const eng = new FirEngine();
    eng.reset("R");
    const commands = segs.map((s, i) => ({
      arriveAt: 0,
      runId: "R",
      seq: i + 1,
      target: s.target,
      coeffs: s.coeffs,
      duration: s.duration ?? 0,
    }));
    const { out } = runEngine(eng, sig, sizes, commands, "R");
    assertClose(out, expected, 1e-6, `overlap blocks=${bs.join("/")}`);
  }

  // 显式核验“承接点”：恒 1 输入下输出即有效系数和。
  // 第一条 ramp 在 t=399 时权重 200/400=0.5；t=400 新命令以 b399 起步（新权重 1/300）。
  // 用极不相同的分块方式（含 1、跨 200、跨 399 边界）跑出的承接值必须一致。
  const partitionChoices = [
    [128, 128, 144],
    [1, 1, 598],
    [200, 199, 201],
    [399, 1, 200],
  ];
  for (const parts of partitionChoices) {
    const M = 750;
    const ones = new Float32Array(M).fill(1);
    const e = new FirEngine();
    e.reset("R2");
    e.ingest("R2", 1, 0, [1]);
    e.ingest("R2", 2, 200, new Array(16).fill(1 / 16), 400);
    e.ingest("R2", 3, 400, long128, 300);
    const flat = new Float32Array(M);
    let p = 0;
    let bi = 0;
    while (p < M) {
      const size = Math.min(parts[bi % parts.length], M - p);
      const b = e.processBlock(ones.subarray(p, p + size));
      flat.set(b, p);
      p += size;
      bi++;
    }

    const b399 = new Float64Array(16);
    for (let k = 0; k < 16; k++)
      b399[k] = 0.5 * (k === 0 ? 1 : 0) + 0.5 / 16;
    const expectSum = (t) => {
      const w = Math.min(1, (t - 400 + 1) / 300);
      let s = 0;
      for (let k = 0; k < 128; k++) {
        const a = k < 16 ? b399[k] : 0;
        s += a + (long128[k] - a) * w;
      }
      return s;
    };
    // t>=127 时所有抽头都有全 1 历史，输出 = 系数和；过渡 t=400..699。
    // 系数经 Float32 存储，128 抽头求和用 1e-6 容差（同时严格于 1 个 ulp 的放大）。
    assert.ok(Math.abs(flat[399] - 1) <= 1e-6, "join-pre: |b399|=1");
    for (const t of [400, 401, 450, 527, 699])
      assert.ok(
        Math.abs(flat[t] - expectSum(t)) <= 1e-6,
        `overlap join sum @${t} parts=${parts.join("/")} got ${flat[t]} expect ${expectSum(t)}`,
      );
    // 过渡完成后（t=700 起）有效组恰为 long128（零补齐尾部裁掉）
    const longSum = long128.reduce((a, b) => a + b, 0);
    assert.ok(
      Math.abs(flat[700] - longSum) <= 1e-6 &&
        Math.abs(flat[749] - longSum) <= 1e-6,
      "join-post: ramp2 converged to long128",
    );
  }
});

test("同目标高序号命令同时替换系数与过渡时长（实际时长属于新命令）", () => {
  const N = 900;
  const sig = makeSignal(N);
  const eng = new FirEngine();
  eng.reset("R");
  eng.ingest("R", 1, 0, [1]);
  // 先发：长过渡 400 + 平均组
  assert.equal(eng.ingest("R", 2, 200, new Array(16).fill(1 / 16), 400).accepted, true);
  // 低序号同目标：拒绝（即使 duration 不同）
  const stale = eng.ingest("R", 2, 200, [0.5, 0.5], 1);
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, "stale-seq");
  // 高序号：整体替换为 短过渡 10 + 不同系数
  const win = eng.ingest("R", 3, 200, [0.3, 0.4, 0.3], 10);
  assert.equal(win.accepted, true);
  assert.equal(win.superseded, 2);

  const { out, applied } = runEngine(
    eng,
    sig,
    [128, 128, 128, 128, 128, 128, 132],
    [],
    "R",
  );
  const expected = referenceConvolve(sig, [
    { target: 0, coeffs: [1] },
    { target: 200, coeffs: [0.3, 0.4, 0.3], duration: 10 },
  ]);
  assertClose(out, expected, 1e-6, "winner duration applies");
  assert.equal(applied.length, 2);
  assert.equal(applied[1].duration, 10); // 实际过渡时长属于新命令
  assert.equal(applied[1].seq, 3);
  // 自 t=209（过渡最后一样本，权重 1）起必须已是 [0.3,0.4,0.3] 稳态
  // （旧命令的 400 ramp 不得残留）
  const steady = referenceConvolve(sig, [
    { target: 0, coeffs: [1] },
    { target: 209, coeffs: [0.3, 0.4, 0.3] },
  ]);
  for (let t = 209; t < N; t++)
    assert.ok(Math.abs(out[t] - steady[t]) <= 1e-6, `steady @${t}`);
});

test("暂停/恢复跨过过渡：时钟与历史（含过渡进度）保持，结果等价连续运行", () => {
  const N = 800;
  const sig = makeSignal(N);
  const mk = () => {
    const e = new FirEngine();
    e.reset("R");
    e.ingest("R", 1, 0, [1]);
    e.ingest("R", 2, 100, new Array(16).fill(1 / 16), 500);
    e.ingest("R", 3, 350, long128, 300); // 暂停点 256 落在第一条 ramp 内
    return e;
  };

  const cont = mk();
  const contBlocks = [
    cont.processBlock(sig.subarray(0, 128)),
    cont.processBlock(sig.subarray(128, 256)),
    cont.processBlock(sig.subarray(256, 512)),
    cont.processBlock(sig.subarray(512, 800)),
  ];

  const paused = mk();
  paused.processBlock(sig.subarray(0, 128));
  paused.processBlock(sig.subarray(128, 256));
  assert.equal(paused.clock, 256);
  // 暂停期间不处理任何样本；过渡不推进
  const resumeBlocks = [
    paused.processBlock(sig.subarray(256, 300)), // 恢复后分块方式与连续时不同
    paused.processBlock(sig.subarray(300, 470)),
    paused.processBlock(sig.subarray(470, 641)),
    paused.processBlock(sig.subarray(641, 800)),
  ];
  assert.equal(paused.clock, 800);

  const flat = (blocks, offset) => {
    const m = new Float32Array(N);
    let p = offset;
    for (const b of blocks) (m.set(b, p), (p += b.length));
    return m;
  };
  const c = flat(contBlocks, 0);
  const r = flat(resumeBlocks, 256);
  for (let t = 256; t < N; t++)
    assert.ok(Math.abs(c[t] - r[t]) <= 1e-9, `ramp across pause @${t}`);
});

test("重置清除过渡状态：新代号无旧 ramp 残留", () => {
  const sig = makeSignal(300);
  const eng = new FirEngine();
  eng.reset("old");
  eng.ingest("old", 1, 0, [1]);
  eng.processBlock(sig.subarray(0, 64));
  eng.ingest("old", 2, 100, long128, 4096); // 长过渡排队

  eng.reset("new");
  // 新代号立即换组：输出只能是新组结果，不受旧过渡影响
  eng.ingest("new", 1, 0, [0.5, 0.5]);
  const out = eng.processBlock(makeSignal(128));
  const expected = referenceConvolve(makeSignal(128), [
    { target: 0, coeffs: [0.5, 0.5] },
  ]);
  assertClose(out, expected, 1e-12, "no residual ramp after reset");
});

test("duration 校验：拒绝非整数/负数/超 4096；0 与 4096 边界接纳", () => {
  const eng = new FirEngine();
  eng.reset("R");
  assert.equal(eng.ingest("R", 1, 0, [1], -1).accepted, false);
  assert.equal(eng.ingest("R", 2, 0, [1], 4097).accepted, false);
  assert.equal(eng.ingest("R", 3, 0, [1], 1.5).accepted, false);
  assert.equal(eng.ingest("R", 4, 0, [1], "3").accepted, false);
  assert.equal(eng.ingest("R", 5, 0, [1], NaN).accepted, false);
  const bad = eng.ingest("R", 6, 0, [1], 4097);
  assert.equal(bad.reason, "bad-duration");
  assert.equal(eng.ingest("R", 7, 0, [1], 0).accepted, true);
  assert.equal(eng.ingest("R", 8, 10, [1], 4096).accepted, true);
});
