export interface GraphqlPreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly url: string;
  readonly endpoint: string;
  readonly logoDomain?: string;
  readonly featured?: boolean;
}

export const graphqlPresets: readonly GraphqlPreset[] = [
  {
    id: "github-graphql",
    name: "GitHub GraphQL",
    summary: "Repos, issues, PRs, and users via GitHub's GraphQL API.",
    url: "https://api.github.com/graphql",
    endpoint: "https://api.github.com/graphql",
    logoDomain: "github.com",
    featured: true,
  },
  {
    id: "gitlab",
    name: "GitLab",
    summary: "Projects, merge requests, pipelines, and users.",
    url: "https://gitlab.com/api/graphql",
    endpoint: "https://gitlab.com/api/graphql",
    logoDomain: "gitlab.com",
    featured: true,
  },
  {
    id: "linear",
    name: "Linear",
    summary: "Issues, projects, teams, and cycles.",
    url: "https://api.linear.app/graphql",
    endpoint: "https://api.linear.app/graphql",
    logoDomain: "linear.app",
    featured: true,
  },
  {
    id: "monday",
    name: "Monday.com",
    summary: "Boards, items, columns, and workspace automation.",
    url: "https://api.monday.com/v2",
    endpoint: "https://api.monday.com/v2",
    logoDomain: "monday.com",
  },
  {
    id: "anilist",
    name: "AniList",
    summary: "Anime and manga database — no auth required.",
    url: "https://graphql.anilist.co",
    endpoint: "https://graphql.anilist.co",
    logoDomain: "anilist.co",
  },
];
