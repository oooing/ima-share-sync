import tsParser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: ["dist/**", "node_modules/**", "tests/**"],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    rules: {
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: ["IMA Share Sync", "IMA", "PowerShell", "LocalAppData", "Windows", "Obsidian", "Markdown"],
        },
      ],
      "obsidianmd/settings-tab/prefer-setting-definitions": "error",
    },
  },
]);
