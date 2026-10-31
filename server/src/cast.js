// {{token}} templating for the story and catalog data. customer.config.json (optional, git-ignored) overrides brand, host and the first engineer.
// Tokens are filled from one of three vertical packs. A test fails on any token a pack does not define.
// Every person, agent, repository, role and host in a pack is synthetic: only .example hosts, no real company, tenant or account.
import fs from 'node:fs';
import { scanHosts } from './safety.js';

const TOKEN = /\{\{(\w+)\}\}/g;
const MAX_CAST = 40;
const ID = /^[a-z0-9.-]{1,40}$/;

export const VERTICALS = {
  finance: {
    castBrand: 'Fabrikam Bank', castHost: 'fabrikam', castEngineer: 'maya.chen', castEngineer2: 'omar.reyes', castManager: 'priya.nair', castOwner: 'sam.jones',
    castDataOwner: 'ines.duarte', castSecLead: 'lee.park', castSecLead2: 'ana.silva', castAgent: 'refund-assistant', castAgent2: 'ledger-reconciler',
    castRepo: 'payments-api', castInfraRepo: 'ledger-infra', castTeam: 'release-captains', castGroup: 'payments-platform', castProject: 'settlement-service',
    castPermSet: 'Support Reader', castPermSetGroup: 'Collections Operations', castRole1: 'ANALYST_RO', castRole2: 'FINANCE_RW',
    castSchema: 'main.payments_gold', castPiiSchema: 'main.customer_pii', castAdminRole1: 'Help Desk Admin', castAdminRole2: 'Groups Admin',
    castIncident: 'a payments settlement incident', castWarehouse: 'the month-end warehouse job',
  },
  health: {
    castBrand: 'Contoso Health', castHost: 'contoso', castEngineer: 'lena.ortiz', castEngineer2: 'tariq.hassan', castManager: 'grace.liu', castOwner: 'noah.becker',
    castDataOwner: 'maria.costa', castSecLead: 'kofi.mensah', castSecLead2: 'ella.novak', castAgent: 'intake-assistant', castAgent2: 'claims-reconciler',
    castRepo: 'patient-portal', castInfraRepo: 'clinical-infra', castTeam: 'release-managers', castGroup: 'clinical-platform', castProject: 'claims-service',
    castPermSet: 'Care Coordinator Reader', castPermSetGroup: 'Patient Services', castRole1: 'CLAIMS_RO', castRole2: 'CLINICAL_RW',
    castSchema: 'main.claims_gold', castPiiSchema: 'main.patient_records', castAdminRole1: 'Service Desk Admin', castAdminRole2: 'User Management Admin',
    castIncident: 'a claims-processing outage', castWarehouse: 'the quarterly reporting job',
  },
  retail: {
    castBrand: 'Northwind Retail', castHost: 'northwind', castEngineer: 'diego.ruiz', castEngineer2: 'hana.sato', castManager: 'olu.adeyemi', castOwner: 'mia.kowalski',
    castDataOwner: 'raj.patel', castSecLead: 'anna.berg', castSecLead2: 'tom.fischer', castAgent: 'checkout-helper', castAgent2: 'stock-reconciler',
    castRepo: 'storefront-web', castInfraRepo: 'edge-infra', castTeam: 'release-captains', castGroup: 'commerce-platform', castProject: 'orders-service',
    castPermSet: 'Store Support Reader', castPermSetGroup: 'Merchandising', castRole1: 'SALES_RO', castRole2: 'INVENTORY_RW',
    castSchema: 'main.sales_gold', castPiiSchema: 'main.shopper_profiles', castAdminRole1: 'Help Desk Admin', castAdminRole2: 'Groups Admin',
    castIncident: 'a checkout outage', castWarehouse: 'the peak-season stock job',
  },
};
export const DEFAULT_VERTICAL = 'finance';
export const DEFAULT_CAST = VERTICALS[DEFAULT_VERTICAL];

export const unfilled = (text, cast) => [...String(text).matchAll(TOKEN)].map((m) => m[1]).filter((k) => !Object.hasOwn(cast, k));
export const fill = (text, cast) => String(text).replace(TOKEN, (m, k) => (Object.hasOwn(cast, k) ? cast[k] : m));
// Iterative, so a deep structure cannot overflow the stack.
export function fillDeep(value, cast) {
  const clone = (x) => (Array.isArray(x) ? [] : x && typeof x === 'object' ? {} : x);
  const outRoot = { v: clone(value) };
  const work = [[value, outRoot, 'v']];
  while (work.length) {
    const [src, dst, key] = work.pop();
    if (typeof src === 'string') { dst[key] = fill(src, cast); continue; }
    if (src === null || typeof src !== 'object') { dst[key] = src; continue; }
    const copy = clone(src);
    dst[key] = copy;
    for (const k of Object.keys(src).reverse()) work.push([src[k], copy, k]);
  }
  return outRoot.v;
}

export const verticalFrom = (id) => (typeof id === 'string' && Object.hasOwn(VERTICALS, id) ? id : DEFAULT_VERTICAL);

// Only brand, host and the first engineer, as short plain strings; anything else in the file is ignored. The engineer must not collide
// with another person in the pack.
export function loadCast(file, vertical = DEFAULT_VERTICAL) {
  const cast = { ...VERTICALS[verticalFrom(vertical)] };
  if (!file) return cast;
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [short, key] of [['brand', 'castBrand'], ['engineer', 'castEngineer'], ['host', 'castHost']]) {
      const v = cfg?.cast?.[short];
      if (typeof v !== 'string' || !v.trim()) continue;
      const clean = v.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').trim().slice(0, MAX_CAST);
      if (/:\/\/|@/.test(clean) || scanHosts(clean).length) continue;
      if (short !== 'brand' && !ID.test(clean.toLowerCase())) continue;
      if (short === 'host' && clean.includes('.')) continue;
      const val = short === 'brand' ? clean : clean.toLowerCase();
      if (short === 'engineer' && Object.entries(cast).some(([k, x]) => k !== 'castEngineer' && x === val)) continue;
      cast[key] = val;
    }
  } catch { /* no file or not JSON: the defaults */ }
  return cast;
}

// The roster: people and agents. Every human has a manager; every agent has a custodian (a human). Groups drive role routing.
export function buildRoster(cast) {
  const h = (id, manager, groups = []) => ({ id, kind: 'human', manager, groups });
  const a = (id, custodian) => ({ id, kind: 'agent', custodian, groups: [] });
  return [
    h(cast.castEngineer, cast.castManager), h(cast.castEngineer2, cast.castManager), h(cast.castManager, cast.castSecLead),
    h(cast.castOwner, cast.castManager), h(cast.castDataOwner, cast.castSecLead2, ['data-owner']),
    h(cast.castSecLead, cast.castSecLead2, ['security']), h(cast.castSecLead2, cast.castSecLead, ['security']),
    a(cast.castAgent, cast.castEngineer2), a(cast.castAgent2, cast.castOwner),
  ];
}
