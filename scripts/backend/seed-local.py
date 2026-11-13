#!/usr/bin/env python3
"""Fills the LOCAL development database with sample social data.

LOCAL ONLY. Writes to the disposable Postgres from compose.backend.yaml through
`docker compose exec`, never to a URL, so it cannot reach a deployed database.

    docker compose -p honey-backend-dev -f compose.backend.yaml up -d --wait
    (cd apps/server && cargo run -- migrate && cargo run)   # the API on :8080
    python3 scripts/backend/seed-local.py

What it adds: 12 people (the cast the app's test mode uses, plus others), who follow each
other; 15 public jars with 30 days of hourly value marks, copies and milestones, so
Explore, the leaderboard and sparklines have something to rank; theses and shared trades
for the feed; a private profile and a jar with hidden picks; and three group jars
(inviting, funding, bought).

Your own account: sign in on the phone and claim a handle, then run this again. Every
profile that isn't a sample one then follows six of them, is followed back by four, is
invited to one group jar, holds a paid share of another and has three notifications.

Re-running replaces the sample data (and only it). Returns are set against the live prices
the local API serves, so they read as real moves; the server's hourly marker carries them on.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMPOSE = [
    "docker", "compose", "-p", "honey-backend-dev",
    "-f", str(ROOT / "compose.backend.yaml"),
]
NS = uuid.UUID("6f1d3a4e-6b0e-4c55-9a43-5eed0da7a001")


def uid(*parts: str) -> str:
    return str(uuid.uuid5(NS, ":".join(parts)))


def q(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def ago(hours: float) -> str:
    return f"now() - make_interval(secs => {hours * 3600:.0f})"


# handle, display name, bio, avatar seed, shares trades, privacy overrides
PEOPLE = [
    ("nina_macro", "Nina Osei", "Macro, rates and the dollar. Slow money.", "nina", True, {}),
    ("ana_defi", "Ana Lima", "DeFi since the first summer. Fees over vibes.", "ana", True, {}),
    ("solmaxi", "Dev on Sol", "Cheap blocks, fast apps.", "solmaxi", True, {}),
    ("steady_sara", "Sara", "Boring jars, rebalanced monthly.", "sara", False, {}),
    ("raj_builds", "Raj", "Building on NEAR. Investing in what I use.", "raj", True, {}),
    ("kofi_onchain", "Kofi Mensah", "L2s and the rollup trade.", "kofi", True, {}),
    ("mei_yields", "Mei Chen", "Yield first, narrative second.", "mei", False, {}),
    ("leo_quant", "Leo Varga", "Systematic. I don't share returns.", "leo", True,
     {"show_returns": False}),
    ("priya_hodl", "Priya Nair", "Bitcoin and chill.", "priya", False, {}),
    ("tomas_ai", "Tomás Ruiz", "AI agents need rails.", "tomas", True, {}),
    ("hana_l2", "Hana Sato", "Memecoins with a stop loss.", "hana", True, {}),
    ("quiet_whale", "Quiet whale", "", "whale", False, {"public_profile": False}),
]

# owner, name, thesis, picks [(symbol, chain, weight)], return now, age (hours),
# copiers [(handle, hours ago)], copy fee, hide picks
JARS = [
    ("nina_macro", "Dollar abroad", "Dollars earning abroad, on chains that settle fast.",
     [("USDC", "NEAR", 50), ("NEAR", "NEAR", 25), ("SOL", "Solana", 25)], 0.034, 150,
     [("raj_builds", 120), ("steady_sara", 90), ("mei_yields", 30), ("kofi_onchain", 6)], 10, False),
    ("nina_macro", "Hard money", "Bitcoin and gold-adjacent, for when it all gets loud.",
     [("BTC", "NEAR", 70), ("ETH", "Ethereum", 30)], 0.118, 640,
     [("priya_hodl", 600), ("steady_sara", 400), ("ana_defi", 200), ("hana_l2", 40),
      ("tomas_ai", 20), ("raj_builds", 3)], 10, False),
    ("ana_defi", "DeFi blue chips", "Fees are back on the blue chips.",
     [("AAVE", "Ethereum", 40), ("UNI", "Ethereum", 30), ("LINK", "Ethereum", 30)], 0.262, 520,
     [("mei_yields", 500), ("kofi_onchain", 300), ("nina_macro", 160), ("solmaxi", 50),
      ("hana_l2", 26), ("tomas_ai", 12), ("raj_builds", 2)], 15, False),
    ("ana_defi", "Lending only", "Borrow demand is the cleanest signal in crypto.",
     [("AAVE", "Ethereum", 100)], -0.071, 200, [("mei_yields", 150)], 10, False),
    ("solmaxi", "Solana stack", "Cheap blocks win the next cycle.",
     [("SOL", "Solana", 70), ("USDC", "Ethereum", 30)], 0.155, 430,
     [("hana_l2", 400), ("tomas_ai", 220), ("kofi_onchain", 70), ("ana_defi", 8)], 10, False),
    ("steady_sara", "Sleep well", "Mostly dollars, a little upside. Rebalanced monthly.",
     [("USDC", "Ethereum", 60), ("BTC", "NEAR", 25), ("ETH", "Ethereum", 15)], 0.021, 700,
     [("priya_hodl", 500), ("nina_macro", 300)], 5, False),
    ("raj_builds", "NEAR builders", "The apps I use every day run here.",
     [("NEAR", "NEAR", 60), ("ETH", "Ethereum", 20), ("USDC", "NEAR", 20)], 0.512, 690,
     [("tomas_ai", 650), ("nina_macro", 500), ("solmaxi", 300), ("kofi_onchain", 140),
      ("ana_defi", 60), ("hana_l2", 30), ("mei_yields", 10), ("steady_sara", 4)], 10, False),
    ("kofi_onchain", "Rollup season", "L2 tokens lag their own usage. Not for long.",
     [("ARB", "Arbitrum", 40), ("OP", "Optimism", 35), ("ETH", "Ethereum", 25)], -0.118, 380,
     [("hana_l2", 300), ("ana_defi", 100)], 20, False),
    ("mei_yields", "Stable yield", "Dollars that work while I sleep.",
     [("USDC", "Ethereum", 80), ("AAVE", "Ethereum", 20)], 0.043, 600,
     [("steady_sara", 580), ("priya_hodl", 220), ("nina_macro", 15)], 5, False),
    ("leo_quant", "Momentum basket", "Rebalanced weekly on a 30-day signal.",
     [("SOL", "Solana", 35), ("BNB", "BSC", 35), ("AVAX", "Avalanche", 30)], 0.091, 300,
     [("kofi_onchain", 200)], 10, False),
    ("priya_hodl", "Just Bitcoin", "There is no second best.",
     [("BTC", "NEAR", 100)], 0.087, 710,
     [("steady_sara", 700), ("nina_macro", 520), ("leo_quant", 300), ("raj_builds", 100),
      ("solmaxi", 45)], 0, False),
    ("tomas_ai", "Weekend AI", "AI agents need compute and a chain to pay on.",
     [("NEAR", "NEAR", 50), ("ETH", "Ethereum", 30), ("SOL", "Solana", 20)], 0.274, 260,
     [("raj_builds", 240), ("hana_l2", 160), ("solmaxi", 72), ("kofi_onchain", 20),
      ("mei_yields", 5)], 15, False),
    ("hana_l2", "Frog money", "Sized small. Stop at -30%.",
     [("PEPE", "Ethereum", 60), ("SOL", "Solana", 40)], -0.213, 160,
     [("solmaxi", 140), ("tomas_ai", 18)], 25, False),
    ("hana_l2", "Secret sauce", "Picks hidden. Returns speak.",
     [("ETH", "Ethereum", 50), ("LINK", "Ethereum", 50)], 0.134, 340,
     [], 10, True),
    ("quiet_whale", "Private book", "Only I see this.",
     [("BTC", "NEAR", 50), ("ETH", "Ethereum", 50)], 0.06, 400, [], 10, False),
]

# author, body, [(symbol, chain, change since)], hours ago, linked jar name or None
POSTS = [
    ("raj_builds", "NEAR fees are tiny and usage keeps climbing. Adding on every dip.",
     [("NEAR", "NEAR", 0.18)], 30, "NEAR builders"),
    ("ana_defi", "Aave revenue is at a new high and the token hasn't noticed.",
     [("AAVE", "Ethereum", 0.06)], 52, "DeFi blue chips"),
    ("solmaxi", "SOL under 100 is a gift. Not advice, just my jar.",
     [("SOL", "Solana", -0.04)], 9, "Solana stack"),
    ("nina_macro", "Rate cuts weaken the dollar at home. Hold it where it earns.",
     [("USDC", "NEAR", 0.0), ("NEAR", "NEAR", 0.07)], 70, "Dollar abroad"),
    ("priya_hodl", "Halving supply shock hasn't hit yet. Patience.",
     [("BTC", "NEAR", 0.05)], 120, None),
    ("kofi_onchain", "Arbitrum does more transactions than mainnet. Priced like it doesn't.",
     [("ARB", "Arbitrum", -0.09), ("OP", "Optimism", -0.12)], 96, "Rollup season"),
    ("tomas_ai", "Agents will pay each other on chain. The rails are being picked now.",
     [("NEAR", "NEAR", 0.22), ("ETH", "Ethereum", 0.03)], 20, "Weekend AI"),
    ("hana_l2", "PEPE is a coin flip with better memes. Sized accordingly.",
     [("PEPE", "Ethereum", -0.19)], 4, None),
    ("mei_yields", "Stablecoin yields beat my bank by 4x. That's the whole thesis.",
     [("USDC", "Ethereum", 0.0)], 160, "Stable yield"),
    ("leo_quant", "BNB and AVAX flipped positive on my 30-day signal.",
     [("BNB", "BSC", 0.04), ("AVAX", "Avalanche", 0.08)], 40, None),
]

# trader, sell (symbol, chain, amount), buy (symbol, chain, amount), usd, hours ago
TRADES = [
    ("solmaxi", ("USDC", "Solana", 250), ("SOL", "Solana", 3.1), 250, 2),
    ("raj_builds", ("USDC", "NEAR", 100), ("NEAR", "NEAR", 28.3), 100, 7),
    ("ana_defi", ("ETH", "Ethereum", 0.2), ("AAVE", "Ethereum", 3.4), 386, 14),
    ("hana_l2", ("SOL", "Solana", 1.5), ("PEPE", "Ethereum", 26000000), 118, 26),
    ("nina_macro", ("USDC", "Ethereum", 500), ("BTC", "NEAR", 0.0073), 500, 44),
    ("kofi_onchain", ("ETH", "Arbitrum", 0.1), ("ARB", "Arbitrum", 1330), 193, 60),
    ("tomas_ai", ("USDC", "NEAR", 60), ("NEAR", "NEAR", 17), 60, 80),
    ("leo_quant", ("USDC", "BSC", 300), ("BNB", "BSC", 0.47), 300, 100),
]

FOLLOWS = {
    "nina_macro": ["ana_defi", "raj_builds", "priya_hodl", "steady_sara", "mei_yields"],
    "ana_defi": ["nina_macro", "mei_yields", "kofi_onchain", "solmaxi"],
    "solmaxi": ["hana_l2", "tomas_ai", "raj_builds", "ana_defi"],
    "steady_sara": ["nina_macro", "priya_hodl", "mei_yields"],
    "raj_builds": ["tomas_ai", "nina_macro", "ana_defi", "solmaxi", "kofi_onchain"],
    "kofi_onchain": ["ana_defi", "hana_l2", "raj_builds", "leo_quant"],
    "mei_yields": ["ana_defi", "steady_sara", "nina_macro"],
    "leo_quant": ["priya_hodl", "kofi_onchain"],
    "priya_hodl": ["nina_macro", "steady_sara"],
    "tomas_ai": ["raj_builds", "solmaxi", "ana_defi", "hana_l2"],
    "hana_l2": ["solmaxi", "tomas_ai", "kofi_onchain"],
    "quiet_whale": ["nina_macro", "priya_hodl"],
}

# What a real profile on this database is connected to.
YOU_FOLLOW = ["nina_macro", "ana_defi", "raj_builds", "solmaxi", "tomas_ai", "steady_sara"]
FOLLOW_YOU = ["nina_macro", "raj_builds", "hana_l2", "kofi_onchain"]

SHARE = 50_000_000  # $50 a person, in micro-USD


def fetch_prices(api: str) -> dict[str, float]:
    with urllib.request.urlopen(f"{api}/api/v1/market/tokens", timeout=20) as res:
        data = json.load(res)
    items = data if isinstance(data, list) else data.get("tokens", [])
    prices: dict[str, float] = {}
    for token in items:
        symbol = str(token.get("symbol", "")).upper()
        price = token.get("priceUsd")
        if symbol and isinstance(price, (int, float)) and price > 0:
            prices.setdefault(symbol, float(price))
    return prices


def build_sql(prices: dict[str, float]) -> str:
    user = {handle: uid("user", handle) for handle, *_ in PEOPLE}
    seed_ids = ", ".join(q(u) + "::uuid" for u in user.values())
    sql: list[str] = [
        "BEGIN;",
        "SET LOCAL statement_timeout = '2min';",
        # Cascades through profiles, follows, jars, marks, copies, posts, events, groups,
        # members, proposals and inbox rows.
        f"DELETE FROM users WHERE id IN ({seed_ids});",
    ]

    for i, (handle, name, bio, seed, trades, privacy) in enumerate(PEOPLE):
        u = user[handle]
        joined = ago(24 * (60 - i * 3))
        sql.append(f"INSERT INTO users (id, created_at) VALUES ({q(u)}, {joined});")
        sql.append(
            "INSERT INTO social_profiles (user_id, handle, display_name, bio, avatar_seed, "
            "share_trades, public_profile, show_holdings, show_returns, allow_copy, created_at, "
            f"updated_at) VALUES ({q(u)}, {q(handle)}, {q(name)}, {q(bio)}, {q(seed)}, "
            f"{str(trades).lower()}, {str(privacy.get('public_profile', True)).lower()}, "
            f"{str(privacy.get('show_holdings', True)).lower()}, "
            f"{str(privacy.get('show_returns', True)).lower()}, "
            f"{str(privacy.get('allow_copy', True)).lower()}, {joined}, {joined});"
        )

    for follower, followees in FOLLOWS.items():
        for j, followee in enumerate(followees):
            sql.append(
                "INSERT INTO social_follows (follower, followee, created_at) VALUES "
                f"({q(user[follower])}, {q(user[followee])}, {ago(24 * (40 - j * 5))});"
            )

    # The feed reads events newest id first, so they are inserted oldest first at the end.
    events: list[tuple[float, str]] = []
    jar_ids: dict[str, str] = {}
    unpriced: set[str] = set()
    for n, (owner, name, thesis, picks, ret, age, copiers, fee, hide) in enumerate(JARS):
        jid = uid("jar", owner, name)
        jar_ids[name] = jid
        pick_json = [{"symbol": s, "chain": c, "weight": w} for s, c, w in picks]
        start = {}
        for s, _, _ in picks:
            if s in prices:
                start[s] = prices[s] / (1 + ret)
            else:
                unpriced.add(s)
        milestone = max([m for m in (10, 25, 50, 100) if ret * 100 >= m], default=0)
        sql.append(
            "INSERT INTO social_jars (id, owner, client_id, name, thesis, picks, start_prices, "
            "copy_fee, base_value, milestone, published_at, hide_picks) VALUES "
            f"({q(jid)}, {q(user[owner])}, {q('seed-' + str(n))}, {q(name)}, {q(thesis)}, "
            f"{q(json.dumps(pick_json))}::jsonb, {q(json.dumps(start))}::jsonb, {fee}, 1, "
            f"{milestone}, {ago(age)}, {str(hide).lower()});"
        )
        # Hourly marks from 1.0 at publish to 1 + return now, with a wander that is zero
        # at both ends, like the marker would have recorded.
        amp = 0.04 + abs(ret) * 0.25
        freq = 3 + (n % 5) * 1.7
        hours = min(age, 30 * 24)
        sql.append(
            "INSERT INTO social_jar_marks (jar_id, at, value) "
            f"SELECT {q(jid)}, now() - make_interval(hours => h), "
            f"GREATEST(0.05, 1 + {ret} * f + {amp:.4f} * sin(pi() * f) * sin(f * {freq:.2f} * pi())) "
            f"FROM (SELECT h, 1 - h::float8 / {age} AS f "
            f"FROM generate_series({hours}, 1, -1) AS h) s;"
        )
        events.append((age, "INSERT INTO social_events (actor, kind, jar_id, created_at) VALUES "
                       f"({q(user[owner])}, 'jar_published', {q(jid)}, {ago(age)});"))
        if milestone:
            # Roughly when the climb crossed it.
            crossed = max(1.0, age * (1 - milestone / (ret * 100)) * 0.9)
            events.append((crossed, "INSERT INTO social_events (actor, kind, jar_id, payload, "
                           f"created_at) VALUES ({q(user[owner])}, 'jar_milestone', {q(jid)}, "
                           f"{q(json.dumps({'percent': milestone}))}::jsonb, {ago(crossed)});"))
        for copier, hours_ago in copiers:
            sql.append(
                "INSERT INTO social_jar_copies (jar_id, copier, created_at) VALUES "
                f"({q(jid)}, {q(user[copier])}, {ago(hours_ago)});"
            )
            events.append((hours_ago, "INSERT INTO social_events (actor, kind, jar_id, created_at) "
                           f"VALUES ({q(user[copier])}, 'jar_copied', {q(jid)}, {ago(hours_ago)});"))

    for k, (author, body, tokens, hours_ago, jar) in enumerate(POSTS):
        pid = uid("post", author, str(k))
        snapshot = []
        for s, c, change in tokens:
            now = prices.get(s)
            if now is None:
                unpriced.add(s)
                continue
            snapshot.append({"symbol": s, "chain": c, "priceAtPost": now / (1 + change)})
        jar_ref = q(jar_ids[jar]) if jar else "NULL"
        sql.append(
            "INSERT INTO social_posts (id, author, body, tokens, jar_id, created_at) VALUES "
            f"({q(pid)}, {q(user[author])}, {q(body)}, {q(json.dumps(snapshot))}::jsonb, "
            f"{jar_ref}, {ago(hours_ago)});"
        )
        events.append((hours_ago, "INSERT INTO social_events (actor, kind, post_id, created_at) "
                       f"VALUES ({q(user[author])}, 'thesis', {q(pid)}, {ago(hours_ago)});"))

    for k, (trader, sell, buy, usd, hours_ago) in enumerate(TRADES):
        payload = {
            "sell": {"symbol": sell[0], "chain": sell[1], "amount": sell[2]},
            "buy": {"symbol": buy[0], "chain": buy[1], "amount": buy[2]},
            "usd": usd,
        }
        events.append((hours_ago, "INSERT INTO social_events (actor, kind, payload, operation_id, "
                       f"created_at) VALUES ({q(user[trader])}, 'trade', "
                       f"{q(json.dumps(payload))}::jsonb, {q(f'seed-trade-{k:04d}')}, "
                       f"{ago(hours_ago)});"))
    sql += [statement for _, statement in sorted(events, key=lambda e: -e[0])]

    # Group jars. None has an open vote on a DAO, so nothing here asks the chain.
    def group(key, creator, name, thesis, picks, status, dao, age, publish=False):
        gid = uid("group", key)
        pick_json = [{"symbol": s, "chain": c, "weight": w} for s, c, w in picks]
        sql.append(
            "INSERT INTO social_groups (id, creator, client_jar_id, name, thesis, picks, "
            "share_micro_usd, status, dao, publish, created_at, updated_at) VALUES "
            f"({q(gid)}, {q(user[creator])}, {q('seed-group-' + key)}, {q(name)}, {q(thesis)}, "
            f"{q(json.dumps(pick_json))}::jsonb, {SHARE}, {q(status)}, "
            f"{q(dao) if dao else 'NULL'}, {str(publish).lower()}, {ago(age)}, {ago(age / 2)});"
        )
        return gid

    def member(gid, handle, state, age, paid=False):
        paid_cols = (
            f"{q('near:seed-' + uid('paid', gid, handle))}, {SHARE}, {ago(age * 0.6)}"
            if paid else "NULL, NULL, NULL"
        )
        answered = ago(age * 0.8) if state != "invited" else "NULL"
        sql.append(
            "INSERT INTO social_group_members (group_id, user_id, state, near_account, paid_ref, "
            "paid_micro_usd, paid_at, invited_at, answered_at) VALUES "
            f"({q(gid)}, {q(user[handle])}, {q(state)}, "
            f"{q(uid('acct', handle).replace('-', '')[:64]) if state == 'accepted' else 'NULL'}, "
            f"{paid_cols}, {ago(age)}, {answered});"
        )

    inviting = group("defi-summer", "ana_defi", "DeFi summer", "Fees are back on the blue chips.",
                     [("AAVE", "Ethereum", 40), ("UNI", "Ethereum", 30), ("LINK", "Ethereum", 30)],
                     "inviting", None, 0.5)
    member(inviting, "ana_defi", "accepted", 0.5)
    member(inviting, "nina_macro", "accepted", 0.5)
    member(inviting, "mei_yields", "invited", 0.5)

    funding = group("solana-stack", "steady_sara", "Solana stack", "Cheap blocks win the next cycle.",
                    [("SOL", "Solana", 70), ("USDC", "Ethereum", 30)],
                    "funding", "seed-solana-stack.sputnik-dao.near", 3)
    member(funding, "steady_sara", "accepted", 3, paid=True)
    member(funding, "solmaxi", "accepted", 3)

    active = group("dollar-abroad", "nina_macro", "Dollar abroad",
                   "Dollars earning abroad, on chains that settle fast.",
                   [("USDC", "NEAR", 50), ("NEAR", "NEAR", 25), ("SOL", "Solana", 25)],
                   "active", "seed-dollar-abroad.sputnik-dao.near", 144, publish=True)
    member(active, "nina_macro", "accepted", 144, paid=True)
    member(active, "raj_builds", "accepted", 144, paid=True)
    sql.append(
        "INSERT INTO social_group_proposals (group_id, proposal_id, kind, proposer, status, "
        f"created_at, settled_at) VALUES ({q(active)}, 0, 'buy', {q(user['nina_macro'])}, "
        f"'executed', {ago(130)}, {ago(128)});"
    )
    sql.append(f"UPDATE social_jars SET group_id = {q(active)} WHERE id = {q(jar_ids['Dollar abroad'])};")

    # Everyone signed in here who isn't a sample person: connect them to the cast.
    real = f"SELECT user_id FROM social_profiles WHERE user_id NOT IN ({seed_ids})"
    for handle in YOU_FOLLOW:
        sql.append(
            "INSERT INTO social_follows (follower, followee) "
            f"SELECT user_id, {q(user[handle])} FROM ({real}) r ON CONFLICT DO NOTHING;"
        )
    for handle in FOLLOW_YOU:
        sql.append(
            "INSERT INTO social_follows (follower, followee) "
            f"SELECT {q(user[handle])}, user_id FROM ({real}) r ON CONFLICT DO NOTHING;"
        )
    sql += [
        # Invited to Ana's group, waiting in Sara's for your share, and in Nina's bought jar.
        "INSERT INTO social_group_members (group_id, user_id, state, invited_at) "
        f"SELECT {q(inviting)}, user_id, 'invited', {ago(0.4)} FROM ({real}) r;",
        "INSERT INTO social_group_members (group_id, user_id, state, near_account, invited_at, "
        f"answered_at) SELECT {q(funding)}, user_id, 'accepted', "
        f"'seed' || replace(user_id::text, '-', ''), {ago(3)}, {ago(2.5)} FROM ({real}) r;",
        "INSERT INTO social_group_members (group_id, user_id, state, near_account, paid_ref, "
        "paid_micro_usd, paid_at, invited_at, answered_at) "
        f"SELECT {q(active)}, user_id, 'accepted', 'seed' || replace(user_id::text, '-', ''), "
        f"'near:seed-you-' || user_id::text, {SHARE}, {ago(132)}, {ago(144)}, {ago(140)} "
        f"FROM ({real}) r;",
        "INSERT INTO social_inbox (id, user_id, kind, group_id, text, created_at) "
        f"SELECT gen_random_uuid(), user_id, 'group_invite', {q(inviting)}, "
        f"'Ana Lima invited you to DeFi summer · $50 each', {ago(0.4)} FROM ({real}) r;",
        "INSERT INTO social_inbox (id, user_id, kind, group_id, text, created_at) "
        f"SELECT gen_random_uuid(), user_id, 'group_update', {q(funding)}, "
        f"'Sara paid her share of Solana stack', {ago(2)} FROM ({real}) r;",
        "INSERT INTO social_inbox (id, user_id, kind, group_id, text, created_at, read_at) "
        f"SELECT gen_random_uuid(), user_id, 'group_update', {q(active)}, "
        f"'Dollar abroad bought its picks', {ago(128)}, {ago(120)} FROM ({real}) r;",
        "COMMIT;",
    ]
    if unpriced:
        print(f"note: no live price for {', '.join(sorted(unpriced))}; those picks show no return",
              file=sys.stderr)
    return "\n".join(sql) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--api", default="http://127.0.0.1:8080",
                        help="local API serving /api/v1/market/tokens (default %(default)s)")
    args = parser.parse_args()

    try:
        prices = fetch_prices(args.api)
    except OSError as error:
        print(f"couldn't read prices from {args.api}: {error}. Is the API running?", file=sys.stderr)
        return 1
    if not prices:
        print("the API returned no prices; try again in a minute", file=sys.stderr)
        return 1

    sql = build_sql(prices)
    run = subprocess.run(
        COMPOSE + ["exec", "-T", "postgres", "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1",
                   "-U", "honey", "-d", "honey"],
        input=sql, text=True, capture_output=True,
    )
    if run.returncode != 0:
        print(run.stderr or run.stdout, file=sys.stderr)
        return run.returncode

    counts = subprocess.run(
        COMPOSE + ["exec", "-T", "postgres", "psql", "-X", "-At", "-U", "honey", "-d", "honey",
                   "-c", "SELECT (SELECT count(*) FROM social_profiles), "
                         "(SELECT count(*) FROM social_jars), "
                         "(SELECT count(*) FROM social_jar_marks), "
                         "(SELECT count(*) FROM social_events), "
                         "(SELECT count(*) FROM social_groups), "
                         f"(SELECT count(*) FROM social_profiles WHERE user_id NOT IN "
                         f"({', '.join(q(uid('user', h)) + '::uuid' for h, *_ in PEOPLE)}))"],
        text=True, capture_output=True,
    ).stdout.strip().split("|")
    if len(counts) == 6:
        profiles, jars, marks, events, groups, real = counts
        print(f"seeded: {profiles} profiles, {jars} jars, {marks} value marks, "
              f"{events} feed events, {groups} group jars")
        if real == "0":
            print("no account of yours yet: sign in on the phone, claim a handle, run this again")
        else:
            print(f"connected {real} real profile(s) to the sample people")
    return 0


if __name__ == "__main__":
    sys.exit(main())
