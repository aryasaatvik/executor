// Both observer sinks track per-execution start times in a Map so a Finished
// event can compute the elapsed duration. An execution killed before its
// Finished event (process signal, VM timeout, hard shutdown) would otherwise
// leak its entry forever in a long-lived host. `rememberStart` bounds the Map:
// when it's at capacity and the key is new, the oldest entry (insertion-order
// first) is evicted — so a steady stream of orphaned starts can't grow without
// limit.

const MAX_TRACKED = 10_000;

export const rememberStart = <K, V>(map: Map<K, V>, key: K, value: V): void => {
  if (map.size >= MAX_TRACKED && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
};
