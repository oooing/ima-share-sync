export interface SourceCatalog {
  kind: "knowledge-bases" | "folders";
  knowledgeBaseName: string;
  names: string[];
  ambiguousNames: string[];
  complete: boolean;
  parentPath?: string[];
}

export function isSourceCatalog(value: unknown): value is SourceCatalog {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const names = (list: unknown): list is string[] => Array.isArray(list) && list.length <= 1000 &&
    list.every((name) => typeof name === "string" && !!name.trim() && name.length <= 4096) && new Set(list).size === list.length;
  return (item.kind === "knowledge-bases" || item.kind === "folders") &&
    typeof item.knowledgeBaseName === "string" && (item.kind === "knowledge-bases" || !!item.knowledgeBaseName.trim()) &&
    names(item.names) && names(item.ambiguousNames) &&
    !item.names.some((name) => (item.ambiguousNames as string[]).includes(name)) &&
    typeof item.complete === "boolean" && (item.parentPath === undefined ||
      (Array.isArray(item.parentPath) && item.parentPath.length <= 5 && item.parentPath.every(part => typeof part === "string" && !!part.trim())));
}
