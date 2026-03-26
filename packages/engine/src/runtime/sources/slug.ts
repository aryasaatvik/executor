const slugifyRegex = /[^a-z0-9]+/g;

export const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(slugifyRegex, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
