/**
 * Deterministic PRNG for PPT ring generation. Seed equality is DSH-internal;
 * golden fixtures use a committed ring rather than cross-language shuffle parity.
 * @module @deepseek-ai/dsh-verifier/rng
 */

/**
 * Mulberry32 generator seeded from a 32-bit integer.
 * @param seed - integer seed; truncated to uint32.
 * @returns a function yielding values in `[0, 1)`.
 */
export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0
  return (): number => {
    state = (state + 0x6D2B79F5) >>> 0
    let next = Math.imul(state ^ (state >>> 15), 1 | state)
    next ^= next + Math.imul(next ^ (next >>> 7), 61 | next)
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}
