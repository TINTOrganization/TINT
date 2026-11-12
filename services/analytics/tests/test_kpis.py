from datetime import UTC, datetime

import pytest

from analytics.kpis import (
    RoomKpis,
    compute_room_kpis,
    format_timestamp,
    heatmap_density,
    reaction_heatmap,
    reactions_by_emoji,
    timeline,
)


def test_compute_room_kpis():
    events = [
        {"type": "presence", "connected_users": 3},
        {"type": "presence", "connected_users": 7},
        {"type": "presence", "connected_users": 5},
        {"type": "drift_correction", "drift_ms": 600, "rtt_ms": 40},
        {"type": "drift_correction", "drift_ms": -800, "rtt_ms": "60"},
        {"type": "trivia_answer", "correct": True},
        {"type": "trivia_answer", "correct": False},
        {"type": "trivia_answer", "correct": True},
        {"type": "reaction"},
        {"type": "reaction"},
        {"type": "chat_message", "message_length": 4},
        {"type": "playback_command", "command": "PLAY"},
        {"type": "buffering", "duration_ms": 300},
        {"type": "buffering", "duration_ms": 900},
        {"type": "room_created"},
    ]
    assert compute_room_kpis("r1", events) == RoomKpis(
        room_id="r1",
        peak_users=7,
        avg_users=5.0,
        avg_drift_ms=700.0,
        trivia_accuracy_pct=66.67,
        messages=1,
        reactions=2,
        playback_commands=1,
        buffering_events=2,
        avg_buffering_ms=600.0,
        avg_rtt_ms=50.0,
        p95_drift_ms=800.0,
        total_buffering_ms=1200,
    )


def test_p95_drift_uses_the_nearest_rank_over_absolute_drifts():
    drifts = [{"type": "drift_correction", "drift_ms": -ms} for ms in range(501, 601)]
    kpis = compute_room_kpis("r1", drifts)
    assert kpis.p95_drift_ms == 595.0
    assert kpis.avg_drift_ms == 550.5


def test_rtt_ignores_missing_malformed_and_negative_samples():
    events = [
        {"type": "drift_correction", "drift_ms": 600},
        {"type": "drift_correction", "drift_ms": 600, "rtt_ms": "lento"},
        {"type": "drift_correction", "drift_ms": 600, "rtt_ms": -5},
        {"type": "drift_correction", "drift_ms": 600, "rtt_ms": "30.5"},
    ]
    assert compute_room_kpis("r1", events).avg_rtt_ms == 30.5


def test_compute_room_kpis_parses_string_values_from_redis():
    events = [
        {"type": "presence", "connected_users": "2"},
        {"type": "presence", "connected_users": "4"},
        {"type": "drift_correction", "drift_ms": "-510"},
        {"type": "trivia_answer", "correct": "true"},
        {"type": "trivia_answer", "correct": "false"},
        {"type": "trivia_answer", "correct": "False"},
        {"type": "trivia_answer", "correct": "1"},
        {"type": "buffering", "duration_ms": "850"},
    ]
    kpis = compute_room_kpis("r1", events)
    assert kpis.peak_users == 4
    assert kpis.avg_users == 3.0
    assert kpis.avg_drift_ms == 510.0
    assert kpis.trivia_accuracy_pct == 50.0
    assert kpis.avg_buffering_ms == 850.0


def test_compute_room_kpis_ignores_malformed_measurements_but_counts_the_event():
    events = [
        {"type": "presence", "connected_users": "muchos"},
        {"type": "presence"},
        {"type": "drift_correction", "drift_ms": None},
        {"type": "buffering", "duration_ms": ""},
        {"type": "trivia_answer"},
    ]
    kpis = compute_room_kpis("r1", events)
    assert (kpis.peak_users, kpis.avg_users, kpis.avg_drift_ms) == (0, 0.0, 0.0)
    assert (kpis.buffering_events, kpis.avg_buffering_ms) == (1, 0.0)
    assert kpis.trivia_accuracy_pct == 0.0


def test_compute_room_kpis_empty_room():
    assert compute_room_kpis("r2", []) == RoomKpis(
        "r2", 0, 0.0, 0.0, 0.0, 0, 0, 0, 0, 0.0, 0.0, 0.0, 0
    )


def test_room_kpis_as_dict():
    kpis = RoomKpis("r1", 1, 1.0, 2.0, 3.0, 4, 5, 6, 7, 8.0, 9.0, 10.0, 11)
    assert kpis.as_dict() == {
        "room_id": "r1",
        "peak_users": 1,
        "avg_users": 1.0,
        "avg_drift_ms": 2.0,
        "trivia_accuracy_pct": 3.0,
        "messages": 4,
        "reactions": 5,
        "playback_commands": 6,
        "buffering_events": 7,
        "avg_buffering_ms": 8.0,
        "avg_rtt_ms": 9.0,
        "p95_drift_ms": 10.0,
        "total_buffering_ms": 11,
    }


def reaction(emoji, position_ms):
    return {"type": "reaction", "emoji": emoji, "position_ms": position_ms}


def test_reaction_heatmap_groups_by_video_position_and_emoji():
    events = [
        reaction("👏", "0"),
        reaction("👏", 4999),
        reaction("😂", "1200"),
        reaction("👏", "5000"),
        reaction("😂", "12000"),
        {"type": "chat_message"},
    ]
    assert reaction_heatmap(events, bucket_ms=5000) == [
        {"bucket_start_ms": 0, "emoji": "👏", "count": 2},
        {"bucket_start_ms": 0, "emoji": "😂", "count": 1},
        {"bucket_start_ms": 5000, "emoji": "👏", "count": 1},
        {"bucket_start_ms": 10000, "emoji": "😂", "count": 1},
    ]


def test_reaction_heatmap_skips_reactions_without_position_or_emoji():
    events = [reaction("👏", None), reaction("👏", "-5"), reaction("", 10), reaction("👏", "x")]
    assert reaction_heatmap(events, bucket_ms=1000) == []


def test_reaction_heatmap_rejects_non_positive_bucket():
    with pytest.raises(ValueError):
        reaction_heatmap([], bucket_ms=0)


def test_heatmap_density_normalizes_each_bucket_against_the_busiest_one():
    events = [
        reaction("👏", "0"),
        reaction("😂", "1200"),
        reaction("👏", 4999),
        reaction("👏", "3000"),
        reaction("👏", "5000"),
        reaction("😂", "12000"),
        reaction("😂", "12500"),
        reaction("", 100),
        reaction("👏", "-1"),
        {"type": "chat_message"},
    ]
    assert heatmap_density(events, bucket_ms=5000) == [
        {"bucket_start_ms": 0, "count": 4, "density": 1.0},
        {"bucket_start_ms": 5000, "count": 1, "density": 0.25},
        {"bucket_start_ms": 10000, "count": 2, "density": 0.5},
    ]


def test_heatmap_density_of_a_single_bucket_is_one_and_empty_without_reactions():
    assert heatmap_density([reaction("👏", 100)]) == [
        {"bucket_start_ms": 0, "count": 1, "density": 1.0}
    ]
    assert heatmap_density([{"type": "presence"}]) == []


def test_heatmap_density_rejects_non_positive_bucket():
    with pytest.raises(ValueError):
        heatmap_density([], bucket_ms=0)


def test_reactions_by_emoji_sorted_by_count_desc_then_emoji():
    events = [
        reaction("😂", 0),
        reaction("👏", 0),
        reaction("👏", None),
        reaction("🔥", 0),
        reaction("😂", 0),
        reaction("👏", 0),
        {"type": "reaction"},
        {"type": "presence"},
    ]
    assert reactions_by_emoji(events) == [
        {"emoji": "👏", "count": 3},
        {"emoji": "😂", "count": 2},
        {"emoji": "🔥", "count": 1},
    ]


def at(minute, second=0):
    return f"2026-10-11T10:{minute:02d}:{second:02d}.000Z"


def test_timeline_buckets_by_interval_and_carries_connected_users():
    events = [
        {"type": "presence", "connected_users": "2", "occurred_at": at(0, 10)},
        {"type": "chat_message", "occurred_at": at(0, 20)},
        {"type": "presence", "connected_users": "3", "occurred_at": at(0, 50)},
        {"type": "reaction", "occurred_at": at(0, 55)},
        {"type": "chat_message", "occurred_at": at(0, 59)},
        # Minuto 1 sin eventos: se arrastra el último valor de presencia.
        {"type": "presence", "connected_users": "1", "occurred_at": at(2, 30)},
        {"type": "reaction", "occurred_at": at(2, 40)},
        {"type": "playback_command", "occurred_at": at(3, 0)},
    ]
    assert timeline(events, step_s=60) == [
        {"t": at(0), "connected_users": 3, "messages": 2, "reactions": 1},
        {"t": at(1), "connected_users": 3, "messages": 0, "reactions": 0},
        {"t": at(2), "connected_users": 1, "messages": 0, "reactions": 1},
    ]


def test_timeline_orders_events_and_starts_with_zero_users():
    events = [
        {"type": "presence", "connected_users": 4, "occurred_at": at(1, 5)},
        {"type": "chat_message", "occurred_at": at(0, 1)},
        {"type": "reaction", "occurred_at": at(0, 1)},
        {"type": "chat_message", "occurred_at": "no es fecha"},
        {"type": "chat_message"},
    ]
    assert timeline(events, step_s=60) == [
        {"t": at(0), "connected_users": 0, "messages": 1, "reactions": 1},
        {"t": at(1), "connected_users": 4, "messages": 0, "reactions": 0},
    ]


def test_timeline_empty_and_invalid_step():
    assert timeline([], step_s=60) == []
    with pytest.raises(ValueError):
        timeline([], step_s=0)


def test_format_timestamp_uses_utc_milliseconds_and_z():
    assert format_timestamp(datetime(2026, 10, 11, 4, 29, 49, 368500, tzinfo=UTC)) == (
        "2026-10-11T04:29:49.368Z"
    )
