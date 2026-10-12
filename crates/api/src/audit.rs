//! The guild audit log: who changed what, with the old and new values. Writing an entry
//! never fails the action that caused it; a lost entry is logged instead.

use proto::Id;
use proto::models::{AuditAction, AuditChange};

use crate::state::AppState;

/// How long entries are kept.
const KEEP_DAYS: i64 = 90;

pub struct Entry {
    pub action: AuditAction,
    pub target: Option<Id>,
    pub target_name: Option<String>,
    pub changes: Vec<AuditChange>,
    pub reason: Option<String>,
}

impl Entry {
    pub fn new(action: AuditAction, target: Option<Id>, target_name: impl Into<Option<String>>) -> Self {
        Entry { action, target, target_name: target_name.into(), changes: Vec::new(), reason: None }
    }

    /// Records `key` going from `old` to `new`, if it changed.
    pub fn change<T: ToString + PartialEq>(mut self, key: &str, old: Option<T>, new: Option<T>) -> Self {
        if old != new {
            self.changes.push(AuditChange { key: key.into(), old: old.map(|v| v.to_string()), new: new.map(|v| v.to_string()) });
        }
        self
    }

    pub fn reason(mut self, reason: Option<String>) -> Self {
        self.reason = reason;
        self
    }
}

pub async fn log(state: &AppState, guild: Id, actor: Id, e: Entry) {
    let changes = (!e.changes.is_empty()).then(|| serde_json::to_string(&e.changes).expect("changes serialize"));
    let r = sqlx::query(
        "INSERT INTO audit_log (id, guild_id, actor_id, action, target_id, target_name, changes, reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(state.ids.next().0)
    .bind(guild.0)
    .bind(actor.0)
    .bind(e.action.as_str())
    .bind(e.target.map(|t| t.0))
    .bind(e.target_name)
    .bind(changes)
    .bind(e.reason)
    .execute(&state.db)
    .await;
    if let Err(err) = r {
        tracing::warn!("audit log for guild {}: {err}", guild.0);
    }
}

/// Drops entries older than `KEEP_DAYS`, hourly.
pub async fn trim(state: AppState) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(3600));
    loop {
        tick.tick().await;
        let cutoff_ms = crate::db::now_ms() - KEEP_DAYS * 24 * 3600 * 1000;
        let cutoff_id = (cutoff_ms - proto::id::EPOCH_MS as i64).max(0) << 22;
        if let Err(e) = sqlx::query("DELETE FROM audit_log WHERE id < $1").bind(cutoff_id).execute(&state.db).await {
            tracing::warn!("trimming the audit log: {e}");
        }
    }
}
