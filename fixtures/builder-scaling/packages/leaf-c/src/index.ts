export type RouteParameters<T extends string> =
  T extends `${string}:${infer Parameter}/${infer Rest}`
    ? Parameter | RouteParameters<Rest>
    : T extends `${string}:${infer Parameter}`
      ? Parameter
      : never;

export function route<T extends string>(pattern: T): T {
  return pattern;
}
