export type EventPayload<T extends string> = {
  [K in T as `on${Capitalize<K>}`]: (value: { type: K }) => void;
};

export function eventNames<T extends string>(values: readonly T[]): T[] {
  return [...values];
}
