// Masking for anything a visitor types that this lab keeps or shows back (a reason, a comment, an echoed request, a hop pane, an audit entry, a key name, a
// path id). Typed text can carry a real credential, so it is masked on the way IN (what is stored) and again on the way OUT (every answer), and ALWAYS
// before anything is cut or shown: a secret placed after many filler characters must not survive by being cut off first or half shown.
//
// THIS IS A HEURISTIC: it recognises common shapes, not every secret. Do not type a real credential into a lab.
// It over-masks on purpose ("my password is required" becomes "my password is [masked]": the word after "password is" is taken for the value).
// What it still misses: a bare word with no keyword and no recognisable shape; letters from another alphabet that look like Latin ones (a Cyrillic a or
// a Greek o inside "password" is not folded: NFKC does not unify them); a keyword split by an ordinary space or another letter ("pass word=x"); a
// plain-space value that has no digit ("password correcthorse") or is shorter than 6 characters; "the secret is correcthorse" (only "password is x"
// takes a value without a digit); the weak keywords pass, auth, cookie, signature and key when nothing ("=", ":", "is", "was") follows them.
//
// Steps: NFKC; delete default-ignorable, format (Cf) and U+FFFD characters AND every C0/C1 control character except tab, newline and carriage return
// (those three cannot split a keyword: see below); percent-decode up to three rounds (each round followed by the same normalisation); then the
// detectors find the ranges to mask. Tab, LF, CR, U+2028 and U+2029 are separators, so the detectors run three times: on the text as typed, on the
// text with those separators deleted (so "pass<TAB>word=x" is caught while a plain multi-line text keeps its lines), and with every "+" read as a
// space ("password+is+x"). The ranges of all three looks are merged on the text as typed.
//
// KEYWORD + PLAIN SPACE (the false-positive tradeoff): "password hunter2xyz" is masked, "password reset" is not. After a strong keyword (password, pw,
// token, secret, api key, ...) and plain whitespace, a value is taken for a secret only when it is at least 6 characters long AND contains a digit.
// That keeps ordinary sentences readable ("password policy", "the token requirements", "secret santa") at the price of two things: a plain-word
// secret ("password correcthorse") is missed, and a harmless word with a digit ("token abc123", "password 2026-11-02") is masked.
//
// Every regular expression is linear or bounded (no unbounded quantifier inside another); a test feeds 400,000 characters of the nastiest shapes.
// Input over MAX_RAW characters is refused whole (replaced by a marker), never cut.
export const MARK = '[masked]';
export const TOO_LONG = '[masked: text too long to check]';
export const MAX_RAW = 1_000_000;

const STRIP = /[\p{Default_Ignorable_Code_Point}\p{Cf}\uFFFD]/gu;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g; // C0 and C1 except tab, newline, carriage return
const SEPARATOR = /[\t\n\r\u2028\u2029]/; // not global: .test() must not carry state

const normalise = (s) => s.normalize('NFKC').replace(STRIP, '').replace(CONTROL, '');
function decodeOnce(s) {
  try { return decodeURIComponent(s); } catch { return s.replace(/%([0-9a-f]{2})/gi, (m, h) => (parseInt(h, 16) < 128 ? String.fromCharCode(parseInt(h, 16)) : m)); }
}

// Each detector masks the named group v. `generic` ones (long opaque runs) apply to text coming IN only: ids, hashes and trace ids are long and legitimate.
const hasDigit = (s) => /\d/.test(s);
const DETECTORS = [
  // key blocks (an unterminated block is masked to the end)
  { re: /(?<v>-----BEGIN [A-Z0-9 ]{1,40}-----[\s\S]*?(?:-----END [A-Z0-9 ]{1,40}-----|$))/dg },
  // URL userinfo, with or without a scheme and with or without a password: https://user:pw@host, //user:pw@host, https://token@host
  { re: /(?<=\/\/)(?<v>[^\s/?#@]{1,200})@/dg },
  // header-style values run to the end of the line
  { re: /\b(?:authorization|proxy-authorization|set-cookie|cookie)\s{0,20}[:=]\s{0,20}(?<v>[^\r\n]+)/dgi },
  // a passphrase is several words: take the next four
  { re: /\bpassphrase\s{0,20}(?:[:=]|\bis\b)\s{0,20}(?<v>\S+(?:[ \t]+\S+){0,3})/dgi },
  // keyword assignments with = : => ->: password=x, "password":"x", my_password: x (a keyword may be glued into a longer name)
  { re: /(?:passphrase|password|passwd|pwd|pw|secret|token|api[-_ ]?key|apikey|authorization|bearer|credentials?|private[-_ ]?key|access[-_ ]?key|account[-_ ]?key|client[-_ ]?secret|session[-_ ]?id)[\w-]{0,30}["']?\s{0,20}(?:=>|->|[:=])\s{0,20}(?<v>"[^"]{0,2000}"|'[^']{0,2000}'|\{[^}]{0,300}\}|\[[^\]]{0,300}\]|[^\s,;&}\])]+)/dgi },
  // plain language: "my password is x" masks any value; for the other keywords "the token is x" needs a digit in the value, so "the credential is stopped"
  // and "the token is valid" stay readable
  { re: /(?:passphrase|password|passwd|pwd|pw)[\w-]{0,30}["']?\s{1,20}(?:is|are|was)\s{1,20}(?<v>"[^"]{0,2000}"|'[^']{0,2000}'|\{[^}]{0,300}\}|\[[^\]]{0,300}\]|[^\s,;&}\])]+)/dgi },
  { re: /(?:passphrase|password|passwd|pwd|pw|secret|token|api[-_ ]?key|apikey|authorization|bearer|credentials?|private[-_ ]?key|access[-_ ]?key|account[-_ ]?key|client[-_ ]?secret|session[-_ ]?id)[\w-]{0,30}["']?\s{1,20}(?:is|are|was)\s{1,20}(?<v>(?=[^\s,;&}\])]{0,300}\d)[^\s,;&}\])]+)/dgi },
  // weak keywords: only as a whole word, and "is"/"was" only when the value has a digit ("the key is hunter2xyz")
  { re: /(?<![A-Za-z])(?:pass|auth|cookie|signature|keys?)["']?\s{0,20}(?:=>|->|[:=])\s{0,20}(?<v>"[^"]{0,2000}"|'[^']{0,2000}'|\{[^}]{0,300}\}|\[[^\]]{0,300}\]|[^\s,;&}\])]+)/dgi },
  { re: /(?<![A-Za-z])(?:pass|auth|cookie|signature|keys?)\s{1,20}(?:is|are|was)\s{1,20}(?<v>(?=[^\s,;&}\])]{0,300}\d)[^\s,;&}\])]+)/dgi },
  // a strong keyword, a plain space, then a value of 6+ characters with a digit: "password hunter2xyz", "api key hunter2xyz"
  { re: /(?<![A-Za-z])(?:passphrase|password|passwd|pwd|pw|secret|token|api[-_ ]?key|apikey|credential|private[-_ ]?key|access[-_ ]?key|account[-_ ]?key|session[-_ ]?id)s?\s{1,20}(?<v>(?=[^\s,;&}\])]{0,300}\d)[^\s,;&}\])]{6,})/dgi },
  // a PIN: "pin: 4821", "pin code is 4821"
  { re: /\bpin(?:[ _-]?(?:code|number))?\s{0,20}(?:[:=]|\b(?:is|are|was)\b)\s{0,20}(?<v>\d{3,8})\b/dgi },
  // user:password@host without a scheme (a mailto: address is left alone)
  { re: /(?<![\w.%+-])(?!mailto:)(?<v>[\w.%+-]{1,200}:[^\s/?#@:]{1,200})@(?=[A-Za-z0-9[])/dgi },
  // bearer / basic values: 6+ characters with a digit, or 20+ of any
  { re: /\b(?:bearer|basic)\s{1,5}(?<v>(?=[A-Za-z0-9._~+/=-]{0,300}\d)[A-Za-z0-9._~+/=-]{6,}|[A-Za-z0-9._~+/=-]{20,})/dgi },
  { re: /\b(?<v>eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*)/dg },
  { re: /\b(?<v>(?:sk|pk|rk|ghp|gho|ghu|ghs|glpat|xox[abprs])[-_][A-Za-z0-9_-]{6,})/dg },
  { re: /\b(?<v>github_pat_[A-Za-z0-9_]{6,})/dg },
  { re: /\b(?<v>ya29\.[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,})/dg },
  { re: /\b(?<v>(?:AKIA|ASIA)[0-9A-Z]{12,})/dg },
  // generic long opaque runs (visitor text only): 20+ key characters with a letter and a digit, or 32+ that are not just lowercase words joined by hyphens;
  // and 32+ of base64 characters unless it is a lowercase path
  { re: /(?<v>[A-Za-z0-9_-]{20,})/dg, generic: true, accept: (m) => (hasDigit(m) && /[A-Za-z]/.test(m)) || (m.length >= 32 && !/^[a-z]+(?:-[a-z]+)+$/.test(m)) },
  { re: /(?<v>[A-Za-z0-9+/_=-]{32,})/dg, generic: true, accept: (m) => !/^[a-z0-9._-]+(?:\/[a-z0-9._-]+)+$/.test(m) && !/^[a-z]+(?:-[a-z]+)+$/.test(m) },
];

function rangesOf(text, generic) {
  const out = [];
  for (const { re, accept, generic: isGeneric } of DETECTORS) {
    if (isGeneric && !generic) continue;
    for (const m of text.matchAll(re)) {
      const [a, b] = m.indices.groups.v;
      if (b > a && (!accept || accept(text.slice(a, b)))) out.push([a, b]);
    }
  }
  return out;
}

// All three looks, as ranges of `text`.
function lookAll(text, generic) {
  const out = rangesOf(text, generic);
  if (text.includes('+')) out.push(...rangesOf(text.replaceAll('+', ' '), generic)); // same length: same positions
  if (SEPARATOR.test(text)) {
    const keep = []; let stripped = '';
    for (let i = 0; i < text.length; i += 1) if (!SEPARATOR.test(text[i])) { keep.push(i); stripped += text[i]; }
    for (const [a, b] of rangesOf(stripped, generic)) out.push([keep[a], keep[b - 1] + 1]);
  }
  return out;
}

function apply(text, ranges) {
  if (!ranges.length) return text;
  ranges.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  let out = ''; let at = 0; let [a, b] = ranges[0];
  const flush = () => { out += text.slice(at, a) + MARK; at = b; };
  for (let i = 1; i < ranges.length; i += 1) {
    const [x, y] = ranges[i];
    if (x <= b) { if (y > b) b = y; } else { flush(); a = x; b = y; }
  }
  flush();
  return out + text.slice(at);
}

// The text after normalising and percent-decoding, with the ranges found in it. The round that holds a credential is the one kept.
function analyse(input, generic) {
  const raw = typeof input === 'string' ? input : String(input ?? '');
  if (raw.length > MAX_RAW) return { text: TOO_LONG, ranges: [] };
  let cur = normalise(raw);
  let best = { text: cur, ranges: lookAll(cur, generic) };
  for (let i = 0; i < 3; i += 1) {
    const next = normalise(decodeOnce(cur));
    if (next === cur) break;
    cur = next;
    const ranges = lookAll(cur, generic);
    if (ranges.length) best = { text: cur, ranges };
  }
  return best;
}

// `generic: false` is the response layer: it leaves long ids, hashes and trace ids alone and masks the specific shapes only.
export function maskText(input, { generic = true } = {}) {
  const { text, ranges } = analyse(input, generic);
  return apply(text, ranges);
}

// The ranges (in the normalised, decoded text) that look like a credential. Empty = nothing found.
export const findCredentials = (input, { generic = true } = {}) => analyse(input, generic).ranges;
export const looksLikeCredential = (input, opts) => findCredentials(input, opts).length > 0;

// Free text from the visitor, as stored and shown: masked, whitespace collapsed. NOT cut to length: the caller refuses an over-long input whole
// (the length is the length as typed), so nothing is silently dropped and a token never straddles a cut.
export function cleanFree(value) {
  return maskText(typeof value === 'string' ? value : String(value ?? '')).replace(/\s+/g, ' ').trim();
}
