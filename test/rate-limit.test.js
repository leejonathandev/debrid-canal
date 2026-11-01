import test from "node:test";
import assert from "node:assert/strict";
import { RateLimitMonitor } from "../src/services/rateLimitMonitor.js";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("the upstream gate bounds concurrency and counts failed attempts", async () => {
  const monitor = new RateLimitMonitor({ concurrency: 2 });
  const gate = deferred();
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 5 }, (_, i) => monitor.run(async () => {
    peak = Math.max(peak, ++running);
    await gate.promise;
    running--;
    if (i === 3) throw new Error("upstream failure");
    return i;
  }));
  await Promise.resolve();
  assert.equal(running, 2);
  gate.resolve();
  const results = await Promise.allSettled(tasks);
  assert.equal(peak, 2);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.equal(monitor.getCurrentRequestCount(), 5);
});

test("requests beyond the budget never dispatch and become available after reset", async () => {
  let now = 100000;
  const monitor = new RateLimitMonitor({ maxRequestsPerMinute: 2, now: () => now });
  let calls = 0;
  await monitor.run(() => calls++);
  await monitor.run(() => calls++);
  await assert.rejects(monitor.run(() => calls++), error => error.status === 429 && error.retryAfter === 60);
  assert.equal(calls, 2);
  now += 60001;
  await monitor.run(() => calls++);
  assert.equal(calls, 3);
});

test("429 cooldown blocks already queued work and honors Retry-After", async () => {
  let now = 100000;
  const monitor = new RateLimitMonitor({ concurrency: 1, now: () => now });
  let calls = 0;
  const first = monitor.run(() => { calls++; monitor.markRateLimitHit("120"); });
  const next = monitor.run(() => calls++);
  const rejected = assert.rejects(next, error => error.status === 429 && error.retryAfter === 120);
  await first;
  await rejected;
  assert.equal(calls, 1);
  now += 120001;
  await monitor.run(() => calls++);
  assert.equal(calls, 2);
});

test("the request queue is bounded", async () => {
  const monitor = new RateLimitMonitor({ concurrency: 1, maxQueue: 1 });
  const gate = deferred();
  const first = monitor.run(() => gate.promise);
  const second = monitor.run(() => 2);
  await assert.rejects(monitor.run(() => 3), error => error.status === 503);
  gate.resolve();
  await Promise.all([first, second]);
});
