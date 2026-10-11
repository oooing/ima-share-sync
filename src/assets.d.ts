declare module "*.ps1" {
  const source: string;
  export default source;
}

declare module "ima-pdf-worker" {
  const source: string;
  export default source;
}

declare module "ima-markdown-runner" {
  const source: string;
  export default source;
}

declare module "ima-markdown-browser-worker" {
  const source: string;
  export default source;
}

declare module "ima-inspector-wasm" {
  const binary: Uint8Array;
  export default binary;
}
