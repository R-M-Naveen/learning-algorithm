// Unbiased API key + gateway resolution, shared by every pareto-mode entry
// point. Same precedence as unbiased-app-engine: the environment wins, then
// the credentials file `unbiased login` writes.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ParetoJudgeBackend } from "./pareto.ts";

export function resolveUnbiasedKey(): string {
  const env = process.env.UNBIASED_API_KEY?.trim();
  if (env) return env;
  try {
    const creds = JSON.parse(readFileSync(join(homedir(), ".unbiased", "credentials.json"), "utf8")) as {
      apiKey?: string;
    };
    return creds.apiKey?.trim() ?? "";
  } catch {
    return "";
  }
}

export function paretoBackendFromEnv(): ParetoJudgeBackend {
  const key = resolveUnbiasedKey();
  if (!key) throw new Error("no API key: set UNBIASED_API_KEY or run `unbiased login`");
  return new ParetoJudgeBackend({
    baseUrl: process.env.UNBIASED_BASE_URL?.trim() || "https://api.unbiased.ai/v1",
    apiKey: key,
  });
}
