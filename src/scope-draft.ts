import type { SourceBinding, SourceTargetKind } from "./source-binding";

export interface ScopeValues {
  knowledgeBaseName: string;
  folderName: string;
  sourceTargetKind: SourceTargetKind;
  sourceFolderPath?: string[];
  destinationPath: string;
  includeSourceFolder: boolean;
  overwriteSameName: boolean;
  maxItems: number;
  syncScopeMode?: "all" | "recent";
  includeSubfolders: boolean;
  maxFolders: number;
  maxFolderDepth: number;
  generalSelectionMode: "total" | "per-folder";
  titleFilterMode: "all" | "contains" | "prefix" | "regex";
  titleFilter: string;
}

export const scopeKeys = ["knowledgeBaseName", "folderName", "sourceTargetKind", "sourceFolderPath", "destinationPath",
  "includeSourceFolder", "overwriteSameName", "maxItems", "syncScopeMode", "includeSubfolders", "maxFolders",
  "maxFolderDepth", "generalSelectionMode", "titleFilterMode", "titleFilter"] as const;

export function scopeValues(settings: ScopeValues): ScopeValues {
  return Object.fromEntries(scopeKeys.map(key => [key,
    Array.isArray(settings[key]) ? [...settings[key]] : settings[key]])) as unknown as ScopeValues;
}

export function scopeFingerprint(settings: ScopeValues & { sourceBinding?: SourceBinding }): string {
  return JSON.stringify([scopeValues(settings), settings.sourceBinding]);
}

export function sourcePath(settings: Pick<ScopeValues, "folderName" | "sourceTargetKind" | "sourceFolderPath">): string[] {
  return settings.sourceTargetKind === "knowledge-base" ? [] : settings.sourceFolderPath ?? (settings.folderName ? [settings.folderName] : []);
}

export function sameSource(a: ScopeValues, b: ScopeValues): boolean {
  return a.knowledgeBaseName === b.knowledgeBaseName && a.sourceTargetKind === b.sourceTargetKind &&
    JSON.stringify(sourcePath(a)) === JSON.stringify(sourcePath(b));
}

export interface ScopeDraft {
  original: ScopeValues;
  values: ScopeValues;
  fingerprint: string;
  preserveIdentity: boolean;
}

export function createScopeDraft(settings: ScopeValues & { sourceBinding?: SourceBinding }): ScopeDraft {
  return { original: scopeValues(settings), values: scopeValues(settings), fingerprint: scopeFingerprint(settings), preserveIdentity: false };
}

export function scopeDirty(draft: ScopeDraft): boolean {
  return JSON.stringify(draft.original) !== JSON.stringify(draft.values);
}
