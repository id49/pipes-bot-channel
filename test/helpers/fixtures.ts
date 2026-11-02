import { readFileSync } from "node:fs";

// Load a JSON fixture from test/fixtures/byon-v2/<name>.json.
export function loadFixture(name: string): unknown {
  const url = new URL(`../fixtures/byon-v2/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}
