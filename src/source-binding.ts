export type SourceTargetKind = "folder" | "knowledge-base";

export interface SourceBinding {
  version: 1;
  knowledgeBaseName: string;
  remoteFolderName: string;
  localDestination: string;
  sourceScope: string;
  verifiedBreadcrumb?: string[];
  targetKind?: SourceTargetKind;
  folderPath?: string[];
}

export interface SourceInspection {
  knowledgeBaseName: string;
  folderName: string;
  breadcrumb: string[];
  stableFolderId: null;
  identityMode: "explicit-confirmation";
  targetKind?: SourceTargetKind;
  folderPath?: string[];
}

export interface SourceNeedsRebind {
  reason: "missing" | "ambiguous" | "path-changed";
  expectedPath: string[];
  actualPath: string[];
  message: string;
}

export interface SourcePendingRecord {
  sourceTitle: string;
  sourceId: string;
  kind: string;
  relativeFolder: string[];
  relativeFolderIds?: string[];
  scrollPercent: number;
  scrollStep: number;
}

export interface PendingSourceResume {
  version: 1;
  sourceScope: string;
  localDestination: string;
  knowledgeBaseName: string;
  folderName: string;
  records: SourcePendingRecord[];
  unresumableCount: number;
  targetKind?: SourceTargetKind;
  folderPath?: string[];
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((part) => typeof part === "string");

export function isSourcePendingRecords(value: unknown): value is SourcePendingRecord[] {
  if (!Array.isArray(value) || value.length > 1000) return false;
  const ids = new Set<string>();
  return value.every((raw: unknown) => {
    if (!raw || typeof raw !== "object") return false;
    const item = raw as Record<string, unknown>;
    if (typeof item.sourceId !== "string" || typeof item.sourceTitle !== "string" || !item.sourceTitle.trim()) return false;
    const identity = /^knowledge-(note|weburl|pdf|file|image|audio|video)_([A-Za-z0-9_-]{16,})$/.exec(item.sourceId);
    if (!identity || /^\d+$/.test(identity[2]!) || item.kind !== identity[1] || ids.has(item.sourceId)) return false;
    ids.add(item.sourceId);
    return isStringArray(item.relativeFolder) && item.relativeFolder.length <= 5 && item.relativeFolder.every((part) => !!part.trim()) &&
      (item.relativeFolderIds === undefined || (isStringArray(item.relativeFolderIds) &&
        item.relativeFolderIds.length === item.relativeFolder.length && item.relativeFolderIds.every(part => /^folder_\d+$/.test(part)) &&
        new Set(item.relativeFolderIds).size === item.relativeFolderIds.length)) &&
      typeof item.scrollPercent === "number" && Number.isFinite(item.scrollPercent) && item.scrollPercent >= 0 && item.scrollPercent <= 100 &&
      typeof item.scrollStep === "number" && Number.isInteger(item.scrollStep) && item.scrollStep >= 0;
  });
}

export function restorePendingSourceResume(value: unknown): PendingSourceResume | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<PendingSourceResume>;
  if (item.version !== 1 || typeof item.sourceScope !== "string" || !/^[a-f0-9]{64}$/.test(item.sourceScope) ||
    typeof item.localDestination !== "string" || !item.localDestination.trim() ||
    typeof item.knowledgeBaseName !== "string" || !item.knowledgeBaseName.trim() ||
    typeof item.folderName !== "string" || !validTarget(item.targetKind, item.folderName) || !validFolderPath(item.folderPath, item.folderName, item.targetKind) || !isSourcePendingRecords(item.records) ||
    typeof item.unresumableCount !== "number" || !Number.isInteger(item.unresumableCount) || item.unresumableCount < 0) return undefined;
  return { version: 1, sourceScope: item.sourceScope, localDestination: item.localDestination,
    knowledgeBaseName: item.knowledgeBaseName, folderName: item.folderName,
    records: item.records.map((record) => ({ ...record, relativeFolder: [...record.relativeFolder],
      ...(record.relativeFolderIds ? { relativeFolderIds: [...record.relativeFolderIds] } : {}) })),
    unresumableCount: item.unresumableCount,
    ...(item.folderPath ? { folderPath: [...item.folderPath] } : {}),
    ...(item.targetKind === "knowledge-base" ? { targetKind: item.targetKind } : {}) };
}

function validFolderPath(path: unknown, folder: string, kind: unknown): boolean {
  return path === undefined || (isStringArray(path) && path.length <= 5 && path.every(part => !!part.trim()) &&
    (kind === "knowledge-base" ? path.length === 0 : path.length > 0 && path[path.length - 1] === folder));
}

function validTarget(kind: unknown, folder: string): boolean {
  return kind === "knowledge-base" ? folder === "" : (kind === undefined || kind === "folder") && !!folder.trim();
}

export function isSourceInspection(value: unknown): value is SourceInspection {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.knowledgeBaseName === "string" && !!item.knowledgeBaseName.trim() &&
    typeof item.folderName === "string" && validTarget(item.targetKind, item.folderName) && validFolderPath(item.folderPath, item.folderName, item.targetKind) &&
    isStringArray(item.breadcrumb) && item.breadcrumb.length > 0 &&
    item.breadcrumb.every((part) => !!part.trim()) &&
    (item.targetKind === "knowledge-base"
      ? item.breadcrumb.length === 1 && /^内容[（(]\d+[）)]$/.test(item.breadcrumb[0]!)
      : item.breadcrumb[item.breadcrumb.length - 1]?.trim() === item.folderName.trim()) &&
    (item.folderPath === undefined || JSON.stringify(item.breadcrumb.slice(1)) === JSON.stringify(item.folderPath)) &&
    item.stableFolderId === null && item.identityMode === "explicit-confirmation";
}

export function isSourceNeedsRebind(value: unknown): value is SourceNeedsRebind {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return ["missing", "ambiguous", "path-changed"].includes(String(item.reason)) &&
    isStringArray(item.expectedPath) && isStringArray(item.actualPath) &&
    typeof item.message === "string";
}

export function restoreSourceBinding(value: unknown, knowledgeBaseName: string): SourceBinding | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<SourceBinding>;
  if (item.version !== 1 || item.knowledgeBaseName !== knowledgeBaseName.trim() ||
    typeof item.remoteFolderName !== "string" || !validTarget(item.targetKind, item.remoteFolderName) || !validFolderPath(item.folderPath, item.remoteFolderName, item.targetKind) ||
    typeof item.localDestination !== "string" || !item.localDestination.trim() ||
    typeof item.sourceScope !== "string" || !/^[a-f0-9]{64}$/.test(item.sourceScope) ||
    (item.verifiedBreadcrumb !== undefined && !isStringArray(item.verifiedBreadcrumb))) return undefined;
  return { version: 1, knowledgeBaseName: item.knowledgeBaseName,
    remoteFolderName: item.remoteFolderName, localDestination: item.localDestination,
    sourceScope: item.sourceScope,
    ...(item.verifiedBreadcrumb ? { verifiedBreadcrumb: [...item.verifiedBreadcrumb] } : {}),
    ...(item.folderPath ? { folderPath: [...item.folderPath] } : {}),
    ...(item.targetKind === "knowledge-base" ? { targetKind: item.targetKind } : {}) };
}

export function createSourceBinding(
  knowledgeBaseName: string, folderName: string, localDestination: string, sourceScope: string, targetKind: SourceTargetKind = "folder",
): SourceBinding | undefined {
  if (!knowledgeBaseName.trim() || !validTarget(targetKind, folderName)) return undefined;
  return { version: 1, knowledgeBaseName: knowledgeBaseName.trim(), remoteFolderName: folderName.trim(),
    localDestination, sourceScope, ...(targetKind === "knowledge-base" ? { targetKind } : {}) };
}

export function rebindSource(binding: SourceBinding, inspection: SourceInspection): SourceBinding {
  if (!isSourceInspection(inspection)) {
    throw new Error("The source has not been verified.");
  }
  // Called only after the user confirms the exact inspected knowledge base and folder.
  // A renamed knowledge base must retain its historical scope and local destination.
  const result = { ...binding, knowledgeBaseName: inspection.knowledgeBaseName, remoteFolderName: inspection.folderName,
    verifiedBreadcrumb: [...inspection.breadcrumb] };
  delete result.targetKind;
  delete result.folderPath;
  if (inspection.folderPath) result.folderPath = [...inspection.folderPath];
  if (inspection.targetKind === "knowledge-base") result.targetKind = "knowledge-base";
  return result;
}
