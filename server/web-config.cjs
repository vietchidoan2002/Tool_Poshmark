function databaseOptions(connectionString, requestedMax) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw Error("DATABASE_URL must be a PostgreSQL connection URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw Error("DATABASE_URL must be a PostgreSQL connection URL");
  if (url.hostname.endsWith(".neon.tech")) {
    // Import locks use a dedicated PostgreSQL session, not a transaction pooler.
    if (url.hostname.includes("-pooler."))
      throw Error(
        "Use the direct Neon connection: disable Connection pooling in Neon",
      );
    url.searchParams.set("sslmode", "verify-full");
  }
  const max = requestedMax === undefined ? 4 : Number(requestedMax);
  if (!Number.isInteger(max) || max < 3 || max > 10)
    throw Error("PG_POOL_MAX must be an integer from 3 to 10");
  return {
    connectionString: url.toString(),
    max,
    connectionTimeoutMillis: 20000,
    idleTimeoutMillis: 10000,
  };
}
module.exports = { databaseOptions };
