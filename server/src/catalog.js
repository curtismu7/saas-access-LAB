// The six platforms, what each grants, the auth METHOD NAME (never a credential), and the resources the lab models. The first two columns
// of each platform come from deck slide 51; the resources, level scales and API shapes are LAB-INVENTED illustrations (never called).
// Resource names are {{cast}} tokens so each vertical pack reads naturally. A resource has an ordered `levels` list, lowest first.
export const PLATFORMS = {
  github: {
    id: 'github', name: 'GitHub', grants: 'Repository collaborator, team membership, team-to-repository', authMethod: 'personal access token', variants: 'GitHub Enterprise Server supported',
    nativeLabel: 'collaborators and team members', modelled: ['repository collaborator', 'team membership'], notModelled: ['team-to-repository (the subject would be a team, not a human or an agent)'],
    host: 'https://github.example/api/v3',
  },
  gitlab: {
    id: 'gitlab', name: 'GitLab', grants: 'Group and project membership with access level', authMethod: 'administrator token', variants: 'self-managed supported',
    nativeLabel: 'group and project members', modelled: ['group membership', 'project membership'], notModelled: [], host: 'https://gitlab.example/api/v4',
  },
  salesforce: {
    id: 'salesforce', name: 'Salesforce', grants: 'Permission sets, permission set groups, profiles', authMethod: 'OAuth JWT bearer with a connected app', variants: '',
    nativeLabel: 'permission set assignments', modelled: ['permission set', 'permission set group'], notModelled: ['profile (a profile is single-valued: a grant swaps it and removal must restore the old one; the lab does not model that)'],
    host: 'https://acme.my.salesforce.example/services/data/v60.0',
  },
  snowflake: {
    id: 'snowflake', name: 'Snowflake', grants: 'Role membership', authMethod: 'key-pair authentication', variants: '',
    nativeLabel: 'role members', modelled: ['role membership'], notModelled: [], host: 'https://acme-acct.snowflake.example/api/v2',
  },
  databricks: {
    id: 'databricks', name: 'Databricks', grants: 'Unity Catalog privileges', authMethod: 'OAuth service principal', variants: '',
    nativeLabel: 'Unity Catalog privilege holders', modelled: ['Unity Catalog privilege on a schema'], notModelled: [], host: 'https://dbc-lab.cloud.databricks.example/api/2.1/unity-catalog',
  },
  google: {
    id: 'google', name: 'Google Workspace', grants: 'Admin role assignment', authMethod: 'service account with domain-wide delegation', variants: '',
    nativeLabel: 'admin role assignees', modelled: ['admin role assignment'], notModelled: [], host: 'https://admin.google.example/admin/directory/v1',
  },
};
export const PLATFORM_IDS = Object.keys(PLATFORMS);

const REPO = ['read', 'triage', 'write', 'maintain', 'admin'];
const MEMBER = ['guest', 'reporter', 'developer', 'maintainer', 'owner'];
export const RESOURCES = {
  'gh-repo-core': { id: 'gh-repo-core', platform: 'github', kind: 'repository collaborator', name: '{{castRepo}}', levels: REPO, ownerSlot: 'castOwner' },
  'gh-repo-infra': { id: 'gh-repo-infra', platform: 'github', kind: 'repository collaborator', name: '{{castInfraRepo}}', levels: REPO, ownerSlot: 'castSecLead' },
  'gh-team-releases': { id: 'gh-team-releases', platform: 'github', kind: 'team membership', name: '{{castTeam}}', levels: ['member', 'maintainer'], ownerSlot: 'castOwner' },
  'gl-group-platform': { id: 'gl-group-platform', platform: 'gitlab', kind: 'group membership', name: '{{castGroup}}', levels: MEMBER, ownerSlot: 'castOwner' },
  'gl-project-service': { id: 'gl-project-service', platform: 'gitlab', kind: 'project membership', name: '{{castProject}}', levels: MEMBER, ownerSlot: 'castOwner' },
  'sf-permset-reader': { id: 'sf-permset-reader', platform: 'salesforce', kind: 'permission set', name: '{{castPermSet}}', levels: ['assigned'], ownerSlot: 'castOwner' },
  'sf-permsetgroup-ops': { id: 'sf-permsetgroup-ops', platform: 'salesforce', kind: 'permission set group', name: '{{castPermSetGroup}}', levels: ['assigned'], ownerSlot: 'castOwner' },
  'snow-role-analyst': { id: 'snow-role-analyst', platform: 'snowflake', kind: 'role membership', name: '{{castRole1}}', levels: ['member'], ownerSlot: 'castDataOwner' },
  'snow-role-writer': { id: 'snow-role-writer', platform: 'snowflake', kind: 'role membership', name: '{{castRole2}}', levels: ['member'], ownerSlot: 'castDataOwner' },
  'dbx-schema-gold': { id: 'dbx-schema-gold', platform: 'databricks', kind: 'Unity Catalog privilege', name: '{{castSchema}}', levels: ['SELECT', 'MODIFY', 'ALL_PRIVILEGES'], ownerSlot: 'castDataOwner' },
  'dbx-schema-pii': { id: 'dbx-schema-pii', platform: 'databricks', kind: 'Unity Catalog privilege', name: '{{castPiiSchema}}', levels: ['SELECT', 'MODIFY', 'ALL_PRIVILEGES'], ownerSlot: 'castDataOwner' },
  'gw-role-helpdesk': { id: 'gw-role-helpdesk', platform: 'google', kind: 'admin role', name: '{{castAdminRole1}}', levels: ['assigned'], ownerSlot: 'castSecLead' },
  'gw-role-groups': { id: 'gw-role-groups', platform: 'google', kind: 'admin role', name: '{{castAdminRole2}}', levels: ['assigned'], ownerSlot: 'castSecLead' },
};
export const RESOURCE_IDS = Object.keys(RESOURCES);
export const rankOf = (resource, level) => RESOURCES[resource].levels.indexOf(level);

export const ROLES = ['manager', 'resource-owner', 'security', 'data-owner'];
export const ROLE_TEXT = {
  manager: "the subject's manager (for an agent: its custodian)",
  'resource-owner': "the owner of the resource",
  security: 'anyone in the security group',
  'data-owner': 'anyone in the data-owner group',
};

// What the lab shows for each simulated platform call. A lab-invented illustration of a typical public API shape: never sent anywhere.
// Authentication shows the METHOD NAME only.
export function platformCall(platformId, op, { resourceName, resourceKind, level, subject, previous }) {
  const p = PLATFORMS[platformId];
  const auth = { method: p.authMethod, value: 'never shown, never stored' };
  const u = encodeURIComponent(subject);
  const r = encodeURIComponent(resourceName);
  const ok = (status, body) => ({ status, body });
  if (platformId === 'github') {
    if (resourceKind === 'team membership') {
      return op === 'revoke'
        ? { request: { method: 'DELETE', url: `${p.host}/orgs/lab/teams/${r}/memberships/${u}`, auth }, response: ok(204, {}) }
        : { request: { method: 'PUT', url: `${p.host}/orgs/lab/teams/${r}/memberships/${u}`, auth, body: { role: level } }, response: ok(200, { state: 'active', role: level }) };
    }
    return op === 'revoke'
      ? { request: { method: 'DELETE', url: `${p.host}/repos/lab/${r}/collaborators/${u}`, auth }, response: ok(204, {}) }
      : { request: { method: 'PUT', url: `${p.host}/repos/lab/${r}/collaborators/${u}`, auth, body: { permission: level } }, response: ok(op === 'update' ? 204 : 201, op === 'update' ? {} : { permissions: level }) };
  }
  if (platformId === 'gitlab') {
    const kind = resourceKind === 'group membership' ? 'groups' : 'projects';
    const access = { guest: 10, reporter: 20, developer: 30, maintainer: 40, owner: 50 }[level];
    if (op === 'revoke') return { request: { method: 'DELETE', url: `${p.host}/${kind}/${r}/members/${u}`, auth }, response: ok(204, {}) };
    return op === 'update'
      ? { request: { method: 'PUT', url: `${p.host}/${kind}/${r}/members/${u}`, auth, body: { access_level: access } }, response: ok(200, { access_level: access }) }
      : { request: { method: 'POST', url: `${p.host}/${kind}/${r}/members`, auth, body: { user: subject, access_level: access } }, response: ok(201, { access_level: access }) };
  }
  if (platformId === 'salesforce') {
    const kind = resourceKind === 'permission set group' ? 'PermissionSetGroup' : 'PermissionSet';
    return op === 'revoke'
      ? { request: { method: 'DELETE', url: `${p.host}/sobjects/PermissionSetAssignment/<assignment of ${subject} to ${resourceName}>`, auth }, response: ok(204, {}) }
      : { request: { method: 'POST', url: `${p.host}/sobjects/PermissionSetAssignment`, auth, body: { AssigneeUser: subject, [kind]: resourceName } }, response: ok(201, { success: true }) };
  }
  if (platformId === 'snowflake') {
    const sql = op === 'revoke' ? `REVOKE ROLE ${resourceName} FROM USER ${subject}` : `GRANT ROLE ${resourceName} TO USER ${subject}`;
    return { request: { method: 'POST', url: `${p.host}/statements`, auth, body: { statement: sql } }, response: ok(200, { message: 'Statement executed successfully.' }) };
  }
  if (platformId === 'databricks') {
    const change = op === 'revoke' ? { principal: subject, remove: previous ? [previous] : [level] } : op === 'update' ? { principal: subject, remove: [previous], add: [level] } : { principal: subject, add: [level] };
    return { request: { method: 'PATCH', url: `${p.host}/permissions/schema/${r}`, auth, body: { changes: [change] } }, response: ok(200, { privilege_assignments: 'updated' }) };
  }
  return op === 'revoke'
    ? { request: { method: 'DELETE', url: `${p.host}/customer/my_customer/roleassignments/<assignment of ${subject} to ${resourceName}>`, auth }, response: ok(204, {}) }
    : { request: { method: 'POST', url: `${p.host}/customer/my_customer/roleassignments`, auth, body: { role: resourceName, assignedTo: subject, scopeType: 'CUSTOMER' } }, response: ok(200, { kind: 'admin#directory#roleAssignment' }) };
}
