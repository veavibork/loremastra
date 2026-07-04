import path from "node:path";

/** Override with LOREMASTER_DATA_DIR for offline/vm-sync experiments without touching live local DBs. */
export function dataDir(): string {
  return path.resolve(process.cwd(), process.env.LOREMASTER_DATA_DIR ?? "data");
}

export function storiesDir(): string {
  return path.join(dataDir(), "stories");
}

export function globalDbPath(): string {
  return path.join(dataDir(), "global.sqlite");
}

export function storyDbPath(storyId: string): string {
  return path.join(storiesDir(), `${storyId}.sqlite`);
}
