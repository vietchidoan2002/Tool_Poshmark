const crypto = require("node:crypto");

async function createWebStore(pool, secret) {
  if (!secret || secret.length < 32)
    throw Error("TOKEN_ENCRYPTION_KEY must contain at least 32 characters");
  const key = crypto.createHash("sha256").update(secret).digest();
  const encrypt = (value, userId) => {
    const iv = crypto.randomBytes(12),
      cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(userId));
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), bytes]
      .map((b) => b.toString("base64"))
      .join(".");
  };
  const decrypt = (value, userId) => {
    if (!value) return null;
    const [iv, tag, bytes] = value
      .split(".")
      .map((x) => Buffer.from(x, "base64"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(userId));
    decipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([decipher.update(bytes), decipher.final()]).toString(),
    );
  };
  await pool.query(`CREATE TABLE IF NOT EXISTS pm_users (
    id text PRIMARY KEY, email text NOT NULL, tokens text, sheet_id text NOT NULL DEFAULT '',
    token_version integer NOT NULL DEFAULT 0
  )`);
  return {
    async get(id) {
      return (await pool.query("SELECT * FROM pm_users WHERE id=$1", [id]))
        .rows[0];
    },
    decrypt,
    async connect(id, email, tokens) {
      const previous = await this.get(id);
      const old = previous?.tokens ? decrypt(previous.tokens, id) : {};
      // A new authorization response need not repeat an existing refresh token.
      const combined = { ...old, ...tokens };
      delete combined.id_token;
      await pool.query(
        `INSERT INTO pm_users (id,email,tokens) VALUES ($1,$2,$3)
        ON CONFLICT (id) DO UPDATE SET email=$2,tokens=$3,token_version=pm_users.token_version+1`,
        [id, email, encrypt(combined, id)],
      );
    },
    async refresh(id, version, tokens) {
      const current = await this.get(id);
      if (!current?.tokens || current.token_version !== version) return;
      const combined = { ...decrypt(current.tokens, id), ...tokens };
      delete combined.id_token;
      await pool.query(
        "UPDATE pm_users SET tokens=$1 WHERE id=$2 AND token_version=$3",
        [encrypt(combined, id), id, version],
      );
    },
    async setSheet(id, value) {
      await pool.query("UPDATE pm_users SET sheet_id=$1 WHERE id=$2", [
        value,
        id,
      ]);
    },
    async disconnect(id) {
      await pool.query(
        "UPDATE pm_users SET tokens=NULL,token_version=token_version+1 WHERE id=$1",
        [id],
      );
    },
    async lock(userId, sheetId) {
      const client = await pool.connect();
      const acquired = [];
      try {
        for (const name of ["pm-user:" + userId, "pm-sheet:" + sheetId]) {
          const result = await client.query(
            "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
            [name],
          );
          if (!result.rows[0].acquired) {
            for (const held of acquired)
              await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
                held,
              ]);
            client.release();
            return null;
          }
          acquired.push(name);
        }
        return async () => {
          let failure;
          try {
            for (const name of acquired)
              await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
                name,
              ]);
          } catch (error) {
            failure = error;
          } finally {
            client.release(failure);
          }
        };
      } catch (error) {
        client.release(error);
        throw error;
      }
    },
  };
}
module.exports = { createWebStore };
