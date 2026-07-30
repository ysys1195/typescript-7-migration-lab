export type Entity<T extends string, P> = {
  id: `${T}_${string}`;
  type: T;
  payload: P;
};

export function indexById<T extends { id: string }>(
  values: readonly T[]
): Record<string, T> {
  return Object.fromEntries(values.map((value) => [value.id, value]));
}
