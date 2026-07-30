export type Project = {
  id: `project_${string}`;
  name: string;
  archived: boolean;
};

export function activeProjects(projects: readonly Project[]): Project[] {
  return projects.filter((project) => !project.archived);
}
