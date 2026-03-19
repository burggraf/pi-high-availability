// Mirrors pi's internal resolveConfigValue — "!" prefix executes a shell command.
// Reimplemented to avoid depending on pi's unexported internal module paths.
import { execSync, spawnSync } from "child_process";
import { join } from "path";
import { homedir } from "os";

const cache = new Map<string, string | undefined>();

export function resolveSecret(value?: string): string | undefined {
  if (!value || !value.startsWith("!")) return value;
  if (cache.has(value)) return cache.get(value);

  let result: string | undefined;
  try {
    result = execSync(value.slice(1), {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    result = undefined;
  }
  cache.set(value, result);
  return result;
}

// Compare a stored field (may be "!pass show …") against a resolved value from auth.json.
export function credValueMatches(stored?: string, resolved?: string): boolean {
  if (!stored || !resolved) return false;
  if (stored === resolved) return true;
  return (resolveSecret(stored) ?? stored) === (resolveSecret(resolved) ?? resolved);
}

/**
 * Find pass entries whose path contains the given query string.
 * Returns paths relative to the password store (e.g. "api/anthropic/api-key").
 * Returns [] if pass is not installed or the store doesn't exist.
 */
export function findPassEntries(query: string): string[] {
  const storeDir = join(homedir(), ".password-store");
  try {
    const result = spawnSync("find", [storeDir, "-name", "*.gpg", "-ipath", `*${query}*`], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout.trim().split("\n")
      .filter(Boolean)
      .map((p: string) => p.replace(storeDir + "/", "").replace(/\.gpg$/, ""));
  } catch {
    return [];
  }
}
