// One budget for every Real-Debrid operation, including failed requests.
export class RateLimitMonitor {
  constructor({ maxRequestsPerMinute = 250, concurrency = 4, maxQueue = 64, now = Date.now } = {}) {
    this.maxRequestsPerMinute = maxRequestsPerMinute;
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
    this.now = now;
    this.requestsPerMinute = [];
    this.rateLimitUntil = 0;
    this.active = 0;
    this.queue = [];
  }

  getCurrentRequestCount() {
    this.requestsPerMinute = this.requestsPerMinute.filter(time => time > this.now() - 60000);
    return this.requestsPerMinute.length;
  }

  getTimeUntilReset() {
    const budgetReset = this.getCurrentRequestCount() >= this.maxRequestsPerMinute
      ? this.requestsPerMinute[0] + 60000 : 0;
    return Math.max(0, this.rateLimitUntil - this.now(), budgetReset - this.now());
  }

  isRateLimited() { return this.getTimeUntilReset() > 0; }
  canMakeRequest() { return !this.isRateLimited(); }
  recordRequest() { this.requestsPerMinute.push(this.now()); }

  markRateLimitHit(retryAfter) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - this.now();
    this.rateLimitUntil = Math.max(this.rateLimitUntil, this.now() + Math.max(60000, delay || 0));
  }

  run(task) {
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(Object.assign(new Error("Upstream request queue is full."), { status: 503 }));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.drain();
    });
  }

  drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const { task, resolve, reject } = this.queue.shift();
      if (!this.canMakeRequest()) {
        reject(Object.assign(new Error("Real-Debrid request limit reached. Please try again later."), {
          status: 429, isRateLimit: true, retryAfter: Math.ceil(this.getTimeUntilReset() / 1000)
        }));
        continue;
      }
      this.recordRequest();
      this.active++;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        this.active--;
        this.drain();
      });
    }
  }
}

export default new RateLimitMonitor();
