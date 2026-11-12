// Every link that embeds a stored id goes through here so ids containing `/`, `#`, `?` or `%` stay one path segment.
export const matchPath = (id: string) => `/matches/${encodeURIComponent(id)}`;
export const matchLivePath = (id: string) => `${matchPath(id)}/live`;
export const matchRecordPath = (id: string) => `${matchPath(id)}/record`;
export const draftPath = (id: string) => `/voice/${encodeURIComponent(id)}`;
