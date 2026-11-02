// Rule 13: a workspace id keeps one visitor's state apart from another's. Server state per workspace is one access Engine per vertical
// (requests, grants, receipts, the platforms' own state, the audit trail, the outbox and the lab clock). Bounded in count and age.
// The browser sends its id in X-Workspace (default "default"). Reset clears the current workspace only.
import { Engine } from './engine.js';
import { isCredentialId } from './credentials.js';

export const WORKSPACE_RE = /^[a-z0-9-]{1,40}$/;
export const DEFAULT_WORKSPACE = 'default';

// An id is echoed back in the `workspace` field and in the hop headers, so one that looks like a credential is refused (400 bad_workspace), never echoed:
// a JWT start, a hyphen-separated part that names a credential or starts a token (sk-, pw-, ghp-, token-, password-, ...), or anything the shared masker's
// isCredentialId flags (24 or more hex characters, an opaque run of 24+ characters, a credential prefix...). Two older tests, "24 hex characters in a row" and
// "anything the masker would change", found nothing more on any id of this shape (a mutation run showed both were dead), so they are gone. The page keeps a copy of this rule (web/src/workspace.js); a test compares the two on a table of ids.
export const CREDENTIAL_PARTS = new Set(['sk', 'pk', 'rk', 'pw', 'pwd', 'pass', 'passwd', 'password', 'passphrase', 'secret', 'token', 'apikey', 'bearer', 'glpat', 'ghp', 'gho', 'ghu', 'ghs', 'xoxa', 'xoxb', 'xoxp', 'xoxr', 'xoxs', 'akia', 'asia']);
export function validWorkspaceId(s) {
  if (typeof s !== 'string' || !WORKSPACE_RE.test(s) || s.startsWith('eyj')) return false;
  if (s.split('-').some((part) => CREDENTIAL_PARTS.has(part))) return false;
  return !isCredentialId(s);
}

export function workspaceFrom(req) {
  const raw = req.headers['x-workspace'];
  if (raw === undefined) return DEFAULT_WORKSPACE;
  return validWorkspaceId(raw) ? raw : null;
}

export function createWorkspaces({ max = 500, ttlMs = 60 * 60 * 1000, now = Date.now } = {}) {
  const map = new Map(); // id -> { engines: Map(vertical -> Engine), at }; insertion order = oldest first
  const sweep = () => {
    const t = now();
    for (const [id, v] of map) { if (t - v.at > ttlMs) map.delete(id); else break; }
    while (map.size > max) map.delete(map.keys().next().value);
  };
  const touch = (id) => { const v = map.get(id) || { engines: new Map(), at: 0 }; v.at = now(); map.delete(id); map.set(id, v); sweep(); return v; };
  return {
    // The engine for this workspace and vertical, created on first use with the cast of that moment.
    engine(id, vertical, cast) {
      const v = touch(id);
      if (!v.engines.has(vertical)) v.engines.set(vertical, new Engine(cast));
      return v.engines.get(vertical);
    },
    // Read-only look: the engine if the workspace has one, else null (nothing is created).
    peek(id, vertical) { sweep(); return map.get(id)?.engines.get(vertical) || null; },
    reset(id) { map.delete(id); },
    size() { return map.size; },
  };
}
