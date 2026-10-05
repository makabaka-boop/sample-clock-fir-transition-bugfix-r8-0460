// 真实浏览器 Worklet 流程 E2E（Playwright + Chromium）：
// 启动本地静态服务 -> 打开页面 -> 经真实 AudioWorklet 消息链路驱动 ->
// 验证 ack / applied / 实际捕获块 / suspend-resume 时钟冻结 / 重置代号隔离 / WAV 下载。

import { chromium } from "playwright";
import http from "node:http";
import fsnode from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const urlPath = req.url.split("?")[0];
      const file = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
      fsnode.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("nope");
          return;
        }
        res.writeHead(200, {
          "Content-Type":
            MIME[path.extname(file)] || "application/octet-stream",
        });
        res.end(data);
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// 页面同款确定性信号
function signal(t, fs) {
  const w = 2 * Math.PI;
  return (
    0.5 * Math.sin(w * 440 * (t / fs)) +
    0.3 * Math.sin(w * 1000 * (t / fs) + 0.7) +
    0.2 * (Math.sin(w * 3.1 * t) > 0 ? 1 : -1)
  );
}
function f32(x) {
  return Math.fround(x);
}

function check(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    failures.push(msg);
  } else console.log("  ok:", msg);
}
const failures = [];

// 按“生效区间”在 Node 端独立复算预期输出（逐样本参考卷积）。
// segs: [[target, coeffsArray], ...]
function expectedOutput(fs, segs, N) {
  const out = new Float64Array(N);
  let b = new Float64Array(0);
  const map = new Map(segs.map((s) => [s[0], s[1]]));
  const hist = new Float64Array(128);
  let hp = 0;
  for (let t = 0; t < N; t++) {
    if (map.has(t)) b = Float64Array.from(map.get(t));
    hp = (hp + 1) % 128;
    hist[hp] = f32(signal(t, fs));
    let acc = 0;
    for (let k = 0; k < b.length; k++) acc += b[k] * hist[(hp - k + 128) % 128];
    out[t] = acc;
  }
  return out;
}

async function waitFor(
  page,
  fn,
  { timeout = 15000, label = "condition", arg } = {},
) {
  const t0 = Date.now();
  let lastErr = null;
  for (;;) {
    let ok = false;
    try {
      ok = await page.evaluate(fn, arg);
    } catch (e) {
      lastErr = e;
    }
    if (ok) return;
    if (Date.now() - t0 > timeout) {
      let probe = "(unavailable)";
      try {
        probe = JSON.stringify(
          await page.evaluate(() => ({
            s: window.__fir?.ctxState?.(),
            l: window.__fir.status()?.length,
            all: window.__fir.allAcks?.(),
          })),
        );
      } catch (e) {
        probe = "probe threw: " + e;
      }
      throw new Error(
        "timeout waiting for " +
          label +
          "; lastErr=" +
          lastErr +
          "; state=" +
          probe,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main() {
  const srv = await startServer();
  const port = srv.address().port;
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-audio-stream-capture-device",
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrs = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrs.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrs.push(String(e)));

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
    console.log("== 页面加载 / Worklet 链路 ==");
    await page.click("#btnStart");
    await waitFor(page, () => !!window.__fir.currentRunId());
    const r1 = await page.evaluate(() => window.__fir.currentRunId());
    check(
      typeof r1 === "string" && r1.startsWith("run-"),
      `收到 started，新代号 ${r1}`,
    );
    check(
      (await page.evaluate(() => window.__fir.ctxState())) === "running",
      "AudioContext running（真实渲染图拉动 worklet）",
    );

    console.log("== 真实捕获块 ==");
    await waitFor(page, () => (window.__fir.status()?.length || 0) >= 512, {
      label: "blocks",
    });
    let snap = await page.evaluate(() => window.__fir.snapshot());
    const fs0 = snap.fs;
    check(
      snap.blocks.length >= 4,
      `已回传 ${snap.blocks.length} 个有限长度输出块（length=${snap.blocks[0].data.length}）`,
    );
    check(
      snap.blocks.every((b) => b.data.length === 128),
      "每块长度为渲染量子 128（即本轮实际处理样本数）",
    );
    check(
      snap.blocks.every(
        (b, i, arr) => i === 0 || b.from === arr[i - 1].from + 128,
      ),
      "块连续无缺口、无重叠",
    );

    // 初始无系数：前 512 样本必须全 0（无历史泄漏）
    check(
      snap.blocks
        .flatMap((b) => b.data)
        .slice(0, 512)
        .every((v) => v === 0),
      "换参前输出全 0",
    );

    console.log("== 块内换参 + 序号裁决 + 迟到拒绝 ==");
    // 等到 clock 越过 640，再下发 T=128 的指令 => 必迟到
    await waitFor(page, () => (window.__fir.status()?.length || 0) >= 768, {
      label: "clock>=768",
    });
    const lenNow = (await page.evaluate(() => window.__fir.status())).length;
    // 余量取 2s：真实音频时钟持续运行，测试轮询/postMessage 在繁忙机器上可能有数百毫秒延迟
    const T = lenNow + Math.round(fs0 * 2);
    await page.evaluate(
      ([id, t]) => {
        // 先 seq=1，再以更高 seq=2 裁决同一下标；中间再发 seq=0（必须拒绝）
        window.__fir.post({
          kind: "set",
          runId: id,
          seq: 1,
          target: t,
          coeffs: Float32Array.from(new Array(8).fill(1 / 8)),
        });
        window.__fir.post({
          kind: "set",
          runId: id,
          seq: 0,
          target: t,
          coeffs: Float32Array.from([0.9]),
        });
        window.__fir.post({
          kind: "set",
          runId: id,
          seq: 2,
          target: t,
          coeffs: Float32Array.from([0.25, 0.25, 0.25, 0.25]),
        });
        // 迟到：目标已被处理
        window.__fir.post({
          kind: "set",
          runId: id,
          seq: 9,
          target: 128,
          coeffs: Float32Array.from([0.5, 0.5]),
        });
      },
      [r1, T],
    );

    // 用轻量 status 轮询；等 applied 落地且再多收 3000 样本后才取全量快照
    await waitFor(
      page,
      (T) => {
        const s = window.__fir.status();
        return (
          (s?.applied || []).some((a) => a.target === T) && s.length > T + 3000
        );
      },
      { timeout: 20000, label: "applied@T+3000", arg: T },
    );
    await waitFor(page, () => (window.__fir.status()?.ackCount || 0) >= 4, {
      timeout: 5000,
      label: "acks>=4",
    });
    snap = await page.evaluate(() => window.__fir.snapshot());
    const acks = snap.acks.filter((a) => a.target === T);
    check(
      acks.length === 3,
      `target=${T} 收到 3 条裁决（实际 ${acks.length}）`,
    );
    check(acks.find((a) => a.seq === 1)?.accepted === true, "seq=1 先被接纳");
    check(
      acks.find((a) => a.seq === 0)?.accepted === false &&
        acks.find((a) => a.seq === 0)?.reason === "stale-seq",
      "seq=0 同下标低序号拒绝",
    );
    check(
      acks.find((a) => a.seq === 2)?.accepted === true &&
        acks.find((a) => a.seq === 2)?.superseded === 1,
      "seq=2 裁决胜出并取代 seq=1",
    );
    const lateAck = snap.acks.find((a) => a.seq === 9);
    check(
      lateAck?.accepted === false && lateAck.reason === "late",
      `迟到指令（target=128 < clock=${lateAck?.at}）明确拒绝`,
    );
    check(lateAck.at >= 768, "ack.at 为处理器收到时的本轮时钟");
    const appliedAtT = snap.applied.find((a) => a.target === T);
    check(
      appliedAtT && appliedAtT.at === T && appliedAtT.seq === 2,
      `实际生效位置 = 目标 ${T}，使用胜出 seq=2`,
    );

    // 捕获与逐样本参考对拍（只比 [T, end)，因为此前系数为空）
    const fs = snap.fs;
    const expected = expectedOutput(
      fs,
      [[T, [0.25, 0.25, 0.25, 0.25]]],
      snap.length,
    );
    const got = new Float64Array(snap.length);
    for (const b of snap.blocks)
      for (let i = 0; i < b.data.length; i++) got[b.from + i] = b.data[i];
    let maxErr = 0,
      errAt = -1;
    for (let t = T; t < snap.length; t++) {
      const e = Math.abs(got[t] - Math.fround(expected[t]));
      if (e > maxErr) {
        maxErr = e;
        errAt = t;
      }
    }
    if (maxErr > 1e-5) {
      // 失配诊断：出错位置的实际窗口落盘，便于定位“用了哪组系数/哪段历史”
      const diag = {
        T,
        length: snap.length,
        errAt,
        maxErr,
        applied: snap.applied,
        acks: snap.acks,
        window: Array.from(got.subarray(Math.max(0, errAt - 12), errAt + 12)),
        refWindow: Array.from(
          Float64Array.from(
            expected.subarray(Math.max(0, errAt - 12), errAt + 12),
          ),
          (v) => Math.fround(v),
        ),
      };
      fsnode.writeFileSync(
        "/tmp/fir-mismatch.json",
        JSON.stringify(diag, null, 1),
      );
    }
    check(
      maxErr <= 1e-5,
      `真实 worklet 输出与逐样本参考一致（[${T},${snap.length}) maxErr=${maxErr.toExponential(2)} @${errAt}）`,
    );
    // 生效前样本不被回写：迟到指令 target=128 处仍为 0（当时是空系数组）
    check(got[128] === 0 && got[129] === 0, "迟到指令不回写已生成样本");
    // 边界样本：T-1 为空组结果（0），T 开始非零（信号非零）
    check(
      got[T - 1] === 0 && got[T] !== 0,
      `换组恰在 T=${T} 计算前一次性完成，边界不混用两组`,
    );

    console.log("== suspend / resume：时钟冻结、历史保留 ==");
    await page.click("#btnSuspend");
    await waitFor(page, () => window.__fir.ctxState() === "suspended", {
      label: "suspended",
    });
    // suspend resolve 时渲染线程可能还有已入队的块消息，取稳定值作为暂停点
    await new Promise((r) => setTimeout(r, 500));
    const pausedLen = (await page.evaluate(() => window.__fir.status())).length;
    // 再等更久确认确实不增长
    await new Promise((r) => setTimeout(r, 400));
    const pausedLen2 = (await page.evaluate(() => window.__fir.status()))
      .length;
    check(
      pausedLen2 === pausedLen,
      `suspend 后处理器时钟冻结（两次读数均为 ${pausedLen}）`,
    );
    // 暂停期间下发未来指令：暂停时时钟冻结；消息可能在 resume 后才被音频线程取走，
    // 但那时 clock 仍等于 pausedLen，裁决与 ack.at 必须一致。
    const T2 = pausedLen + fs0; // 1s 余量，避免 resume/轮询延迟造成迟到
    await page.evaluate(
      ([id, t]) =>
        window.__fir.post({
          kind: "set",
          runId: id,
          seq: 5,
          target: t,
          coeffs: Float32Array.from([1]),
        }),
      [r1, T2],
    );
    await page.click("#btnResume");
    await waitFor(
      page,
      (target) => (window.__fir.status()?.length || 0) >= target,
      { timeout: 20000, label: "post-resume", arg: T2 + 1024 },
    );
    snap = await page.evaluate(() => window.__fir.snapshot());
    const pausedAck = snap.acks.find((a) => a.seq === 5);
    // 暂停时无渲染量子，排队消息可能在 resume 后第一个量子才被取走；
    // at 与 pausedLen 的差至多一个量子，证明时钟正是从暂停点续上。
    check(
      pausedAck?.accepted === true &&
        pausedAck.at >= pausedLen &&
        pausedAck.at <= pausedLen + 128,
      `暂停期间排队的指令以冻结时钟受理（at=${pausedAck?.at}, 暂停点=${pausedLen}）`,
    );
    const ap2 = snap.applied.find((a) => a.seq === 5);
    check(
      ap2 && ap2.at === T2,
      `resume 后在 ${T2} 生效；暂停期间保留的输入历史连续（时钟从 ${pausedLen} 续上）`,
    );
    // 历史连续性：[T2, end) 为 [1] 直通，应等于量化后的确定性信号；T2 之前一刻 FIR 历史仍在
    const got2 = new Float64Array(snap.length);
    for (const b of snap.blocks)
      for (let i = 0; i < b.data.length; i++) got2[b.from + i] = b.data[i];
    let passthroughErr = 0;
    for (let t = T2; t < snap.length; t++)
      passthroughErr = Math.max(
        passthroughErr,
        Math.abs(got2[t] - f32(signal(t, fs))),
      );
    check(
      passthroughErr <= 1e-5,
      `resume 后 [${T2},${snap.length}) 直通输出与确定性信号一致（历史未清空，maxErr=${passthroughErr.toExponential(1)}）`,
    );

    console.log("== WAV 下载（内容为实际捕获） ==");
    // 先挂起上下文让块流静止，保证“下载文件”与“随后读取的处理器回传数据”严格同源
    await page.click("#btnSuspend");
    await waitFor(page, () => window.__fir.ctxState() === "suspended", {
      label: "suspend-for-download",
    });
    await new Promise((r) => setTimeout(r, 400));
    const wavDownloadPromise = page.waitForEvent("download");
    await page.click("#btnDownloadWav");
    const snapWav = await page.evaluate(() => window.__fir.snapshot());
    const download = await wavDownloadPromise;
    const wavPath = await download.path();
    const wav = fsnode.readFileSync(wavPath);
    check(
      wav.toString("ascii", 0, 4) === "RIFF" &&
        wav.toString("ascii", 8, 12) === "WAVE",
      "下载文件为 WAV",
    );
    const channels = wav.readUInt16LE(22);
    const wavFs = wav.readUInt32LE(24);
    const bits = wav.readUInt16LE(34);
    check(
      channels === 1 && wavFs === snapWav.fs && bits === 32,
      `WAV 单声道 / ${wavFs}Hz / 32-bit float`,
    );
    const dataBytes = wav.readUInt32LE(40);
    check(
      dataBytes === snapWav.length * 4,
      `WAV 样本数 ${dataBytes / 4} = 静止时实际捕获长度 ${snapWav.length}`,
    );
    const gotWav = new Float64Array(snapWav.length);
    for (const b of snapWav.blocks)
      for (let i = 0; i < b.data.length; i++) gotWav[b.from + i] = b.data[i];
    let wavErr = 0;
    for (let t = T; t < snapWav.length; t++) {
      wavErr = Math.max(
        wavErr,
        Math.abs(wav.readFloatLE(44 + t * 4) - gotWav[t]),
      );
    }
    check(wavErr === 0, "WAV 逐样本即处理器回传块（无另算/离线卷积）");

    // 为下载而挂起的上下文仍处于 suspended。
    console.log("== 显式重置：新代号隔离，旧代号指令失效 ==");
    // 挂起时消息仅在渲染量子处理；先“重置+恢复”一拍，等新代号真正开始处理后再挂起，
    // 保证随后发的指令一定由新代号裁决。
    await page.click("#btnReset");
    await page.click("#btnResume");
    await waitFor(
      page,
      (oldId) => {
        const ids = window.__fir.listRuns();
        const newId = window.__fir.currentRunId();
        return (
          ids.length >= 2 &&
          newId &&
          newId !== oldId &&
          (window.__fir.status(newId)?.length || 0) >= 128
        );
      },
      { label: "r2-started", arg: r1 },
    );
    const r2 = await page.evaluate(() => window.__fir.currentRunId());
    check(r2 && r2 !== r1, `重置后代号更新 ${r1} -> ${r2}`);
    await page.click("#btnSuspend");
    await waitFor(page, () => window.__fir.ctxState() === "suspended", {
      label: "suspended-after-reset",
    });

    // 冻结态裁决：旧代号指令（未来目标，排除 late 干扰）=> run-mismatch；
    // 新代号指令定未来目标 T0 => 接纳。
    const r2Clock0 = await page.evaluate(
      (rid) => window.__fir.status(rid)?.length,
      r2,
    );
    const T0 = r2Clock0 + 44100;
    await page.evaluate(
      (arg) =>
        window.__fir.post({
          kind: "set",
          runId: arg,
          seq: 7,
          target: 999999,
          coeffs: Float32Array.from([0.5, 0.5]),
        }),
      r1,
    );
    await page.evaluate(
      (arg) =>
        window.__fir.post({
          kind: "set",
          runId: arg.id,
          seq: 7,
          target: arg.t,
          coeffs: Float32Array.from([1]),
        }),
      { id: r2, t: T0 },
    );
    await page.click("#btnResume");
    await waitFor(
      page,
      ([oldId, newId, t0]) => {
        const a = window.__fir.allAcks();
        const st = window.__fir.status(newId);
        return (
          a.some(
            (x) =>
              x.runId === oldId && x.seq === 7 && x.reason === "run-mismatch",
          ) &&
          a.some((x) => x.runId === newId && x.seq === 7 && x.accepted) &&
          (st?.applied || []).some((x) => x.at === t0 && x.seq === 7) &&
          (st?.length || 0) >= t0 + 512
        );
      },
      { timeout: 20000, label: "r2 applied", arg: [r1, r2, T0] },
    );
    const snap2 = await page.evaluate(() => window.__fir.snapshot());
    const allAcks = await page.evaluate(() => window.__fir.allAcks());
    const oldAck = allAcks.find(
      (a) => a.runId === r1 && a.seq === 7 && a.reason === "run-mismatch",
    );
    check(
      oldAck?.accepted === false && oldAck.reason === "run-mismatch",
      "旧代号指令在新一轮被拒绝（run-mismatch），不影响新代号",
    );
    // 重置后时钟确实从 0 开始：捕获块 from 从 0 计
    check(
      snap2.blocks[0].from === 0,
      "新一轮时钟/历史已清空（块从样本 0 重新计数）",
    );
    // T0 起为 [1] 直通：输出 == 量化后的确定性信号（验证跨暂停点历史连续，且无旧代号系数残留）
    const got3 = new Float64Array(snap2.length);
    for (const b of snap2.blocks)
      for (let i = 0; i < b.data.length; i++) got3[b.from + i] = b.data[i];
    let freshErr = 0;
    for (let t = T0; t < snap2.length; t++)
      freshErr = Math.max(
        freshErr,
        Math.abs(got3[t] - f32(signal(t, snap2.fs))),
      );
    check(
      freshErr === 0,
      `新代号自 ${T0} 起直通输出逐样本等于确定性信号（旧代号/旧历史无残留）`,
    );

    console.log("== 实现约束自检 ==");
    const proc = fsnode.readFileSync(
      path.join(ROOT, "src/fir-processor.js"),
      "utf8",
    );
    const engine = fsnode.readFileSync(
      path.join(ROOT, "src/fir-engine.js"),
      "utf8",
    );
    const pageSrc = fsnode.readFileSync(path.join(ROOT, "page.js"), "utf8");
    // 剥离注释后再匹配，避免“禁用词只出现在说明性注释里”误报
    const stripComments = (s) =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const codeOnly = stripComments(proc + "\n" + engine + "\n" + pageSrc);
    check(!/ConvolverNode/i.test(codeOnly), "未使用 ConvolverNode");
    check(
      !/\bFFT\b|createAnalyser|AnalyserNode/.test(codeOnly),
      "未使用 FFT / Analyser",
    );
    check(!/getUserMedia|MediaStream/.test(codeOnly), "未使用麦克风采集");
    check(
      !/\bsetTimeout\s*\(|\bsetInterval\s*\(/.test(
        stripComments(proc + engine),
      ),
      "处理器侧无页面计时器调度",
    );

    check(
      consoleErrs.length === 0,
      `浏览器控制台无错误${consoleErrs.length ? ": " + consoleErrs.join(" | ") : ""}`,
    );
  } catch (e) {
    console.error("E2E 异常:", e);
    process.exitCode = 1;
    failures.push(String(e));
  } finally {
    await browser.close();
    srv.close();
  }

  if (failures.length) {
    console.error(`\n${failures.length} 项失败`);
    process.exit(1);
  }
  console.log("\n全部 E2E 检查通过");
}

main();
