import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  // Only the assertion suite; the demo montage (out/test/demo) is recorded
  // separately via scripts/record_demo.py and must not run in CI.
  files: "out/test/suite/**/*.test.js",
  workspaceFolder: "src/test/fixtures",
  // Treat the fixture workspace as trusted so the binary resolver uses PATH ryl
  // instead of the (absent, in dev) bundled binary.
  launchArgs: ["--disable-workspace-trust"],
  mocha: {
    ui: "tdd",
    timeout: 60000,
  },
});
