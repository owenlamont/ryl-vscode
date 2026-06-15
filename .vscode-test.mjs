import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "out/test/**/*.test.js",
  workspaceFolder: "src/test/fixtures",
  // Treat the fixture workspace as trusted so the binary resolver uses PATH ryl
  // instead of the (absent, in dev) bundled binary.
  launchArgs: ["--disable-workspace-trust"],
  mocha: {
    ui: "tdd",
    timeout: 60000,
  },
});
