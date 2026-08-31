// Judge-output parsing, ported from draco-bench-box src/judge.ts (the
// battle-tested half: fence stripping, prose tolerance, and salvageVerdicts,
// which regex-recovers complete {"id","met"} pairs from a truncated response
// so a cut-off tail loses only trailing verdicts, not the whole grade).
//
// Extended for our payload: alongside `verdicts` the judge emits `lessons`
// and `tags`. Lessons deliberately do NOT survive salvage — a truncated
// free-text lesson is worse than none.

export type CriterionVerdict = { id: string; met: boolean; rationale: string };
export type JudgeLesson = {
  contextKey: string;
  lesson: string;
  confidence: number;
  polarity: "do" | "avoid";
};
export type ParsedJudgeResponse = { verdicts: CriterionVerdict[]; lessons: JudgeLesson[]; tags: string[] };

const EMPTY: ParsedJudgeResponse = { verdicts: [], lessons: [], tags: [] };

export function parseJudgeResponse(text: string): ParsedJudgeResponse {
  let payload = text.trim();
  const fence = payload.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) payload = fence[1]!.trim();
  if (!payload.startsWith("{")) {
    const start = payload.indexOf("{");
    const end = payload.lastIndexOf("}");
    if (start >= 0 && end > start) payload = payload.slice(start, end + 1);
  }

  try {
    const parsed = JSON.parse(payload) as {
      verdicts?: Array<Partial<CriterionVerdict>>;
      lessons?: Array<Record<string, unknown>>;
      tags?: unknown;
    };
    const verdicts: CriterionVerdict[] = [];
    for (const v of parsed.verdicts ?? []) {
      if (typeof v.id !== "string") continue;
      verdicts.push({ id: v.id, met: v.met === true, rationale: String(v.rationale ?? "") });
    }
    if (verdicts.length > 0) {
      const lessons: JudgeLesson[] = [];
      for (const l of parsed.lessons ?? []) {
        if (typeof l.lesson !== "string" || !l.lesson) continue;
        lessons.push({
          contextKey: typeof l.context_key === "string" && l.context_key ? l.context_key : "general",
          lesson: l.lesson,
          confidence: typeof l.confidence === "number" ? Math.max(0, Math.min(1, l.confidence)) : 0.5,
          polarity: l.polarity === "avoid" ? "avoid" : "do",
        });
      }
      const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === "string") : [];
      return { verdicts, lessons, tags };
    }
  } catch {
    // fall through to salvage
  }

  const salvaged = salvageVerdicts(text);
  return salvaged.length ? { verdicts: salvaged, lessons: [], tags: [] } : EMPTY;
}

/** Regex-recover id/met pairs, tolerant of key order and truncation.
 *  Ported verbatim from draco-bench-box. */
export function salvageVerdicts(text: string): CriterionVerdict[] {
  const out: CriterionVerdict[] = [];
  const seen = new Set<string>();
  const re =
    /\{[^{}]*?"id"\s*:\s*"([^"]+)"[^{}]*?"met"\s*:\s*(true|false)[^{}]*?\}|\{[^{}]*?"met"\s*:\s*(true|false)[^{}]*?"id"\s*:\s*"([^"]+)"[^{}]*?\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = m[1] ?? m[4];
    const met = (m[2] ?? m[3]) === "true";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, met, rationale: "" });
  }
  return out;
}
