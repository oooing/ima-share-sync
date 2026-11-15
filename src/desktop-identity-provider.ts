import { isDesktopKnowledgeBaseId } from "./source-identity";
import type { IdentityChoice, IdentityProfile, IdentityProvider, RemoteEntity, RemoteFolder } from "./source-identity";

export interface NativeIdentityRequest {
  action: "list-knowledge-bases" | "list-folders" | "resolve" | "match-records";
  knowledgeBaseId?: string;
  folderId?: string;
  folderPath?: RemoteEntity[];
  sourceIds?: string[];
  includeSubfolders?: boolean;
  /** Cached lists are for display only. resolve/match-records must always read remotely. */
  cacheOnly?: boolean;
}
export type NativeIdentityCall = (request: NativeIdentityRequest) => Promise<unknown>;
type Obj = Record<string, unknown>;
const invalid = () => new Error("客户端来源身份未能确认，原配置和同步记录已保留。");
function object(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Obj;
}
function list(value: unknown): unknown[] { if (!Array.isArray(value)) throw invalid(); return value; }
function id(value: unknown, kind: "knowledge-base" | "folder"): string {
  if (typeof value !== "string" || !(kind === "knowledge-base" ? isDesktopKnowledgeBaseId(value) : /^folder_\d+$/.test(value))) throw invalid();
  return value;
}
function entity(value: unknown, kind: "knowledge-base" | "folder"): RemoteEntity {
  const item = object(value);
  if (typeof item.name !== "string" || !item.name.trim()) throw invalid();
  return { id: id(item.id, kind), name: item.name, ...(typeof item.detail === "string" ? { detail: item.detail } : {}) };
}
function folder(value: unknown): RemoteFolder {
  const item = object(value), entry = entity(item, "folder");
  const path = list(item.path).map(part => entity(part, "folder"));
  if (!path.length || path.at(-1)!.id !== entry.id || path.at(-1)!.name !== entry.name || new Set(path.map(part => part.id)).size !== path.length) throw invalid();
  return { ...entry, path };
}
function choice(value: unknown, kbId: string, folderId?: string): IdentityChoice {
  const item = object(value), knowledgeBase = entity(item.knowledgeBase, "knowledge-base");
  const target = item.folder == null ? undefined : folder(item.folder);
  if (knowledgeBase.id !== kbId || target?.id !== folderId) throw invalid();
  return { knowledgeBase, ...(target ? { folder: target } : {}), includeSubfolders: item.includeSubfolders !== false, identityProvider: "desktop-uia" };
}

/** Stable client ID namespace, independent of the transport used to read it. */
export class DesktopIdentityProvider implements IdentityProvider {
  private readonly paths = new Map<string, RemoteEntity[]>();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly call: NativeIdentityCall, profiles: IdentityProfile[] = []) {
    for (const profile of profiles) this.seedProfile(profile);
  }
  seedProfile(profile: IdentityProfile): void {
    if (profile.identityProvider !== "desktop-uia" || !isDesktopKnowledgeBaseId(profile.knowledgeBaseId)) return;
    if (!profile.folderId) return;
    const ids = profile.folderPathIds;
    if (!ids || ids.length !== profile.folderPath.length || ids.at(-1) !== profile.folderId || ids.some(part => !/^folder_\d+$/.test(part)) || new Set(ids).size !== ids.length) return;
    this.remember(profile.knowledgeBaseId, ids.map((part, index) => ({ id: part, name: profile.folderPath[index]! })));
  }
  private remember(kbId: string, path: RemoteEntity[]): void {
    path.forEach((part, index) => this.paths.set(kbId + ":" + part.id, path.slice(0, index + 1).map(node => ({ ...node }))));
  }
  private request(request: NativeIdentityRequest): Promise<unknown> {
    // Settings refresh and source browsing share one desktop; don't interleave their navigation.
    const result = this.pending.then(() => this.call(request));
    this.pending = result.catch(() => undefined);
    return result;
  }
  private location(kbId: string, folderId?: string): Pick<NativeIdentityRequest, "knowledgeBaseId" | "folderId" | "folderPath"> {
    id(kbId, "knowledge-base");
    if (folderId) id(folderId, "folder");
    const path = folderId ? this.paths.get(kbId + ":" + folderId) : undefined;
    return { knowledgeBaseId: kbId, ...(folderId ? { folderId } : {}), ...(path ? { folderPath: path.map(node => ({ ...node })) } : {}) };
  }
  async listKnowledgeBases(): Promise<RemoteEntity[]> {
    const result = list(await this.request({ action: "list-knowledge-bases" })).map(item => entity(item, "knowledge-base"));
    if (new Set(result.map(item => item.id)).size !== result.length) throw invalid();
    return result;
  }
  async cachedKnowledgeBases(): Promise<RemoteEntity[] | undefined> {
    try {
      const result = await this.call({ action: "list-knowledge-bases", cacheOnly: true });
      return result === undefined ? undefined : list(result).map(item => entity(item, "knowledge-base"));
    } catch { return undefined; }
  }
  async cachedFolders(kbId: string, parentId?: string): Promise<RemoteFolder[] | undefined> {
    try {
      const result = await this.call({ action: "list-folders", ...this.location(kbId, parentId), cacheOnly: true });
      if (result === undefined) return undefined;
      const items = list(result).map(folder);
      if (items.some(item => parentId ? item.path.at(-2)?.id !== parentId : item.path.length !== 1)) return undefined;
      return items;
    } catch { return undefined; }
  }
  async listFolders(kbId: string, parentId?: string): Promise<RemoteFolder[]> {
    const result = list(await this.request({ action: "list-folders", ...this.location(kbId, parentId) })).map(folder);
    if (new Set(result.map(item => item.id)).size !== result.length || result.some(item => parentId
      ? item.path.at(-2)?.id !== parentId : item.path.length !== 1)) throw invalid();
    for (const item of result) this.remember(kbId, item.path);
    return result;
  }
  async resolve(kbId: string, folderId?: string): Promise<IdentityChoice> {
    const result = choice(await this.request({ action: "resolve", ...this.location(kbId, folderId) }), kbId, folderId);
    if (result.folder) this.remember(kbId, result.folder.path);
    return result;
  }
  async matchRecords(selected: IdentityChoice, sourceIds: string[]): Promise<number> {
    const verified = choice(selected, selected.knowledgeBase.id, selected.folder?.id);
    if (verified.folder) this.remember(verified.knowledgeBase.id, verified.folder.path);
    const wanted = [...new Set(sourceIds.filter(value => typeof value === "string" && value.length > 0))];
    if (!wanted.length) return 0;
    const count = await this.request({ action: "match-records", ...this.location(verified.knowledgeBase.id, verified.folder?.id),
      sourceIds: wanted, includeSubfolders: selected.includeSubfolders });
    if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > wanted.length) throw invalid();
    return count as number;
  }
}
