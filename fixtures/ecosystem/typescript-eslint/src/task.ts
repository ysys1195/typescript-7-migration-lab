export async function readTaskName(task: Promise<{ name: string }>): Promise<string> {
  const result = await task;
  return result.name;
}

void readTaskName(Promise.resolve({ name: "ecosystem-check" }));
