// Masking for anything a visitor types that this lab keeps or shows back (a reason, a comment, an echoed request, a hop pane, an audit entry, a key name, a
// path id). Typed text can carry a real credential, so it is masked on the way IN (what is stored) and again on the way OUT (every answer), and ALWAYS
// before anything is cut or shown. This file is a thin adapter over the canonical shared masker (shared/mask.js, shared-masker 1.4.0); the detectors live
// there and are described in its README ("Known limits"). THIS IS A HEURISTIC: it recognises common shapes, not every secret. Do not type a real
// credential into a lab. The names below are the ones the rest of the app already imports.
import { createMasker } from './shared/mask.js';
import { OPAQUE_KEYS, opaqueHere } from './maskConfig.js';

// One masker, plain mark "[masked]", the lab's own exceptions (maskConfig.js).
export const masker = createMasker({ markStyle: 'plain', tooLongText: '[masked: text too long to check]', opaqueKeys: OPAQUE_KEYS, opaque: opaqueHere });
export const { maskText, maskDeep, looksLikeCredential, isCredentialId } = masker;

// A hit is reported as one range over the whole text: the shared masker answers "is there a credential", not where (the ranges are not part of its API).
export const findCredentials = (input) => {
  const s = typeof input === 'string' ? input : String(input ?? '');
  return looksLikeCredential(s) ? [[0, s.length]] : [];
};

// Control characters and bidi controls (the ones that can reorder or hide what a reviewer reads) are deleted from stored text AFTER masking. Zero-width and
// other format characters are left as typed: deleting them could join the pieces of a word the masker had no reason to mask into a new plain word (corpus
// row L2146 "h<ZWSP>u<ZWSP>n..." is such a case), and the shared masker keeps the original text around a mask for the same reason. Tab, newline and carriage
// return are kept here and collapse to one space below.
const INVISIBLE = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const keepWhitespace = (ch) => (ch === '\t' || ch === '\n' || ch === '\r' ? ch : '');

// Free text from the visitor, as stored and shown: masked FIRST, then invisible characters deleted, whitespace collapsed. NOT cut to length: the caller
// refuses an over-long input whole (the length is the length as typed), so nothing is silently dropped and a token never straddles a cut.
export function cleanFree(value) {
  return maskText(typeof value === 'string' ? value : String(value ?? '')).replace(INVISIBLE, keepWhitespace).replace(/\s+/gu, ' ').trim();
}
