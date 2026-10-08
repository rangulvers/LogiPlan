// Human-friendly unique ids within one layout: prefix + incrementing number ("s1", "f12").

/** Next unused id for `prefix` given any iterable of existing ids. */
export function nextId(prefix, existing) {
  const used = new Set(existing);
  let n = 1;
  while (used.has(prefix + n)) n++;
  return prefix + n;
}
