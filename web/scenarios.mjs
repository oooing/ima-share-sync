import { sha256 } from './sha256.mjs';

export const scenarios = [
  { id: 'configured', name: '已有配置' },
  { id: 'long-path', name: '超长来源路径' },
  { id: 'live', name: '真实 IMA（来源只读）' },
  { id: 'new', name: '首次使用' },
  { id: 'renamed', name: '来源改名' },
  { id: 'ambiguous', name: '同名目录' },
  { id: 'offline', name: '读取失败' },
  { id: 'missing-folder', name: '文件夹已删除' },
  { id: 'legacy', name: '旧记录首次关联' },
  { id: 'recreated', name: '同名新库' },
  { id: 'save-failed', name: '保存失败' },
];

export function createScenario(id = 'configured') {
  if (!scenarios.some(s => s.id === id)) throw new Error('Unknown Web scenario');
  const kb = id === 'long-path' ? '2027全球八大顶级投行研报库1 · 全球金融市场与行业趋势研究资料合集' : '机构研报';
  const folder = id === 'long-path' ? '2026年11月【最新】 · 每日更新与重点行业跟踪 · InternationalInvestmentResearchArchive202611' : '2026年10月';
  const destination = '阅读/研报';
  const effective = `${destination}/${folder}`;
  const files = ['new','live'].includes(id) ? [] : Array.from({ length: 24 }, (_, i) => ({
    path: `${effective}/行业观察 ${String(i + 1).padStart(2, '0')}.md`,
    stat: { ctime: Date.now() - i * 3600000, mtime: Date.now() - i * 3600000, size: 2048 + i * 160 },
  }));
  const reports = ['new','live'].includes(id) ? [] : Array.from({ length: 4 }, (_, i) => ({
    id: `web-report-${i}`, finishedAt: Date.now() - i * 86400000,
    interactive: true, status: 'success', read: true,
    summary: '新增 6 篇，跳过 4 篇。', errors: [], destination: effective,
    metrics: { checked: 10, saved: 6 },
  }));
  const data = ['new','live'].includes(id) ? null : {
    autoSync: false, hasConsented: true, contentMode: 'general', language: 'zh-CN',
    knowledgeBaseName: kb, folderName: folder, sourceTargetKind: 'folder',
    destinationPath: destination, includeSourceFolder: true, includeSubfolders: true,
    generalSelectionMode: 'total', syncScopeMode: 'recent', maxItems: 100,
    maxFolders: 10, maxFolderDepth: 3, overwriteSameName: false,
    syncReports: reports, syncedAttachments: files.slice(0, 3).map((file, i) => ({
      path: file.path, sourceId: `knowledge-pdf_webfixture0000000${i}`,
      sourceScope: sha256(kb), sourceTitle: `行业观察 ${i + 1}`,
    })),
  };
  const remote = createIdentityFixture(id);
  if (id === 'missing-folder') reports.unshift({ id: 'web-missing-source', finishedAt: Date.now(), interactive: true,
    status: 'failed', read: false, action: 'source-settings', summary: '同步失败：找不到文件夹，请重新选择来源。',
    errors: [{ title: '同步任务', message: '找不到文件夹，请重新选择来源。' }], destination: effective });
  if (data && id !== 'legacy') {
    const profile = {
      knowledgeBaseId: 'demo-kb-reports', knowledgeBaseName: kb,
      folderId: 'demo-folder-oct', folderPath: [folder], includeSubfolders: true,
      sourceScope: sha256(kb), localDestination: effective, destinationPath: destination, includeSourceFolder: true,
    };
    data.sourceIdentity = { version: 1, activeKnowledgeBaseId: profile.knowledgeBaseId, profiles: { [profile.knowledgeBaseId]: profile } };
    data.sourceBinding = { version: 1, knowledgeBaseName: kb, remoteFolderName: folder,
      localDestination: effective, sourceScope: sha256(kb), folderPath: [folder] };
  }
  const visibleKnowledgeBases = id === 'renamed' ? ['机构研报 · 新名称', '我的学习资料', '行业观察'] : [kb, '我的学习资料', '行业观察'];
  const roots = id === 'renamed' ? ['2026年10月 · 归档', '2026年11月'] : [folder, '2026年11月', '专题研究'];
  return {
    id, data, files, identityProvider: remote, failSaves: id === 'save-failed', destinationFolders: ['阅读', destination, effective, '阅读/待读', '项目/参考资料'],
    async catalog(operation, settings) {
      // Delay only the simulated source, so loading and cancellation can be exercised.
      await new Promise(resolve => setTimeout(resolve, 180));
      if (id === 'offline') throw new Error('暂时无法读取 IMA。请稍后点击“刷新”。');
      if (operation === 'list-knowledge-bases') return { items: [], errors: [], sourceCatalog: {
        kind: 'knowledge-bases', knowledgeBaseName: '', names: visibleKnowledgeBases,
        ambiguousNames: [], complete: false,
      } };
      if (operation === 'list-source-folders') {
        const parentPath = settings.sourceCatalogPath ?? [];
        const names = parentPath.length === 0 ? roots : parentPath.length === 1 ? ['261031', '261030'] : parentPath.length === 2 ? ['图表', '附录'] : [];
        return { items: [], errors: [], sourceCatalog: { kind: 'folders',
          knowledgeBaseName: settings.knowledgeBaseName, parentPath, names,
          ambiguousNames: id === 'ambiguous' && parentPath.length === 0 ? ['重复文件夹'] : [], complete: true,
        } };
      }
      if (operation === 'inspect-source') {
        const folderPath = settings.sourceTargetKind === 'knowledge-base' ? [] : settings.sourceFolderPath ?? [settings.folderName];
        if (id === 'renamed' && (settings.knowledgeBaseName === kb || folderPath.includes(folder))) {
          throw new Error('原来源名称已变化，请选择新名称并确认是否沿用原记录。');
        }
        if (folderPath.includes('重复文件夹')) throw new Error('同名目录无法唯一确认，本次不保存。');
        return { items: [], errors: [], sourceInspection: {
          knowledgeBaseName: settings.knowledgeBaseName, folderName: settings.folderName,
          targetKind: settings.sourceTargetKind, folderPath, breadcrumb: ['内容(100)', ...folderPath],
          stableFolderId: null, identityMode: 'explicit-confirmation',
        } };
      }
      throw new Error(`Web preview does not run desktop operation: ${operation}`);
    },
  };
}

export const storageKey = id => `ima-web-preview:v2:${id}`;

export function loadPreviewData(storage, scenario) {
  const value = storage.getItem(storageKey(scenario.id));
  if (value === null) return structuredClone(scenario.data);
  try { return JSON.parse(value); }
  catch { throw new Error('测试配置无法读取，请使用“重置场景”。'); }
}

/** Deterministic ID adapter for isolated Web acceptance. No network or real vault access. */
export function createIdentityFixture(scenarioId) {
  const renamed = scenarioId === 'renamed';
  const kbId = scenarioId === 'recreated' ? 'demo-kb-reports-recreated' : 'demo-kb-reports';
  const bases = [
    { id: kbId, name: scenarioId === 'long-path' ? '2027全球八大顶级投行研报库1 · 全球金融市场与行业趋势研究资料合集' : renamed ? '机构研报 · 新名称' : '机构研报' },
    { id: 'demo-kb-learning', name: '我的学习资料' },
    { id: 'demo-kb-industry', name: '行业观察' },
  ];
  const folders = new Map();
  function add(kb, parent, entity) {
    const path = parent ? [...parent.path, entity] : [entity];
    const folder = { ...entity, path, kb, parentId: parent?.id };
    folders.set(entity.id, folder); return folder;
  }
  for (const base of bases) {
    const reports = base.id === kbId;
    const month = add(base.id, null, { id: reports ? 'demo-folder-oct' : base.id + '-root',
      name: reports ? (scenarioId === 'long-path' ? '2026年11月【最新】 · 每日更新与重点行业跟踪 · InternationalInvestmentResearchArchive202611' : renamed ? '2026年10月 · 归档' : '2026年10月') : '学习笔记' });
    add(base.id, null, { id: base.id + '-nov', name: '2026年11月' });
    add(base.id, null, { id: base.id + '-topics', name: '专题研究' });
    for (const day of ['261031','261030']) {
      const daily = add(base.id, month, { id: month.id + '-' + day, name: day });
      add(base.id, daily, { id: daily.id + '-charts', name: '图表' });
      add(base.id, daily, { id: daily.id + '-appendix', name: '附录' });
    }
    if (scenarioId === 'ambiguous') {
      add(base.id, null, { id: base.id + '-duplicate-a', name: '重复文件夹', detail: '创建于 10 月 30 日' });
      add(base.id, null, { id: base.id + '-duplicate-b', name: '重复文件夹', detail: '创建于 10 月 31 日' });
    }
  }
  async function available() {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (scenarioId === 'offline') throw new Error('暂时无法读取来源。原配置已保留，请稍后刷新。');
  }
  if (scenarioId === 'missing-folder') {
    for (const [key, entry] of folders) if (entry.path.some(part => part.id === 'demo-folder-oct')) folders.delete(key);
  }
  return {
    async listKnowledgeBases() { await available(); return structuredClone(bases); },
    async listFolders(id, parentId) {
      await available();
      if (!bases.some(base => base.id === id)) throw new Error('知识库不可用。');
      if (parentId && folders.get(parentId)?.kb !== id) throw new Error('目录不属于这个知识库。');
      return structuredClone([...folders.values()].filter(folder => folder.kb === id && folder.parentId === parentId));
    },
    async resolve(id, folderId) {
      await available();
      if (scenarioId === 'recreated' && id === 'demo-kb-reports') return { knowledgeBase: { id, name: '机构研报' }, includeSubfolders: true };
      const knowledgeBase = bases.find(item => item.id === id);
      if (!knowledgeBase) throw new Error('知识库不存在。');
      const folder = folderId ? folders.get(folderId) : undefined;
      if (folderId && (!folder || folder.kb !== id)) throw Object.assign(new Error('原文件夹已不可用。请重新选择，原记录会保留。'), { code: 'not-found' });
      return structuredClone({ knowledgeBase, folder, includeSubfolders: true });
    },
    async matchRecords(choice, sourceIds) {
      await available();
      const matchingSource = choice.knowledgeBase.id === 'demo-kb-reports' &&
        (!choice.folder || choice.folder.path.some(part => part.id === 'demo-folder-oct'));
      return matchingSource ? sourceIds.filter(id => /^knowledge-pdf_webfixture0000000[0-2]$/.test(id)).length : 0;
    },
  };
}
