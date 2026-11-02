// Credential-shaped test values are assembled at run time, so no such string sits in the repository.
export const SECRETS = {
  github: ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join(''),
  githubPat: ['github', '_pat_', '11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGHIJ'].join(''),
  gitlab: ['glpat', '-', 'AbCdEfGhIjKlMnOpQrSt'].join(''),
  slack: ['xox', 'b-', '123456789012-abcdefghijklmnopqrstuvwx'].join(''),
  aws: ['AKI', 'AIOSFODNN7EXAMPLE'].join(''),
  openai: ['sk', '-proj-', 'Zy9Xw8Vv7Uu6Tt5Ss4Rr3Qq2Pp1'].join(''),
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJhYmNkZWYifQ', 'abcdefghij1234567890XYZ'].join('.'),
  pem: ['-----BEGIN ', 'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nabcdefghijklmnop\n-----END ', 'PRIVATE KEY-----'].join(''),
  bearer: ['Bear', 'er ', 'abcdEFGH1234567890.tokenvalue'].join(''),
  assignment: ['pass', 'word=', 'hunter2hunter2'].join(''),
  blob: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5',
  hex: 'a3f9c2e1'.repeat(6), // 48 hex characters with digits (the shared masker needs a digit in a 32+ character run: see LIMITS in masking.test.js)
  // plain-language and short shapes (a review found these raw in a stored reason)
  plainIs: ['my pass', 'word is hunter2xyz'].join(''),
  pwColon: ['p', 'w: Hunter2Secret!'].join(''),
  passEq: ['pa', 'ss=Tr0ub4dor&3'].join(''),
  passphrase: ['pass', 'phrase: "correct horse battery"'].join(''), // quoted: the shared masker masks a quoted phrase whole, an unquoted one only its first word
  userinfo: ['https://bob:', 'hunter2@x.example/repo'].join(''),
  tokenWord: ['Authorization: tok', 'en abcdef1234567890zz'].join(''),
  google: ['ya', '29.a0AfH6SMBxQ1w2e3r4t5y6u7i8o9p0'].join(''),
  accountKey: ['Account', 'Key=abcdEFGH', '1234/ijkl'].join(''),
  sessionId: ['session', 'id=00D5g000008dkQz!AQ4AQGhw12'].join(''),
  key32: ['Zq9Xk2Lm8Rt4Vb7N', 'c1Hd5Fj3Gs6Pw0Yz'].join(''),
  shortGh: ['gh', 'p_shortone12345678'].join(''),
};
// What must NOT be masked: ordinary prose, ids, dates, resource and policy names.
export const PLAIN = [
  'I need read access to review the change for the release',
  'please look at req-0001 on gh-repo-core for maya.chen until 2026-11-02T10:00:00Z under pol-code-write',
  'the token requirements and the password policy are in the handbook',
  'passing the review needs sign-off from priya.nair and lee.park, see non-human-identity-governance-track',
  'Snowflake role ANALYST_RO on main.payments_gold, approved by ines.duarte (a data-owner) in Slack',
  'see https://github.example/payments-api/pull/123 and the incident write-up',
];

// ---- The masking sweep (2026-11-01). Probe secrets: PROBE and PROBE2. Assembled at run time so no such string sits in the repository.
export const PROBE = 'hunter2xyz';
export const PROBE2 = ['abcdefghijklmnop', '1234'].join('');
const PW = ['pass', 'word'].join(''); const TK = ['tok', 'en'].join(''); const SK = ['s', 'k-'].join(''); const BR = ['Bea', 'rer'].join('');
const between = (word, c) => [...word].join(c);
// [name, text, the part that must not survive]. A) controls inside a keyword  B) keyword + plain space  C) userinfo  D) JSON-quoted assignment
export const SWEEP = [
  ['A1 every letter split by U+0001', `${between(PW, '\u0001')}: ${PROBE}`, PROBE],
  ['A2 NUL inside', `${PW.slice(0, 4)}\u0000${PW.slice(4)}=${PROBE}`, PROBE],
  ['A3 U+0085 inside', `${PW.slice(0, 4)}\u0085${PW.slice(4)}=${PROBE}`, PROBE],
  ['A4 DEL inside', `${PW.slice(0, 4)}\u007f${PW.slice(4)}=${PROBE}`, PROBE],
  ['A5 plain language, two splits', `my pa\u0000ss\u0000${PW.slice(4)} is ${PROBE}`, PROBE],
  ['A6 token split', `${TK.slice(0, 3)}\u0001${TK.slice(3)} ${PROBE}`, PROBE],
  ['A7 bearer split', `${BR.slice(0, 3)}\u0001${BR.slice(3)} ${PROBE}`, PROBE],
  ['A8 sk- split', `${SK[0]}\u0001${SK.slice(1)}${PROBE2}`, PROBE2],
  ['A9 C1 control U+009F inside', `${PW.slice(0, 4)}\u009f${PW.slice(4)}: ${PROBE}`, PROBE],
  ['B1 password + space', `${PW} ${PROBE}`, PROBE],
  ['B2 pw + space', `pw ${PROBE}`, PROBE],
  ['B3 token + space', `${TK} ${PROBE}`, PROBE],
  ['B4 secret + space', `secret ${PROBE}`, PROBE],
  ['B5 api key + space', `api key ${PROBE}`, PROBE],
  ['B6 the key is', `the key is ${PROBE}`, PROBE],
  ['B7 my password is', `my ${PW} is ${PROBE}`, PROBE],
  ['C1 userinfo, no scheme', `bob:${PROBE}@host.example`, PROBE],
  ['C2 userinfo, protocol-relative', `//bob:${PROBE}@host.example`, PROBE],
  ['C3 userinfo, with scheme', `https://bob:${PROBE}@host.example/x`, PROBE],
  ['D1 JSON-quoted assignment as text', `{"${PW}":"${PROBE}"}`, PROBE],
  ['D2 JSON-quoted, spaced', `{ "${PW}" : "${PROBE}" }`, PROBE],
  ['D3 JSON-quoted token', `{"${TK}":"${PROBE}"}`, PROBE],
];
// Ordinary sentences that must stay readable (the false-positive tradeoff: a keyword, a space, and a value of 6+ characters WITH A DIGIT is masked).
export const READABLE = [
  `the ${PW} reset flow is documented`,
  `please change the ${PW} policy before Friday`,
  'the token bucket refills every minute',
  'secret santa is on Friday',
  'the api key rotation is due next week',
  'pw rotation is monthly',
  'we need a new credential for the build',
  'the key is in the safe',
  'author: Bob wrote the review',
  'a token is valid for one hour',
  'keys and tokens are rotated',
  'monkey and turkey',
  'review the password manager rollout with priya.nair on 2026-11-02',
];
