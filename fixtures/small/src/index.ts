type User = {
  id: string;
  name: string;
  roles: readonly ("admin" | "member")[];
};

export function canEdit(user: User): boolean {
  return user.roles.includes("admin");
}

export const users = [
  { id: "1", name: "Ada", roles: ["admin"] },
  { id: "2", name: "Grace", roles: ["member"] }
] satisfies readonly User[];
