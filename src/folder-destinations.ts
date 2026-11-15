/** Relative directory ID chains keep their first verified local save locations. */
export type FolderDestinations = Record<string, string[]>;
export interface FolderDestinationObservation {
  sourceId: string;
  /** Local-safe segments, cleaned by the existing filename policy before calling. */
  relativeFolder: readonly string[];
  relativeFolderIds: readonly string[];
}
export interface FolderDestinationRecord { id: string; path: readonly string[] }

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(part => typeof part !== "string" || !/^folder_\d+$/.test(part)) ||
      new Set(value).size !== value.length) throw new Error("目录 ID 链无效，未更改保存位置。");
  return [...(value as string[])];
}
function localPath(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(part => typeof part !== "string" || !part || part === "." || part === ".." ||
      /[<>:"/\\|?*]/.test(part) || [...part].some(char => char.charCodeAt(0) < 32) || /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
    throw new Error("本地目录路径无效，未更改保存位置。");
  }
  return [...(value as string[])];
}
function requireArray(value: unknown): void {
  if (!Array.isArray(value)) throw new Error("目录核对数据无效。");
}
function sourceId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("文章来源 ID 缺失，无法核对原保存位置。");
  return value;
}
function pathKey(value: readonly string[]): string { return JSON.stringify(value.map(part => part.toLowerCase())); }
export function folderDestinationKey(relativeFolderIds: readonly string[]): string { return JSON.stringify(ids(relativeFolderIds)); }

/**
 * Evidence comes from exact article IDs, including skipped articles. Display names
 * supply paths only for genuinely new ID chains. Inputs are never changed.
 */
export function buildFolderDestinations(
  existing: Readonly<FolderDestinations> | undefined,
  observations: readonly FolderDestinationObservation[],
  oldRecords: readonly FolderDestinationRecord[],
): FolderDestinations {
  if (existing !== undefined && (!existing || typeof existing !== "object" || Array.isArray(existing))) {
    throw new Error("已保存的目录映射无效，未更改保存位置。");
  }
  requireArray(observations); requireArray(oldRecords);
  const result = new Map<string, string[]>(), owners = new Map<string, string>();
  function remember(chain: readonly string[], path: readonly string[]): void {
    if (chain.length !== path.length) throw new Error("原记录目录层级与目录 ID 链不一致，无法安全关联。");
    // Prefixes also pin renamed ancestors when a new child first appears later.
    for (let depth = 0; depth <= chain.length; depth++) {
      const key = JSON.stringify(chain.slice(0, depth)), part = path.slice(0, depth), normalized = pathKey(part);
      const previous = result.get(key);
      if (previous && pathKey(previous) !== normalized) throw new Error("同一目录 ID 对应多个保存位置，未更改原映射。");
      const owner = owners.get(normalized);
      if (owner !== undefined && owner !== key) throw new Error("不同目录 ID 对应同一保存位置，已停止以避免混存。");
      if (!previous) result.set(key, [...part]);
      owners.set(normalized, key);
    }
  }
  remember([], []);
  for (const [key, value] of Object.entries(existing ?? {})) {
    let chain: string[];
    try { chain = ids(JSON.parse(key)); } catch { throw new Error("已保存的目录 ID 映射无效，未更改保存位置。"); }
    if (JSON.stringify(chain) !== key) throw new Error("已保存的目录 ID 映射格式无效。");
    const path = localPath(value);
    remember(chain, path);
    result.set(key, path); // Preserve the exact spelling of every existing entry.
  }

  const records = new Map<string, Map<string, string[]>>();
  for (const record of oldRecords) {
    const id = sourceId(record?.id), path = localPath(record?.path);
    const paths = records.get(id) ?? new Map<string, string[]>();
    if (!paths.has(pathKey(path))) paths.set(pathKey(path), path);
    records.set(id, paths);
  }
  const groups = new Map<string, { chain: string[]; displayed: string[][]; evidence: Map<string, string[]> }>();
  for (const observation of observations) {
    const id = sourceId(observation?.sourceId), chain = ids(observation?.relativeFolderIds), path = localPath(observation?.relativeFolder);
    if (chain.length !== path.length) throw new Error("目录名称与 ID 链层级不一致，未更改保存位置。");
    const key = JSON.stringify(chain), group = groups.get(key) ?? { chain, displayed: [], evidence: new Map<string, string[]>() };
    group.displayed.push(path);
    for (const [oldKey, oldPath] of records.get(id) ?? []) group.evidence.set(oldKey, oldPath);
    groups.set(key, group);
  }
  // Apply every article-backed path before inventing paths for new folders.
  for (const group of groups.values()) {
    if (group.evidence.size > 1) throw new Error("同一目录 ID 的旧文章记录指向多个目录，无法自动确定保存位置。");
    const proven = group.evidence.values().next().value;
    if (proven) remember(group.chain, proven);
  }
  for (const group of [...groups.values()].sort((a, b) => a.chain.length - b.chain.length)) {
    if (result.has(JSON.stringify(group.chain))) continue;
    const candidates = new Map<string, string[]>();
    for (const displayed of group.displayed) {
      let candidate = displayed;
      for (let depth = group.chain.length - 1; depth >= 0; depth--) {
        const parent = result.get(JSON.stringify(group.chain.slice(0, depth)));
        if (parent) { candidate = [...parent, ...displayed.slice(depth)]; break; }
      }
      candidates.set(pathKey(candidate), candidate);
    }
    if (candidates.size !== 1) throw new Error("读取期间目录名称发生变化，请刷新后重试。");
    remember(group.chain, candidates.values().next().value!);
  }
  return Object.fromEntries([...result].map(([key, path]) => [key, [...path]]));
}

/** Missing mappings fail closed; callers must not fall back to renamed labels. */
export function resolveFolderDestination(
  mapping: Readonly<FolderDestinations>, relativeFolderIds: readonly string[],
): string[] {
  const chain = ids(relativeFolderIds), key = JSON.stringify(chain);
  if (!Object.prototype.hasOwnProperty.call(mapping, key)) throw new Error("目录身份尚未关联保存位置，未保存文件。");
  const path = localPath(mapping[key]);
  if (path.length !== chain.length) throw new Error("已保存的目录映射层级不一致。");
  return path;
}