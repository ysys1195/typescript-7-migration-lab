// @ts-check

/**
 * @template T
 * @param {readonly T[]} values
 * @param {(value: T) => boolean} predicate
 * @returns {T | undefined}
 */
export function first(values, predicate) {
  return values.find(predicate);
}

/** @type {readonly number[]} */
export const scores = [10, 20, 30];
