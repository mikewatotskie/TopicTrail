export function photoCancelled(): Error {
  const error = new Error('Photo operation was cancelled.');
  error.name = 'AbortError';
  return error;
}

export function checkPhotoSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw photoCancelled();
}

/** Prompt cancellation, with disposal for resources returned after cancellation. */
export function abortablePhoto<T>(operation: Promise<T>, signal?: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const abort = () => { if (!finished) { finished = true; signal?.removeEventListener('abort', abort); reject(photoCancelled()); } };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    operation.then(value => {
      if (finished) { late?.(value); return; }
      finished = true; signal?.removeEventListener('abort', abort); resolve(value);
    }, reason => {
      if (finished) return;
      finished = true; signal?.removeEventListener('abort', abort); reject(reason);
    });
  });
}
