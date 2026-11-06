#!/usr/bin/env python3
"""Local, project-scoped PostgreSQL/media backup. Never use administrator credentials."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import tempfile

PROJECT = "tijoratmarkazi"
DATABASE = "tijorat_markazi_db"  # Confirmed on the dedicated server, 26 October 2026.


def read_env(path):
    return dict(line.split("=", 1) for line in path.read_text().splitlines() if line)


def config(root):
    env = read_env(root / "runtime/backend.env")
    env.update(read_env(root / "runtime/compose.env"))
    if env.get("DB_NAME") != DATABASE or env.get("DB_USER") != "tijorat_markazi_user":
        raise ValueError("Refusing a database/role outside this project")
    if not env.get("POSTGRES_PASSWORD"):
        raise ValueError("Missing application database password")
    return env


def database(env, action, file):
    # Password goes only through encrypted SSH/file permissions and this stdin,
    # never Docker configuration, process arguments, environment logs or archives.
    tool = ("pg_dump --format=custom --no-owner --no-acl" if action == "dump" else
            "pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error --single-transaction")
    command = ["docker", "exec", "-i", env["DB_CONTAINER"], "sh", "-c",
               'IFS= read -r PGPASSWORD; export PGPASSWORD; export PGCONNECT_TIMEOUT=5; '
               'exec timeout --signal=TERM --kill-after=15s 12m ' + tool +
               ' -h "$1" -p "$2" -U "$3" -d "$4"',
               "project-database", env["DB_HOST"], env["DB_PORT"], env["DB_USER"], env["DB_NAME"]]
    with subprocess.Popen(command, stdin=subprocess.PIPE,
                          stdout=file if action == "dump" else subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL) as child:
        try:
            child.stdin.write(env["POSTGRES_PASSWORD"].encode() + b"\n")
            if action != "dump":
                shutil.copyfileobj(file, child.stdin)
            child.stdin.close()
        except BrokenPipeError:
            pass
        if child.wait(timeout=780):
            raise ValueError("Project database operation failed; verify application access and archive compatibility")


def backup(root):
    env = config(root)
    destination = root / "backups"
    if destination.is_symlink() or (root / "data").is_symlink():
        raise ValueError("Refusing symlinked project storage")
    destination.mkdir(mode=0o700, exist_ok=True)
    name = datetime.now(timezone.utc).strftime("tijoratmarkazi-%Y%m%dT%H%M%S%fZ.tar.gz")
    partial = destination / (name + ".partial")
    try:
        with tempfile.TemporaryDirectory(prefix="backup-", dir=destination) as work:
            work = Path(work)
            with (work / "database.dump").open("wb") as dump:
                database(env, "dump", dump)
            if not (work / "database.dump").stat().st_size:
                raise ValueError("Empty database dump")
            (work / "manifest.json").write_text(json.dumps({"project": PROJECT, "database": DATABASE, "version": 1}))
            with tarfile.open(partial, "w:gz") as archive:
                for file in ("manifest.json", "database.dump"):
                    archive.add(work / file, arcname=file)
                for folder in ("backend", "uploads"):
                    source = root / "data" / folder
                    # Application media must never follow symlinks out of project storage.
                    if source.is_symlink() or any(p.is_symlink() for p in source.rglob("*")):
                        raise ValueError("Symlinks are not allowed in project media")
                    archive.add(source, arcname="media/" + folder)
            os.chmod(partial, 0o600)
            partial.rename(destination / name)
        # Retain seven completed local archives, never database/container volumes.
        for old in sorted(destination.glob("tijoratmarkazi-*.tar.gz"))[:-7]:
            if old.is_file() and not old.is_symlink():
                old.unlink()
    finally:
        partial.unlink(missing_ok=True)
    print("Project database and media backup completed; seven local archives retained.")


def validate_archive(archive):
    names = set()
    for member in archive.getmembers():
        path = PurePosixPath(member.name)
        if (path.is_absolute() or ".." in path.parts or "\\" in member.name or
                not (member.isfile() or member.isdir()) or member.name in names):
            raise ValueError("Unsafe or duplicate archive member")
        if member.name not in ("database.dump", "manifest.json", "media") and not (
                member.name in ("media/backend", "media/uploads") or
                member.name.startswith(("media/backend/", "media/uploads/"))):
            raise ValueError("Archive contains data outside project database/media")
        names.add(member.name)
    if not {"database.dump", "manifest.json", "media/backend", "media/uploads"} <= names:
        raise ValueError("Incomplete project archive")
    manifest = json.load(archive.extractfile("manifest.json"))
    if manifest != {"project": PROJECT, "database": DATABASE, "version": 1}:
        raise ValueError("Archive belongs to a different project/database")


def restore(root, filename, confirmation):
    env = config(root)
    if confirmation != "--confirm=" + DATABASE:
        raise ValueError("Explicit project database confirmation required")
    running = subprocess.check_output(["docker", "ps", "-q", "--filter",
        "label=com.docker.compose.project=" + PROJECT, "--filter",
        "label=com.docker.compose.service=backend"], timeout=15, text=True).strip()
    if running:
        raise ValueError("Stop this project's backend after approval before restoring")
    for folder in ("backend", "uploads"):
        target = root / "data" / folder
        if (root / "data").is_symlink() or target.is_symlink() or any(p.is_symlink() for p in target.rglob("*")):
            raise ValueError("Refusing symlinked target media")
    with tarfile.open(filename, "r:gz") as archive:
        validate_archive(archive)
        # Stage and validate every file before touching either database or media.
        with tempfile.TemporaryDirectory(prefix="restore-", dir=root / "backups") as work:
            work = Path(work)
            archive.extractall(work, filter="data")
            with (work / "database.dump").open("rb") as dump:
                database(env, "restore", dump)
            for folder in ("backend", "uploads"):
                target = root / "data" / folder
                shutil.copytree(work / "media" / folder, target, dirs_exist_ok=True)
                for entry in [target, *target.rglob("*")]:
                    os.chown(entry, 10001, 10001)
    print("Project database and media restored. Existing extra media was preserved; backend remains stopped.")


if __name__ == "__main__":
    os.umask(0o077)
    try:
        action, root = sys.argv[1], Path(sys.argv[2]).resolve()
        if action == "backup":
            backup(root)
        elif action == "restore":
            restore(root, sys.argv[3], sys.argv[4])
        else:
            raise ValueError("Unknown operation")
    except (ValueError, OSError, KeyError, subprocess.SubprocessError, tarfile.TarError) as exc:
        # Never include subprocess output or configuration values in diagnostics.
        sys.exit("Project backup/restore failed: " + (str(exc) if isinstance(exc, ValueError) else type(exc).__name__))
