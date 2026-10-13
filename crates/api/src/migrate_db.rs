//! `api migrate-db --from sqlite://… --to postgres://…`: moves a server that outgrew SQLite
//! to Postgres. Both are migrated to the current schema first; then every table is copied
//! in foreign-key order inside one transaction, converting where the two differ (SQLite's
//! 0/1 to booleans). The target must be empty; the source is left as it was.

use std::collections::HashSet;

use anyhow::{Context, bail};
use sqlx::postgres::PgArguments;
use sqlx::sqlite::SqliteRow;
use sqlx::{Column, PgPool, Row, SqlitePool, TypeInfo, ValueRef};

/// Every table, parents before children. A table missing here fails the copy (a new
/// migration needs adding), rather than being left behind.
const TABLES: &[&str] = &[
    "users",
    "sessions",
    "guilds",
    "members",
    "roles",
    "member_roles",
    "channels",
    "channel_overwrites",
    "messages",
    "reactions",
    "emotes",
    "invites",
    "attachments",
    "read_states",
    "federation",
    "instance_bans",
    "instance_settings",
    "instance_staff",
    "guild_bans",
    "audit_log",
    "webhooks",
    "polls",
    "poll_votes",
    "notify_settings",
    "guild_events",
    "event_interest",
];

pub async fn run(from: &str, to: &str) -> anyhow::Result<()> {
    anyhow::ensure!(from.starts_with("sqlite:"), "--from must be a sqlite:// URL");
    anyhow::ensure!(crate::db::is_postgres(to), "--to must be a postgres:// URL");
    // Brings both to the current schema (and creates the Postgres tables).
    crate::db::connect(from).await.context("source")?.close().await;
    crate::db::connect(to).await.context("target")?.close().await;

    let src = SqlitePool::connect(from).await?;
    // One connection, so a search path set on it holds for everything below.
    let dst: PgPool = sqlx::postgres::PgPoolOptions::new().max_connections(1).connect(to).await?;
    if let Ok(schema) = std::env::var("DATABASE_SCHEMA") {
        // (Tests keep their tables in a schema of their own.)
        anyhow::ensure!(schema.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'), "bad schema name");
        sqlx::query(sqlx::AssertSqlSafe(format!("SET search_path TO {schema}"))).execute(&dst).await?;
    }
    let tables: HashSet<String> = sqlx::query_scalar("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name <> '_sqlx_migrations'")
        .fetch_all(&dst)
        .await?
        .into_iter()
        .collect();
    let missing: Vec<&String> = tables.iter().filter(|t| !TABLES.contains(&t.as_str())).collect();
    if !missing.is_empty() {
        bail!("migrate-db doesn't know these tables yet: {missing:?}");
    }
    let (users,): (i64,) = sqlx::query_as("SELECT count(*) FROM users").fetch_one(&dst).await?;
    if users > 0 {
        bail!("the target already has data; migrate into an empty database");
    }

    let mut tx = dst.begin().await?;
    for table in TABLES {
        let columns: Vec<(String, String)> = sqlx::query_as(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position",
        )
        .bind(table)
        .fetch_all(&mut *tx)
        .await?;
        let rows: Vec<SqliteRow> = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT * FROM {table}"))).fetch_all(&src).await?;
        let Some(first) = rows.first() else {
            tracing::info!("{table}: empty");
            continue;
        };
        // Only columns both sides have (the schemas match, but be safe).
        let have: HashSet<&str> = first.columns().iter().map(|c| c.name()).collect();
        let cols: Vec<&(String, String)> = columns.iter().filter(|(n, _)| have.contains(n.as_str())).collect();
        let sql = format!(
            "INSERT INTO {table} ({}) VALUES ({})",
            cols.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join(", "),
            (1..=cols.len()).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ")
        );
        for row in &rows {
            let mut q = sqlx::query_with(sqlx::AssertSqlSafe(sql.clone()), PgArguments::default());
            for (name, ty) in &cols {
                q = bind(q, row, name, ty).with_context(|| format!("{table}.{name}"))?;
            }
            q.execute(&mut *tx).await.with_context(|| format!("copying {table}"))?;
        }
        tracing::info!("{table}: {} rows", rows.len());
    }
    tx.commit().await?;
    tracing::info!("migrate-db: done; point DATABASE_URL at the new database");
    Ok(())
}

type Query<'q> = sqlx::query::Query<'q, sqlx::Postgres, PgArguments>;

/// Binds one SQLite value as the Postgres column's type.
fn bind<'q>(q: Query<'q>, row: &SqliteRow, name: &str, ty: &str) -> anyhow::Result<Query<'q>> {
    let null = row.try_get_raw(name)?.is_null();
    Ok(match ty {
        "bigint" | "integer" | "smallint" => {
            let v: Option<i64> = if null { None } else { Some(row.try_get(name)?) };
            if ty == "bigint" { q.bind(v) } else { q.bind(v.map(|v| v as i32)) }
        }
        "boolean" => {
            // SQLite keeps booleans as 0/1.
            let v: Option<i64> = if null { None } else { Some(row.try_get(name)?) };
            q.bind(v.map(|v| v != 0))
        }
        "bytea" => q.bind(if null { None } else { Some(row.try_get::<Vec<u8>, _>(name)?) }),
        "double precision" | "real" => q.bind(if null { None } else { Some(row.try_get::<f64, _>(name)?) }),
        "text" | "character varying" => q.bind(if null { None } else { Some(row.try_get::<String, _>(name)?) }),
        other => bail!("unhandled column type {other} ({})", row.try_get_raw(name)?.type_info().name()),
    })
}

#[cfg(test)]
mod tests {
    /// A SQLite server with a bit of everything moves to Postgres intact.
    /// Needs TEST_DATABASE_URL (Postgres); skipped without it.
    #[tokio::test]
    async fn copies_a_server_to_postgres() {
        let Ok(pg) = std::env::var("TEST_DATABASE_URL") else { return };
        let dir = std::env::temp_dir().join(format!("migrate-db-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let from = format!("sqlite://{}/db.sqlite", dir.display());
        let src = crate::db::connect(&from).await.unwrap();
        for q in [
            "INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (1, 'ana', 'Ana', 'x', 0)",
            "INSERT INTO sessions (token_hash, user_id, created_at) VALUES (x'0102', 1, 0)",
            "INSERT INTO guilds (id, name, owner_id) VALUES (10, 'g', 1)",
            "INSERT INTO members (guild_id, user_id, joined_at) VALUES (10, 1, 0)",
            "INSERT INTO roles (id, guild_id, name, position, permissions, hoist, mentionable) VALUES (10, 10, '@everyone', 0, 5, 1, 0)",
            "INSERT INTO channels (id, guild_id, name, kind, position) VALUES (20, 10, 'general', 'text', 0)",
            "INSERT INTO messages (id, channel_id, author_id, content, mention_everyone) VALUES (30, 20, 1, 'hi', 1)",
        ] {
            sqlx::query(q).execute(&src).await.unwrap();
        }
        src.close().await;

        let schema = format!("migdb_{}", std::process::id());
        // SAFETY: test-only; set before anything reads it.
        unsafe { std::env::set_var("DATABASE_SCHEMA", &schema) };
        super::run(&from, &pg).await.unwrap();
        let dst = sqlx::PgPool::connect(&pg).await.unwrap();
        let q = |s: &str| sqlx::query_as::<_, (bool,)>(sqlx::AssertSqlSafe(s.replace("$S", &schema)));
        assert!(q("SELECT mention_everyone FROM $S.messages WHERE id = 30").fetch_one(&dst).await.unwrap().0);
        assert!(q("SELECT hoist FROM $S.roles WHERE id = 10").fetch_one(&dst).await.unwrap().0);
        let (hash,): (Vec<u8>,) = sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT token_hash FROM {schema}.sessions"))).fetch_one(&dst).await.unwrap();
        assert_eq!(hash, vec![1, 2]);
        // A second run refuses: the target isn't empty any more.
        assert!(super::run(&from, &pg).await.is_err());
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE"))).execute(&dst).await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
