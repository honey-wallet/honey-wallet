//! A small least-recently-used map with a fixed capacity. When full, inserting drops the
//! entry read or written longest ago, rather than clearing everything (which let a flood
//! of one-off keys wipe every other caller's cached answers).

use std::{
    collections::{BTreeMap, HashMap},
    hash::Hash,
};

pub struct BoundedLru<K, V> {
    capacity: usize,
    tick: u64,
    entries: HashMap<K, (u64, V)>,
    /// Last use → key, oldest first.
    order: BTreeMap<u64, K>,
}

impl<K: Hash + Eq + Clone, V> BoundedLru<K, V> {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            tick: 0,
            entries: HashMap::new(),
            order: BTreeMap::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn next_tick(&mut self) -> u64 {
        self.tick += 1;
        self.tick
    }

    /// The value, marked as just used.
    pub fn get(&mut self, key: &K) -> Option<&V> {
        let tick = self.next_tick();
        let (used, _) = self.entries.get_mut(key)?;
        self.order.remove(used);
        *used = tick;
        self.order.insert(tick, key.clone());
        self.entries.get(key).map(|(_, v)| v)
    }

    /// Whether the key is held, without marking it used.
    pub fn contains_key(&self, key: &K) -> bool {
        self.entries.contains_key(key)
    }

    pub fn insert(&mut self, key: K, value: V) {
        let tick = self.next_tick();
        if let Some((used, _)) = self.entries.remove(&key) {
            self.order.remove(&used);
        }
        while self.entries.len() >= self.capacity {
            let Some((_, oldest)) = self.order.pop_first() else {
                break;
            };
            self.entries.remove(&oldest);
        }
        self.order.insert(tick, key.clone());
        self.entries.insert(key, (tick, value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evicts_the_least_recently_used_one_at_a_time() {
        let mut lru = BoundedLru::new(3);
        lru.insert("a", 1);
        lru.insert("b", 2);
        lru.insert("c", 3);
        assert_eq!(lru.get(&"a"), Some(&1));
        lru.insert("d", 4);
        assert!(!lru.contains_key(&"b"), "b was used longest ago");
        assert!(lru.contains_key(&"a") && lru.contains_key(&"c") && lru.contains_key(&"d"));
        lru.insert("c", 30);
        assert_eq!(lru.len(), 3);
        assert_eq!(lru.get(&"c"), Some(&30));
    }

    #[test]
    fn a_flood_of_new_keys_keeps_hot_entries_that_are_read() {
        let mut lru = BoundedLru::new(100);
        lru.insert("hot".to_string(), 0);
        for i in 0..10_000 {
            lru.insert(format!("k{i}"), i);
            if i % 50 == 0 {
                assert!(lru.get(&"hot".to_string()).is_some(), "lost at {i}");
            }
        }
        assert_eq!(lru.len(), 100);
        assert_eq!(lru.order.len(), 100);
    }
}
