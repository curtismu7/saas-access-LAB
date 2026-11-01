// Bounds on what a write may carry, checked on the whole body BEFORE anything runs: a text, a key, a list, an object or a nesting that is over the line
// is refused whole (413), never cut. That is why a request echo (the hop pane) never has to be cut: everything that gets that far is small enough to show.
// The numbers are part of the contract and the tests assert them as literals: a text of 400 characters is taken, 401 is refused; a key of 80, 81;
// a list of 20, 21; an object with 40 keys, 41; nesting 6 deep, 7. (Lengths are JavaScript string lengths, UTF-16 units, of the text as typed.)
// The field limits inside the engine (a reason 300, a comment 200) are tighter and refuse in their own words.
export const BOUNDS = Object.freeze({ text: 400, key: 80, items: 20, keys: 40, depth: 6 });

// true when the value breaks a bound. Iterative: a hostile structure cannot overflow the stack.
export function overBounds(value) {
  const work = [[value, 1]];
  while (work.length) {
    const [x, depth] = work.pop();
    if (typeof x === 'string') { if (x.length > BOUNDS.text) return true; continue; }
    if (x === null || typeof x !== 'object') continue;
    if (depth > BOUNDS.depth) return true;
    if (Array.isArray(x)) {
      if (x.length > BOUNDS.items) return true;
      for (const v of x) work.push([v, depth + 1]);
    } else {
      const keys = Object.keys(x);
      if (keys.length > BOUNDS.keys) return true;
      for (const k of keys) { if (k.length > BOUNDS.key) return true; work.push([x[k], depth + 1]); }
    }
  }
  return false;
}
