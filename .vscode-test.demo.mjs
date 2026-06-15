import { defineConfig } from "@vscode/test-cli";

// Runs only the demo montage (src/test/demo) for screen recording. Driven by
// scripts/record-demo.sh on a headless Xvfb display.
export default defineConfig({
  files: "out/test/demo/**/*.test.js",
  workspaceFolder: "src/test/demo-workspace",
  launchArgs: ["--disable-workspace-trust"],
  mocha: {
    ui: "tdd",
    timeout: 300000,
  },
});
