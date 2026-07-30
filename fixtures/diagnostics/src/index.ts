type Account = {
  id: string;
  active: boolean;
};

const account: Account = {
  id: 42,
  active: "yes"
};

export const missing = account.name;
