// The response layer. Every JSON answer passes through maskDeep, so a credential-shaped value can never leave in any field, and not in an object KEY either,
// even if a code path forgot to clean its input. Iterative: a deep structure cannot overflow the stack. Same masker as the input side (credentials.js) minus its
// generic long-run detectors (ids, hashes and trace ids are long and legitimate); the specific token, key, bearer, userinfo and keyword detectors all apply.
import { maskText } from './credentials.js';

export const maskResponseText = (text) => maskText(text, { generic: false });

const put = (obj, key, value) => Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });

// A copy of any JSON-like value with every string AND every object key masked. Two keys that mask to the same text are kept apart ("#2"), nothing is
// dropped, and a key called __proto__ stays an ordinary own property of the copy.
export function maskDeep(value) {
  const memo = new Map(); // the same text is masked once per call
  const mask = (s) => { let m = memo.get(s); if (m === undefined) { m = maskResponseText(s); memo.set(s, m); } return m; };
  const out = {};
  const work = [[value, out, 'v']];
  while (work.length) {
    const [x, dst, key] = work.pop();
    if (typeof x === 'string') put(dst, key, mask(x));
    else if (x === null || typeof x !== 'object') put(dst, key, x);
    else if (Array.isArray(x)) {
      const copy = []; put(dst, key, copy);
      for (let i = x.length - 1; i >= 0; i -= 1) work.push([x[i], copy, i]);
    } else {
      const copy = {}; put(dst, key, copy);
      const used = new Set(); const names = [];
      for (const k of Object.keys(x)) {
        let nk = mask(k); let n = 2;
        while (used.has(nk)) { nk = `${mask(k)}#${n}`; n += 1; }
        used.add(nk); names.push([k, nk]);
      }
      for (let i = names.length - 1; i >= 0; i -= 1) work.push([x[names[i][0]], copy, names[i][1]]);
    }
  }
  return out.v;
}
