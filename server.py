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
import shlex
import hashlib
import hmac
import secrets
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
BRAVE_API_BASE = "https://api.search.brave.com"
TAVILY_API_BASE = "https://api.tavily.com"
MCP_TIMEOUT_SECONDS = 10

# ── Backend Tool Runner ────────────────────────────────────────────────────────

# Workspace root: restricts all file operations to this directory tree.
WORKSPACE_ROOT = os.path.abspath(os.path.dirname(os.path.abspath(__file__)))

# Audit log path (JSONL, one JSON object per line)
AUDIT_LOG_PATH = os.path.join(WORKSPACE_ROOT, ".audit", "tool_audit.jsonl")
INTEGRATION_AUDIT_LOG_PATH = os.path.join(WORKSPACE_ROOT, ".audit", "integration_audit.jsonl")

# Local integration state. Secrets/tokens are generated at runtime and stored outside
# source-controlled app files by default; operators can back this directory up if needed.
INTEGRATION_STATE_DIR = os.environ.get(
    "SYNAPSE_INTEGRATION_STATE_DIR",
    os.path.join(WORKSPACE_ROOT, ".synapse"),
)
INTEGRATION_STATE_PATH = os.path.join(INTEGRATION_STATE_DIR, "integrations.json")
DEFAULT_TOKEN_SCOPES = ["tools:read", "tools:run", "mcp:discover", "mcp:call", "webhooks:receive", "webhooks:send"]
INTERNAL_ONLY_ENDPOINTS = ["/api/brave/*", "/api/tavily/*", "/api/integrations/*"]
INTEGRATION_SCOPE_MAP = {
    ("GET", "/api/tools/list"): "tools:read",
    ("POST", "/api/tools/run"): "tools:run",
    ("POST", "/api/mcp/discover"): "mcp:discover",
    ("POST", "/api/mcp/call"): "mcp:call",
    ("POST", "/api/webhooks/inbound"): "webhooks:receive",
    ("POST", "/api/webhooks/emit"): "webhooks:send",
}

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


def _utc_now():
    return datetime.now(timezone.utc).isoformat()


def _read_json_body(handler):
    content_length = int(handler.headers.get("Content-Length", 0))
    raw = handler.rfile.read(content_length) if content_length > 0 else b"{}"
    if not raw:
        return {}
    return json.loads(raw)


def _send_json(handler, status, payload):
    body = json.dumps(payload, default=str).encode()
    handler.send_response(status)
    handler._cors_headers()
    handler.send_header("Content-Type", "application/json")
    handler.end_headers()
    handler.wfile.write(body)


def _integration_audit(event, status="ok", **extra):
    os.makedirs(os.path.dirname(INTEGRATION_AUDIT_LOG_PATH), exist_ok=True)
    entry = {"ts": _utc_now(), "event": event, "status": status}
    entry.update(extra)
    with open(INTEGRATION_AUDIT_LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, default=str) + "\n")


def _default_integration_state():
    return {"tokens": [], "webhooks": [], "inbound_events": [], "outbound_deliveries": []}


def _load_integration_state():
    try:
        with open(INTEGRATION_STATE_PATH, "r", encoding="utf-8") as f:
            state = json.load(f)
    except FileNotFoundError:
        state = _default_integration_state()
    except json.JSONDecodeError:
        state = _default_integration_state()
    for key, default in _default_integration_state().items():
        state.setdefault(key, default)
    return state


def _save_integration_state(state):
    os.makedirs(INTEGRATION_STATE_DIR, exist_ok=True)
    tmp_path = INTEGRATION_STATE_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, sort_keys=True)
    os.replace(tmp_path, INTEGRATION_STATE_PATH)


def _hash_secret(secret):
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _public_token(token):
    public = {k: v for k, v in token.items() if k not in ("token_hash",)}
    return public


def _new_token_secret():
    return "syn_" + secrets.token_urlsafe(32)


def _parse_expiry(expires_at):
    if not expires_at:
        return None
    try:
        return datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("expires_at must be an ISO-8601 timestamp") from exc


def _token_is_expired(token):
    expiry = token.get("expires_at")
    if not expiry:
        return False
    parsed = _parse_expiry(expiry)
    return parsed is not None and parsed <= datetime.now(timezone.utc)


def _token_has_scope(token, required_scope):
    scopes = token.get("scopes") or []
    return "*" in scopes or required_scope in scopes


def _authenticate_integration_request(headers, required_scope):
    auth = headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None, "Missing Bearer token"
    provided = auth[len("Bearer "):].strip()
    if not provided:
        return None, "Missing Bearer token"
    provided_hash = _hash_secret(provided)
    state = _load_integration_state()
    for token in state.get("tokens", []):
        if not hmac.compare_digest(token.get("token_hash", ""), provided_hash):
            continue
        if token.get("revoked_at"):
            return None, "Token revoked"
        if _token_is_expired(token):
            return None, "Token expired"
        if required_scope and not _token_has_scope(token, required_scope):
            return None, f"Token missing scope: {required_scope}"
        token["last_used_at"] = _utc_now()
        _save_integration_state(state)
        return token, None
    return None, "Invalid token"


def _verify_webhook_signature(raw_body, secret, signature_header):
    if not secret:
        return False
    if not signature_header:
        return False
    expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    candidates = [signature_header]
    if signature_header.startswith("sha256="):
        candidates.append(signature_header.split("=", 1)[1])
    return any(hmac.compare_digest(expected, candidate) for candidate in candidates)


def _safe_webhook_url(url):
    parsed = urlparse(url)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def _deliver_outbound_webhook(webhook, event, payload):
    body = json.dumps({"event": event, "payload": payload, "sent_at": _utc_now()}).encode()
    signature = hmac.new(webhook["secret"].encode("utf-8"), body, hashlib.sha256).hexdigest()
    headers = {
        "Content-Type": "application/json",
        "X-Synapse-Event": event,
        "X-Synapse-Signature": f"sha256={signature}",
    }
    req = urllib.request.Request(webhook["url"], data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=10) as resp:
        response_body = resp.read(2048).decode("utf-8", errors="replace")
        return {"status_code": resp.status, "body_preview": response_body}


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


# ── MCP discovery helpers ─────────────────────────────────────────────────────

def _json_rpc(method, params=None, request_id=1):
    return {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}


def _mcp_extract_tools(payload):
    if not isinstance(payload, dict):
        return []
    result = payload.get("result", payload)
    tools = result.get("tools") if isinstance(result, dict) else []
    clean = []
    for tool in tools or []:
        if not isinstance(tool, dict):
            continue
        clean.append({
            "name": tool.get("name", "unknown"),
            "description": tool.get("description", ""),
            "inputSchema": tool.get("inputSchema") or tool.get("parameters") or {"type": "object", "properties": {}},
        })
    return clean


def _mcp_discover_http(server):
    url = server.get("url")
    if not url:
        raise ValueError("HTTP MCP server requires a url")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    headers.update(server.get("headers") or {})
    token = server.get("token")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    init_body = json.dumps(_json_rpc("initialize", {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "Synapse", "version": "1.0"},
    }, 1)).encode()
    try:
        req = urllib.request.Request(url, data=init_body, headers=headers, method="POST")
        urllib.request.urlopen(req, timeout=MCP_TIMEOUT_SECONDS).read()
    except Exception:
        pass

    body = json.dumps(_json_rpc("tools/list", {}, 2)).encode()
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=MCP_TIMEOUT_SECONDS) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    return _mcp_extract_tools(payload)


def _mcp_call_http(server, tool_name, arguments):
    url = server.get("url")
    if not url:
        raise ValueError("HTTP MCP server requires a url")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    headers.update(server.get("headers") or {})
    token = server.get("token")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    init_body = json.dumps(_json_rpc("initialize", {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "Synapse", "version": "1.0"},
    }, 1)).encode()
    try:
        req = urllib.request.Request(url, data=init_body, headers=headers, method="POST")
        urllib.request.urlopen(req, timeout=MCP_TIMEOUT_SECONDS).read()
    except Exception:
        pass

    body = json.dumps(_json_rpc("tools/call", {
        "name": tool_name,
        "arguments": arguments or {},
    }, 3)).encode()
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=MCP_TIMEOUT_SECONDS) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if isinstance(payload, dict) and payload.get("error"):
        error = payload["error"]
        raise RuntimeError(error.get("message") if isinstance(error, dict) else str(error))
    return payload.get("result", payload) if isinstance(payload, dict) else payload


def _mcp_discover_stdio(server):
    command = server.get("command") or ""
    if not command:
        raise ValueError("stdio MCP server requires a command")
    proc = subprocess.Popen(
        shlex.split(command),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=WORKSPACE_ROOT,
    )
    requests = [
        _json_rpc("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "Synapse", "version": "1.0"},
        }, 1),
        _json_rpc("tools/list", {}, 2),
    ]
    stdin = "".join(json.dumps(item) + "\n" for item in requests)
    try:
        stdout, stderr = proc.communicate(stdin, timeout=MCP_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        proc.kill()
        stdout, stderr = proc.communicate()
        raise TimeoutError(f"MCP stdio discovery timed out: {stderr[:400]}")
    if proc.returncode not in (0, None) and not stdout.strip():
        raise RuntimeError(stderr.strip() or f"MCP command exited with {proc.returncode}")
    tools = []
    for line in stdout.splitlines():
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        tools = _mcp_extract_tools(payload) or tools
    return tools


def _mcp_call_stdio(server, tool_name, arguments):
    command = server.get("command") or ""
    if not command:
        raise ValueError("stdio MCP server requires a command")
    command_parts = shlex.split(command) + list(server.get("args") or [])
    proc = subprocess.Popen(
        command_parts,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=WORKSPACE_ROOT,
    )
    requests = [
        _json_rpc("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "Synapse", "version": "1.0"},
        }, 1),
        _json_rpc("tools/call", {"name": tool_name, "arguments": arguments or {}}, 2),
    ]
    stdin = "".join(json.dumps(item) + "\n" for item in requests)
    try:
        stdout, stderr = proc.communicate(stdin, timeout=MCP_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        proc.kill()
        stdout, stderr = proc.communicate()
        raise TimeoutError(f"MCP stdio tool call timed out: {stderr[:400]}")
    if proc.returncode not in (0, None) and not stdout.strip():
        raise RuntimeError(stderr.strip() or f"MCP command exited with {proc.returncode}")
    result = None
    for line in stdout.splitlines():
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and payload.get("id") == 2:
            if payload.get("error"):
                error = payload["error"]
                raise RuntimeError(error.get("message") if isinstance(error, dict) else str(error))
            result = payload.get("result", payload)
    if result is None:
        raise RuntimeError(stderr.strip() or "MCP stdio tool call produced no result")
    return result


def discover_mcp_tools(server):
    transport = server.get("transport", "http")
    if transport == "stdio":
        return _mcp_discover_stdio(server)
    if transport == "http":
        return _mcp_discover_http(server)
    raise ValueError(f"Unsupported MCP transport: {transport}")


def call_mcp_tool(server, tool_name, arguments):
    if not tool_name or not isinstance(tool_name, str):
        raise ValueError("MCP tool name is required")
    transport = server.get("transport", "http")
    if transport == "stdio":
        return _mcp_call_stdio(server, tool_name, arguments)
    if transport == "http":
        return _mcp_call_http(server, tool_name, arguments)
    raise ValueError(f"Unsupported MCP transport: {transport}")


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
        elif self.path == "/api/integrations/tokens":
            self._handle_tokens_list()
        elif self.path == "/api/integrations/webhooks":
            self._handle_webhooks_list()
        elif self.path == "/api/integrations/audit":
            self._handle_integration_audit_tail()
        elif self.path == "/api/health":
            self._handle_health()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/tavily/"):
            self._proxy_tavily()
        elif self.path == "/api/tools/run":
            self._handle_tools_run()
        elif self.path == "/api/mcp/discover":
            self._handle_mcp_discover()
        elif self.path == "/api/mcp/call":
            self._handle_mcp_call()
        elif self.path == "/api/integrations/tokens":
            self._handle_token_create()
        elif self.path.startswith("/api/integrations/tokens/"):
            self._handle_token_action()
        elif self.path == "/api/integrations/webhooks":
            self._handle_webhook_create()
        elif self.path.startswith("/api/integrations/webhooks/"):
            self._handle_webhook_action()
        elif self.path == "/api/webhooks/inbound":
            self._handle_inbound_webhook()
        elif self.path == "/api/webhooks/emit":
            self._handle_webhook_emit()
        else:
            self.send_response(405)
            self._cors_headers()
            self.end_headers()

    def do_OPTIONS(self):
        if (self.path.startswith("/api/brave/")
                or self.path.startswith("/api/tavily/")
                or self.path.startswith("/api/tools/")
                or self.path.startswith("/api/mcp/")
                or self.path.startswith("/api/integrations/")
                or self.path.startswith("/api/webhooks/")):
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
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, X-Subscription-Token, Accept, Authorization, X-Synapse-Signature, X-Synapse-Event",
        )
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _required_scope(self):
        return INTEGRATION_SCOPE_MAP.get((self.command, self.path))

    def _require_scope(self, scope=None):
        required = scope if scope is not None else self._required_scope()
        if not required:
            return True
        token, error = _authenticate_integration_request(self.headers, required)
        if error:
            _integration_audit("auth", "denied", path=self.path, scope=required, error=error)
            _send_json(self, 401, {"ok": False, "error": error, "required_scope": required})
            return False
        assert token is not None
        _integration_audit("auth", "ok", path=self.path, scope=required, token_id=token.get("id"))
        return True

    # ── Health & tool endpoints ──────────────────────────────────────────────

    def _handle_health(self):
        """GET /api/health — lightweight server health check."""
        uptime_s = round(time.monotonic() - _server_start_time, 1)
        checks = {
            "server": {"ok": True, "detail": "Running"},
            "tool_runner": {"ok": True, "detail": f"{len(TOOL_SCHEMAS)} tools registered"},
            "audit_log": {"ok": True, "path": AUDIT_LOG_PATH},
            "integrations": {
                "ok": True,
                "detail": "API tokens, scoped external endpoints, inbound webhooks, outbound hooks",
                "state_path": INTEGRATION_STATE_PATH,
                "external_scopes": DEFAULT_TOKEN_SCOPES,
                "internal_only": INTERNAL_ONLY_ENDPOINTS,
            },
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
        if not self._require_scope():
            return
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
        if not self._require_scope():
            return
        try:
            payload = _read_json_body(self)
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

    def _handle_mcp_discover(self):
        """POST /api/mcp/discover — discover tools from an MCP server config."""
        if not self._require_scope():
            return
        try:
            payload = _read_json_body(self)
            server = payload.get("server") or {}
            tools = discover_mcp_tools(server)
            response = {"ok": True, "tools": tools, "count": len(tools)}
            status = 200
        except Exception as e:
            response = {"ok": False, "error": str(e), "tools": []}
            status = 422

        body = json.dumps(response, default=str).encode()
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def _handle_mcp_call(self):
        """POST /api/mcp/call — execute a tool on a configured MCP server."""
        if not self._require_scope():
            return
        try:
            payload = _read_json_body(self)
            server = payload.get("server") or {}
            tool_name = payload.get("tool")
            arguments = payload.get("args") or {}
            result = call_mcp_tool(server, tool_name, arguments)
            response = {"ok": True, "tool": tool_name, "result": result}
            status = 200
        except Exception as e:
            response = {"ok": False, "error": str(e)}
            status = 422

        body = json.dumps(response, default=str).encode()
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    # ── Integration token & webhook endpoints ────────────────────────────────

    def _handle_tokens_list(self):
        state = _load_integration_state()
        _send_json(self, 200, {
            "ok": True,
            "scopes": DEFAULT_TOKEN_SCOPES,
            "tokens": [_public_token(token) for token in state.get("tokens", [])],
        })

    def _handle_token_create(self):
        try:
            payload = _read_json_body(self)
            scopes = payload.get("scopes") or ["tools:read"]
            if not isinstance(scopes, list) or not all(isinstance(scope, str) for scope in scopes):
                raise ValueError("scopes must be a list of strings")
            unknown_scopes = sorted(set(scopes) - set(DEFAULT_TOKEN_SCOPES) - {"*"})
            if unknown_scopes:
                raise ValueError(f"Unknown scopes: {', '.join(unknown_scopes)}")
            expires_at = payload.get("expires_at")
            _parse_expiry(expires_at)
            secret = _new_token_secret()
            now = _utc_now()
            token = {
                "id": str(uuid.uuid4()),
                "name": payload.get("name") or "Synapse API token",
                "scopes": scopes,
                "expires_at": expires_at,
                "created_at": now,
                "rotated_at": None,
                "revoked_at": None,
                "last_used_at": None,
                "token_prefix": secret[:12],
                "token_hash": _hash_secret(secret),
            }
            state = _load_integration_state()
            state["tokens"].append(token)
            _save_integration_state(state)
            _integration_audit("token.create", token_id=token["id"], scopes=scopes)
            response = _public_token(token)
            response["token"] = secret
            _send_json(self, 201, {"ok": True, "token": response})
        except (json.JSONDecodeError, ValueError) as e:
            _send_json(self, 400, {"ok": False, "error": str(e)})

    def _handle_token_action(self):
        subparts = self.path.strip("/").split("/")
        if len(subparts) != 5 or subparts[:3] != ["api", "integrations", "tokens"]:
            _send_json(self, 404, {"ok": False, "error": "Use /api/integrations/tokens/{id}/revoke or /rotate"})
            return
        token_id, action = subparts[3], subparts[4]
        if action not in ("revoke", "rotate"):
            _send_json(self, 404, {"ok": False, "error": "Use /api/integrations/tokens/{id}/revoke or /rotate"})
            return
        state = _load_integration_state()
        token = next((item for item in state.get("tokens", []) if item.get("id") == token_id), None)
        if not token:
            _send_json(self, 404, {"ok": False, "error": "Token not found"})
            return
        if action == "revoke":
            token["revoked_at"] = _utc_now()
            _save_integration_state(state)
            _integration_audit("token.revoke", token_id=token_id)
            _send_json(self, 200, {"ok": True, "token": _public_token(token)})
            return
        secret = _new_token_secret()
        token["token_hash"] = _hash_secret(secret)
        token["token_prefix"] = secret[:12]
        token["rotated_at"] = _utc_now()
        token["revoked_at"] = None
        _save_integration_state(state)
        _integration_audit("token.rotate", token_id=token_id)
        response = _public_token(token)
        response["token"] = secret
        _send_json(self, 200, {"ok": True, "token": response})

    def _handle_webhooks_list(self):
        state = _load_integration_state()
        webhooks = [{k: v for k, v in hook.items() if k != "secret"} for hook in state.get("webhooks", [])]
        _send_json(self, 200, {"ok": True, "webhooks": webhooks})

    def _handle_webhook_create(self):
        try:
            payload = _read_json_body(self)
            url = payload.get("url")
            if not url or not _safe_webhook_url(url):
                raise ValueError("url must be http(s)")
            events = payload.get("events") or ["agent_run.completed", "research_report.completed", "task.reminder"]
            if not isinstance(events, list) or not all(isinstance(event, str) for event in events):
                raise ValueError("events must be a list of strings")
            secret = payload.get("secret") or secrets.token_urlsafe(32)
            webhook = {
                "id": str(uuid.uuid4()),
                "name": payload.get("name") or "Synapse outbound webhook",
                "url": url,
                "events": events,
                "secret": secret,
                "active": bool(payload.get("active", True)),
                "created_at": _utc_now(),
                "last_delivery_at": None,
                "last_status": None,
            }
            state = _load_integration_state()
            state["webhooks"].append(webhook)
            _save_integration_state(state)
            _integration_audit("webhook.create", webhook_id=webhook["id"], events=events)
            response = {k: v for k, v in webhook.items() if k != "secret"}
            response["secret"] = secret
            _send_json(self, 201, {"ok": True, "webhook": response})
        except (json.JSONDecodeError, ValueError) as e:
            _send_json(self, 400, {"ok": False, "error": str(e)})

    def _handle_webhook_action(self):
        subparts = self.path.strip("/").split("/")
        if len(subparts) != 5 or subparts[:3] != ["api", "integrations", "webhooks"]:
            _send_json(self, 404, {"ok": False, "error": "Use /api/integrations/webhooks/{id}/disable|enable|test"})
            return
        webhook_id, action = subparts[3], subparts[4]
        if action not in ("disable", "enable", "test"):
            _send_json(self, 404, {"ok": False, "error": "Unknown webhook action"})
            return
        state = _load_integration_state()
        webhook = next((item for item in state.get("webhooks", []) if item.get("id") == webhook_id), None)
        if not webhook:
            _send_json(self, 404, {"ok": False, "error": "Webhook not found"})
            return
        if action in ("disable", "enable"):
            webhook["active"] = action == "enable"
            _save_integration_state(state)
            _integration_audit(f"webhook.{action}", webhook_id=webhook_id)
            _send_json(self, 200, {"ok": True, "webhook": {k: v for k, v in webhook.items() if k != "secret"}})
            return
        self._emit_webhook_event("synapse.webhook.test", {"webhook_id": webhook_id}, only_id=webhook_id)

    def _handle_inbound_webhook(self):
        if not self._require_scope():
            return
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(content_length) if content_length > 0 else b"{}"
            payload = json.loads(raw or b"{}")
            shared_secret = payload.get("secret") or os.environ.get("SYNAPSE_INBOUND_WEBHOOK_SECRET")
            if shared_secret and not _verify_webhook_signature(raw, shared_secret, self.headers.get("X-Synapse-Signature", "")):
                _integration_audit("webhook.inbound", "denied", error="Invalid signature")
                _send_json(self, 401, {"ok": False, "error": "Invalid webhook signature"})
                return
            event = {
                "id": str(uuid.uuid4()),
                "event": self.headers.get("X-Synapse-Event") or payload.get("event") or "external.event",
                "payload": payload.get("payload", payload),
                "received_at": _utc_now(),
            }
            state = _load_integration_state()
            state["inbound_events"].append(event)
            state["inbound_events"] = state["inbound_events"][-100:]
            _save_integration_state(state)
            _integration_audit("webhook.inbound", event_id=event["id"], event_name=event["event"])
            _send_json(self, 202, {"ok": True, "event": event})
        except (json.JSONDecodeError, ValueError) as e:
            _send_json(self, 400, {"ok": False, "error": str(e)})

    def _handle_webhook_emit(self):
        if not self._require_scope():
            return
        try:
            payload = _read_json_body(self)
            event = payload.get("event") or "synapse.event"
            event_payload = payload.get("payload") or {}
            self._emit_webhook_event(event, event_payload)
        except (json.JSONDecodeError, ValueError) as e:
            _send_json(self, 400, {"ok": False, "error": str(e)})

    def _emit_webhook_event(self, event, payload, only_id=None):
        state = _load_integration_state()
        deliveries = []
        for webhook in state.get("webhooks", []):
            if only_id:
                if webhook.get("id") != only_id:
                    continue
            elif event not in webhook.get("events", []) and "*" not in webhook.get("events", []):
                continue
            if not webhook.get("active", True):
                continue
            delivery = {
                "id": str(uuid.uuid4()),
                "webhook_id": webhook.get("id"),
                "event": event,
                "sent_at": _utc_now(),
            }
            try:
                result = _deliver_outbound_webhook(webhook, event, payload)
                delivery.update({"ok": True, **result})
                webhook["last_status"] = result.get("status_code")
            except Exception as e:
                delivery.update({"ok": False, "error": str(e)})
                webhook["last_status"] = "error"
            webhook["last_delivery_at"] = delivery["sent_at"]
            deliveries.append(delivery)
            _integration_audit("webhook.deliver", "ok" if delivery.get("ok") else "error", **delivery)
        state["outbound_deliveries"].extend(deliveries)
        state["outbound_deliveries"] = state["outbound_deliveries"][-100:]
        _save_integration_state(state)
        status = 200 if any(item.get("ok") for item in deliveries) or not deliveries else 502
        _send_json(self, status, {"ok": status == 200, "event": event, "deliveries": deliveries})

    def _handle_integration_audit_tail(self):
        lines = []
        try:
            with open(INTEGRATION_AUDIT_LOG_PATH, "r", encoding="utf-8") as f:
                lines = f.readlines()[-100:]
        except FileNotFoundError:
            pass
        entries = []
        for line in lines:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        _send_json(self, 200, {"ok": True, "entries": entries})

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
