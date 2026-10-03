// Usage: node scripts/changelog-ryl-bump.mjs <extension-version> <ryl-version> <previous-ryl-version>
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const CHANGELOG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "CHANGELOG.md");
const UNRELEASED = "## [Unreleased]";
const BUNDLE_LINE = /^- Bundle ryl \d+\.\d+\.\d+/;

function sectionEnd(lines, start) {
  const next = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return next === -1 ? lines.length : next;
}

/**
 * A new version takes over the [Unreleased] entries and gains a "Bundle ryl" bullet;
 * a version that already has a section (bumped but never tagged) has its existing
 * bullet's ryl version updated in place.
 */
function recordBump(lines, version, ryl, previousRyl) {
  const heading = `## [${version}]`;
  let start = lines.indexOf(heading);
  if (start === -1) {
    const unreleased = lines.indexOf(UNRELEASED);
    if (unreleased === -1) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" heading.`);
    lines.splice(unreleased + 1, 0, "", heading);
    start = unreleased + 2;
  }
  const end = sectionEnd(lines, start);

  const existing = lines.findIndex((line, i) => i > start && i < end && BUNDLE_LINE.test(line));
  if (existing !== -1) {
    lines[existing] = lines[existing].replace(BUNDLE_LINE, `- Bundle ryl ${ryl}`);
    return;
  }
  const bullet = [
    `- Bundle ryl ${ryl} (was ${previousRyl}). See its`,
    `  [release notes](https://github.com/owenlamont/ryl/releases/tag/v${ryl}).`,
  ];
  const changed = lines.findIndex((line, i) => i > start && i < end && line === "### Changed");
  if (changed !== -1) {
    lines.splice(changed + 2, 0, ...bullet);
  } else {
    lines.splice(start + 1, 0, "", "### Changed", "", ...bullet);
  }
}

const [version, ryl, previousRyl] = process.argv.slice(2);
const semver = /^\d+\.\d+\.\d+$/;
if (![version, ryl, previousRyl].every((arg) => semver.test(arg ?? ""))) {
  console.error(
    "Usage: node scripts/changelog-ryl-bump.mjs <extension-version> <ryl-version> <previous-ryl-version>",
  );
  process.exit(1);
}
const lines = fs.readFileSync(CHANGELOG, "utf8").split("\n");
recordBump(lines, version, ryl, previousRyl);
fs.writeFileSync(CHANGELOG, lines.join("\n"));
