/**
 * A single-process bound on how many instances of an expensive async
 * operation may run at once (ugcportal-e86).
 *
 * Generic on purpose: the policy decisions (what the limit is, how deep the
 * queue goes, how long a caller may wait) belong to the caller that knows
 * what resource is being protected. This module owns only the mechanism, and
 * is therefore testable without touching sharp, images or HTTP.
 *
 * Scope: one process. It is not a distributed rate limiter, and N replicas
 * behind a load balancer get N times this bound — which is correct, because
 * what it protects is one container's memory, and each replica has its own.
 */

export type ConcurrencyLimitReason = "queue-full" | "timeout";

/**
 * The gate refused to run the task. The gate only ever raises this *instead
 * of* calling the task, so it distinguishes "we were too busy to try" from
 * "we tried and it failed", and the two can map to different HTTP statuses.
 * (A task that threw this type itself would be indistinguishable — nothing
 * here can prevent that, and no task in this repo does.)
 */
export class ConcurrencyLimitError extends Error {
  readonly reason: ConcurrencyLimitReason;
  /** Suggested backoff, suitable for a Retry-After header. */
  readonly retryAfterSeconds: number;

  constructor(
    message: string,
    options: { reason: ConcurrencyLimitReason; retryAfterSeconds: number },
  ) {
    super(message);
    this.name = "ConcurrencyLimitError";
    this.reason = options.reason;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export interface ConcurrencyGateOptions {
  /** Used in error messages so a log line says which pool was saturated. */
  name: string;
  /** Maximum tasks running at once. Clamped to at least 1. */
  limit: number;
  /**
   * Maximum callers allowed to wait for a slot. 0 means pure load shedding:
   * anything arriving while the gate is full is rejected immediately.
   */
  queueLimit: number;
  /** How long a queued caller may wait before it is rejected. */
  queueTimeoutMs: number;
  /** Defaults to the queue timeout, rounded up to whole seconds. */
  retryAfterSeconds?: number;
}

export interface ConcurrencyGateStats {
  limit: number;
  queueLimit: number;
  /** Tasks holding a slot right now. Never exceeds `limit`. */
  inFlight: number;
  /** Callers waiting for a slot right now. Never exceeds `queueLimit`. */
  queued: number;
  /** Highest `inFlight` ever observed. The number this gate exists to bound. */
  peakInFlight: number;
  /** Tasks that were let through, cumulative. */
  admitted: number;
  /** Callers rejected with a {@link ConcurrencyLimitError}, cumulative. */
  shed: number;
  /**
   * How long the longest-running in-flight task has held its slot, in
   * milliseconds; 0 when nothing is running.
   *
   * Exposed because the gate deliberately does *not* time admitted tasks
   * out — see {@link ConcurrencyGate.run} — so this is the only way to
   * notice a wedged one. A value far above the expected task duration means
   * a slot is not coming back, and on a small `limit` that is
   * indistinguishable from the service being down. A health check can read
   * it; nothing in the gate acts on it.
   */
  longestRunningMs: number;
}

export interface ConcurrencyGate {
  /**
   * Runs `task` once a slot is free, releasing the slot whether it resolves
   * or rejects. Rejects with {@link ConcurrencyLimitError} — without ever
   * calling `task` — if the queue is full or the wait times out.
   *
   * The timeout applies to *waiting*, not to running. An admitted task has
   * no deadline, and that is deliberate rather than an omission: the task
   * this gate was built for is a native libvips call that cannot be
   * cancelled from JavaScript. A deadline could only abandon the promise,
   * not the operation, so it would hand the slot to a new caller while the
   * old one still held its hundreds of megabytes — converting a stuck
   * request into the memory overshoot the gate exists to prevent. The
   * honest trade is that a genuinely wedged task holds its slot until the
   * process restarts; {@link ConcurrencyGateStats.longestRunningMs} is there
   * so that is detectable rather than silent.
   */
  run<T>(task: () => Promise<T>): Promise<T>;
  stats(): ConcurrencyGateStats;
}

interface Waiter {
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  admit: () => void;
  reject: (error: Error) => void;
}

export function createConcurrencyGate(
  options: ConcurrencyGateOptions,
): ConcurrencyGate {
  const limit = Math.max(1, Math.floor(options.limit));
  const queueLimit = Math.max(0, Math.floor(options.queueLimit));
  // A zero timeout would make every queued caller time out on the next
  // macrotask, i.e. a queue that exists but never works. If you want pure
  // shedding, that is what queueLimit: 0 is for.
  const queueTimeoutMs = Math.max(1, Math.floor(options.queueTimeoutMs));
  const retryAfterSeconds = Math.max(
    1,
    Math.floor(options.retryAfterSeconds ?? Math.ceil(queueTimeoutMs / 1000)),
  );

  let inFlight = 0;
  let peakInFlight = 0;
  let admitted = 0;
  let shed = 0;
  const waiters: Waiter[] = [];

  // Start times of the tasks currently holding a slot, keyed by a run id so
  // two tasks starting in the same millisecond stay distinct. Only used to
  // compute longestRunningMs; see the note on run().
  let nextRunId = 0;
  const startedAt = new Map<number, number>();

  function occupySlot(): void {
    inFlight += 1;
    admitted += 1;
    if (inFlight > peakInFlight) peakInFlight = inFlight;
  }

  function releaseSlot(): void {
    const next = waiters.shift();
    if (!next) {
      inFlight -= 1;
      return;
    }
    // Hand the slot straight to the next waiter instead of decrementing and
    // letting it re-check. Decrementing first would open a window in which
    // inFlight < limit while a waiter is still queued, and a caller arriving
    // in that window would jump the queue — and, worse, could push inFlight
    // back to limit before the waiter resumed, so the waiter would have to go
    // round again while strictly older than the caller that overtook it.
    next.settled = true;
    if (next.timer) clearTimeout(next.timer);
    admitted += 1;
    next.admit();
  }

  function acquire(): Promise<void> {
    if (inFlight < limit) {
      occupySlot();
      return Promise.resolve();
    }

    if (waiters.length >= queueLimit) {
      shed += 1;
      return Promise.reject(
        new ConcurrencyLimitError(
          `${options.name} is at capacity (${limit} running, ${waiters.length} queued); try again shortly`,
          { reason: "queue-full", retryAfterSeconds },
        ),
      );
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        settled: false,
        timer: undefined,
        admit: () => resolve(),
        reject,
      };
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        shed += 1;
        reject(
          new ConcurrencyLimitError(
            `${options.name} did not free a slot within ${queueTimeoutMs}ms; try again shortly`,
            { reason: "timeout", retryAfterSeconds },
          ),
        );
      }, queueTimeoutMs);
      // Don't hold the event loop open just because something is queued.
      waiter.timer.unref?.();
      waiters.push(waiter);
    });
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      const runId = (nextRunId += 1);
      startedAt.set(runId, Date.now());
      try {
        return await task();
      } finally {
        startedAt.delete(runId);
        releaseSlot();
      }
    },
    stats: () => {
      let longestRunningMs = 0;
      if (startedAt.size > 0) {
        const now = Date.now();
        for (const started of startedAt.values()) {
          const age = now - started;
          if (age > longestRunningMs) longestRunningMs = age;
        }
      }
      return {
        limit,
        queueLimit,
        inFlight,
        queued: waiters.length,
        peakInFlight,
        admitted,
        shed,
        longestRunningMs,
      };
    },
  };
}
