// Download a pinned ryl release binary into bundled/ for packaging into the
// per-platform .vsix. Each downloaded asset is verified against a committed
// SHA-256 (scripts/ryl-checksums.json) before extraction, so a release tampered
// with after pin-time fails the build. Usage:
//   node scripts/download-ryl.mjs                 # current host platform
//   node scripts/download-ryl.mjs --target <code-target>
//   node scripts/download-ryl.mjs --update-checksums   # regenerate the pins
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Pinned ryl version. Bump in lockstep with the binary you intend to ship, then
// regenerate the checksums (see --update-checksums).
const RYL_VERSION = "0.18.1";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = path.join(SCRIPT_DIR, "..", "bundled");
const CHECKSUMS_FILE = path.join(SCRIPT_DIR, "ryl-checksums.json");
const RELEASE_BASE = `https://github.com/owenlamont/ryl/releases/download/v${RYL_VERSION}`;

// VS Code platform target -> ryl release asset + the binary name inside it.
// Linux and Alpine share the static musl builds; armhf uses the gnueabihf build.
// ryl ships no x86_64-apple-darwin (Intel macOS) binary, so darwin-x64 has no
// target; re-add it once ryl publishes that asset.
const TARGETS = {
  "win32-x64": { asset: "ryl-x86_64-pc-windows-msvc.zip", binary: "ryl.exe" },
  "win32-arm64": { asset: "ryl-aarch64-pc-windows-msvc.zip", binary: "ryl.exe" },
  "darwin-arm64": { asset: "ryl-aarch64-apple-darwin.tar.gz", binary: "ryl" },
  "linux-x64": { asset: "ryl-x86_64-unknown-linux-musl.tar.gz", binary: "ryl" },
  "linux-arm64": { asset: "ryl-aarch64-unknown-linux-musl.tar.gz", binary: "ryl" },
  "linux-armhf": { asset: "ryl-armv7-unknown-linux-gnueabihf.tar.gz", binary: "ryl" },
  "alpine-x64": { asset: "ryl-x86_64-unknown-linux-musl.tar.gz", binary: "ryl" },
  "alpine-arm64": { asset: "ryl-aarch64-unknown-linux-musl.tar.gz", binary: "ryl" },
};

function distinctAssets() {
  return [...new Set(Object.values(TARGETS).map((entry) => entry.asset))].sort();
}

function currentTarget() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "win32" && arch === "x64") return "win32-x64";
  if (platform === "win32" && arch === "arm64") return "win32-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  throw new Error(`No bundled ryl mapping for ${platform}-${arch}; pass --target.`);
}

async function downloadWithRetry(url, dest, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": "ryl-vscode-download-script" },
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} ${response.statusText}`);
        // A 4xx (e.g. a wrong asset name after a version bump) will never
        // succeed on retry, so surface it immediately instead of looping.
        if (response.status >= 400 && response.status < 500) {
          error.fatal = true;
        }
        throw error;
      }
      fs.writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      lastError = error;
      if (error.fatal) {
        break;
      }
      console.warn(`Attempt ${attempt}/${attempts} failed: ${error.message ?? error}`);
    }
  }
  throw new Error(`Failed to download ${url}: ${lastError?.message ?? lastError}`);
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function loadChecksums() {
  if (!fs.existsSync(CHECKSUMS_FILE)) {
    throw new Error(
      "Missing ryl-checksums.json. Generate it with: node scripts/download-ryl.mjs --update-checksums",
    );
  }
  const data = JSON.parse(fs.readFileSync(CHECKSUMS_FILE, "utf8"));
  if (data.version !== RYL_VERSION) {
    throw new Error(
      `ryl-checksums.json is for ryl ${data.version} but RYL_VERSION is ${RYL_VERSION}; regenerate with --update-checksums.`,
    );
  }
  return data.assets ?? {};
}

function extract(archivePath, asset, destDir) {
  if (asset.endsWith(".tar.gz")) {
    execFileSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "inherit" });
  } else if (asset.endsWith(".zip")) {
    // Windows .zip assets are extracted on a Windows runner (PowerShell). The
    // unzip fallback only matters when packaging a Windows target off-Windows.
    if (process.platform === "win32") {
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
        ],
        { stdio: "inherit" },
      );
    } else {
      execFileSync("unzip", ["-o", archivePath, "-d", destDir], { stdio: "inherit" });
    }
  } else {
    throw new Error(`Unsupported archive type for ${asset}`);
  }
}

async function updateChecksums() {
  fs.mkdirSync(BUNDLED_DIR, { recursive: true });
  const assets = {};
  for (const asset of distinctAssets()) {
    const dest = path.join(BUNDLED_DIR, asset);
    const url = `${RELEASE_BASE}/${asset}`;
    console.log(`Hashing ${url}`);
    await downloadWithRetry(url, dest);
    assets[asset] = sha256(dest);
    fs.rmSync(dest, { force: true });
  }
  fs.writeFileSync(
    CHECKSUMS_FILE,
    `${JSON.stringify({ version: RYL_VERSION, assets }, null, 2)}\n`,
  );
  console.log(`Wrote ${Object.keys(assets).length} checksums to ${CHECKSUMS_FILE}`);
}

async function downloadTarget(target) {
  const entry = TARGETS[target];
  if (!entry) {
    throw new Error(`Unknown target "${target}". Valid: ${Object.keys(TARGETS).join(", ")}`);
  }
  const expected = loadChecksums()[entry.asset];
  if (!expected) {
    throw new Error(`No checksum recorded for ${entry.asset}; regenerate with --update-checksums.`);
  }

  fs.rmSync(BUNDLED_DIR, { recursive: true, force: true });
  fs.mkdirSync(BUNDLED_DIR, { recursive: true });

  const archivePath = path.join(BUNDLED_DIR, entry.asset);
  const url = `${RELEASE_BASE}/${entry.asset}`;
  console.log(`Downloading ryl ${RYL_VERSION} for ${target}: ${url}`);
  await downloadWithRetry(url, archivePath);

  const actual = sha256(archivePath);
  if (actual !== expected) {
    fs.rmSync(archivePath, { force: true });
    throw new Error(
      `Checksum mismatch for ${entry.asset}:\n  expected ${expected}\n  actual   ${actual}`,
    );
  }

  extract(archivePath, entry.asset, BUNDLED_DIR);
  fs.rmSync(archivePath, { force: true });

  const binaryPath = path.join(BUNDLED_DIR, entry.binary);
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Expected "${entry.binary}" inside ${entry.asset} but it was not found`);
  }
  if (process.platform !== "win32") {
    fs.chmodSync(binaryPath, 0o755);
  }
  fs.writeFileSync(
    path.join(BUNDLED_DIR, "version.json"),
    `${JSON.stringify({ version: RYL_VERSION, target, asset: entry.asset }, null, 2)}\n`,
  );
  console.log(`Bundled ${entry.binary} (ryl ${RYL_VERSION}) at ${binaryPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--update-checksums")) {
    await updateChecksums();
    return;
  }
  const targetFlag = args.indexOf("--target");
  if (targetFlag !== -1 && !args[targetFlag + 1]) {
    throw new Error("--target requires a value (e.g. --target linux-x64)");
  }
  await downloadTarget(targetFlag !== -1 ? args[targetFlag + 1] : currentTarget());
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
