// Promise timeout utility
// Races an existing asynchronous operation against a labeled timer. The
// operation's result or error is preserved when it settles first, and the
// timer is always cleared so completed work does not leave pending callbacks.
export function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
}
