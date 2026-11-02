// The response layer: every JSON answer passes through maskDeep, so a credential-shaped value never leaves in any field or in an object key, even if a code
// path forgot to clean its input. The one masker lives in credentials.js (an adapter over shared/mask.js, shared-masker 1.4.0); this file keeps the name the
// rest of the app imports.
export { maskDeep, maskText } from './credentials.js';
