"""MCP (Model Context Protocol) Client — connects to external MCP servers.

Supports the Streamable HTTP transport (the modern standard) and SSE responses.
Reference: https://modelcontextprotocol.io/docs
"""

import httpx
import json
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse


class MCPClient:
    """Client for connecting to MCP servers via Streamable HTTP transport.

    Supports both plain JSON and SSE (text/event-stream) responses,
    and optional MCP session initialization for servers that require it.
    """

    def __init__(self, server_url: str, api_key: str | None = None):
        # Extract apiKey from URL query params and move to Authorization header
        parsed = urlparse(server_url)
        qs = parse_qs(parsed.query, keep_blank_values=True)

        self.api_key = api_key
        if not self.api_key and "apiKey" in qs:
            self.api_key = qs.pop("apiKey")[0]

        # Rebuild URL without apiKey in query string
        remaining_qs = urlencode({k: v[0] for k, v in qs.items()}) if qs else ""
        self.server_url = urlunparse(parsed._replace(query=remaining_qs)).rstrip("/")

        # Session ID for servers that use stateful sessions (e.g. Atlassian Rovo)
        self._session_id: str | None = None

    def _headers(self) -> dict:
        """Build request headers with proper MCP and auth headers."""
        h = {
            "Content-Type": "application/json",
            # Streamable HTTP requires accepting both JSON and SSE
            "Accept": "application/json, text/event-stream",
        }
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        if self._session_id:
            h["Mcp-Session-Id"] = self._session_id
        return h

    def _parse_response(self, resp: httpx.Response) -> dict:
        """Parse response — handles both JSON and SSE (text/event-stream) formats."""
        content_type = resp.headers.get("content-type", "")

        # Save session ID if the server returns one
        session_id = resp.headers.get("mcp-session-id")
        if session_id:
            self._session_id = session_id

        if "text/event-stream" in content_type:
            return self._parse_sse_response(resp.text)
        else:
            return resp.json()

    def _parse_sse_response(self, text: str) -> dict:
        """Extract the last JSON-RPC result from an SSE stream."""
        last_data = None
        for line in text.splitlines():
            if line.startswith("data:"):
                raw = line[5:].strip()
                if raw and raw != "[DONE]":
                    try:
                        last_data = json.loads(raw)
                    except json.JSONDecodeError:
                        pass
        if last_data is None:
            raise Exception("No valid JSON found in SSE response")
        return last_data

    async def _initialize(self, client: httpx.AsyncClient) -> None:
        """Send MCP initialize handshake to establish a session.

        Called automatically on first request for servers that require it.
        """
        try:
            resp = await client.post(
                self.server_url,
                json={
                    "jsonrpc": "2.0",
                    "id": 0,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {"name": "clawith", "version": "1.0"},
                    },
                },
                headers=self._headers(),
            )
            if resp.status_code == 200:
                self._parse_response(resp)  # captures Mcp-Session-Id if present
        except Exception:
            pass  # initialization failure is non-fatal — server may be stateless

    async def list_tools(self) -> list[dict]:
        """Fetch available tools from the MCP server."""
        try:
            async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
                # Initialize session for servers that require it (e.g. Atlassian)
                await self._initialize(client)

                resp = await client.post(
                    self.server_url,
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/list",
                    },
                    headers=self._headers(),
                )
                data = self._parse_response(resp)

                if "error" in data:
                    err = data["error"]
                    msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
                    raise Exception(f"MCP error: {msg}")

                result = data.get("result", {})
                tools = result.get("tools", []) if isinstance(result, dict) else []
                return [
                    {
                        "name": t.get("name", ""),
                        "description": t.get("description", ""),
                        "inputSchema": t.get("inputSchema", {}),
                    }
                    for t in tools
                ]
        except httpx.HTTPError as e:
            raise Exception(f"Connection failed: {str(e)[:200]}")

    async def call_tool(self, tool_name: str, arguments: dict) -> str:
        """Execute a tool on the MCP server."""
        try:
            async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
                # Initialize session for servers that require it (e.g. Atlassian)
                if not self._session_id:
                    await self._initialize(client)

                resp = await client.post(
                    self.server_url,
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/call",
                        "params": {
                            "name": tool_name,
                            "arguments": arguments,
                        },
                    },
                    headers=self._headers(),
                )
                data = self._parse_response(resp)

                if "error" in data:
                    err = data["error"]
                    msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
                    return f"❌ MCP 工具执行错误: {msg[:200]}"

                result = data.get("result", {})
                if isinstance(result, str):
                    return result

                # MCP returns content as list of content blocks
                content_blocks = result.get("content", []) if isinstance(result, dict) else []
                texts = []
                for block in content_blocks:
                    if isinstance(block, str):
                        texts.append(block)
                    elif isinstance(block, dict):
                        if block.get("type") == "text":
                            texts.append(block.get("text", ""))
                        elif block.get("type") == "image":
                            texts.append(f"[图片: {block.get('mimeType', 'image')}]")
                        else:
                            texts.append(str(block))
                    else:
                        texts.append(str(block))

                return "\n".join(texts) if texts else str(result)

        except httpx.HTTPError as e:
            return f"❌ MCP 连接失败: {str(e)[:200]}"
