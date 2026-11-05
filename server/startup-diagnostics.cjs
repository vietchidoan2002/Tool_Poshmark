// Fixed messages only: never log upstream errors, URLs or environment values.
const reasons = {
  CONFIG_PUBLIC_BASE_URL:
    "PUBLIC_BASE_URL/Render hostname is missing or invalid. Use an HTTPS origin only.",
  CONFIG_GOOGLE_CLIENT_ID: "GOOGLE_CLIENT_ID is missing.",
  CONFIG_GOOGLE_CLIENT_SECRET: "GOOGLE_CLIENT_SECRET is missing.",
  CONFIG_SESSION_SECRET:
    "SESSION_SECRET is missing or shorter than 32 characters. Use a generated random value.",
  CONFIG_TOKEN_ENCRYPTION_KEY:
    "TOKEN_ENCRYPTION_KEY is missing or shorter than 32 characters. Use a generated random value.",
  CONFIG_ADMIN_EMAILS:
    "ADMIN_EMAILS is required because REQUIRE_REVIEWED_PHONE is true.",
  "28P01":
    "Database authentication failed. Check the Neon role/password in DATABASE_URL.",
  28000:
    "Database authentication/authorization was rejected. Check Neon connection settings.",
  "3D000":
    "Database does not exist. Copy the correct Neon database connection string.",
  42501:
    "Database permission denied. The database role needs permission to create application tables.",
  53300:
    "Database connection limit reached. Close unused connections and retry.",
  "57P03":
    "Database is starting up or temporarily unavailable. Retry after Neon becomes active.",
  ENOTFOUND:
    "Database hostname could not be resolved. Check the Neon connection hostname.",
  EAI_AGAIN:
    "Temporary DNS failure reaching the database. Retry when networking is available.",
  ECONNREFUSED:
    "Database connection was refused. Check the Neon endpoint and connection settings.",
  ECONNRESET:
    "Database connection was interrupted. Retry and check Neon availability.",
  ETIMEDOUT:
    "Database connection timed out. Check Neon endpoint availability and networking.",
  CONNECTION_TIMEOUT:
    "Database connection timed out. Check Neon endpoint availability and networking.",
  ERR_TLS_CERT_ALTNAME_INVALID:
    "Database TLS hostname verification failed. Check the connection hostname; keep TLS verification enabled.",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    "Database TLS certificate verification failed. Check supported certificate/trust settings; do not disable verification.",
  SELF_SIGNED_CERT_IN_CHAIN:
    "Database TLS certificate chain is not trusted. Check supported certificate/trust settings; do not disable verification.",
};
function configurationError(code) {
  return Object.assign(
    new Error(reasons[code] || "Invalid web configuration"),
    { code },
  );
}
function startupDiagnostic(error) {
  let code = Object.hasOwn(reasons, error?.code) ? error.code : null;
  // node-postgres uses this fixed message without an error code for pool timeouts.
  if (
    !code &&
    error?.message === "Connection terminated due to connection timeout"
  )
    code = "CONNECTION_TIMEOUT";
  if (!code && Array.isArray(error?.errors)) {
    code =
      error.errors.find((item) => Object.hasOwn(reasons, item?.code))?.code ||
      null;
  }
  return `[WEB_STARTUP:${code || "UNKNOWN"}] ${code ? reasons[code] : "Startup failed. Check database/schema availability and environment configuration. Upstream error details are withheld to protect credentials."}`;
}
module.exports = { configurationError, startupDiagnostic };
