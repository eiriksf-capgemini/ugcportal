import { describe, expect, it } from "vitest";

import {
  ConcurrencyLimitError,
  createConcurrencyGate,
} from "@/lib/concurrency-gate";

/**
 * Lets the microtask queue and one macrotask turn drain, so every gate
 * decision that was going to be made has been made before an assertion runs.
 *
 * A bare `await Promise.resolve()` is not enough: the gate's timeout path
 * goes through setTimeout, and a test that only flushed microtasks would
 * assert on a state the gate had not finished settling into.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The error a promise rejected with, failing the test if it resolved. */
async function rejection(
  promise: Promise<unknown>,
): Promise<ConcurrencyLimitError> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (outcome === undefined) {
    throw new Error("expected the call to be rejected, but it resolved");
  }
  return outcome as ConcurrencyLimitError;
}

/**
 * A worker instrumented by the *test*, not by the gate.
 *
 * This is the core of K1. Asserting on the gate's own peakInFlight counter
 * would only prove the gate agrees with itself; this counts entries and exits
 * around the guarded section from the outside, so a gate that admitted
 * everything would be caught. Each task parks on a promise the test resolves
 * by hand, which removes all timing luck: while nothing is released, the
 * number of workers inside the section is exactly the number the gate let in.
 */
function instrumentedWorker() {
  const releases: Array<() => void> = [];
  const state = { inFlight: 0, peak: 0, entered: 0, completed: 0 };

  const task = async () => {
    state.entered += 1;
    state.inFlight += 1;
    if (state.inFlight > state.peak) state.peak = state.inFlight;
    await new Promise<void>((resolve) => {
      releases.push(resolve);
    });
    state.inFlight -= 1;
    state.completed += 1;
  };

  return {
    state,
    task,
    /** Lets `count` of the parked workers finish, oldest first. */
    async release(count: number) {
      for (let i = 0; i < count; i += 1) {
        const next = releases.shift();
        if (!next) throw new Error("nothing parked to release");
        next();
      }
      await settle();
    },
    parked: () => releases.length,
  };
}

describe("createConcurrencyGate", () => {
  it("never lets more than `limit` tasks run at once (K1)", async () => {
    const LIMIT = 3;
    const CALLERS = 12;
    const gate = createConcurrencyGate({
      name: "test",
      limit: LIMIT,
      queueLimit: CALLERS,
      queueTimeoutMs: 60_000,
    });
    const worker = instrumentedWorker();

    const all = Promise.all(
      Array.from({ length: CALLERS }, () => gate.run(worker.task)),
    );
    await settle();

    // Exactly the limit, not merely at most it: `toBeLessThanOrEqual` would
    // also pass for a gate that had serialised everything, or deadlocked
    // after one, and neither of those is the behaviour being specified.
    expect(worker.state.peak).toBe(LIMIT);
    expect(worker.state.inFlight).toBe(LIMIT);
    expect(gate.stats().queued).toBe(CALLERS - LIMIT);

    // Drain one at a time; each freed slot must admit exactly one more, and
    // the section must stay full while there is still a queue.
    for (let drained = 1; drained <= CALLERS; drained += 1) {
      await worker.release(1);
      expect(worker.state.completed).toBe(drained);
      expect(worker.state.inFlight).toBe(
        Math.min(LIMIT, CALLERS - drained),
      );
      expect(worker.state.peak).toBe(LIMIT);
    }

    await all;
    expect(worker.state.entered).toBe(CALLERS);
    expect(worker.state.peak).toBe(LIMIT);
    expect(gate.stats().peakInFlight).toBe(LIMIT);
    expect(gate.stats().inFlight).toBe(0);
    expect(gate.stats().shed).toBe(0);
  });

  it("holds the bound when tasks are released out of step with arrivals", async () => {
    // The test above drains in lockstep. This one releases in uneven batches,
    // which is what actually happens when previews of different sizes finish
    // at different times, and is where an off-by-one in the slot hand-off
    // would show up.
    const LIMIT = 2;
    const gate = createConcurrencyGate({
      name: "test",
      limit: LIMIT,
      queueLimit: 50,
      queueTimeoutMs: 60_000,
    });
    const worker = instrumentedWorker();

    const all = Promise.all(
      Array.from({ length: 9 }, () => gate.run(worker.task)),
    );
    await settle();

    await worker.release(2);
    expect(worker.state.inFlight).toBe(LIMIT);
    await worker.release(1);
    expect(worker.state.inFlight).toBe(LIMIT);
    await worker.release(2);
    expect(worker.state.inFlight).toBe(LIMIT);
    await worker.release(2);
    expect(worker.state.inFlight).toBe(LIMIT);
    await worker.release(2);

    await all;
    expect(worker.state.peak).toBe(LIMIT);
    expect(worker.state.completed).toBe(9);
  });

  it("sheds immediately once the queue is full (K2)", async () => {
    const gate = createConcurrencyGate({
      name: "watermark preview generation",
      limit: 1,
      queueLimit: 1,
      queueTimeoutMs: 60_000,
    });
    const worker = instrumentedWorker();

    const running = gate.run(worker.task);
    const queued = gate.run(worker.task);
    await settle();

    const error = await rejection(gate.run(worker.task));
    expect(error).toBeInstanceOf(ConcurrencyLimitError);
    expect(error.reason).toBe("queue-full");
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
    expect(error.message).toContain("watermark preview generation");

    // The rejected caller must not have run the task at all — a shed upload
    // that still burned the memory would defeat the point.
    expect(worker.state.entered).toBe(1);

    await worker.release(1);
    await worker.release(1);
    await Promise.all([running, queued]);
    expect(worker.state.peak).toBe(1);
    expect(gate.stats().shed).toBe(1);
  });

  it("times out a queued caller rather than waiting forever (K2)", async () => {
    const gate = createConcurrencyGate({
      name: "test",
      limit: 1,
      queueLimit: 10,
      queueTimeoutMs: 20,
      retryAfterSeconds: 7,
    });
    const worker = instrumentedWorker();

    const running = gate.run(worker.task);
    await settle();

    const error = await rejection(gate.run(worker.task));
    expect(error).toBeInstanceOf(ConcurrencyLimitError);
    expect(error.reason).toBe("timeout");
    expect(error.retryAfterSeconds).toBe(7);
    expect(worker.state.entered).toBe(1);
    expect(gate.stats().queued).toBe(0);

    await worker.release(1);
    await running;
  });

  it("lets a queued caller through when a slot frees inside the timeout (K2)", async () => {
    const gate = createConcurrencyGate({
      name: "test",
      limit: 1,
      queueLimit: 10,
      queueTimeoutMs: 5_000,
    });
    const worker = instrumentedWorker();

    const running = gate.run(worker.task);
    await settle();
    const queued = gate.run(worker.task);
    await settle();
    expect(worker.state.entered).toBe(1);

    await worker.release(1);
    expect(worker.state.entered).toBe(2);
    await worker.release(1);
    await Promise.all([running, queued]);
    expect(worker.state.peak).toBe(1);
    expect(gate.stats().shed).toBe(0);
  });

  it("releases the slot when the task throws", async () => {
    const gate = createConcurrencyGate({
      name: "test",
      limit: 1,
      queueLimit: 0,
      queueTimeoutMs: 1_000,
    });

    await expect(
      gate.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // A leaked slot would make this one shed instead of running.
    await expect(gate.run(async () => "ok")).resolves.toBe("ok");
    expect(gate.stats().inFlight).toBe(0);
    expect(gate.stats().shed).toBe(0);
  });

  it("with queueLimit 0 degenerates to pure load shedding", async () => {
    const gate = createConcurrencyGate({
      name: "test",
      limit: 1,
      queueLimit: 0,
      queueTimeoutMs: 1_000,
    });
    const worker = instrumentedWorker();

    const running = gate.run(worker.task);
    await settle();
    await expect(gate.run(worker.task)).rejects.toMatchObject({
      reason: "queue-full",
    });

    await worker.release(1);
    await running;
  });

  it("clamps nonsensical options instead of trusting them", async () => {
    // A misconfigured WATERMARK_MAX_CONCURRENCY of 0 must not mean "no
    // previews ever"; a negative queue must not mean "negative capacity".
    const gate = createConcurrencyGate({
      name: "test",
      limit: 0,
      queueLimit: -5,
      queueTimeoutMs: 0,
    });
    expect(gate.stats().limit).toBe(1);
    expect(gate.stats().queueLimit).toBe(0);
    await expect(gate.run(async () => "ok")).resolves.toBe("ok");
  });
});
