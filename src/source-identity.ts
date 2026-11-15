import type { SourceBinding } from "./source-binding";
import { scopeValues, type ScopeValues } from "./scope-draft";

export interface RemoteEntity { id: string; name: string; detail?: string }
export interface RemoteFolder extends RemoteEntity { path: RemoteEntity[] }
export type IdentityProviderKind = "ima-api" | "desktop-uia";
/** Shared libraries use decimal IDs; the client's default personal library uses a 16-digit hex ID. */
export function isDesktopKnowledgeBaseId(value: unknown): value is string {
  return typeof value === "string" && /^(?:\d{8,30}|[a-fA-F0-9]{16})$/.test(value);
}
export interface IdentityChoice { knowledgeBase: RemoteEntity; folder?: RemoteFolder; includeSubfolders: boolean; identityProvider?: IdentityProviderKind }
export interface IdentityProvider {
  cachedKnowledgeBases?(): Promise<RemoteEntity[] | undefined>;
  cachedFolders?(knowledgeBaseId: string, parentId?: string): Promise<RemoteFolder[] | undefined>;
  listKnowledgeBases(): Promise<RemoteEntity[]>;
  listFolders(knowledgeBaseId: string, parentId?: string): Promise<RemoteFolder[]>;
  resolve(knowledgeBaseId: string, folderId?: string): Promise<IdentityChoice>;
  matchRecords(choice: IdentityChoice, sourceIds: string[]): Promise<number>;
}
export interface IdentityProfile {
  identityProvider?: IdentityProviderKind;
  folderPathIds?: string[];
  legacyKnowledgeBaseIds?: string[];
  /** Stable relative directory ID chain to its original local relative path. */
  folderDestinations?: Record<string, string[]>;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  folderId?: string;
  folderPath: string[];
  includeSubfolders: boolean;
  sourceScope: string;
  localDestination: string;
  destinationPath: string;
  includeSourceFolder: boolean;
}
export interface IdentityState {
  version: 1;
  activeKnowledgeBaseId?: string;
  rangeReviewRequired?: boolean;
  profiles: Record<string, IdentityProfile>;
  legacy?: { values: ScopeValues; binding?: SourceBinding };
}
export type IdentitySettings = ScopeValues & { sourceBinding?: SourceBinding; sourceIdentity?: IdentityState };

export function activeProfile(settings: IdentitySettings): IdentityProfile | undefined {
  const state = settings.sourceIdentity;
  return state?.activeKnowledgeBaseId ? state.profiles[state.activeKnowledgeBaseId] : undefined;
}
export function identityDestination(settings: ScopeValues): string {
  const root = settings.destinationPath.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return settings.includeSourceFolder && settings.sourceTargetKind === "folder" && settings.folderName
    ? root + "/" + settings.folderName : root;
}

/** Identity and availability are separate: a stale detail response is insufficient. */
export async function verifyIdentity(provider: IdentityProvider, kbId: string, folderId?: string): Promise<IdentityChoice> {
  const bases = await provider.listKnowledgeBases();
  const matches = bases.filter(item => item.id === kbId);
  if (matches.length !== 1) throw Object.assign(new Error("原知识库暂不可用。原配置和同步记录已保留，请刷新或重新选择来源。"), { code: matches.length === 0 ? "not-found" : "unverified", sourceTarget: "knowledge-base" });
  const resolved = await provider.resolve(kbId, folderId);
  if (resolved.knowledgeBase.id !== kbId || resolved.folder?.id !== folderId ||
    (resolved.folder && resolved.folder.path.at(-1)?.id !== folderId)) {
    throw new Error("来源身份未能确认，未更改原配置。");
  }
  return resolved;
}

function applyProfile<T extends IdentitySettings>(settings: T, profile: IdentityProfile, state: IdentityState): T {
  const path = [...profile.folderPath];
  const targetKind = profile.folderId ? "folder" as const : "knowledge-base" as const;
  const name = path.at(-1) ?? "";
  return { ...settings, sourceIdentity: state, knowledgeBaseName: profile.knowledgeBaseName,
    folderName: name, sourceFolderPath: path, sourceTargetKind: targetKind,
    includeSubfolders: profile.includeSubfolders, destinationPath: profile.destinationPath,
    includeSourceFolder: profile.includeSourceFolder,
    sourceBinding: { version: 1, knowledgeBaseName: profile.knowledgeBaseName,
      remoteFolderName: name, localDestination: profile.localDestination, sourceScope: profile.sourceScope,
      targetKind, folderPath: path } };
}

/** Same ID only updates remote labels; destination and deduplication scope stay pinned. */
export function refreshIdentityLabels<T extends IdentitySettings>(settings: T, choice: IdentityChoice): T {
  const previous = activeProfile(settings);
  if (!previous || previous.knowledgeBaseId !== choice.knowledgeBase.id || previous.folderId !== choice.folder?.id ||
    (previous.identityProvider && choice.identityProvider && previous.identityProvider !== choice.identityProvider)) {
    throw new Error("来源身份不一致，不能按改名处理。");
  }
  const profile = { ...previous, knowledgeBaseName: choice.knowledgeBase.name,
    folderPath: choice.folder?.path.map(part => part.name) ?? [],
    folderPathIds: choice.folder?.path.map(part => part.id) ?? [],
    ...(choice.identityProvider ? { identityProvider: choice.identityProvider } : {}) };
  const state = { ...settings.sourceIdentity!, profiles: { ...settings.sourceIdentity!.profiles, [profile.knowledgeBaseId]: profile } };
  return applyProfile(settings, profile, state);
}

export function chooseIdentity<T extends IdentitySettings>(
  settings: T, choice: IdentityChoice, hash: (value: string) => string,
  linkLegacy = false, matchedRecords = 0,
): T {
  const originalState = settings.sourceIdentity ?? { version: 1 as const, profiles: {},
    ...(settings.knowledgeBaseName ? { legacy: { values: scopeValues(settings), binding: settings.sourceBinding } } : {}) };
  const state: IdentityState = { ...originalState, profiles: { ...originalState.profiles } };
  const kbId = choice.knowledgeBase.id;
  const remembered = state.profiles[kbId];
  const legacy = state.legacy;
  if (linkLegacy && (!legacy || remembered || matchedRecords < 1)) throw new Error("没有找到可关联的旧文章记录，请保留原配置并重新核对来源。");
  const base = linkLegacy && legacy ? legacy.values : settings;
  const path = choice.folder?.path.map(item => item.name) ?? [];
  const profile: IdentityProfile = {
    knowledgeBaseId: kbId, knowledgeBaseName: choice.knowledgeBase.name, folderId: choice.folder?.id,
    identityProvider: choice.identityProvider ?? remembered?.identityProvider,
    ...(remembered?.folderDestinations ? { folderDestinations: remembered.folderDestinations } : {}),
    folderPathIds: choice.folder?.path.map(part => part.id) ?? [],
    ...(remembered?.legacyKnowledgeBaseIds ? { legacyKnowledgeBaseIds: [...remembered.legacyKnowledgeBaseIds] } : {}),
    folderPath: path, includeSubfolders: choice.includeSubfolders,
    sourceScope: remembered?.sourceScope ?? (linkLegacy ? legacy?.binding?.sourceScope : undefined) ?? hash(linkLegacy ? base.knowledgeBaseName : (choice.identityProvider === "desktop-uia" ? "ima-desktop:" : "ima-api:") + kbId),
    localDestination: remembered?.localDestination ?? (linkLegacy ? legacy?.binding?.localDestination ?? identityDestination(base) : identityDestination({
      ...base, folderName: path.at(-1) ?? "", sourceTargetKind: choice.folder ? "folder" : "knowledge-base",
    })),
    destinationPath: remembered?.destinationPath ?? base.destinationPath,
    includeSourceFolder: remembered?.includeSourceFolder ?? base.includeSourceFolder,
  };
  state.rangeReviewRequired = linkLegacy ? false : originalState.activeKnowledgeBaseId !== kbId || Boolean(originalState.rangeReviewRequired);
  state.profiles[kbId] = profile; state.activeKnowledgeBaseId = kbId;
  if (linkLegacy) delete state.legacy;
  return applyProfile(settings, profile, state);
}

/** Ordinary options never replace remote IDs or old record scopes. */
export function updateIdentityOptions<T extends IdentitySettings>(settings: T, values: ScopeValues): T {
  const profile = activeProfile(settings);
  if (values.knowledgeBaseName !== settings.knowledgeBaseName || values.folderName !== settings.folderName ||
      values.sourceTargetKind !== settings.sourceTargetKind) throw new Error("请通过来源选择器更改同步来源。");
  const next = { ...settings, ...scopeValues(values) };
  if (profile) {
    const moved = values.destinationPath !== settings.destinationPath || values.includeSourceFolder !== settings.includeSourceFolder;
    const changed = { ...profile, includeSubfolders: values.includeSubfolders,
      destinationPath: values.destinationPath, includeSourceFolder: values.includeSourceFolder,
      localDestination: moved ? identityDestination(values) : profile.localDestination };
    return applyProfile(next, changed, { ...settings.sourceIdentity!, profiles: { ...settings.sourceIdentity!.profiles, [changed.knowledgeBaseId]: changed } });
  }
  return next;
}

/** Dismissing the visible range reminder acknowledges the currently saved choice. */
export function acknowledgeIdentityRange<T extends IdentitySettings>(settings: T): T {
  if (!settings.sourceIdentity) return settings;
  return { ...settings, sourceIdentity: { ...settings.sourceIdentity, rangeReviewRequired: false } };
}

export interface DesktopMigrationEvidence {
  previousKnowledgeBaseId: string;
  matchedRecords: number;
  /** All positively verified candidates; collection must not suppress incomplete-read errors. */
  candidateKnowledgeBaseIds: string[];
}

/** Migrate an API identity only after uniquely locating it and matching actual old records. */
export function migrateDesktopIdentity<T extends IdentitySettings>(settings: T, choice: IdentityChoice, evidence: DesktopMigrationEvidence): T {
  const previous = activeProfile(settings);
  const candidates = [...new Set(evidence.candidateKnowledgeBaseIds)];
  if (!previous || previous.knowledgeBaseId !== evidence.previousKnowledgeBaseId ||
    choice.identityProvider !== "desktop-uia" || !isDesktopKnowledgeBaseId(choice.knowledgeBase.id) ||
    candidates.length !== 1 || candidates[0] !== choice.knowledgeBase.id ||
    !Number.isSafeInteger(evidence.matchedRecords) || evidence.matchedRecords < 1 ||
    previous.folderId !== choice.folder?.id) throw new Error("旧来源身份尚未唯一核实，原保存位置和同步记录已保留。");
  const path = choice.folder?.path ?? [];
  if ((choice.folder && path.at(-1)?.id !== choice.folder.id) ||
    path.some(part => !/^folder_\d+$/.test(part.id)) || new Set(path.map(part => part.id)).size !== path.length) throw new Error("目录身份链未能确认，未迁移原记录。");
  const existing = settings.sourceIdentity!.profiles[choice.knowledgeBase.id];
  if (existing && existing !== previous) throw new Error("客户端来源已有独立记录，不能自动合并两个来源。");
  const profile: IdentityProfile = { ...previous, identityProvider: "desktop-uia",
    knowledgeBaseId: choice.knowledgeBase.id, knowledgeBaseName: choice.knowledgeBase.name,
    folderPath: path.map(part => part.name), folderPathIds: path.map(part => part.id),
    legacyKnowledgeBaseIds: [...new Set([...(previous.legacyKnowledgeBaseIds ?? []), previous.knowledgeBaseId])].filter(value => value !== choice.knowledgeBase.id) };
  const profiles = { ...settings.sourceIdentity!.profiles };
  delete profiles[previous.knowledgeBaseId];
  profiles[profile.knowledgeBaseId] = profile;
  return applyProfile(settings, profile, { ...settings.sourceIdentity!, activeKnowledgeBaseId: profile.knowledgeBaseId, profiles });
}

/** Persisted ID chains survive restart and are sent as hints; the worker re-verifies every ID. */
export function desktopSource(profile: IdentityProfile): { knowledgeBaseId: string; folderId?: string; folderPath: RemoteEntity[] } {
  if (profile.identityProvider !== "desktop-uia" || !isDesktopKnowledgeBaseId(profile.knowledgeBaseId)) throw new Error("来源尚未完成客户端身份核验。");
  const ids = profile.folderPathIds ?? [];
  if (ids.length !== profile.folderPath.length || ids.some(part => !/^folder_\d+$/.test(part)) ||
    new Set(ids).size !== ids.length || ids.at(-1) !== profile.folderId) throw new Error("目录身份链不完整，未开始同步。");
  return { knowledgeBaseId: profile.knowledgeBaseId, ...(profile.folderId ? { folderId: profile.folderId } : {}),
    folderPath: ids.map((part, index) => ({ id: part, name: profile.folderPath[index]! })) };
}
