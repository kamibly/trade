// Sliding-window limiter for APIs that count credits per minute (Twelve Data's
// free plan allows 8). `take(n)` resolves once n credits fit in the window.
export class CreditLimiter {
  constructor(perWindow, windowMs = 60000, { now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    this.perWindow = perWindow;
    this.windowMs = windowMs;
    this.now = now;
    this.sleep = sleep;
    this.spent = []; // [{ at, n }]
    this.queue = Promise.resolve();
  }

  used(at = this.now()) {
    this.spent = this.spent.filter(s => at - s.at < this.windowMs);
    return this.spent.reduce((sum, s) => sum + s.n, 0);
  }

  // Milliseconds until n credits are free (0 = now).
  waitFor(n, at = this.now()) {
    const need = Math.min(n, this.perWindow);
    let free = this.perWindow - this.used(at);
    if (free >= need) return 0;
    for (const s of this.spent) {
      free += s.n;
      if (free >= need) return s.at + this.windowMs - at;
    }
    return this.windowMs;
  }

  // `signal` (an AbortSignal) cancels a caller still waiting, without spending credits.
  take(n = 1, signal) {
    // Callers are served in order, so a big batch is not starved by small ones.
    const turn = this.queue.then(async () => {
      for (let wait = this.waitFor(n); wait > 0; wait = this.waitFor(n)) {
        if (signal && signal.aborted) break;
        await this.sleep(Math.min(wait, 1000));
      }
      if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      this.spent.push({ at: this.now(), n: Math.min(n, this.perWindow) });
    });
    this.queue = turn.catch(() => {});
    return turn;
  }

  // Report a 429 from the server: treat the window as full for a while.
  penalize(at = this.now()) {
    this.spent.push({ at, n: this.perWindow });
  }
}
