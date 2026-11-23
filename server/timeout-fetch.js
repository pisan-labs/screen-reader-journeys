// fetch with a time limit, for the Supabase clients: one stuck request must not stall the only
// worker for good. A caller's own signal still works alongside the limit.

export function timeoutFetch(ms, baseFetch = globalThis.fetch) {
  return (input, init = {}) => {
    const limit = AbortSignal.timeout(ms);
    const signal = init.signal ? AbortSignal.any([init.signal, limit]) : limit;
    return baseFetch(input, { ...init, signal });
  };
}
