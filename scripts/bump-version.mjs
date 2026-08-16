/**
 * Bumps the version in package.json.
 *
 * The version must move on every commit: minor for a functional change,
 * patch for a fix or a subtle adjustment. Which of those a change is cannot be
 * decided by a script — it is a judgement about what the change means to
 * someone using the app — so this does the mechanical part and the choice stays
 * with whoever is committing.
 *
 * `scripts/pre-commit` refuses a commit whose version has not moved, so
 * forgetting is caught rather than discovered later.
 *
 * Usage: node scripts/bump-version.mjs minor|patch
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(root, "package.json");

const kind = process.argv[2];
if (kind !== "minor" && kind !== "patch") {
  console.error("usage: node scripts/bump-version.mjs minor|patch");
  console.error("  minor  a functional change — new behaviour, changed rules");
  console.error("  patch  a fix, or a subtle adjustment to something existing");
  process.exit(1);
}

const raw = readFileSync(packagePath, "utf8");
const pkg = JSON.parse(raw);
const [major, minor, patch] = pkg.version.split(".").map(Number);

if ([major, minor, patch].some((n) => !Number.isInteger(n))) {
  console.error(`cannot parse version "${pkg.version}" as major.minor.patch`);
  process.exit(1);
}

const next = kind === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;

// Rewritten by hand rather than through JSON.stringify so the file keeps its
// existing formatting and the diff is the one line that actually changed.
writeFileSync(packagePath, raw.replace(`"version": "${pkg.version}"`, `"version": "${next}"`));

console.log(`${pkg.version} -> ${next}`);
