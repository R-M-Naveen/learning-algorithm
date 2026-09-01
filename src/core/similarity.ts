// Are two lessons saying the same thing?
//
// The first real judge run produced these two, from different trajectories:
//
//   "Use sub-agents to parallelize independent exploration tasks like git
//    history, dependency audit, and file structure review."
//   "Use parallel sub-agents for independent research tasks to save time."
//
// Same advice, different words — so different hashes, no merge, two rows both
// starting at 0.4 confidence and competing for the same retrieval slots. A
// judge running regularly fills the table with paraphrases, and the user-facing
// cost is an injection (or a set of proposed memories) that says one thing
// three times. That is the annoyance side of the ledger, so it is worth
// spending code on.
//
// Local and lexical, necessarily: the gateway has no embeddings endpoint and
// retrieval has to work offline. Two choices worth stating:
//
//   * The measure is the OVERLAP COEFFICIENT (|A∩B| / min(|A|,|B|)), not
//     Jaccard. On the real pair above Jaccard is 0.31 — low enough that a
//     threshold catching it would also merge unrelated lessons — while overlap
//     is 0.63, because a short paraphrase is largely CONTAINED in a longer
//     one. Containment is the right question for "is this already said".
//   * Similar lessons are SUPPRESSED AT RETRIEVAL, never merged in the store.
//     Merging is destructive and threshold-sensitive; suppression only changes
//     what rides a prompt, is reversible, and keeps both rows auditable.

/** Words that carry no topical information and would otherwise make any two
 *  sentences look related. Deliberately short: an aggressive list starts
 *  deciding what a lesson means. */
const FILLER = new Set([
  "a", "an", "and", "are", "as", "at", "be", "before", "but", "by", "do", "does", "for", "from", "if",
  "in", "is", "it", "its", "not", "of", "on", "or", "so", "that", "the", "then", "there", "this", "to",
  "was", "were", "when", "which", "with", "without", "you", "your",
]);

/** Truncation instead of stemming: `parallel` and `parallelize` have to match,
 *  and a real stemmer is a dependency this repo does not have. Five characters
 *  is enough to keep distinct words apart in practice (`brows` ≠ `branc`). */
const STEM_LEN = 5;

export function normalizeTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw || raw.length < 3 || FILLER.has(raw)) continue;
    out.add(raw.slice(0, STEM_LEN));
  }
  return out;
}

/** |A∩B| / min(|A|,|B|) — how much of the SHORTER text is already in the
 *  longer one. 0 when either side has no content words. */
export function overlapCoefficient(a: string, b: string): number {
  const ta = normalizeTokens(a);
  const tb = normalizeTokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

/** Calibrated against the real judge output in similarity.test.ts: the
 *  paraphrase pair scores 0.63 and every genuinely distinct pair from the same
 *  run scores ≤ 0.29. Raising this lets paraphrases through; lowering it
 *  starts merging real advice. */
export const NEAR_DUPLICATE_THRESHOLD = 0.6;

export function isNearDuplicate(a: string, b: string, threshold = NEAR_DUPLICATE_THRESHOLD): boolean {
  return overlapCoefficient(a, b) >= threshold;
}

/** Keep the first of each similar group. Callers apply this AFTER ranking and
 *  BEFORE the limit, so the better-ranked lesson is the survivor and the
 *  caller still gets a full complement of DISTINCT lessons.
 *
 *  `groupOf` bounds where suppression may happen, and it is not optional in
 *  spirit: "The api project pins its migrations by hand" and "The web project
 *  pins its migrations by hand" are textually near-identical and yet are two
 *  different facts about two different projects. Nothing may suppress across
 *  scopes — only within one. */
export function dropNearDuplicates<T>(
  items: T[],
  textOf: (item: T) => string,
  opts: { groupOf?: (item: T) => string; threshold?: number } = {},
): T[] {
  const threshold = opts.threshold ?? NEAR_DUPLICATE_THRESHOLD;
  const groupOf = opts.groupOf ?? (() => "");
  const kept: T[] = [];
  for (const item of items) {
    const text = textOf(item);
    const group = groupOf(item);
    if (kept.some((k) => groupOf(k) === group && isNearDuplicate(textOf(k), text, threshold))) continue;
    kept.push(item);
  }
  return kept;
}
