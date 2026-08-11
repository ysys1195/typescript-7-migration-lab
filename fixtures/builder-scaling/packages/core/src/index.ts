export type LabRecord<TName extends string, TValue> = {
  id: `${TName}_${string}`;
  name: TName;
  value: TValue;
};

export type ReadonlyRecordMap<T extends { id: string }> = {
  readonly [K in T["id"]]: Extract<T, { id: K }>;
};
