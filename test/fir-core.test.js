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
function referenceConvolve(signal, segments) {
  const N = signal.length;
  const ref = new Float32Array(N);
  let coeffs = new Float32Array(0);
  const segMap = new Map(segments.map((s) => [s.target, s.coeffs]));
  for (let t = 0; t < N; t++) {
    if (segMap.has(t)) coeffs = Float32Array.from(segMap.get(t));
    let acc = 0;
    for (let k = 0; k < coeffs.length; k++) {
      acc += coeffs[k] * (t - k >= 0 ? signal[t - k] : 0);
    }
    ref[t] = acc;
  }
  return ref;
}

// 以给定块长序列把信号喂给引擎；commands: {arriveAt, runId, seq, target, coeffs, duration?}
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
      acks.push(
        engine.ingest(c.runId, c.seq, c.target, c.coeffs, c.duration ?? 0),
      );
    }
    const block = engine.processBlock(signal.subarray(pos, pos + size));
    for (const ev of engine.events) applied.push(ev);
    outputs.push(block);
    pos += size;
  }
  while (ci < sorted.length) {
    const c = sorted[ci++];
    acks.push(
      engine.ingest(c.runId, c.seq, c.target, c.coeffs, c.duration ?? 0),
    );
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

// ---------------- 线性过渡 ----------------

// 独立参考：把每个样本的有效核表示为若干“纯组整段卷积”的加权和
// （输出交叉淡化表述）。它与实现的“逐抽头混合内核后单次卷积”是两条不同的
// 计算路径，仅靠线性性等价；纯组卷积全部卷积同一份真实输入历史。
// commands: [{target, coeffs, duration}]（已裁决，每个 target 只留一条）。
function referenceBlend(signal, commands) {
  const N = signal.length;
  const convCache = new Map();
  const convOf = (coeffs) => {
    const key = coeffs.join(",");
    let c = convCache.get(key);
    if (!c) {
      c = referenceConvolve(signal, [{ target: 0, coeffs }]); // 纯组因果卷积
      convCache.set(key, c);
    }
    return c;
  };
  const segMap = new Map(commands.map((c) => [c.target, c]));
  let weights = new Map(); // key -> { coeffs, weight }：上一已生成样本的有效核
  let ramp = null; // { from: weights, to, start, duration }
  const out = new Float64Array(N);
  for (let t = 0; t < N; t++) {
    const cmd = segMap.get(t);
    if (cmd) {
      if (!cmd.duration) {
        weights = new Map([
          [cmd.coeffs.join(","), { coeffs: cmd.coeffs, weight: 1 }],
        ]);
        ramp = null;
      } else {
        // 重叠过渡：承接上一已生成样本（t-1）的有效权重重新起步
        ramp = {
          from: weights,
          to: cmd.coeffs,
          start: t,
          duration: cmd.duration,
        };
      }
    }
    let eff = weights;
    if (ramp) {
      const w = Math.min(1, (t - ramp.start + 1) / ramp.duration); // 第 k 个样本 (k+1)/N
      eff = new Map();
      for (const [k, v] of ramp.from) {
        const nw = v.weight * (1 - w);
        if (nw !== 0) eff.set(k, { coeffs: v.coeffs, weight: nw });
      }
      const key = ramp.to.join(",");
      const prev = eff.get(key);
      eff.set(key, {
        coeffs: ramp.to,
        weight: (prev ? prev.weight : 0) + w,
      });
      weights = eff;
      if (w === 1) ramp = null; // 第 start+N-1 个样本过渡完成
    }
    let acc = 0;
    for (const v of eff.values()) acc += v.weight * convOf(v.coeffs)[t];
    out[t] = acc;
  }
  return out;
}

const comb16 = () => {
  const c = new Array(16).fill(0);
  c[0] = 0.7;
  c[15] = 0.3;
  return c;
};
const hann128 = () => {
  const c = new Array(128);
  for (let i = 0; i < 128; i++)
    c[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 127);
  const s = c.reduce((a, b) => a + b, 0);
  return c.map((v) => v / s);
};

function sizesFor(blockSize, N) {
  const sizes = [];
  for (let p = 0; p < N; p += blockSize) sizes.push(Math.min(blockSize, N - p));
  return sizes;
}

test("线性过渡：按本轮样本时钟 N 个样本完成，且与分块方式无关", () => {
  const N = 1600;
  const sig = makeSignal(N);
  const A = [1];
  const B = new Array(8).fill(1 / 8);
  const T = 300;
  const D = 100;
  const cmds = [
    { target: 0, coeffs: A, duration: 0 },
    { target: T, coeffs: B, duration: D },
  ];
  const expected = referenceBlend(sig, cmds);
  const convA = referenceConvolve(sig, [{ target: 0, coeffs: A }]);
  const convB = referenceConvolve(sig, [{ target: 0, coeffs: B }]);
  for (const blockSize of [1, 7, 127, 128, 129, 256, 333]) {
    const eng = new FirEngine();
    eng.reset("R");
    const commands = [
      { arriveAt: 0, runId: "R", seq: 1, target: 0, coeffs: A },
      { arriveAt: 0, runId: "R", seq: 2, target: T, coeffs: B, duration: D },
    ];
    const { out, applied } = runEngine(
      eng,
      sig,
      sizesFor(blockSize, N),
      commands,
      "R",
    );
    assertClose(out, expected, 1e-5, `transition block=${blockSize}`);
    // 过渡区之外：前段是纯 A、完成后是纯 B（同一输入历史的纯卷积），
    // 切分点精确落在样本下标上：过渡恰在 T+D-1 完成。
    assertClose(out.subarray(0, T), convA.subarray(0, T), 0, `pre block=${blockSize}`);
    assertClose(
      out.subarray(T + D - 1),
      convB.subarray(T + D - 1),
      0,
      `post block=${blockSize}`,
    );
    const ap = applied.find((e) => e.seq === 2);
    assert.equal(ap.at, T);
    assert.equal(ap.duration, D); // 应用事件带 duration
  }
});

test("多抽头与长度突变过渡：全部抽头参与混合，长度差异零补齐", () => {
  const N = 2000;
  const sig = makeSignal(N);
  const cmds = [
    { target: 0, coeffs: comb16(), duration: 0 },
    { target: 200, coeffs: [0.3, 0.4, 0.3], duration: 64 }, // 16 -> 3 抽头
    { target: 700, coeffs: hann128(), duration: 129 }, // 3 -> 128 抽头（跨量子）
    { target: 1400, coeffs: [1], duration: 96 }, // 128 -> 1 抽头
  ];
  const expected = referenceBlend(sig, cmds);
  for (const blockSize of [1, 7, 128, 129, 400]) {
    const eng = new FirEngine();
    eng.reset("R");
    const commands = cmds.map((c, i) => ({
      arriveAt: 0,
      runId: "R",
      seq: i + 1,
      ...c,
    }));
    const { out } = runEngine(eng, sig, sizesFor(blockSize, N), commands, "R");
    assertClose(out, expected, 1e-5, `len-change transition block=${blockSize}`);
  }
});

test("重叠过渡：从上一已生成样本的有效系数重新起步；立即换组可切断过渡", () => {
  const N = 1500;
  const sig = makeSignal(N);
  const cmds = [
    { target: 0, coeffs: [1], duration: 0 },
    { target: 200, coeffs: new Array(8).fill(1 / 8), duration: 400 }, // 过渡区间 [200,599]
    { target: 350, coeffs: [0.3, 0.4, 0.3], duration: 120 }, // 重叠：中途改道
    { target: 420, coeffs: [0.25, 0.25, 0.25, 0.25], duration: 0 }, // 立即切断第二段过渡
    { target: 900, coeffs: comb16(), duration: 250 }, // 安静状态下再起一段
  ];
  const expected = referenceBlend(sig, cmds);
  for (const blockSize of [1, 7, 128, 129, 333]) {
    const eng = new FirEngine();
    eng.reset("R");
    const commands = cmds.map((c, i) => ({
      arriveAt: 0,
      runId: "R",
      seq: i + 1,
      ...c,
    }));
    const { out, applied } = runEngine(
      eng,
      sig,
      sizesFor(blockSize, N),
      commands,
      "R",
    );
    assertClose(out, expected, 1e-5, `overlap block=${blockSize}`);
    assert.deepEqual(
      applied.map((e) => [e.at, e.duration]),
      cmds.map((c) => [c.target, c.duration]),
    );
  }
});

test("同目标高序号整体替换系数与 duration（实际过渡时长属于新命令）", () => {
  const N = 1200;
  const sig = makeSignal(N);
  const eng = new FirEngine();
  eng.reset("R");
  eng.ingest("R", 1, 0, [1]);
  const a1 = eng.ingest("R", 2, 500, new Array(8).fill(1 / 8), 300);
  assert.equal(a1.accepted, true);
  const a2 = eng.ingest("R", 3, 500, [0.3, 0.4, 0.3], 40); // 同目标高序号：整体替换
  assert.equal(a2.accepted, true);
  assert.equal(a2.superseded, 2);

  const { out, applied } = runEngine(eng, sig, sizesFor(128, N), [], "R");
  const ap = applied.find((e) => e.target === 500);
  assert.equal(ap.seq, 3);
  assert.equal(ap.duration, 40); // 不是旧命令的 300

  const expected = referenceBlend(sig, [
    { target: 0, coeffs: [1], duration: 0 },
    { target: 500, coeffs: [0.3, 0.4, 0.3], duration: 40 },
  ]);
  assertClose(out, expected, 1e-5, "supersede replaces duration");
  // 若错误沿用旧命令的系数/duration，输出必然可分辨（证明用例有区分度）
  const wrong = referenceBlend(sig, [
    { target: 0, coeffs: [1], duration: 0 },
    { target: 500, coeffs: new Array(8).fill(1 / 8), duration: 300 },
  ]);
  let diff = 0;
  for (let t = 500; t < 900; t++)
    diff = Math.max(diff, Math.abs(out[t] - wrong[t]));
  assert.ok(diff > 1e-3, "用例必须能区分新旧 duration/系数");
});

test("单样本过渡 duration=1 与立即换组一致；duration=0 立即换组", () => {
  const N = 800;
  const sig = makeSignal(N);
  const B = [0.3, 0.4, 0.3];
  const eng = new FirEngine();
  eng.reset("R");
  eng.ingest("R", 1, 0, new Array(16).fill(1 / 16));
  eng.ingest("R", 2, 400, B, 1); // 单样本过渡：w=(0+1)/1=1，目标样本即用新组
  const { out, applied } = runEngine(eng, sig, sizesFor(129, N), [], "R");
  const expected = referenceConvolve(sig, [
    { target: 0, coeffs: new Array(16).fill(1 / 16) },
    { target: 400, coeffs: B },
  ]);
  assertClose(out, expected, 1e-6, "duration=1 == immediate");
  assert.equal(applied.find((e) => e.seq === 2).duration, 1);
});

test("暂停不推进过渡进度：恢复后承接同一时钟与历史，与连续运行一致", () => {
  const N = 1000;
  const sig = makeSignal(N);
  const cmds = [
    { target: 0, coeffs: [1], duration: 0 },
    { target: 100, coeffs: new Array(8).fill(1 / 8), duration: 300 }, // 过渡区间 [100,399]
    { target: 500, coeffs: [0.3, 0.4, 0.3], duration: 200 },
    { target: 800, coeffs: [1], duration: 0 }, // 暂停期间受理的未来指令
  ];
  const expected = referenceBlend(sig, cmds);

  const eng = new FirEngine();
  eng.reset("R");
  for (const [i, c] of cmds.slice(0, 3).entries())
    eng.ingest("R", i + 1, c.target, c.coeffs, c.duration);
  eng.processBlock(sig.subarray(0, 128)); // 处理到过渡中途（[100,399] 内）
  const clockAtPause = eng.clock;
  assert.equal(clockAtPause, 128);
  // “暂停”：不调用 processBlock —— 时钟与过渡进度冻结；期间受理未来指令
  const late = eng.ingest("R", 9, 800, [1], 0);
  assert.equal(late.accepted, true);
  assert.equal(eng.clock, clockAtPause);
  // 恢复：用与暂停前不同的分块继续，结果必须与连续参考一致
  const rest = [
    eng.processBlock(sig.subarray(128, 200)),
    eng.processBlock(sig.subarray(200, 333)),
    eng.processBlock(sig.subarray(333, 700)),
    eng.processBlock(sig.subarray(700, 1000)),
  ];
  const got = new Float32Array(N);
  let p = 128; // 首块（暂停前）输出由连续参考的前段覆盖，这里校验恢复段
  for (const b of rest) {
    got.set(b, p);
    p += b.length;
  }
  for (let t = 128; t < N; t++) {
    assert.ok(
      Math.abs(got[t] - expected[t]) <= 1e-5,
      `resume @${t}: got ${got[t]} ref ${expected[t]}`,
    );
  }
  assert.equal(eng.clock, 1000);
});

test("显式重置清除进行中的过渡与全部运行状态", () => {
  const sig = makeSignal(600);
  const eng = new FirEngine();
  eng.reset("old");
  eng.ingest("old", 1, 0, [1]);
  eng.ingest("old", 2, 100, hann128(), 300); // 过渡将在 [100,399] 进行
  eng.processBlock(sig.subarray(0, 200)); // 过渡进行中
  eng.ingest("old", 3, 500, [0.5, 0.5], 100); // 未生效的过渡指令

  eng.reset("new"); // 重置：过渡、历史、待生效队列全部清除
  assert.equal(eng.clock, 0);
  assert.equal(eng.pendingCount, 0);
  assert.equal(eng.coeffs.length, 0);

  // 新一轮：旧过渡不留痕迹 —— 未下发指令时输出全 0
  const silent = eng.processBlock(makeSignal(128));
  for (const v of silent) assert.equal(v, 0);
  // 新指令从干净的零历史起步
  eng.ingest("new", 1, 128, [0.3, 0.4, 0.3], 10);
  const sig2 = makeSignal(600);
  const out = [silent, eng.processBlock(sig2.subarray(128, 400))];
  const got = new Float32Array(400);
  got.set(out[0], 0);
  got.set(out[1], 128);
  const expected = referenceBlend(sig2.subarray(0, 400), [
    { target: 128, coeffs: [0.3, 0.4, 0.3], duration: 10 },
  ]);
  assertClose(got, expected, 1e-5, "reset clears transition state");
});

test("duration 校验：非整数/越界拒绝，0 与 4096 边界接纳", () => {
  const eng = new FirEngine();
  eng.reset("R");
  for (const d of [-1, 4097, 2.5, NaN, "10", null]) {
    const v = eng.ingest("R", 1, 100, [1], d);
    assert.equal(v.accepted, false, `duration=${d}`);
    assert.equal(v.reason, "bad-duration");
  }
  assert.equal(eng.ingest("R", 1, 100, [1], 0).accepted, true);
  assert.equal(eng.ingest("R", 2, 200, [1], 4096).accepted, true);
});
