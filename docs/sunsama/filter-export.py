#!/usr/bin/env python3
"""Remove Google document links from a Sunsama export and list the URLs that remain.

    python3 -I docs/sunsama/filter-export.py export.json [--out filtered.json] [--urls urls.json]

Writes a copy of the export with every https://*.google.*/ URL removed (Google Scholar links are
kept: they are not documents), and a list of every URL left in that copy with its domain and
counts, most mentioned first. The defaults put both next to the export:
`sunsama-exports-filtered-2026oct31.json` (the day from the export's file name) and
`sunsama-urls.json`. Only counts are printed, so running it shows nothing of the tasks.

How a URL goes depends on where it is:
- a link in `notes` whose text is the URL goes whole; a link with other text keeps the text;
- a URL in a title or other text is cut out, with the `()` it was wrapped in;
- a `url` field left empty becomes null, and a `website` attachment to a Google URL is dropped.

In the URL list, `count` is mentions (a link counts once, though its URL is in `href`, `text=`
and the link text) and `tasks` is how many tasks, with their subtasks, mention the URL.
"""
import datetime
import html
import json
import os
import re
import sys
from collections import Counter
from urllib.parse import urlparse

GOOGLE = r"https?://(?!scholar\.google\.)[A-Za-z0-9.-]*\.google\.[A-Za-z.]+"
# A bare Google URL ends at whitespace (nbsp too), a quote, an angle bracket or a paren;
# trailing sentence punctuation stays in the text.
GOOGLE_URL = re.compile(GOOGLE + r"""[^\s"'<>()]*[^\s"'<>().,;:!?]|""" + GOOGLE)
GOOGLE_ANCHOR = re.compile(r'<a\b[^>]*\bhref="' + GOOGLE + r'[^"]*"[^>]*>(.*?)</a>', re.S)
ANY_URL = re.compile(r"""https?://[^\s"'<>]+""")
ANCHOR = re.compile(r'<a\b[^>]*\bhref="([^"]*)"[^>]*>(.*?)</a>', re.S)
EXPORT_DAY = re.compile(r"(\d{4})-(\d{2})-(\d{2})T")


def scrub(s, stats):
    def anchor(m):
        stats["links in notes"] += 1
        text = m.group(1).strip()
        return "" if text.startswith("http") else m.group(1)

    s = GOOGLE_ANCHOR.sub(anchor, s)
    s, n = GOOGLE_URL.subn("", s)
    stats["urls in text"] += n
    return s.replace(" ()", "").replace("()", "")


def strip_google(o, stats, key=None):
    if isinstance(o, dict):
        integ = o.get("integration")
        if (isinstance(integ, dict) and integ.get("service") == "website"
                and GOOGLE_URL.match((integ.get("identifier") or {}).get("url") or "")):
            o["integration"] = None
            stats["website attachments"] += 1
        for k, v in o.items():
            o[k] = strip_google(v, stats, k)
        return o
    if isinstance(o, list):
        return [strip_google(v, stats) for v in o]
    if isinstance(o, str) and re.search(GOOGLE, o):
        new = scrub(o, stats)
        if key == "url" and not new.strip():
            stats["url fields"] += 1
            return None
        return new
    return o


def clean_url(u):
    u = html.unescape(u).rstrip(".,;:!?")
    # A closing paren that wraps the URL is not part of it.
    while u.endswith(")") and u.count(")") > u.count("("):
        u = u[:-1]
    return u


def urls_in(s):
    found = []

    def anchor(m):
        href = clean_url(m.group(1))
        if href.startswith(("http://", "https://")):
            found.append(href)
        return " ".join(u for u in ANY_URL.findall(m.group(2)) if clean_url(u) != href)

    s = ANCHOR.sub(anchor, s)
    return found + [clean_url(u) for u in ANY_URL.findall(s)]


def strings(o):
    if isinstance(o, dict):
        for v in o.values():
            yield from strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from strings(v)
    elif isinstance(o, str):
        yield o


def list_urls(tasks):
    count, in_tasks = Counter(), Counter()
    for task in tasks:
        seen = [u for s in strings(task) for u in urls_in(s)]
        count.update(seen)
        in_tasks.update(set(seen))
    order = sorted(count, key=lambda u: (-count[u], -in_tasks[u], u))
    return [{"url": u, "domain": urlparse(u).hostname, "count": count[u], "tasks": in_tasks[u]}
            for u in order]


def default_out(export_path):
    m = EXPORT_DAY.search(os.path.basename(export_path))
    day = datetime.date(*map(int, m.groups())) if m else datetime.date.today()
    return os.path.join(os.path.dirname(export_path),
                        f"sunsama-exports-filtered-{day.year}{day.strftime('%b').lower()}{day.day:02d}.json")


def main(argv):
    def option(name, default):
        if name in argv:
            i = argv.index(name)
            value = argv[i + 1]
            del argv[i:i + 2]
            return value
        return default

    out_path = option("--out", None)
    urls_path = option("--urls", None)
    export_path = argv[0]
    out_path = out_path or default_out(export_path)
    urls_path = urls_path or os.path.join(os.path.dirname(export_path), "sunsama-urls.json")
    if os.path.abspath(out_path) == os.path.abspath(export_path):
        sys.exit("refusing to overwrite the export")

    tasks = json.load(open(export_path))
    stats = Counter()
    tasks = strip_google(tasks, stats)
    # The export's layout, one compact task per line, so the two files diff line by line.
    with open(out_path, "w") as f:
        f.write("[\n" + ",\n".join(
            "  " + json.dumps(t, ensure_ascii=False, separators=(",", ":")) for t in tasks) + "\n]\n")
    left = sum(len(re.findall(GOOGLE, s)) for s in strings(tasks))
    urls = list_urls(tasks)
    with open(urls_path, "w") as f:
        json.dump(urls, f, ensure_ascii=False, indent=2)
        f.write("\n")
    removed = ", ".join(f"{n} {what}" for what, n in sorted(stats.items())) or "nothing"
    print(f"{len(tasks)} tasks -> {out_path}; removed {removed}; {left} Google URLs left", file=sys.stderr)
    print(f"{len(urls)} distinct URLs, {sum(u['count'] for u in urls)} mentions -> {urls_path}", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
