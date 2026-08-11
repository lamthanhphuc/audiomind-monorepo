#!/usr/bin/env python3
"""Aggregate AudioMind website traffic from Nginx access logs.

Production usage:
  docker logs audiomind-prod-web-1 2>&1 | python scripts/ops/aggregate_website_traffic.py --input - --output /var/lib/audiomind/analytics/website-traffic.json
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


LOCAL_ZONE = ZoneInfo("Asia/Ho_Chi_Minh")
SOURCE = "nginx_access_log"
BOT_USER_AGENT_KEYWORDS = (
    "bot",
    "crawler",
    "spider",
    "cms-checker",
    "palo alto",
    "whatsapp",
    "curl",
    "python",
    "wget",
    "go-http-client",
    "facebookexternalhit",
    "discordbot",
    "slackbot",
    "bingbot",
    "googlebot",
    "yandexbot",
    "baiduspider",
)
STATIC_PATH_PREFIXES = ("/assets/",)
STATIC_PATH_EXACT = {"/favicon.ico", "/favicon.svg", "/robots.txt", "/sitemap.xml"}
STATIC_PATH_SUFFIXES = (
    ".js",
    ".css",
    ".png",
    ".jpg",
    ".jpeg",
    ".svg",
    ".webp",
    ".woff",
    ".woff2",
    ".ttf",
    ".map",
)

ACCESS_LOG_PATTERN = re.compile(
    r'^(?P<remote>\S+) \S+ \S+ \[(?P<time>[^\]]+)\] '
    r'"(?P<request>[^"]*)" (?P<status>\d{3}) \S+ '
    r'"(?P<referer>[^"]*)" "(?P<agent>[^"]*)" "(?P<xff>[^"]*)"'
)


@dataclass(frozen=True)
class ParsedAccessLog:
    timestamp: datetime
    method: str
    path: str
    status: int
    user_agent: str
    visitor_ip: str
    qualified_visit: bool


def visitor_ip(remote_addr: str, x_forwarded_for: str) -> str:
    xff = (x_forwarded_for or "").strip()
    if xff and xff != "-":
        return xff.split(",", 1)[0].strip()
    return remote_addr.strip()


def is_bot_or_probe(user_agent: str) -> bool:
    normalized = (user_agent or "").lower()
    return any(keyword in normalized for keyword in BOT_USER_AGENT_KEYWORDS)


def is_static_path(path: str) -> bool:
    clean_path = path.split("?", 1)[0]
    lower_path = clean_path.lower()
    return (
        lower_path in STATIC_PATH_EXACT
        or any(lower_path.startswith(prefix) for prefix in STATIC_PATH_PREFIXES)
        or any(lower_path.endswith(suffix) for suffix in STATIC_PATH_SUFFIXES)
    )


def parse_access_log_line(line: str) -> ParsedAccessLog | None:
    match = ACCESS_LOG_PATTERN.match(line.strip())
    if not match:
        return None

    request_parts = match.group("request").split()
    if len(request_parts) < 2:
        return None

    timestamp = datetime.strptime(match.group("time"), "%d/%b/%Y:%H:%M:%S %z")
    method = request_parts[0].upper()
    path = request_parts[1]
    agent = match.group("agent")
    ip = visitor_ip(match.group("remote"), match.group("xff"))
    qualified = (
        method == "GET"
        and not is_static_path(path)
        and not is_bot_or_probe(agent)
    )
    return ParsedAccessLog(
        timestamp=timestamp.astimezone(LOCAL_ZONE),
        method=method,
        path=path,
        status=int(match.group("status")),
        user_agent=agent,
        visitor_ip=ip,
        qualified_visit=qualified,
    )


def aggregate(lines: list[str], now: datetime | None = None) -> dict[str, object]:
    now_local = (now or datetime.now(LOCAL_ZONE)).astimezone(LOCAL_ZONE)
    today = now_local.date().isoformat()
    seen_ips: set[str] = set()
    today_ips: set[str] = set()
    daily_visits: defaultdict[str, int] = defaultdict(int)
    daily_ips: defaultdict[str, set[str]] = defaultdict(set)
    visits = 0
    today_visits = 0
    observation_start: datetime | None = None
    latest_seen: datetime | None = None

    for line in lines:
        parsed = parse_access_log_line(line)
        if parsed is None:
            continue
        observation_start = parsed.timestamp if observation_start is None else min(observation_start, parsed.timestamp)
        latest_seen = parsed.timestamp if latest_seen is None else max(latest_seen, parsed.timestamp)
        if not parsed.qualified_visit:
            continue

        day = parsed.timestamp.date().isoformat()
        visits += 1
        seen_ips.add(parsed.visitor_ip)
        daily_visits[day] += 1
        daily_ips[day].add(parsed.visitor_ip)
        if day == today:
            today_visits += 1
            today_ips.add(parsed.visitor_ip)

    daily = [
        {
            "date": day,
            "visits": daily_visits[day],
            "uniqueVisitors": len(daily_ips[day]),
        }
        for day in sorted(daily_visits)
    ]
    return {
        "visits": visits,
        "uniqueVisitors": len(seen_ips),
        "todayVisits": today_visits,
        "todayUniqueVisitors": len(today_ips),
        "daily": daily,
        "observationStart": observation_start.isoformat() if observation_start else None,
        "observationEnd": (latest_seen or now_local).isoformat(),
        "source": SOURCE,
        "partialHistory": True,
        "timezone": "Asia/Ho_Chi_Minh",
        "generatedAt": now_local.isoformat(),
    }


def read_input(args: argparse.Namespace) -> list[str]:
    if args.container:
        result = subprocess.run(
            ["docker", "logs", args.container],
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout.splitlines() + result.stderr.splitlines()
    if args.input == "-":
        return sys.stdin.read().splitlines()
    return Path(args.input).read_text(encoding="utf-8").splitlines()


def main() -> int:
    parser = argparse.ArgumentParser(description="Aggregate AudioMind website traffic from Nginx logs.")
    parser.add_argument("--input", default="-", help="Access log file path, or '-' for stdin.")
    parser.add_argument("--container", help="Docker container name to read with docker logs.")
    parser.add_argument("--output", required=True, help="Output JSON path.")
    args = parser.parse_args()

    payload = aggregate(read_input(args))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
