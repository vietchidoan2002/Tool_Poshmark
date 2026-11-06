const normalizeEmail = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();
const DISABLED_PASSWORD = "disabled-unverified-google-claim";

async function initializeIdentities(pool, store, { lockTables = true } = {}) {
  await pool.query(`CREATE TABLE IF NOT EXISTS pm_user_aliases (
    old_user_id text PRIMARY KEY, user_id text NOT NULL REFERENCES pm_users(id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS pm_user_merge_archive (
    id bigserial PRIMARY KEY, original_user_id text NOT NULL, canonical_user_id text NOT NULL,
    snapshot text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  )`);
  const client = await pool.connect();
  let mergedGroups = 0;
  let removedCopies = 0;
  try {
    await client.query("BEGIN");
    if (lockTables)
      await client.query(
        "LOCK TABLE pm_users, pm_password_accounts, pm_phone_profiles, pm_account_actions IN ACCESS EXCLUSIVE MODE",
      );
    const users = (await client.query("SELECT * FROM pm_users ORDER BY id"))
      .rows;
    const passwords = new Map(
      (await client.query("SELECT * FROM pm_password_accounts")).rows.map(
        (row) => [row.user_id, row],
      ),
    );
    const phones = new Map(
      (await client.query("SELECT * FROM pm_phone_profiles")).rows.map(
        (row) => [row.user_id, row],
      ),
    );
    const groups = new Map();
    const hasRuns =
      (
        await client.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='pm_get_runs'",
        )
      ).rows.length > 0;
    for (const user of users) {
      const key = normalizeEmail(user.email);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(user);
    }
    for (const [email, group] of groups) {
      if (group.length > 1) {
        mergedGroups++;
        removedCopies += group.length - 1;
        // Keep the password account's stable ID; a verified password takes priority.
        group.sort(
          (a, b) =>
            Number(!!passwords.get(b.id)?.email_verified) -
              Number(!!passwords.get(a.id)?.email_verified) ||
            Number(passwords.has(b.id)) - Number(passwords.has(a.id)) ||
            a.id.localeCompare(b.id),
        );
        const target = group[0];
        const googleProof = group.some((user) => !passwords.has(user.id));
        for (const user of group) {
          await client.query(
            "INSERT INTO pm_user_merge_archive(original_user_id,canonical_user_id,snapshot) VALUES($1,$2,$3)",
            [
              user.id,
              target.id,
              store.encrypt(
                {
                  user,
                  password: passwords.get(user.id) || null,
                  phone: phones.get(user.id) || null,
                },
                user.id,
              ),
            ],
          );
        }
        let tokens = null;
        for (const user of group.filter((user) => user.tokens)) {
          try {
            tokens = store.encrypt(
              store.decrypt(user.tokens, user.id),
              target.id,
            );
            break;
          } catch {
            /* Preserve unreadable ciphertext in the archive; a new Google login can reconnect. */
          }
        }
        const sheetId = group.find((user) => user.sheet_id)?.sheet_id || "";
        const phoneRows = group
          .map((user) => phones.get(user.id))
          .filter(Boolean);
        const bestPhone = phoneRows
          .filter((row) => row.phone)
          .sort((a, b) => Number(b.reviewed) - Number(a.reviewed))[0];
        for (const user of group) {
          await client.query(
            "DELETE FROM pm_account_actions WHERE user_id=$1",
            [user.id],
          );
          await client.query("DELETE FROM pm_phone_profiles WHERE user_id=$1", [
            user.id,
          ]);
          if (user.id !== target.id)
            await client.query(
              "DELETE FROM pm_password_accounts WHERE user_id=$1",
              [user.id],
            );
        }
        if (phoneRows.length)
          await client.query(
            "INSERT INTO pm_phone_profiles(user_id,phone,version,reviewed,reviewed_at,reviewed_by) VALUES($1,$2,$3,$4,$5,$6)",
            [
              target.id,
              bestPhone?.phone || null,
              Math.max(...phoneRows.map((row) => row.version)) + 1,
              !!bestPhone?.reviewed,
              bestPhone?.reviewed_at || null,
              bestPhone?.reviewed_by || null,
            ],
          );
        const password = passwords.get(target.id);
        if (password)
          await client.query(
            "UPDATE pm_password_accounts SET email=$1,password_hash=$2,email_verified=$3,auth_version=auth_version+1 WHERE user_id=$4",
            [
              email,
              googleProof && !password.email_verified
                ? DISABLED_PASSWORD
                : password.password_hash,
              password.email_verified || googleProof,
              target.id,
            ],
          );
        for (const user of group.slice(1)) {
          await client.query(
            "UPDATE pm_user_aliases SET user_id=$1 WHERE user_id=$2",
            [target.id, user.id],
          );
          await client.query(
            "INSERT INTO pm_user_aliases(old_user_id,user_id) VALUES($1,$2) ON CONFLICT(old_user_id) DO UPDATE SET user_id=$2",
            [user.id, target.id],
          );
          await client.query(
            "UPDATE pm_phone_audit SET user_id=$1 WHERE user_id=$2",
            [target.id, user.id],
          );
          if (hasRuns)
            await client.query(
              "UPDATE pm_get_runs SET user_id=$1 WHERE user_id=$2",
              [target.id, user.id],
            );
          await client.query("DELETE FROM pm_users WHERE id=$1", [user.id]);
        }
        await client.query(
          "UPDATE pm_users SET email=$1,tokens=$2,sheet_id=$3,token_version=$4,session_version=$6,status=$7,deleted_at=$8,created_at=$9,last_seen_at=$10,display_name=$11 WHERE id=$5",
          [
            email,
            tokens,
            sheetId,
            Math.max(...group.map((user) => user.token_version)) + 1,
            target.id,
            Math.max(...group.map((user) => user.session_version || 1)) + 1,
            group.some((user) => user.status !== "active")
              ? "suspended"
              : "active",
            group.find((user) => user.deleted_at)?.deleted_at || null,
            group
              .filter((user) => user.created_at)
              .map((user) => user.created_at)
              .sort((a, b) => new Date(a) - new Date(b))[0] || null,
            group
              .filter((user) => user.last_seen_at)
              .map((user) => user.last_seen_at)
              .sort((a, b) => new Date(b) - new Date(a))[0] || null,
            target.display_name || password?.display_name || "",
          ],
        );
      } else if (group[0].email !== email) {
        await client.query("UPDATE pm_users SET email=$1 WHERE id=$2", [
          email,
          group[0].id,
        ]);
      }
    }
    await client.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS pm_users_email_unique ON pm_users (lower(email))",
    );
    await client.query("COMMIT");
    if (mergedGroups)
      console.info(
        `[ACCOUNT_MERGE] Consolidated ${mergedGroups} email groups; archived and removed ${removedCopies} duplicate copies.`,
      );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  async function resolveId(id) {
    return (
      (
        await pool.query(
          "SELECT user_id FROM pm_user_aliases WHERE old_user_id=$1",
          [id],
        )
      ).rows[0]?.user_id || id
    );
  }
  async function claimGoogle(identity) {
    if (
      identity?.email_verified !== true ||
      typeof identity.sub !== "string" ||
      !identity.sub ||
      !identity.email
    )
      throw Error("Google identity must be verified");
    const email = normalizeEmail(identity.email);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const alias = (
        await client.query(
          "SELECT user_id FROM pm_user_aliases WHERE old_user_id=$1",
          [identity.sub],
        )
      ).rows[0];
      let user = (
        await client.query("SELECT * FROM pm_users WHERE id=$1", [
          alias?.user_id || identity.sub,
        ])
      ).rows[0];
      if (!user)
        user = (
          await client.query("SELECT * FROM pm_users WHERE lower(email)=$1", [
            email,
          ])
        ).rows[0];
      if (!user) {
        // The unique email index arbitrates simultaneous Google/signup requests.
        await client.query(
          "INSERT INTO pm_users(id,email) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [identity.sub, email],
        );
        user = (
          await client.query("SELECT * FROM pm_users WHERE lower(email)=$1", [
            email,
          ])
        ).rows[0];
      }
      if (!user) throw Error("Google identity could not be claimed");
      if (user.deleted_at || user.status !== "active")
        throw Object.assign(new Error("Tài khoản đã bị khóa hoặc xóa."), {
          code: "ACCOUNT_DISABLED",
          status: 403,
        });
      const password = (
        await client.query(
          "SELECT * FROM pm_password_accounts WHERE user_id=$1 FOR UPDATE",
          [user.id],
        )
      ).rows[0];
      if (
        password &&
        !password.email_verified &&
        normalizeEmail(password.email) === email
      ) {
        // Google proves the email, not ownership of a previously entered password.
        // Disable an unverified pre-registration password and revoke its sessions/links.
        await client.query(
          "UPDATE pm_password_accounts SET password_hash=$1,email_verified=true,auth_version=auth_version+1,failed_attempts=0,locked_until=NULL WHERE user_id=$2",
          [DISABLED_PASSWORD, user.id],
        );
        await client.query("DELETE FROM pm_account_actions WHERE user_id=$1", [
          user.id,
        ]);
      }
      if (identity.sub !== user.id)
        await client.query(
          "INSERT INTO pm_user_aliases(old_user_id,user_id) VALUES($1,$2) ON CONFLICT(old_user_id) DO UPDATE SET user_id=$2",
          [identity.sub, user.id],
        );
      await client.query("COMMIT");
      return user.id;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return { resolveId, claimGoogle };
}
module.exports = { initializeIdentities, DISABLED_PASSWORD };
