// Shared across sockets: reconnecting must not reset a visitor's send quota.
class SlidingWindowLimiter {
  constructor(maxKeys = 20000) { this.entries = new Map(); this.maxKeys = maxKeys; }
  take(key, max, windowMs, cost = 1, now = Date.now()) {
    const previous = this.entries.get(key);
    const events = previous ? previous.events.filter(event => event.at > now - windowMs) : [];
    if (events.reduce((sum, event) => sum + event.cost, 0) + cost > max) return false;
    if (!previous && this.entries.size >= this.maxKeys) {
      this.sweep(now);
      if (this.entries.size >= this.maxKeys) return false;
    }
    events.push({ at: now, cost });
    this.entries.set(key, { events, expiresAt: now + windowMs });
    return true;
  }
  sweep(now = Date.now()) {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }
}
module.exports = { SlidingWindowLimiter };
