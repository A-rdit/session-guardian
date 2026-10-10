#!/usr/bin/env python3
"""Cold-return benchmark for Session Guardian.

Reads every Claude Code transcript under ~/.claude/projects and prices each API request at
Anthropic list prices (October 2026). A "cold return" is a main-conversation request that
comes more than 60 minutes after the previous one in the same session: the 1-hour cache has
expired and the whole context is written again at 2x the input price. Session Guardian exists
to make those rarer and smaller, so this script is the before/after measure.

Usage:  python cold-returns.py [--since 2026-09-01] [--weeks 6] [--top 10] [--md out.md]
Nothing leaves the machine; nothing is written unless --md is given.
"""
import argparse
import glob
import json
import os
import re
from collections import defaultdict
from datetime import datetime, timezone

# (model id pattern, input $/M, cache read $/M, output $/M)
PRICES = [
    (re.compile(r"fable-5-1|mythos-5-1"), 10, 0.25, 50),
    (re.compile(r"fable|mythos"), 10, 1, 50),
    (re.compile(r"opus-5-5"), 4, 0.2, 20),
    (re.compile(r"opus-[45]"), 5, 0.5, 25),
    (re.compile(r"sonnet-5"), 2, 0.2, 10),
    (re.compile(r"sonnet-4"), 3, 0.3, 15),
    (re.compile(r"haiku"), 1, 0.1, 5),
]
DEFAULT = PRICES[2]
COLD_GAP_S = 60 * 60
MIN_COLD_TOKENS = 10_000  # smaller rewrites are tiny sessions, not what the plugin is for


def price(model):
    for pattern, i, c, o in PRICES:
        if pattern.search(model or ""):
            return i, c, o
    return DEFAULT[1:]


def cost(model, u):
    i, c, o = price(model)
    cc = u.get("cache_creation") or {}
    w1h = cc.get("ephemeral_1h_input_tokens")
    w5m = cc.get("ephemeral_5m_input_tokens")
    if w1h is None and w5m is None:
        w1h, w5m = u.get("cache_creation_input_tokens", 0), 0  # old logs: assume 1h
    return (
        u.get("input_tokens", 0) * i
        + (w1h or 0) * 2 * i
        + (w5m or 0) * 1.25 * i
        + u.get("cache_read_input_tokens", 0) * c
        + u.get("output_tokens", 0) * o
    ) / 1e6


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def load(root, since):
    """Yield (session id, title, requests) with one request per message id, main thread only."""
    for path in glob.glob(os.path.join(root, "*", "*.jsonl")):
        if os.path.getmtime(path) < since.timestamp():
            continue
        reqs, title, sid = {}, None, os.path.basename(path)[:-6]
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                if '"customTitle"' in line or '"agentName"' in line:
                    try:
                        o = json.loads(line)
                        title = o.get("customTitle") or o.get("agentName") or title
                    except json.JSONDecodeError:
                        pass
                    continue
                if '"usage"' not in line or '"assistant"' not in line:
                    continue
                try:
                    o = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if o.get("type") != "assistant" or o.get("isSidechain"):
                    continue
                m = o.get("message") or {}
                u = m.get("usage")
                if not u or not o.get("timestamp"):
                    continue
                mid = m.get("id") or o.get("uuid")
                reqs[mid] = (ts(o["timestamp"]), m.get("model", ""), u)  # last entry wins
        if reqs:
            yield sid, title or sid, sorted(reqs.values(), key=lambda r: r[0])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--since", default="2026-08-01")
    ap.add_argument("--weeks", type=int, default=8)
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--md", help="write the report as markdown here")
    a = ap.parse_args()
    since = datetime.fromisoformat(a.since).replace(tzinfo=timezone.utc)

    def week():
        return dict(total=0.0, cold=0.0, cold_n=0, cold_tokens=0, fresh=0.0, fresh_n=0,
                    warm_reads=0.0, reqs=0, sessions=set())

    weeks = defaultdict(week)
    colds = []
    for sid, title, reqs in load(a.root, since):
        prev = None
        for t, model, u in reqs:
            if t < since:
                prev = t
                continue
            iso = t.isocalendar()
            w = weeks[f"{iso[0]}-W{iso[1]:02d}"]
            c = cost(model, u)
            w["total"] += c
            w["reqs"] += 1
            w["sessions"].add(sid)
            w["warm_reads"] += u.get("cache_read_input_tokens", 0) * price(model)[1] / 1e6
            written = u.get("cache_creation_input_tokens", 0)
            if prev is None:
                w["fresh"] += c
                w["fresh_n"] += 1
            elif (t - prev).total_seconds() > COLD_GAP_S and written >= MIN_COLD_TOKENS:
                w["cold"] += c
                w["cold_n"] += 1
                w["cold_tokens"] += written
                colds.append((c, written, (t - prev).total_seconds() / 3600, t, model, title))
            prev = t

    keys = sorted(weeks)[-a.weeks:]
    out = [f"# Cold returns, {a.since} to {datetime.now().date()}\n"]
    out.append(
        "A cold return is a main-conversation request more than 60 minutes after the previous one in the "
        "same session, so the whole context is written into the cache again. Costs are at API list prices "
        "and are a guide to how the weekly limit drains, not a bill. Subagents are left out.\n"
    )
    out.append("| Week | Requests | Sessions | Total $ | Cold returns | Cold $ | Cold share | Avg cold size | Fresh starts $ | Cache reads $ |")
    out.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    tot = dict(total=0.0, cold=0.0, cold_n=0, cold_tokens=0, fresh=0.0, warm_reads=0.0)
    for k in keys:
        w = weeks[k]
        share = w["cold"] / w["total"] * 100 if w["total"] else 0
        avg = w["cold_tokens"] / w["cold_n"] / 1000 if w["cold_n"] else 0
        out.append(
            f"| {k} | {w['reqs']} | {len(w['sessions'])} | {w['total']:.0f} | {w['cold_n']} | {w['cold']:.0f} | "
            f"{share:.1f}% | {avg:.0f}K | {w['fresh']:.0f} | {w['warm_reads']:.0f} |"
        )
        for f in tot:
            tot[f] += w[f]
    share = tot["cold"] / tot["total"] * 100 if tot["total"] else 0
    avg = tot["cold_tokens"] / tot["cold_n"] / 1000 if tot["cold_n"] else 0
    out.append(
        f"| **All** | | | **{tot['total']:.0f}** | **{tot['cold_n']}** | **{tot['cold']:.0f}** | "
        f"**{share:.1f}%** | {avg:.0f}K | {tot['fresh']:.0f} | {tot['warm_reads']:.0f} |"
    )

    colds.sort(reverse=True)
    out.append(f"\n## The {a.top} most expensive cold returns\n")
    out.append("| $ | Rewritten | Gap | When (UTC) | Model | Session |")
    out.append("| ---: | ---: | ---: | --- | --- | --- |")
    for c, written, gap, t, model, title in colds[: a.top]:
        when = t.strftime("%Y-%m-%d %H:%M")
        out.append(f"| {c:.2f} | {written / 1000:.0f}K | {gap:.1f} h | {when} | {model.replace('claude-', '')} | {title[:50]} |")

    text = "\n".join(out)
    print(text)
    if a.md:
        with open(a.md, "w", encoding="utf-8") as f:
            f.write(text + "\n")


if __name__ == "__main__":
    main()
