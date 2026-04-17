import { defineConfig } from "@vscode/test-cli";
import path from "path";

export default defineConfig({
  files: "out/test/**/*.test.js",
  mocha: {
    ui: "bdd",
    timeout: 30000,
  },
  workspaceFolder: "test-workspace",
  version: "stable",
  extensionDevelopmentPath: path.resolve("./"),
  launchArgs: ["--disable-extensions"],
});
