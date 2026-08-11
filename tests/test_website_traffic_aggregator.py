from datetime import datetime
from zoneinfo import ZoneInfo

from scripts.ops.aggregate_website_traffic import aggregate, parse_access_log_line


def test_normal_chrome_request_is_qualified_and_uses_x_forwarded_for():
    parsed = parse_access_log_line(
        '172.18.0.1 - - [11/Aug/2026:03:46:05 +0000] "GET / HTTP/1.1" '
        '200 1115 "-" "Mozilla/5.0 ..." "14.187.5.39"'
    )

    assert parsed is not None
    assert parsed.qualified_visit is True
    assert parsed.visitor_ip == "14.187.5.39"


def test_healthcheck_wget_is_not_qualified():
    parsed = parse_access_log_line(
        '127.0.0.1 - - [11/Aug/2026:03:46:05 +0000] "GET / HTTP/1.1" '
        '200 1115 "-" "Wget" "-"'
    )

    assert parsed is not None
    assert parsed.qualified_visit is False


def test_static_asset_is_not_qualified():
    parsed = parse_access_log_line(
        '172.18.0.1 - - [11/Aug/2026:03:46:05 +0000] "GET /assets/index.js HTTP/1.1" '
        '200 1115 "-" "Mozilla/5.0" "14.187.5.39"'
    )

    assert parsed is not None
    assert parsed.qualified_visit is False


def test_scanner_is_not_qualified():
    parsed = parse_access_log_line(
        '172.18.0.1 - - [11/Aug/2026:03:46:05 +0000] "GET / HTTP/1.1" '
        '200 1115 "-" "CMS-Checker/1.0" "14.187.5.39"'
    )

    assert parsed is not None
    assert parsed.qualified_visit is False


def test_whatsapp_preview_is_not_qualified():
    parsed = parse_access_log_line(
        '172.18.0.1 - - [11/Aug/2026:03:46:05 +0000] "GET / HTTP/1.1" '
        '200 1115 "-" "WhatsApp/2" "14.187.5.39"'
    )

    assert parsed is not None
    assert parsed.qualified_visit is False


def test_duplicate_ip_counts_visits_but_one_unique_visitor():
    lines = [
        '172.18.0.1 - - [11/Aug/2026:03:46:05 +0000] "GET / HTTP/1.1" 200 1115 "-" "Mozilla/5.0" "14.187.5.39"',
        '172.18.0.1 - - [11/Aug/2026:03:47:05 +0000] "GET /dashboard HTTP/1.1" 200 1115 "-" "Mozilla/5.0" "14.187.5.39"',
        '172.18.0.1 - - [11/Aug/2026:03:48:05 +0000] "GET /billing HTTP/1.1" 200 1115 "-" "Mozilla/5.0" "14.187.5.39"',
    ]

    payload = aggregate(lines, now=datetime(2026, 8, 11, 12, 0, tzinfo=ZoneInfo("Asia/Ho_Chi_Minh")))

    assert payload["visits"] == 3
    assert payload["uniqueVisitors"] == 1


def test_utc_timestamp_groups_by_vietnam_day():
    lines = [
        '172.18.0.1 - - [10/Aug/2026:18:30:00 +0000] "GET / HTTP/1.1" 200 1115 "-" "Mozilla/5.0" "14.187.5.39"',
    ]

    payload = aggregate(lines, now=datetime(2026, 8, 11, 12, 0, tzinfo=ZoneInfo("Asia/Ho_Chi_Minh")))

    assert payload["todayVisits"] == 1
    assert payload["daily"] == [{"date": "2026-08-11", "visits": 1, "uniqueVisitors": 1}]
