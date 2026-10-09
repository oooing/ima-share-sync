import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

// Embed the local WASM parser and runner so the three standard release assets
// work without Node.js, native addons, a source checkout, or network downloads.
export async function bundleMarkdownRunner() {
  const require = createRequire(import.meta.url);
  const entry = fileURLToPath(new URL("../src/pdf-markdown-runner.cjs", import.meta.url));
  const wasm = require.resolve("@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm");
  const bundled = await esbuild.build({
          entryPoints: [entry], bundle: true, write: false, platform: "node",
          format: "cjs", target: "node20", minify: true, logLevel: "silent",
          define: { "import.meta.url": '""' },
          plugins: [{
            name: "embedded-inspector-wasm",
            setup(runner) {
              runner.onResolve({ filter: /^ima-inspector-wasm$/ }, () => ({ path: wasm, namespace: "inspector-wasm" }));
              runner.onLoad({ filter: /.*/, namespace: "inspector-wasm" }, async () => ({ contents: await readFile(wasm), loader: "binary" }));
            },
          }],
  });
  return bundled.outputFiles[0].text;
}

export function markdownRunnerPlugin() {
  return {
    name: "embedded-markdown-runner",
    setup(build) {
      build.onResolve({ filter: /^ima-markdown-runner$/ }, () => ({ path: "runner", namespace: "markdown-runner" }));
      build.onLoad({ filter: /.*/, namespace: "markdown-runner" }, async () => {
        return { contents: await bundleMarkdownRunner(), loader: "text" };
      });
    },
  };
}
