type Primitive = string | number | boolean | bigint | symbol | null | undefined;

type Paths<T> = T extends Primitive
  ? never
  : {
      [K in keyof T & string]:
        T[K] extends Primitive
          ? K
          : K | `${K}.${Paths<T[K]>}`;
    }[keyof T & string];

type ValueAtPath<T, P extends string> =
  P extends `${infer Head}.${infer Tail}`
    ? Head extends keyof T
      ? ValueAtPath<T[Head], Tail>
      : never
    : P extends keyof T
      ? T[P]
      : never;

type ApiModel = {
  account: {
    profile: {
      name: string;
      preferences: {
        locale: string;
        theme: "light" | "dark";
        notifications: {
          email: boolean;
          push: boolean;
        };
      };
    };
    security: {
      sessions: {
        current: { id: string; createdAt: Date };
        history: readonly { id: string; revoked: boolean }[];
      };
    };
  };
  workspace: {
    projects: Record<string, {
      owner: { id: string; displayName: string };
      settings: { visibility: "public" | "private"; archived: boolean };
    }>;
  };
};

export function readPath<P extends Paths<ApiModel>>(
  value: ApiModel,
  path: P
): ValueAtPath<ApiModel, P> {
  return path.split(".").reduce<unknown>(
    (current, key) => (current as Record<string, unknown>)[key],
    value
  ) as ValueAtPath<ApiModel, P>;
}

export type AllModelPaths = Paths<ApiModel>;
