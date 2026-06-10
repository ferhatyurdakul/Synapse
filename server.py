#!/usr/bin/env python3
"""
Synapse dev server — static file server + CORS proxy for external APIs.

Usage:  python3 server.py [port]
        Default port: 8000

Proxies requests under /api/brave/* to https://api.search.brave.com/*
and /api/tavily/* to https://api.tavily.com/*
so the browser can call external search APIs without CORS issues.

Backend tool runner: POST /api/tools/run executes sandboxed backend tools
(list_dir, read_file, write_file, shell) with policy enforcement, audit
logging, and structured JSON responses.
"""

import http.server
import urllib.request
import urllib.error
import sys
import os
import json
import time
import threading
import subprocess
from datetime import datetime, timezone

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
BRAVE_API_BASE = "https://api.search.brave.com"
TAVILY_API_BASE = "https://api.tavily.com"

# ── Backend Tool Runner ────────────────────────────────────────────────────────

# Workspace root: restricts all file operations to this directory tree.
WORKSPACE_ROOT = os.path.abspath(os.path.dirname(os.path.abspath(__file__)))

# Audit log path (JSONL, one JSON object per line)
AUDIT_LOG_PATH = os.path.join(WORKSPACE_ROOT, ".audit", "tool_audit.jsonl")

# Default policy per tool: "allowed" | "ask" | "denied"
DEFAULT_POLICIES = {
    "list_dir": "allowed",
    "read_file": "allowed",
    "write_file": "ask",
    "shell": "denied",
}

# Concurrency and timeout limits
MAX_CONCURRENT_TOOLS = 4
TOOL_TIMEOUT_SECONDS = 30

# Thread pool semaphore for concurrency control
_tool_semaphore = threading.Semaphore(MAX_CONCURRENT_TOOLS)

# Server start time for uptime tracking
_server_start_time = time.monotonic()


# ── Tool schemas (OpenAI function-calling format) ──────────────────────────────

TOOL_SCHEMAS = {
    "list_dir": {
        "name": "list_dir",
        "description": "List directory contents on the server filesystem, restricted to the workspace root.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative path within the workspace to list. Defaults to '.' (workspace root)."
                },
                "show_hidden": {
                    "type": "boolean",
                    "description": "Whether to include hidden files (starting with '.'). Default: false."
                }
            },
            "required": []
        }
    },
    "read_file": {
        "name": "read_file",
        "description": "Read a file's contents from the server filesystem, restricted to the workspace root.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative path of the file within the workspace."
                },
                "encoding": {
                    "type": "string",
                    "description": "File encoding. Default: 'utf-8'."
                },
                "max_bytes": {
                    "type": "integer",
                    "description": "Maximum bytes to read. Default: 65536 (64 KB)."
                }
            },
            "required": ["path"]
        }
    },
    "write_file": {
        "name": "write_file",
        "description": "Write content to a file on the server filesystem, restricted to the workspace root.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative path of the file within the workspace."
                },
                "content": {
                    "type": "string",
                    "description": "The text content to write."
                },
                "append": {
                    "type": "boolean",
                    "description": "If true, append to the file instead of overwriting. Default: false."
                },
                "create_dirs": {
                    "type": "boolean",
                    "description": "If true, create parent directories if they don't exist. Default: false."
                }
            },
            "required": ["path", "content"]
        }
    },
    "shell": {
        "name": "shell",
        "description": "Execute a shell command on the server. Uses the system default shell.",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to execute."
                },
                "cwd": {
                    "type": "string",
                    "description": "Working directory relative to workspace root. Default: workspace root."
                },
                "timeout": {
                    "type": "integer",
                    "description": "Per-command timeout in seconds. Default: 30. Max: 60."
                }
            },
            "required": ["command"]
        }
    },
}


def _resolve_path(relative_path):
    """Resolve a relative path against WORKSPACE_ROOT, enforcing it stays within."""
    if not relative_path:
        relative_path = "."
    # Normalize and resolve
    abs_path = os.path.normpath(os.path.join(WORKSPACE_ROOT, relative_path))
    # Ensure the resolved path is still under WORKSPACE_ROOT
    if not abs_path.startswith(WORKSPACE_ROOT + os.sep) and abs_path != WORKSPACE_ROOT:
        raise PermissionError(f"Path escapes workspace root: {relative_path}")
    return abs_path


def _write_audit_log(entry):
    """Append a JSONL entry to the audit log."""
    os.makedirs(os.path.dirname(AUDIT_LOG_PATH), exist_ok=True)
    line = json.dumps(entry, default=str) + "\n"
    with open(AUDIT_LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line)


def _make_response(ok, tool_name, result=None, error=None, **extra):
    """Build a structured tool response dict."""
    resp = {
        "ok": ok,
        "tool": tool_name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if result is not None:
        resp["result"] = result
    if error is not None:
        resp["error"] = error
    resp.update(extra)
    return resp


def _execute_list_dir(args):
    """List directory contents."""
    rel_path = args.get("path", ".")
    show_hidden = args.get("show_hidden", False)
    abs_path = _resolve_path(rel_path)

    if not os.path.isdir(abs_path):
        raise FileNotFoundError(f"Not a directory: {rel_path}")

    entries = []
    for entry in sorted(os.listdir(abs_path)):
        if not show_hidden and entry.startswith("."):
            continue
        full = os.path.join(abs_path, entry)
        entries.append({
            "name": entry,
            "type": "dir" if os.path.isdir(full) else "file",
            "size": os.path.getsize(full) if os.path.isfile(full) else None,
        })

    return {"path": rel_path, "entries": entries, "count": len(entries)}


def _execute_read_file(args):
    """Read file contents."""
    rel_path = args.get("path")
    if not rel_path:
        raise ValueError("'path' is required")
    encoding = args.get("encoding", "utf-8")
    max_bytes = min(args.get("max_bytes", 65536), 65536)
    abs_path = _resolve_path(rel_path)

    if not os.path.isfile(abs_path):
        raise FileNotFoundError(f"File not found: {rel_path}")

    size = os.path.getsize(abs_path)
    truncated = size > max_bytes

    with open(abs_path, "r", encoding=encoding, errors="replace") as f:
        content = f.read(max_bytes)

    return {
        "path": rel_path,
        "content": content,
        "bytes_read": len(content.encode(encoding, errors="replace")),
        "total_bytes": size,
        "truncated": truncated,
    }


def _execute_write_file(args):
    """Write content to a file."""
    rel_path = args.get("path")
    content = args.get("content")
    if not rel_path:
        raise ValueError("'path' is required")
    if content is None:
        raise ValueError("'content' is required")
    append = args.get("append", False)
    create_dirs = args.get("create_dirs", False)
    abs_path = _resolve_path(rel_path)

    if create_dirs:
        os.makedirs(os.path.dirname(abs_path), exist_ok=True)

    mode = "a" if append else "w"
    with open(abs_path, mode, encoding="utf-8") as f:
        f.write(content)

    return {
        "path": rel_path,
        "bytes_written": len(content.encode("utf-8")),
        "appended": append,
    }


def _execute_shell(args):
    """Execute a shell command."""
    command = args.get("command")
    if not command:
        raise ValueError("'command' is required")
    cwd_rel = args.get("cwd", ".")
    timeout = min(args.get("timeout", TOOL_TIMEOUT_SECONDS), 60)
    cwd_abs = _resolve_path(cwd_rel)

    if not os.path.isdir(cwd_abs):
        raise FileNotFoundError(f"Working directory not found: {cwd_rel}")

    proc = subprocess.run(
        command,
        shell=True,
        capture_output=True,
        text=True,
        cwd=cwd_abs,
        timeout=timeout,
    )

    return {
        "command": command,
        "exit_code": proc.returncode,
        "stdout": proc.stdout[:65536],  # cap output
        "stderr": proc.stderr[:65536],
        "timed_out": False,
    }


TOOL_EXECUTORS = {
    "list_dir": _execute_list_dir,
    "read_file": _execute_read_file,
    "write_file": _execute_write_file,
    "shell": _execute_shell,
}


def run_backend_tool(tool_name, args):
    """
    Execute a backend tool with policy check, concurrency control,
    timeout, and audit logging. Returns a response dict.
    """
    start = time.monotonic()
    timestamp = datetime.now(timezone.utc).isoformat()
    audit_entry = {
        "ts": timestamp,
        "tool": tool_name,
        "args": args,
    }

    # Validate tool name
    if tool_name not in TOOL_SCHEMAS:
        audit_entry["status"] = "error"
        audit_entry["error"] = f"Unknown tool: {tool_name}"
        _write_audit_log(audit_entry)
        return _make_response(False, tool_name, error=f"Unknown tool: {tool_name}")

    # Check policy
    policy = DEFAULT_POLICIES.get(tool_name, "denied")
    if policy == "denied":
        audit_entry["status"] = "denied"
        _write_audit_log(audit_entry)
        return _make_response(
            False, tool_name,
            error=f"Tool '{tool_name}' is denied by policy. Update DEFAULT_POLICIES to allow.",
            policy=policy,
        )
    if policy == "ask":
        audit_entry["status"] = "ask"
        _write_audit_log(audit_entry)
        return _make_response(
            False, tool_name,
            error=f"Tool '{tool_name}' requires user approval. Not yet implemented in this slice.",
            policy=policy,
        )

    # Acquire concurrency slot
    if not _tool_semaphore.acquire(blocking=True, timeout=TOOL_TIMEOUT_SECONDS):
        audit_entry["status"] = "timeout"
        audit_entry["error"] = "Concurrency limit reached"
        _write_audit_log(audit_entry)
        return _make_response(
            False, tool_name,
            error=f"Concurrency limit ({MAX_CONCURRENT_TOOLS}) reached. Try again later.",
        )

    try:
        executor = TOOL_EXECUTORS[tool_name]
        result = executor(args)
        elapsed = round(time.monotonic() - start, 3)
        audit_entry["status"] = "ok"
        audit_entry["elapsed_s"] = elapsed
        _write_audit_log(audit_entry)
        return _make_response(True, tool_name, result=result, elapsed_s=elapsed)

    except subprocess.TimeoutExpired:
        elapsed = round(time.monotonic() - start, 3)
        audit_entry["status"] = "timeout"
        audit_entry["elapsed_s"] = elapsed
        _write_audit_log(audit_entry)
        return _make_response(
            False, tool_name,
            error=f"Tool timed out after {TOOL_TIMEOUT_SECONDS}s",
            elapsed_s=elapsed,
        )

    except PermissionError as e:
        audit_entry["status"] = "error"
        audit_entry["error"] = str(e)
        _write_audit_log(audit_entry)
        return _make_response(False, tool_name, error=str(e))

    except FileNotFoundError as e:
        audit_entry["status"] = "error"
        audit_entry["error"] = str(e)
        _write_audit_log(audit_entry)
        return _make_response(False, tool_name, error=str(e))

    except Exception as e:
        elapsed = round(time.monotonic() - start, 3)
        audit_entry["status"] = "error"
        audit_entry["error"] = str(e)
        audit_entry["elapsed_s"] = elapsed
        _write_audit_log(audit_entry)
        return _make_response(False, tool_name, error=str(e), elapsed_s=elapsed)

    finally:
        _tool_semaphore.release()


class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Prevent caching for JS/CSS so changes are picked up immediately
        if self.path and (self.path.endswith(('.js', '.css')) or '.js?' in self.path or '.css?' in self.path):
            self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/api/brave/"):
            self._proxy_brave()
        elif self.path == "/api/tools/list":
            self._handle_tools_list()
        elif self.path == "/api/health":
            self._handle_health()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/tavily/"):
            self._proxy_tavily()
        elif self.path == "/api/tools/run":
            self._handle_tools_run()
        else:
            self.send_response(405)
            self._cors_headers()
            self.end_headers()

    def do_OPTIONS(self):
        if (self.path.startswith("/api/brave/")
                or self.path.startswith("/api/tavily/")
                or self.path.startswith("/api/tools/")):
            self.send_response(204)
            self._cors_headers()
            self.end_headers()
        else:
            super().do_OPTIONS()

    def _proxy_brave(self):
        # Strip /api/brave prefix and forward to Brave API
        remote_path = self.path[len("/api/brave"):]
        url = f"{BRAVE_API_BASE}{remote_path}"

        # Forward relevant headers (skip Accept-Encoding so we get plain text)
        headers = {}
        for key in ("X-Subscription-Token", "Accept"):
            val = self.headers.get(key)
            if val:
                headers[key] = val

        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = resp.read()
                self.send_response(resp.status)
                self._cors_headers()
                self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_response(e.code)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_response(502)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Subscription-Token, Accept")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    # ── Health & tool endpoints ──────────────────────────────────────────────

    def _handle_health(self):
        """GET /api/health — lightweight server health check."""
        uptime_s = round(time.monotonic() - _server_start_time, 1)
        checks = {
            "server": {"ok": True, "detail": "Running"},
            "tool_runner": {"ok": True, "detail": f"{len(TOOL_SCHEMAS)} tools registered"},
            "audit_log": {"ok": True, "path": AUDIT_LOG_PATH},
        }

        # Check audit log is writable
        try:
            os.makedirs(os.path.dirname(AUDIT_LOG_PATH), exist_ok=True)
            with open(AUDIT_LOG_PATH, "a", encoding="utf-8") as f:
                pass
        except Exception as e:
            checks["audit_log"] = {"ok": False, "detail": str(e)}

        # Count audit log entries (last 100 lines max)
        audit_count = 0
        try:
            with open(AUDIT_LOG_PATH, "r", encoding="utf-8") as f:
                for _ in f:
                    audit_count += 1
        except FileNotFoundError:
            pass

        all_ok = all(c["ok"] for c in checks.values())
        payload = {
            "ok": all_ok,
            "version": "1.0",
            "uptime": f"{uptime_s}s",
            "uptime_seconds": uptime_s,
            "workspace": WORKSPACE_ROOT,
            "audit_entries": audit_count,
            "checks": checks,
        }

        body = json.dumps(payload, default=str).encode()
        self.send_response(200)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def _handle_tools_list(self):
        """GET /api/tools/list — return available tools with schemas and policies."""
        tools = []
        for name, schema in TOOL_SCHEMAS.items():
            tools.append({
                "name": name,
                "description": schema["description"],
                "parameters": schema["parameters"],
                "policy": DEFAULT_POLICIES.get(name, "denied"),
            })
        body = json.dumps({"tools": tools, "workspace": WORKSPACE_ROOT}).encode()
        self.send_response(200)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def _handle_tools_run(self):
        """POST /api/tools/run — execute a backend tool."""
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(content_length) if content_length > 0 else b"{}"
            payload = json.loads(raw)
        except (json.JSONDecodeError, ValueError) as e:
            body = json.dumps({"ok": False, "error": f"Invalid JSON: {e}"}).encode()
            self.send_response(400)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
            return

        tool_name = payload.get("tool")
        args = payload.get("args", {})

        if not tool_name or not isinstance(tool_name, str):
            body = json.dumps({"ok": False, "error": "'tool' is required and must be a string"}).encode()
            self.send_response(400)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
            return

        response = run_backend_tool(tool_name, args)
        status = 200 if response.get("ok") else 422

        body = json.dumps(response, default=str).encode()
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def _proxy_tavily(self):
        # Strip /api/tavily prefix and forward to Tavily API
        remote_path = self.path[len("/api/tavily"):]
        url = f"{TAVILY_API_BASE}{remote_path}"

        # Read the request body (contains api_key + query)
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else None

        headers = {"Content-Type": "application/json"}

        try:
            req = urllib.request.Request(url, data=body, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read()
                self.send_response(resp.status)
                self._cors_headers()
                self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_response(e.code)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_response(502)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def log_message(self, format, *args):
        # Colorize proxy requests
        msg = format % args
        if "/api/brave/" in msg or "/api/tavily/" in msg:
            print(f"\033[36m[proxy] {msg}\033[0m")
        else:
            super().log_message(format, *args)


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with http.server.HTTPServer(("", PORT), ProxyHandler) as httpd:
        print(f"Synapse server running at http://localhost:{PORT}")
        print(f"Brave API proxy at http://localhost:{PORT}/api/brave/")
        print(f"Tavily API proxy at http://localhost:{PORT}/api/tavily/")
        print(f"Backend tools at http://localhost:{PORT}/api/tools/list and /api/tools/run")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down.")
