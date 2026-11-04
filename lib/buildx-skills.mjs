import path from 'node:path';

// This is a product-owned catalog, not a filter over user-supplied names or
// descriptions. New entries require a bundled skill and an explicit contract.
const CATALOG = Object.freeze([Object.freeze({
  name: 'buildx-project-research',
  title: '资料库问答',
  description: '查看已添加的资料，结合原文回答问题并标明来源。',
  relativePath: ['.agents', 'skills', 'buildx-project-research', 'SKILL.md'],
  dependencies: Object.freeze([
    Object.freeze({ name: 'buildx_materials_list', label: '资料库目录读取' }),
    Object.freeze({ name: 'buildx_materials_read', label: '资料库原文读取' }),
  ]),
})]);

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * Build a customer-facing view from already validated, current discovery.
 * `root` is the trusted product root, not a request parameter. The discovery
 * owner supplies an opaque ID for each enabled item and retains the ID/path
 * mapping for turn validation. `toolStates` comes from the current connection's
 * tool owner: available, unavailable, or unknown. Omission means unknown.
 * This function never obtains or grants tool permissions and never returns paths.
 */
export function customerSkillCatalog({ root, discovered, toolStates = {} }) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !Array.isArray(discovered) ||
      !toolStates || typeof toolStates !== 'object' || Array.isArray(toolStates))
    throw new TypeError('Invalid customer skill catalog input');
  const productRoot = path.resolve(root);
  return CATALOG.map(entry => {
    const expected = path.join(productRoot, ...entry.relativePath);
    const matches = discovered.filter(item => item && item.name === entry.name && item.scope === 'repo' &&
      typeof item.path === 'string' && path.isAbsolute(item.path) && samePath(path.resolve(item.path), expected));
    // An ambiguous discovery never yields a usable ID.
    const found = matches.length === 1 ? matches[0] : null;
    const enabled = found?.enabled === true && typeof found.id === 'string' && uuid.test(found.id);
    const dependencies = entry.dependencies.map(dep => ({ name: dep.name, label: dep.label,
      status: ['available', 'unavailable'].includes(toolStates[dep.name]) ? toolStates[dep.name] : 'unknown' }));
    let availability = 'unknown';
    if (!found || found.enabled === false || dependencies.some(dep => dep.status === 'unavailable')) availability = 'unavailable';
    else if (enabled && dependencies.every(dep => dep.status === 'available')) availability = 'available';
    const reason = !found ? '当前连接未发现产品技能。' : found.enabled === false ? '该技能当前未启用。' :
      !enabled ? '技能选择身份未核实。' : dependencies.some(dep => dep.status === 'unavailable') ? '所需工具当前不可用。' :
        dependencies.some(dep => dep.status === 'unknown') ? '所需工具状态尚未核实。' : '资料库已添加地址；实际文件读取结果以工具回执为准。';
    return { name: entry.name, title: entry.title, description: entry.description, dependencies,
      availability, reason, selectable: availability === 'available',
      ...(availability === 'available' ? { id: found.id } : {}) };
  });
}
