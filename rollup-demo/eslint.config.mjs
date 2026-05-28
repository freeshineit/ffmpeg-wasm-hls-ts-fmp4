// import js from '@eslint/js';
// import globals from 'globals';
// import reactHooks from 'eslint-plugin-react-hooks';
// import reactRefresh from 'eslint-plugin-react-refresh';
import { defineConfig, globalIgnores } from "eslint/config";
import configs from "eslint-config-xx";

export default defineConfig([
  globalIgnores(["dist", "build"]),
  ...configs,
  {
    files: ["src/utils/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    rules: {
      "no-unused-vars": ["warn", { varsIgnorePattern: "^[A-Z_]" }],
      "@typescript-eslint/no-unused-vars": ["warn"],
    },
  },
]);
