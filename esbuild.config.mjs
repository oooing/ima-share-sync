import { watch as watchFiles } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import process from "node:process";
import * as esbuild from "esbuild";

const production = process.argv.includes("production");
const watchMode = process.argv.includes("watch");
const staticFiles = new Set(["manifest.json", "styles.css"]);
const pendingCopies = new Map();

async function copyStaticFile(fileName) {
  await copyFile(fileName, "dist/" + fileName);
  console.log("Copied " + fileName + " to dist");
}

function scheduleStaticCopy(fileName) {
  const previous = pendingCopies.get(fileName);
  if (previous) clearTimeout(previous);
  pendingCopies.set(
    fileName,
    setTimeout(() => {
      pendingCopies.delete(fileName);
      copyStaticFile(fileName).catch((error) => {
        console.error("Failed to copy " + fileName + ":", error);
        process.exitCode = 1;
      });
    }, 50),
  );
}

const options = {
  banner: {
    js: "/* Generated from the public TypeScript and PowerShell sources. */",
  },
  bundle: true,
  entryPoints: ["src/main.ts"],
  external: [
    "obsidian",
    "electron",
    "child_process",
    "crypto",
    "fs/promises",
    "os",
    "path",
  ],
  format: "cjs",
  legalComments: "none",
  loader: {
    ".ps1": "text",
  },
  logLevel: "info",
  minify: production,
  outfile: "dist/main.js",
  platform: "browser",
  sourcemap: production ? false : "inline",
  target: "es2022",
};

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await Promise.all([...staticFiles].map(copyStaticFile));

if (watchMode) {
  const context = await esbuild.context(options);
  await context.watch();
  watchFiles(".", { persistent: true }, (_eventType, fileName) => {
    const normalizedName = fileName?.toString().replaceAll("\\", "/");
    if (normalizedName && staticFiles.has(normalizedName)) {
      scheduleStaticCopy(normalizedName);
    }
  });
} else {
  await esbuild.build(options);
}
