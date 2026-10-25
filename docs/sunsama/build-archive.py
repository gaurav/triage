#!/usr/bin/env python3
"""Turn Sunsama MCP task records into one JSON list for chaff.

    python3 docs/sunsama/build-archive.py out.json page1.json page2.json ... [--export export.json] [--no-github]

Each page file is what an MCP tool returned: `{"tasks": [...]}`, `{"task": {...}}` or a bare list.
Tasks are deduplicated by `_id`, which matters because `get_archived_tasks` returns overlapping
windows. `--export` merges the fields a Sunsama CSV/JSON export has and the API lacks (the
export's `notes`, `subtasks` and `latestDailyPriority`). Every GitHub issue or PR link is looked
up with `gh` and its state written to `githubState`, so "already closed" is a facet in chaff
rather than a judgement made here. `--no-github` skips those lookups (tests, offline).
"""
import datetime
import json
import re
import subprocess
import sys

GITHUB = re.compile(r"https://github\.com/([\w.-]+)/([\w.-]+)/(issues|pull)/(\d+)")


def load_tasks(path):
    data = json.load(open(path))
    if isinstance(data, dict):
        data = data.get("tasks") or [data.get("task")]
    return [t for t in data if t]


def github_state(url):
    m = GITHUB.match(url or "")
    if not m:
        return {}
    owner, repo, _, number = m.groups()
    try:
        out = subprocess.run(
            ["gh", "api", f"repos/{owner}/{repo}/issues/{number}", "--jq",
             "{state,merged:(.pull_request.merged_at!=null),title}"],
            capture_output=True, text=True, check=True).stdout
    except subprocess.CalledProcessError:
        return {"githubState": "unknown"}
    j = json.loads(out)
    return {"githubState": "merged" if j["merged"] else j["state"], "githubTitle": j["title"]}


def main(argv):
    out_path, paths = argv[0], argv[1:]
    export = {}
    github = True
    if "--no-github" in paths:
        github = False
        paths = [p for p in paths if p != "--no-github"]
    if "--export" in paths:
        i = paths.index("--export")
        export = {t["id"]: t for t in json.load(open(paths[i + 1]))}
        paths = paths[:i] + paths[i + 2:]
    today = datetime.date.today()
    tasks = {}
    for p in paths:
        for t in load_tasks(p):
            tasks.setdefault(t["_id"], t)
    items = []
    for tid, t in tasks.items():
        e = export.get(tid)
        integ = t.get("integrationDetails") or {}
        created = t["createdAt"][:10]
        spent = t.get("actualTimeSpent") or {}
        item = {
            "id": tid,
            "title": t["title"].replace("\xa0", " ").strip(),
            "notes": t.get("notes") or (e["notes"] if e else ""),
            "channel": t.get("channel") or "",
            "category": t.get("category") or "",
            "service": integ.get("service", ""),
            "url": integ.get("url", ""),
            "createdAt": created,
            "ageDays": (today - datetime.date.fromisoformat(created)).days,
            "dueDate": t.get("dueDate", ""),
            "lastWorkedOn": spent.get("lastWorkedOn", ""),
            "timeSpent": spent.get("total", ""),
            "timeEstimate": t.get("timeEstimate", ""),
            "priority": t.get("dailyPriority") or (e["latestDailyPriority"] if e else ""),
            "recurring": bool(t.get("recurrenceRule")),
            "recurrence": t.get("recurrenceRule", ""),
            "folder": (t.get("folder") or {}).get("name", ""),
            "subtasks": [{"title": s["title"], "completed": s.get("completed", False)} for s in t.get("subtasks", [])],
            "isArchived": t.get("isArchived", False),
            "isBacklogged": t.get("isBacklogged", False),
        }
        if github:
            item.update(github_state(item["url"]))
        items.append(item)
    items.sort(key=lambda i: i["createdAt"])
    json.dump(items, open(out_path, "w"), indent=1, ensure_ascii=False)
    print(f"{len(items)} tasks -> {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
