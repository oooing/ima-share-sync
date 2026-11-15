import type { IdentityChoice, IdentityProvider, RemoteEntity, RemoteFolder } from "./source-identity";
export type ImaReadCall = (method: "search_knowledge_base" | "get_knowledge_list", body: Record<string, unknown>) => Promise<unknown>;
type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("IMA 返回了无法识别的数据，请重试。");
  return value as Obj;
}
function text(value: unknown): string { if (typeof value !== "string" || !value) throw new Error("IMA 返回的来源标识或名称不完整。"); return value; }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error("IMA 列表结构不完整，未更改原配置。"); return value; }
export class ImaIdentityProvider implements IdentityProvider {
  constructor(private readonly call: ImaReadCall) {}
  private async page(method: Parameters<ImaReadCall>[0], body: Record<string, unknown>): Promise<Obj> {
    const reply = object(await this.call(method, body));
    if (reply.code !== 0) throw new Error(typeof reply.msg === "string" ? "IMA：" + reply.msg : "IMA 请求失败。");
    return object(reply.data);
  }
  async listKnowledgeBases(): Promise<RemoteEntity[]> {
    const result: RemoteEntity[] = [], cursors = new Set<string>(); let cursor = "";
    for (;;) {
      const page = await this.page("search_knowledge_base", { query: "", cursor, limit: 20 });
      for (const value of array(page.info_list)) {
        const item = object(value), id = text(item.kb_id ?? item.id), name = text(item.kb_name ?? item.name);
        if (result.some(entry => entry.id === id)) throw new Error("IMA 分页返回重复来源，未使用不完整列表。");
        result.push({ id, name, detail: [item.base_type, item.role_type].filter(v => typeof v === "string").join(" · ") });
      }
      if (page.is_end === true) return result;
      if (page.is_end !== false) throw new Error("IMA 没有确认列表是否完整。");
      const next = text(page.next_cursor); if (next === cursor || cursors.has(next)) throw new Error("IMA 列表分页未前进，请重试。");
      cursors.add(next); cursor = next;
    }
  }
  private async contents(kbId: string, folderId?: string): Promise<{ path: RemoteEntity[]; entries: Obj[] }> {
    const entries: Obj[] = [], cursors = new Set<string>(); let cursor = "", path: RemoteEntity[] | undefined;
    for (;;) {
      const page = await this.page("get_knowledge_list", { knowledge_base_id: kbId, ...(folderId ? { folder_id: folderId } : {}), cursor, limit: 50 });
      const rawPath = array(page.current_path).map(object);
      if (!rawPath.length || rawPath[0]!.folder_id !== kbId) throw new Error("目录不属于选定知识库，已停止。");
      const currentPath = rawPath.map((part, index) => {
        const id = text(part.folder_id), name = text(part.name);
        if (index && part.parent_folder_id !== rawPath[index - 1]!.folder_id) throw new Error("IMA 目录父子关系未能确认。");
        return { id, name };
      });
      if (currentPath.at(-1)?.id !== (folderId ?? kbId) || new Set(currentPath.map(p => p.id)).size !== currentPath.length) throw new Error("IMA 返回的目录身份不一致。");
      if (path && JSON.stringify(path) !== JSON.stringify(currentPath)) throw new Error("读取期间来源已变化，请刷新后重试。");
      path = currentPath;
      for (const value of array(page.knowledge_list)) {
        const item = object(value); text(item.media_id); text(item.title);
        if (item.parent_folder_id !== (folderId ?? kbId)) throw new Error("IMA 返回的条目不属于当前目录。");
        if (typeof item.media_type !== "number") throw new Error("IMA 条目类型无法识别。");
        if (entries.some(entry => entry.media_id === item.media_id)) throw new Error("IMA 列表分页含重复条目，请重试。");
        entries.push(item);
      }
      if (page.is_end === true) return { path, entries };
      if (page.is_end !== false) throw new Error("IMA 没有确认目录列表是否完整。");
      const next = text(page.next_cursor); if (next === cursor || cursors.has(next)) throw new Error("IMA 目录分页未前进，请重试。");
      cursors.add(next); cursor = next;
    }
  }
  async listFolders(kbId: string, parentId?: string): Promise<RemoteFolder[]> {
    const listing = await this.contents(kbId, parentId);
    return listing.entries.filter(item => item.media_type === 99).map(item => {
      const node = { id: text(item.media_id), name: text(item.title) };
      return { ...node, path: [...listing.path.slice(1), node] };
    });
  }
  async resolve(kbId: string, folderId?: string): Promise<IdentityChoice> {
    const listing = await this.contents(kbId, folderId), path = listing.path.slice(1);
    return { knowledgeBase: listing.path[0]!, ...(folderId ? { folder: { ...path.at(-1)!, path } } : {}), includeSubfolders: true };
  }
  async matchRecords(choice: IdentityChoice, sourceIds: string[]): Promise<number> {
    const wanted = new Set(sourceIds), found = new Set<string>();
    const queue: (string | undefined)[] = [choice.folder?.id], seen = new Set<string>();
    while (queue.length) {
      const folderId = queue.shift(), key = folderId ?? choice.knowledgeBase.id;
      if (seen.has(key)) throw new Error("IMA 目录循环，已停止核对。"); seen.add(key);
      const listing = await this.contents(choice.knowledgeBase.id, folderId);
      for (const item of listing.entries) {
        // This bridge was verified for original PDF records; do not guess for notes/URLs.
        if (item.media_type === 1 && wanted.has("knowledge-" + text(item.media_id))) found.add("knowledge-" + text(item.media_id));
        if (choice.includeSubfolders && item.media_type === 99) queue.push(text(item.media_id));
      }
      if (found.size >= 20) return found.size;
    }
    return found.size;
  }
  async assertDesktopNamesUnique(choice: IdentityChoice): Promise<void> {
    const bases = await this.listKnowledgeBases();
    if (bases.filter(base => base.name === choice.knowledgeBase.name).length !== 1) throw new Error("存在同名知识库，桌面无法唯一定位。未开始同步。");
    let parent: string | undefined;
    for (const node of choice.folder?.path ?? []) {
      const siblings = await this.listFolders(choice.knowledgeBase.id, parent);
      if (siblings.filter(folder => folder.name === node.name).length !== 1 || !siblings.some(folder => folder.id === node.id && folder.name === node.name)) throw new Error("存在同名或已变化的目录，桌面无法唯一定位。未开始同步。");
      parent = node.id;
    }
  }
}
