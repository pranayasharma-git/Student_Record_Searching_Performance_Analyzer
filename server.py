"""Student record search and algorithm performance analyzer."""
from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import time
from collections import Counter
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_PATH = Path(os.environ.get("STUDENT_DB_PATH", DATA_DIR / "students.sqlite3"))
HOST = os.environ.get("STUDENT_APP_HOST", "127.0.0.1")
PORT = int(os.environ.get("STUDENT_APP_PORT", "8000"))
SEED = [
    ("STU-1001", "Aarav Mehta", "Computer Science", 9.1),
    ("STU-1002", "Diya Sharma", "Information Technology", 8.7),
    ("STU-1003", "Kabir Patel", "Electronics", 7.9),
    ("STU-1004", "Anaya Nair", "Computer Science", 9.5),
    ("STU-1005", "Vivaan Rao", "Mechanical Engineering", 8.2),
    ("STU-1006", "Saanvi Iyer", "Information Technology", 9.3),
    ("STU-1007", "Arjun Das", "Civil Engineering", 7.6),
    ("STU-1008", "Myra Kapoor", "Electronics", 8.9),
    ("STU-1009", "Ishaan Khan", "Computer Science", 8.4),
    ("STU-1010", "Aadhya Sen", "Information Technology", 9.7),
    ("STU-1011", "Reyansh Joshi", "Mechanical Engineering", 7.8),
    ("STU-1012", "Kiara Bose", "Civil Engineering", 8.8),
]


def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    return db


def initialize():
    with connect() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS students (
            id TEXT PRIMARY KEY COLLATE NOCASE,
            name TEXT NOT NULL,
            department TEXT NOT NULL,
            gpa REAL NOT NULL CHECK (gpa >= 0 AND gpa <= 10),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""")
        if db.execute("SELECT COUNT(*) FROM students").fetchone()[0] == 0:
            db.executemany("INSERT INTO students(id,name,department,gpa) VALUES(?,?,?,?)", SEED)


def student(row):
    return {"id": row["id"], "name": row["name"], "department": row["department"],
            "gpa": row["gpa"], "created_at": row["created_at"], "updated_at": row["updated_at"]}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.log_date_time_string(), fmt % args))

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 100_000:
            raise ValueError("Request body is too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            return super().do_GET()
        query = parse_qs(parsed.query)
        try:
            with connect() as db:
                if parsed.path == "/api/students":
                    search = query.get("q", [""])[0].strip()
                    sort = query.get("sort", ["id"])[0]
                    direction = "DESC" if query.get("direction", ["asc"])[0] == "desc" else "ASC"
                    columns = {"id": "id", "name": "name", "department": "department", "gpa": "gpa", "updated_at": "updated_at"}
                    order = columns.get(sort, "id")
                    if search:
                        term = f"%{search}%"
                        rows = db.execute(f"SELECT * FROM students WHERE id LIKE ? OR name LIKE ? OR department LIKE ? ORDER BY {order} {direction}, id", (term, term, term)).fetchall()
                    else:
                        rows = db.execute(f"SELECT * FROM students ORDER BY {order} {direction}, id").fetchall()
                    return self.send_json({"students": [student(r) for r in rows], "total": len(rows)})
                if parsed.path == "/api/summary":
                    rows = db.execute("SELECT COUNT(*) total, AVG(gpa) avg_gpa, MAX(gpa) max_gpa FROM students").fetchone()
                    departments = db.execute("SELECT department, COUNT(*) count FROM students GROUP BY department ORDER BY count DESC, department LIMIT 1").fetchone()
                    return self.send_json({"total": rows["total"], "average_gpa": round(rows["avg_gpa"] or 0, 2), "top_gpa": rows["max_gpa"] or 0, "top_department": departments["department"] if departments else "—"})
                if parsed.path.startswith("/api/students/"):
                    sid = parsed.path.rsplit("/", 1)[-1]
                    row = db.execute("SELECT * FROM students WHERE id=?", (sid,)).fetchone()
                    return self.send_json({"student": student(row)} if row else {"error": "Student record not found"}, 200 if row else 404)
            return self.send_json({"error": "Endpoint not found"}, 404)
        except (sqlite3.Error, ValueError) as exc:
            return self.send_json({"error": str(exc)}, 400)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/search":
                body = self.read_json()
                key, field, algorithm = str(body.get("query", "")).strip(), body.get("field", "id"), body.get("algorithm", "linear")
                if not key:
                    return self.send_json({"error": "Enter a search value."}, 400)
                if field not in ("id", "name") or algorithm not in ("linear", "binary"):
                    return self.send_json({"error": "Choose a valid search field and algorithm."}, 400)
                with connect() as db:
                    rows = [student(r) for r in db.execute("SELECT * FROM students").fetchall()]
                rows.sort(key=lambda r: (r[field].casefold(), r["id"].casefold()))
                target = key.casefold()
                checks = 0
                started = time.perf_counter_ns()
                found = None
                if algorithm == "linear":
                    for row in rows:
                        checks += 1
                        if row[field].casefold() == target:
                            found = row
                            break
                else:
                    lo, hi = 0, len(rows) - 1
                    while lo <= hi:
                        mid = (lo + hi) // 2
                        checks += 1
                        value = rows[mid][field].casefold()
                        if value == target:
                            found = rows[mid]
                            break
                        if value < target:
                            lo = mid + 1
                        else:
                            hi = mid - 1
                elapsed = time.perf_counter_ns() - started
                return self.send_json({"student": found, "found": found is not None, "algorithm": algorithm,
                                       "field": field, "comparisons": checks, "elapsed_ns": elapsed,
                                       "dataset_size": len(rows), "preparation_note": "Records were sorted before search." if algorithm == "binary" else None})
            if path == "/api/benchmark":
                sizes = (250, 1000, 5000, 15000, 40000)
                results = []
                for size in sizes:
                    data = list(range(size))
                    target = size - 1  # Worst-case hit for linear search.
                    repeats = max(4, min(80, 200000 // size))
                    def linear():
                        for i, value in enumerate(data):
                            if value == target:
                                return i
                        return -1
                    def binary():
                        lo, hi = 0, size - 1
                        while lo <= hi:
                            mid = (lo + hi) // 2
                            if data[mid] == target:
                                return mid
                            if data[mid] < target:
                                lo = mid + 1
                            else:
                                hi = mid - 1
                        return -1
                    linear()  # Warm-up
                    binary()
                    started = time.perf_counter_ns()
                    for _ in range(repeats):
                        linear()
                    linear_ns = (time.perf_counter_ns() - started) / repeats
                    started = time.perf_counter_ns()
                    for _ in range(repeats):
                        binary()
                    binary_ns = (time.perf_counter_ns() - started) / repeats
                    results.append({"size": size, "linear_ns": round(linear_ns), "binary_ns": round(binary_ns)})
                return self.send_json({"results": results, "method": "Worst-case successful search; dataset creation and sorting excluded; average of repeated runs."})
            if path == "/api/students":
                body = self.validate_student(self.read_json())
                with connect() as db:
                    db.execute("INSERT INTO students(id,name,department,gpa) VALUES(?,?,?,?)", (body["id"], body["name"], body["department"], body["gpa"]))
                    row = db.execute("SELECT * FROM students WHERE id=?", (body["id"],)).fetchone()
                return self.send_json({"student": student(row)}, 201)
            return self.send_json({"error": "Endpoint not found"}, 404)
        except sqlite3.IntegrityError:
            return self.send_json({"error": "A student with this ID already exists."}, 409)
        except (sqlite3.Error, ValueError, TypeError, json.JSONDecodeError) as exc:
            return self.send_json({"error": str(exc)}, 400)

    def do_PUT(self):
        try:
            sid = urlparse(self.path).path.rsplit("/", 1)[-1]
            body = self.validate_student(self.read_json())
            with connect() as db:
                cur = db.execute("UPDATE students SET id=?, name=?, department=?, gpa=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                                 (body["id"], body["name"], body["department"], body["gpa"], sid))
                if not cur.rowcount:
                    return self.send_json({"error": "Student record not found"}, 404)
                row = db.execute("SELECT * FROM students WHERE id=?", (body["id"],)).fetchone()
            return self.send_json({"student": student(row)})
        except sqlite3.IntegrityError:
            return self.send_json({"error": "A student with this ID already exists."}, 409)
        except (sqlite3.Error, ValueError, TypeError, json.JSONDecodeError) as exc:
            return self.send_json({"error": str(exc)}, 400)

    def do_DELETE(self):
        sid = urlparse(self.path).path.rsplit("/", 1)[-1]
        try:
            with connect() as db:
                cur = db.execute("DELETE FROM students WHERE id=?", (sid,))
            return self.send_json({"deleted": bool(cur.rowcount)}, 200 if cur.rowcount else 404)
        except sqlite3.Error as exc:
            return self.send_json({"error": str(exc)}, 400)

    @staticmethod
    def validate_student(data):
        sid = str(data.get("id", "")).strip().upper()
        name = str(data.get("name", "")).strip()
        department = str(data.get("department", "")).strip()
        try:
            gpa = float(data.get("gpa"))
        except (TypeError, ValueError):
            raise ValueError("GPA must be a number between 0 and 10.")
        if not re.fullmatch(r"[A-Z0-9][A-Z0-9_-]{0,29}", sid):
            raise ValueError("Student ID must start with a letter or number and contain only letters, numbers, hyphens, or underscores.")
        if not name or len(name) > 100 or not department or len(department) > 100:
            raise ValueError("Student ID, name, and department are required and must be within their length limits.")
        if not math.isfinite(gpa) or not 0 <= gpa <= 10:
            raise ValueError("GPA must be between 0 and 10.")
        return {"id": sid, "name": name, "department": department, "gpa": round(gpa, 2)}


if __name__ == "__main__":
    initialize()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Student Record Analyzer is running at http://{HOST}:{PORT}")
    print(f"SQLite database: {DB_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
        server.server_close()
