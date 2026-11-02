// What the shared masker must NOT treat as a secret in this lab. Everything here is a value the lab writes itself (never typed by a visitor) that the masker
// would otherwise read as a credential. The shared masker (shared/mask.js, shared-masker 1.4.0) is not edited: the lab states its own exceptions.
//
// Opaque by NAME (any depth): narrow names only the engine and trace.js write.
//   hash, prevHash, head   the receipt chain (engine.js): sha-256 hex, computed
//   traceparent, traceId   W3C Trace Context values minted in trace.js: random, no meaning outside the app
export const OPAQUE_KEYS = new Set(['hash', 'prevHash', 'head', 'traceparent', 'traceId']);

// Opaque by PATH (the dotted path from the root of the answer), for the two places where a lab-written value looks like a credential to the masker:
//   state.holdings.N.key   "github|gh-repo-core|human:lee.park", built by engine.js from validated roster ids. maskDeep reads a pipe-joined "x|y|z:name" as a
//                          credential-shaped value (maskText does not). Anchored at the root, so a visitor's echo (hops.0.request.body...) can never match.
//   claims.N.claim         the story's deck claims (data.js, constants). The first one says "personal access token; GitHub Enterprise Server supported", and the
//                          masker reads "token; GitHub" as a token and its value (a false positive, see README). The story route has no visitor input.
const OPAQUE_PATHS = [/^state\.holdings\.\d+\.key$/, /^claims\.\d+\.claim$/];
export const opaqueHere = (_key, path) => typeof path === 'string' && OPAQUE_PATHS.some((re) => re.test(path));
