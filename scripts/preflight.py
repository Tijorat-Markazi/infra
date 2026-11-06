#!/usr/bin/env python3
"""Read-only checks of the shared Docker host; no database or host changes."""
import json
from pathlib import Path
import subprocess
import sys


def settings(path):
    return dict(line.split("=", 1) for line in Path(path).read_text().splitlines() if line)


def inspect(kind, name):
    return json.loads(subprocess.check_output(
        ["docker", kind, "inspect", name], timeout=15, text=True))[0]


def check(root):
    config = settings(Path(root) / "runtime/compose.env")
    backend = Path(root) / "runtime/backend.env"
    if backend.exists():
        app = settings(backend)
        if app.get("DB_NAME") != "tijorat_markazi_db" or app.get("DB_USER") != "tijorat_markazi_user":
            raise ValueError("Database/role is outside the confirmed project scope")
    database = inspect("network", config["DB_NETWORK"])
    edge = inspect("network", config["PROXY_NETWORK"])
    for container, network in ((config["DB_CONTAINER"], database),
                               (config["EDGE_PROXY_CONTAINER"], edge)):
        # Container inspection is captured, never printed (it contains secrets).
        info = json.loads(subprocess.check_output(
            ["docker", "inspect", container], timeout=15, text=True))[0]
        if not info["State"]["Running"]:
            raise ValueError("A required shared container is stopped")
        if info["Id"] not in network.get("Containers", {}):
            raise ValueError("A required shared container is on a different network")
    for network in (database, edge):
        if network.get("Driver") != "bridge":
            raise ValueError("Expected existing bridge networks")
    print("Existing database and edge proxy networks are ready; shared services unchanged.")


if __name__ == "__main__":
    try:
        check(sys.argv[1])
    except (ValueError, KeyError, OSError, subprocess.SubprocessError):
        sys.exit("Shared-host preflight failed. Check configured resource names and container/network state.")
