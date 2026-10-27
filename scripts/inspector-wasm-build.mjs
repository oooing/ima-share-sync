import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

// Compress binary data only, never JavaScript. The parser remains bundled and
// available offline. Node's built-in decoder is present in desktop Obsidian.
export function embeddedWasmPlugin() {
  const require = createRequire(import.meta.url);
  const wasm = require.resolve("@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm");
  return {
    name: "embedded-inspector-wasm",
    setup(build) {
      build.onResolve({ filter: /^ima-inspector-wasm$/ }, () => ({ path: wasm, namespace: "inspector-wasm" }));
      build.onLoad({ filter: /.*/, namespace: "inspector-wasm" }, async () => {
        const compressed = gzipSync(await readFile(wasm), { level: 9 }).toString("base64");
        return {
          contents: `import { gunzipSync } from "zlib"; import { Buffer } from "buffer"; export default gunzipSync(Buffer.from(${JSON.stringify(compressed)}, "base64"));`,
          loader: "js",
          watchFiles: [wasm],
        };
      });
    },
  };
}
