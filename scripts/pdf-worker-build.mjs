import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

/** Embed a self-contained worker; users still install only main.js/manifest/styles. */
export function pdfWorkerPlugin() {
  const entry = fileURLToPath(new URL("../src/pdf-validation-worker.ts", import.meta.url));
  return {
    name: "embedded-pdf-validation-worker",
    setup(build) {
      build.onResolve({ filter: /^ima-pdf-worker$/ }, () => ({ path: "ima-pdf-worker", namespace: "pdf-worker" }));
      build.onLoad({ filter: /.*/, namespace: "pdf-worker" }, async () => {
        const result = await esbuild.build({
          entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "node",
          target: "node20", minify: true, legalComments: "none", metafile: true,
          external: ["worker_threads"],
          nodePaths: process.env.NODE_PATH?.split(path.delimiter).filter(Boolean),
        });
        return {
          contents: JSON.stringify(result.outputFiles[0].text), loader: "json",
          watchFiles: Object.keys(result.metafile.inputs).map((input) => path.resolve(input)),
        };
      });
    },
  };
}
