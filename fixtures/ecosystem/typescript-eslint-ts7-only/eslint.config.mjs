import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

const fixtureRoot = fileURLToPath(new URL(".", import.meta.url));

export default tseslint.config({
  files: ["src/**/*.ts"],
  plugins: {
    "@typescript-eslint": tseslint.plugin
  },
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: true,
      tsconfigRootDir: fixtureRoot
    }
  },
  rules: {
    "@typescript-eslint/no-floating-promises": "error"
  }
});
