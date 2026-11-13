//! Spaces calls to one provider within its free rate limit, across every replica.
//!
//! Each call reserves the next free slot (one `interval` after the last one taken) and
//! sleeps until it. A slot further away than `max_wait` is not taken: the caller gets
//! `Busy` at once instead of joining an unbounded queue (docs/routing/AUDIT.md finding
//! 3). With Redis the slots are one shared schedule per provider (a Lua script on Redis
//! time), so N replicas together stay inside the provider's limit; without it, the
//! schedule is this process's own.

use std::{
    sync::{Mutex, OnceLock},
    time::Duration,
};

use tokio::time::Instant;

use crate::{error::AppError, redis_store::RedisStore};

/// Reserves a slot on Redis's clock. KEYS[1] holds the next free slot (unix ms).
/// ARGV: interval ms, max wait ms. Returns the wait in ms, or -1 when it is too long.
const RESERVE: &str = r"
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local slot = tonumber(redis.call('GET', KEYS[1]) or '0')
if slot < now then slot = now end
local wait = slot - now
if wait > tonumber(ARGV[2]) then return -1 end
redis.call('SET', KEYS[1], slot + tonumber(ARGV[1]), 'PX', wait + tonumber(ARGV[1]) + 1000)
return wait
";

/// The default bound on how long a call may wait for its slot.
pub const DEFAULT_MAX_WAIT: Duration = Duration::from_secs(5);

pub struct Pacer {
    /// The provider's name: the Redis key all replicas share.
    name: &'static str,
    interval: Duration,
    max_wait: Duration,
    next: Mutex<Instant>,
    redis: OnceLock<RedisStore>,
}

/// The slot after `next` at `now`: Some((wait, next after it)), None past `max_wait`.
pub fn reserve(
    next: Instant,
    now: Instant,
    interval: Duration,
    max_wait: Duration,
) -> Option<(Duration, Instant)> {
    let slot = next.max(now);
    let wait = slot - now;
    (wait <= max_wait).then_some((wait, slot + interval))
}

impl Pacer {
    pub fn new(name: &'static str, interval: Duration, max_wait: Duration) -> Self {
        Self {
            name,
            interval,
            max_wait,
            next: Mutex::new(Instant::now()),
            redis: OnceLock::new(),
        }
    }

    /// Shares the schedule with every replica through Redis.
    pub fn share(&self, redis: RedisStore) {
        let _ = self.redis.set(redis);
    }

    /// Waits for this call's slot; `Busy` at once when it is more than `max_wait` away.
    pub async fn wait(&self) -> Result<(), AppError> {
        let wait = match self.redis.get() {
            Some(redis) => self.reserve_shared(redis).await?,
            None => self.reserve_local()?,
        };
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        Ok(())
    }

    fn reserve_local(&self) -> Result<Duration, AppError> {
        let mut next = self.next.lock().unwrap_or_else(|p| p.into_inner());
        let (wait, after) = reserve(*next, Instant::now(), self.interval, self.max_wait)
            .ok_or_else(|| {
                tracing::info!(provider = self.name, "dex provider queue full");
                AppError::Busy
            })?;
        *next = after;
        Ok(wait)
    }

    async fn reserve_shared(&self, redis: &RedisStore) -> Result<Duration, AppError> {
        let key = redis.key("dex-pace", self.name);
        let wait: i64 = redis
            .query(
                redis::cmd("EVAL")
                    .arg(RESERVE)
                    .arg(1)
                    .arg(key)
                    .arg(self.interval.as_millis() as u64)
                    .arg(self.max_wait.as_millis() as u64),
            )
            .await?;
        match u64::try_from(wait) {
            Ok(ms) => Ok(Duration::from_millis(ms)),
            Err(_) => {
                tracing::info!(provider = self.name, "dex provider queue full (shared)");
                Err(AppError::Busy)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_are_spaced_and_bounded() {
        let now = Instant::now();
        let i = Duration::from_millis(350);
        let max = Duration::from_secs(1);
        // Idle: now, and the next one an interval later.
        assert_eq!(reserve(now, now, i, max), Some((Duration::ZERO, now + i)));
        // Behind by 0.7 s: wait for it.
        let behind = now + Duration::from_millis(700);
        assert_eq!(
            reserve(behind, now, i, max),
            Some((Duration::from_millis(700), behind + i))
        );
        // More than a second behind: refused, nothing reserved.
        assert_eq!(
            reserve(now + Duration::from_millis(1_001), now, i, max),
            None
        );
    }

    #[tokio::test]
    async fn a_full_queue_answers_busy_at_once_instead_of_waiting() {
        // Kyber's pace (350 ms) with a 1 s bound: four callers fit (0, .35, .7, 1.05 is
        // past it), the rest are refused immediately rather than queued.
        let pacer = Pacer::new("test", Duration::from_millis(350), Duration::from_secs(1));
        let started = Instant::now();
        let mut ok = 0;
        let mut busy = 0;
        let results =
            futures_util::future::join_all((0..20).map(|_| async { pacer.wait().await })).await;
        for r in results {
            match r {
                Ok(()) => ok += 1,
                Err(AppError::Busy) => busy += 1,
                Err(e) => panic!("{e:?}"),
            }
        }
        assert_eq!((ok, busy), (3, 17));
        // Nobody waited past the bound (the last slot was 0.7 s out).
        assert!(started.elapsed() < Duration::from_millis(1_000));
    }
}
