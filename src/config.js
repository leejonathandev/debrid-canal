import { randomBytes } from "node:crypto";

export function resolveSessionSecret(env = process.env) {
  const value = env.SESSION_SECRET?.trim();
  const weak = !value || value.length < 32 || /^(change[\s_-]*me|debrid-canal-secret|your[\s_-].*secret)/i.test(value);
  if (env.NODE_ENV === "production" && weak) {
    throw new Error("Production requires SESSION_SECRET with at least 32 characters; generate it with openssl rand -hex 32.");
  }
  return weak ? randomBytes(32).toString("hex") : value;
}

export function positiveInteger(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Expected a positive integer configuration value.");
  return number;
}

export function resolveTrustProxy(value = "1") {
  if (value === "false" || value === false) return false;
  const hops = Number(value);
  if (!Number.isSafeInteger(hops) || hops < 0 || hops > 10) {
    throw new Error("TRUST_PROXY must be a hop count between 0 and 10 (or false).");
  }
  return hops;
}
