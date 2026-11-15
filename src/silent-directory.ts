import type { NativeIdentityRequest } from "./desktop-identity-provider";
import { isDesktopKnowledgeBaseId, type IdentityChoice, type RemoteEntity, type RemoteFolder } from "./source-identity";

type Obj = Record<string, unknown>;
export type DirectoryEndpoint = "get_knowledge_base_list" | "get_folder_list" | "get_knowledge_list";
export type DirectoryQuery = (endpoint: DirectoryEndpoint, body: Obj) => Promise<Obj>;
export interface DirectoryCacheEntry { value: RemoteEntity[] | RemoteFolder[]; checkedAt: number }
export interface DirectoryCache { [key: string]: DirectoryCacheEntry }
export const directoryKey = (kb?: string, folder?: string): string => kb ? `folders:${kb}:${folder ?? ""}` : "bases";
export function directoryError(code = "unverified"): Error & { code: string } {
  const messages: Record<string, string> = {
    "not-found": "原来源已不可用，原保存位置和同步记录保持不变。",
    "login-required": "IMA 登录暂不可用。请在方便时登录 IMA，原配置保持不变。",
    "network-unavailable": "暂时无法核对来源，原配置保持不变。稍后可重试。",
    "incomplete": "目录尚未完整读取，原配置保持不变。请重试。",
  };
  return Object.assign(new Error(messages[code] ?? "来源身份未能确认，原配置和同步记录保持不变。"), { code });
}
const object = (v: unknown): Obj => { if (!v || typeof v !== "object" || Array.isArray(v)) throw directoryError(); return v as Obj; };
const array = (v: unknown): unknown[] => { if (!Array.isArray(v)) throw directoryError("incomplete"); return v; };
const name = (v: unknown): string => { if (typeof v !== "string" || !v.trim()) throw directoryError(); return v; };
const folderId = (v: unknown): string => { if (typeof v !== "string" || !/^folder_\d+$/.test(v)) throw directoryError(); return v; };
const kbId = (v: unknown): string => { if (!isDesktopKnowledgeBaseId(v)) throw directoryError(); return v; };
function nextPage(page: Obj, seen: Set<string>): string | undefined {
  if (page.is_end === true) return undefined;
  if (page.is_end !== false || typeof page.next_cursor !== "string" || !page.next_cursor || seen.has(page.next_cursor)) throw directoryError("incomplete");
  seen.add(page.next_cursor); return page.next_cursor;
}
function unique<T extends RemoteEntity>(items: T[]): T[] {
  if (new Set(items.map(item => item.id)).size !== items.length) throw directoryError("incomplete");
  return items;
}
interface FolderPage { base: RemoteEntity; path: RemoteEntity[]; folders: RemoteFolder[] }

/** Read-only HTTP transport. Cache entries are display hints, never identity proof. */
export class SilentDirectoryService {
  constructor(private readonly query: DirectoryQuery, readonly cache: DirectoryCache = {}) {}
  async call(request: NativeIdentityRequest): Promise<unknown> {
    if (!request || !["list-knowledge-bases", "list-folders", "resolve", "match-records"].includes(request.action)) throw directoryError();
    if (request.action !== "list-knowledge-bases") kbId(request.knowledgeBaseId);
    if (request.folderId) folderId(request.folderId);
    if (request.cacheOnly) {
      if (!["list-knowledge-bases", "list-folders"].includes(request.action)) throw directoryError();
      return this.cache[directoryKey(request.action === "list-folders" ? request.knowledgeBaseId : undefined, request.folderId)]?.value;
    }
    // Coalesce repeated reads only within this verification. A later selection always rechecks remotely.
    const reads = new Map<string, Promise<Obj>>();
    const query: DirectoryQuery = (endpoint, body) => {
      const key = endpoint + JSON.stringify(body);
      let pending = reads.get(key);
      if (!pending) { pending = this.query(endpoint, body); reads.set(key, pending); }
      return pending;
    };
    const bases = await this.listBases(query);
    if (request.action === "list-knowledge-bases") return bases;
    const base = bases.find(item => item.id === request.knowledgeBaseId);
    if (!base) throw Object.assign(directoryError("not-found"), { sourceTarget: "knowledge-base" });
    const current = await this.verifyPath(query, base, request.folderId);
    if (request.action === "list-folders") return current.folders;
    const selected = current.path.at(-1);
    const choice: IdentityChoice = { knowledgeBase: current.base, ...(selected ? { folder: { ...selected, path: current.path } } : {}), includeSubfolders: request.includeSubfolders !== false, identityProvider: "desktop-uia" };
    if (request.action === "resolve") return choice;
    return this.match(query, base, request.folderId, request.sourceIds ?? [], request.includeSubfolders !== false);
  }
  private remember(key: string, value: RemoteEntity[] | RemoteFolder[]): void {
    this.cache[key] = { value, checkedAt: Date.now() };
  }
  private async listBases(query: DirectoryQuery): Promise<RemoteEntity[]> {
    let params = [1001, 1002, 1004, 1005].map(type => ({ type, cursor: "", limit: 50 }));
    const seen = new Map(params.map(p => [p.type, new Set<string>()]));
    const bases = new Map<string, RemoteEntity>();
    for (let page = 0; params.length; page++) {
      if (page >= 200) throw directoryError("incomplete");
      const result = await query("get_knowledge_base_list", { params });
      const groups = array(result.results).map(object);
      if (groups.length !== params.length || new Set(groups.map(g => g.type)).size !== groups.length) throw directoryError("incomplete");
      const pending: typeof params = [];
      for (const param of params) {
        const group = groups.find(g => g.type === param.type);
        if (!group) throw directoryError("incomplete");
        for (const raw of array(group.knowledge_base_list)) {
          const item = object(raw), basic = object(item.basic_info);
          if (basic.has_deleted === true) continue;
          const entry = { id: kbId(item.id), name: name(basic.name) }, previous = bases.get(entry.id);
          if (previous && previous.name !== entry.name) throw directoryError();
          bases.set(entry.id, entry);
        }
        const cursor = nextPage(group, seen.get(param.type)!);
        if (cursor !== undefined) pending.push({ ...param, cursor });
      }
      params = pending;
    }
    const value = [...bases.values()]; this.remember(directoryKey(), value);
    const liveIds = new Set(value.map(v => v.id));
    for (const key of Object.keys(this.cache)) if (key.startsWith("folders:") && !liveIds.has(key.split(":")[1]!)) delete this.cache[key];
    return value;
  }
  private async folderPage(query: DirectoryQuery, base: RemoteEntity, parent?: string): Promise<FolderPage> {
    let cursor = "", canonical: RemoteEntity[] | undefined;
    const seen = new Set<string>(), folders: RemoteFolder[] = [];
    for (let page = 0; ; page++) {
      if (page >= 200) throw directoryError("incomplete");
      const result = await query("get_folder_list", { knowledge_base_id: base.id, folder_id: parent ?? "", cursor, limit: 50 });
      const fullPath = array(result.current_path).map((v, index) => {
        const node = object(v);
        return { id: index === 0 ? kbId(node.folder_id) : folderId(node.folder_id), name: name(node.name), parent: node.parent_folder_id };
      });
      if (fullPath[0]?.id !== base.id || fullPath.at(-1)?.id !== (parent ?? base.id) || new Set(fullPath.map(v => v.id)).size !== fullPath.length) throw directoryError("not-found");
      if (fullPath.some((v, i) => i > 0 && v.parent !== fullPath[i - 1]!.id)) throw directoryError();
      const path = fullPath.map(({ id, name }) => ({ id, name }));
      if (canonical && JSON.stringify(path) !== JSON.stringify(canonical)) throw directoryError("incomplete");
      canonical = path;
      for (const raw of array(result.folder_list)) {
        const item = object(raw), entry = { id: folderId(item.folder_id), name: name(item.name) };
        // IMA leaves this field empty for folder_list children; the verified response path supplies their parent.
        if ((item.parent_folder_id && item.parent_folder_id !== (parent ?? base.id)) || path.some(p => p.id === entry.id)) throw directoryError();
        folders.push({ ...entry, path: [...path.slice(1), entry] });
      }
      const next = nextPage(result, seen);
      if (next === undefined) break;
      cursor = next;
    }
    return { base: canonical[0]!, path: canonical.slice(1), folders: unique(folders) };
  }
  private async verifyPath(query: DirectoryQuery, base: RemoteEntity, target?: string): Promise<FolderPage> {
    const current = await this.folderPage(query, base, target);
    // Deleted objects may still answer detail requests. Confirm each link in its live parent list.
    const verifiedPages: [string, FolderPage][] = [];
    for (let i = 0; i < current.path.length; i++) {
      const parent = current.path[i - 1]?.id;
      const page = await this.folderPage(query, base, parent);
      const entry = page.folders.find(f => f.id === current.path[i]!.id);
      if (!entry) throw directoryError("not-found");
      if (JSON.stringify(entry.path) !== JSON.stringify(current.path.slice(0, i + 1))) throw directoryError();
      verifiedPages.push([directoryKey(base.id, parent), page]);
    }
    verifiedPages.push([directoryKey(base.id, target), current]);
    for (const [key, page] of verifiedPages) this.remember(key, page.folders);
    return current;
  }
  private async match(query: DirectoryQuery, base: RemoteEntity, target: string | undefined, sourceIds: string[], recursive: boolean): Promise<number> {
    if (!Array.isArray(sourceIds) || sourceIds.some(id => typeof id !== "string")) throw directoryError();
    const wanted = new Set(sourceIds), matched = new Set<string>();
    const queue: (string | undefined)[] = [target], visited = new Set<string>();
    for (let i = 0; i < queue.length && matched.size < wanted.size; i++) {
      const parent = queue[i], key = parent ?? base.id;
      if (visited.has(key) || visited.size >= 2000) throw directoryError("incomplete");
      visited.add(key);
      let cursor = ""; const seen = new Set<string>();
      for (let page = 0; ; page++) {
        if (page >= 400) throw directoryError("incomplete");
        const result = await query("get_knowledge_list", { knowledge_base_id: base.id, folder_id: parent ?? "", cursor, limit: 50, sort_type: 9, need_default_cover: false });
        const path = array(result.current_path).map(object);
        if (path[0]?.folder_id !== base.id || path.at(-1)?.folder_id !== key) throw directoryError();
        for (const raw of array(result.knowledge_list)) {
          const item = object(raw), mediaId = name(item.media_id);
          if (wanted.has(mediaId)) matched.add(mediaId);
          // The client's DOM card ID is "knowledge-" + media_id; retain the exact stored identity.
          if (/^(note|weburl|pdf|file|image|audio|video)_/.test(mediaId) && wanted.has("knowledge-" + mediaId)) matched.add("knowledge-" + mediaId);
          if (recursive && /^folder_\d+$/.test(mediaId)) queue.push(mediaId);
        }
        if (matched.size === wanted.size) break;
        const next = nextPage(result, seen); if (next === undefined) break; cursor = next;
      }
    }
    return matched.size;
  }
}
