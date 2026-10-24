/** Offline migration review only. Do not import this legacy baseline into UI. */
import { defaultContent as oldDefault, firstReleaseContent } from './legacy-content';
import { furwardV2Defaults } from './furward-v2-defaults';
import { FURWARD_SCHEMA_VERSION, upgradeContent, type SiteContent } from './content';

type Difference = { path: string; value: unknown; action: 'preserved_in_content' | 'preserved_in_backup' };
export type MigrationPlan = { fromVersion: number; toVersion: number; needsMigration: boolean; customChanges: Difference[]; preservedUploads: string[]; archivedSections: string[]; content: SiteContent };
function leaves(value: unknown, path = '', result = new Map<string, unknown>()): Map<string, unknown> {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const id = entry && typeof entry === 'object' && 'id' in entry ? String(entry.id) : String(index);
      leaves(entry, `${path}[${id}]`, result);
    }
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) leaves(entry, path ? `${path}.${key}` : key, result);
  } else result.set(path, value);
  return result;
}
export function createMigrationPlan(saved: unknown): MigrationPlan {
  const content = upgradeContent(saved);
  const source = saved as { schemaVersion?: number; sections: { id: string }[] };
  const version = source.schemaVersion ?? 1;
  const entries = leaves(saved);
  const preservedUploads = [...new Set([...entries.values()].filter((value): value is string => typeof value === 'string' && value.startsWith('/api/media/')))];
  const baselines = version === 2 ? [leaves(furwardV2Defaults)] : [leaves(oldDefault), leaves(firstReleaseContent)];
  const upgradedEntries = leaves(content);
  const customChanges = version < FURWARD_SCHEMA_VERSION
    ? [...entries].filter(([path, value]) => path !== 'schemaVersion' && !baselines.some(baseline => baseline.has(path) && JSON.stringify(baseline.get(path)) === JSON.stringify(value))).map(([path, value]): Difference => ({ path, value, action: version === 2 && upgradedEntries.has(path) && JSON.stringify(upgradedEntries.get(path)) === JSON.stringify(value) ? 'preserved_in_content' : 'preserved_in_backup' }))
    : [];
  return { fromVersion: version, toVersion: FURWARD_SCHEMA_VERSION, needsMigration: version < FURWARD_SCHEMA_VERSION, customChanges, preservedUploads, archivedSections: version < FURWARD_SCHEMA_VERSION ? source.sections.filter(section => version < 2 || !content.sections.some(current => current.id === section.id)).map(section => section.id) : [], content };
}
