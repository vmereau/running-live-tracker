// Module graph from the architecture spine. An arrow means "may import";
// anything not listed is forbidden. Every server module and web may also
// import shared. server/src/main.ts is the only composition root.
/** @type {Record<string, string[]>} */
const serverModules = {
  http: ['ingest', 'live', 'projection', 'config'],
  ingest: ['store', 'projection', 'config'],
  live: ['projection'],
  projection: ['domain', 'config', 'store'],
  config: ['domain'],
  store: [],
  domain: [],
};

// Anything inside the repo's own code (as opposed to npm packages and node builtins).
const INTERNAL = '^(server|web|shared|config)/';

/** @type {import('dependency-cruiser').IForbiddenRuleType[]} */
const moduleRules = Object.entries(serverModules).map(([mod, allowed]) => ({
  name: `${mod}-allowed-imports`,
  comment: `server/src/${mod} may import only: ${[...allowed, 'shared'].join(', ')}`,
  severity: 'error',
  from: { path: `^server/src/${mod}/` },
  to: {
    path: INTERNAL,
    pathNot: [`^server/src/(${[mod, ...allowed].join('|')})/`, '^shared/src/'],
  },
}));

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    ...moduleRules,
    {
      name: 'scripts-allowed-imports',
      comment: 'server/scripts may import only domain and shared',
      severity: 'error',
      from: { path: '^server/scripts/' },
      to: { path: INTERNAL, pathNot: ['^server/scripts/', '^server/src/domain/', '^shared/src/'] },
    },
    {
      name: 'server-files-belong-to-a-module',
      comment: 'Only main.ts (and its test) may live directly in server/src; everything else goes in a module folder',
      severity: 'error',
      from: { path: '^server/src/[^/]+$', pathNot: '^server/src/main(\\.test)?\\.ts$' },
      to: {},
    },
    {
      name: 'no-importing-composition-root',
      comment: 'server/src/main.ts is the composition root; nothing imports it',
      severity: 'error',
      from: {},
      to: { path: '^server/src/main\\.ts$' },
    },
    {
      name: 'web-allowed-imports',
      comment: 'web may import only web and shared',
      severity: 'error',
      from: { path: '^web/' },
      to: { path: INTERNAL, pathNot: ['^web/', '^shared/src/'] },
    },
    {
      name: 'shared-is-a-leaf',
      comment: 'shared must not import server or web code',
      severity: 'error',
      from: { path: '^shared/' },
      to: { path: INTERNAL, pathNot: '^shared/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|dist)/' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.mjs', '.cjs', '.json'],
    },
  },
};
