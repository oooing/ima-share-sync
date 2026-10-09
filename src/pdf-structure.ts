import { PDFArray, PDFDocument, PDFName, PDFPageLeaf, PDFPageTree, PDFStream } from "pdf-lib";

const MAX_PAGES = 10_000;
const MAX_TREE_NODES = 50_000;
const MAX_TREE_DEPTH = 128;

/** Checks parsed objects, never repairs or serializes the user's original bytes. */
export async function inspectPdfStructure(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: false,
    throwOnInvalidObject: true,
    updateMetadata: false,
    parseSpeed: Infinity,
  });
  const root = doc.catalog.Pages();
  const visited = new Set<PDFPageTree | PDFPageLeaf>();
  const counts = new Map<PDFPageTree | PDFPageLeaf, number>();
  const stack: { node: PDFPageTree | PDFPageLeaf; depth: number; finish: boolean }[] = [
    { node: root, depth: 0, finish: false },
  ];
  while (stack.length) {
    const { node, depth, finish } = stack.pop()!;
    if (!(node instanceof PDFPageTree || node instanceof PDFPageLeaf)) throw new Error("页面树节点无效");
    if (finish) {
      let count = 0;
      const kids = (node as PDFPageTree).Kids();
      for (let index = 0; index < kids.size(); index++) {
        const child = doc.context.lookup(kids.get(index));
        count += counts.get(child as PDFPageTree | PDFPageLeaf) ?? 0;
      }
      if (count > MAX_PAGES || (node as PDFPageTree).Count().asNumber() !== count) throw new Error("页面树页数不一致或过多");
      counts.set(node, count);
      continue;
    }
    if (visited.has(node) || depth > MAX_TREE_DEPTH || visited.size >= MAX_TREE_NODES) throw new Error("页面树循环、重复或过深");
    visited.add(node);
    if (node instanceof PDFPageLeaf) {
      counts.set(node, 1);
      const contentRef = node.get(PDFName.of("Contents"));
      if (contentRef) {
        const content = doc.context.lookup(contentRef);
        if (content instanceof PDFArray) {
          for (let index = 0; index < content.size(); index++) {
            if (!(doc.context.lookup(content.get(index)) instanceof PDFStream)) throw new Error("页面内容引用无效");
          }
        } else if (!(content instanceof PDFStream)) throw new Error("页面内容引用无效");
      }
      let mediaBox: PDFArray | undefined;
      try {
        mediaBox = node.MediaBox();
      } catch {
        throw new Error("PDF 页面尺寸无效");
      }
      if (!(mediaBox instanceof PDFArray) || mediaBox.size() !== 4) throw new Error("PDF 页面尺寸无效");
      const { x, y, width, height } = mediaBox.asRectangle();
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error("PDF 页面尺寸无效");
    } else {
      const kids = node.Kids();
      if (kids.size() > MAX_TREE_NODES) throw new Error("页面树节点过多");
      stack.push({ node, depth, finish: true });
      for (let index = kids.size() - 1; index >= 0; index--) {
        const child = doc.context.lookup(kids.get(index));
        if (!(child instanceof PDFPageTree || child instanceof PDFPageLeaf)) throw new Error("页面树引用缺失或无效");
        stack.push({ node: child, depth: depth + 1, finish: false });
      }
    }
  }
  const count = counts.get(root) ?? 0;
  if (count < 1) throw new Error("PDF 没有可读取的页面");
  return count;
}
