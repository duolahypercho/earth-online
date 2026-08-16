import sfAuthoritativeMetricMapPlugin from '../../plugins/sf-authoritative-metric-map/index.js';
import sfBuildingInteriorsPlugin from '../../plugins/sf-building-interiors/index.js';

const WORLD_ID = 'sf';
const REQUIRED_TEXT_FIELDS = Object.freeze([
  'id',
  'name',
  'worldId',
  'owner',
  'kind',
  'runtimeEntry',
  'verificationPage',
]);

function validatePlugin(plugin) {
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (typeof plugin?.[field] !== 'string' || !plugin[field].trim()) {
      throw new Error(`World plugin is missing ${field}`);
    }
  }
  if (plugin.worldId !== WORLD_ID) {
    throw new Error(`${plugin.id} targets ${plugin.worldId}; only ${WORLD_ID} is canonical`);
  }
  if (typeof plugin.load !== 'function') {
    throw new Error(`${plugin.id} does not expose its production load function`);
  }
  return plugin;
}

const registeredPlugins = [
  sfAuthoritativeMetricMapPlugin,
  sfBuildingInteriorsPlugin,
].map(validatePlugin);

const pluginsById = new Map();
for (const plugin of registeredPlugins) {
  if (pluginsById.has(plugin.id)) throw new Error(`Duplicate world plugin id: ${plugin.id}`);
  pluginsById.set(plugin.id, plugin);
}

export function getWorldPlugin(id) {
  const plugin = pluginsById.get(id);
  if (!plugin) throw new Error(`Unknown world plugin: ${id}`);
  return plugin;
}

export function listWorldPlugins() {
  return [...registeredPlugins];
}
