'use strict';

/**
 * 模块 4：滑动窗口节流器（默认 28 RPM / 60s 窗口）。
 * 满额时排队等待而不是报错；等待可被 AbortSignal 取消。
 * 队列打满（maxWaiters）时直接放行——宁可少节流，也不能把会话卡死。
 */

function createPacer(options = {}) {
  const rpm = Math.max(1, Math.floor(Number(options.rpm) || 1));
  const windowMs = Math.max(1, Math.floor(Number(options.windowMs) || 1));
  const maxWaiters = Math.max(1, Math.floor(Number(options.maxWaiters) || 1));
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const stamps = [];
  let waiting = 0;

  function trim(nowMs) {
    while (stamps.length > 0 && nowMs - stamps[0] >= windowMs) stamps.shift();
  }

  function sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal && signal.aborted) { resolve(false); return; }
      let settled = false;
      const timer = setTimeout(() => finish(true), ms);
      function finish(ok) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(ok);
      }
      function onAbort() { finish(false); }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  return {
    /** @returns {Promise<boolean>} false 表示等待期间被取消 */
    async acquire(signal) {
      if (waiting >= maxWaiters) return true;
      waiting += 1;
      try {
        for (;;) {
          if (signal && signal.aborted) return false;
          const nowMs = now();
          trim(nowMs);
          if (stamps.length < rpm) {
            stamps.push(nowMs);
            return true;
          }
          const waitMs = Math.max(1, windowMs - (nowMs - stamps[0]));
          const slept = await sleep(waitMs, signal);
          if (slept === false) return false;
        }
      } finally {
        waiting -= 1;
      }
    },
    admitted: () => stamps.length,
    waiting: () => waiting,
    rpm: () => rpm,
    windowMs: () => windowMs,
    reset: () => { stamps.length = 0; },
  };
}

module.exports = { createPacer };
