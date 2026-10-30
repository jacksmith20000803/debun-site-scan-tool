'use strict';

function makeAbortError(reason) {
  if (reason instanceof Error) {
    if (reason.name !== 'AbortError') reason.name = 'AbortError';
    return reason;
  }
  const error = new Error(reason == null ? 'The operation was stopped.' : String(reason));
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw makeAbortError(signal.reason);
}

function isAbortError(error, signal) {
  return Boolean(signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR');
}

function raceWithSignal(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); reject(makeAbortError(signal.reason)); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function combineAbortSignals(...signals) {
  const active = signals.filter(Boolean);
  if (active.length === 1) return { signal: active[0], dispose() {} };
  const controller = new AbortController();
  const listeners = [];
  const dispose = () => {
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    listeners.length = 0;
  };
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      dispose();
      break;
    }
    const listener = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
      dispose();
    };
    listeners.push([signal, listener]);
    signal.addEventListener('abort', listener, { once: true });
  }
  return { signal: controller.signal, dispose };
}

module.exports = { makeAbortError, throwIfAborted, isAbortError, raceWithSignal, combineAbortSignals };
