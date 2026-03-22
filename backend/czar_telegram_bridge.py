"""
czar_telegram_bridge.py — Telegram ↔ CZAR Agent Bridge
Routes Telegram messages to the correct CZAR agent via WebSocket.
Run as: python czar_telegram_bridge.py
"""
import asyncio
import httpx
import json
import logging
import os
import re
import websockets
import websockets.exceptions
from datetime import datetime, timezone

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CZAR_BASE_URL = os.environ.get("CZAR_BASE_URL", "https://czarguard-bot-production.up.railway.app")
CZAR_WS_URL = CZAR_BASE_URL.replace("https://", "wss://").replace("http://", "ws://")
CZAR_EMAIL = os.environ.get("CZAR_ADMIN_EMAIL", "alhassan.mohammed.erc3643@gmail.com")
CZAR_PASSWORD = os.environ.get("CZAR_ADMIN_PASSWORD", "")

AGENT_MAP = {
    "scout": os.environ.get("CZAR_SCOUT_ID", "4ac5f641-dc54-43d6-8852-da604aff8c66"),
    "intel": os.environ.get("CZAR_INTEL_ID", "067b4853-af0e-42ca-9cc2-966adaa3691e"),
    "closer": os.environ.get("CZAR_CLOSER_ID", "153d4ba5-a658-43e7-bbee-c72e54d7fbe0"),
    "author": os.environ.get("CZAR_AUTHOR_ID", "b574d901-4c3d-499e-b8ad-02dac0453d33"),
    "counsel": os.environ.get("CZAR_COUNSEL_ID", "8ad84cba-73a2-4de0-a396-ef40999d69f7"),
}

# Default agent (for plain messages without a command)
DEFAULT_AGENT = "scout"

HELP_TEXT = """🦅 *CZAR Operator Fleet*

*Commands:*
`/scout <query>` — Bounty & grant radar
`/intel <query>` — Competitive intelligence
`/closer <query>` — BD & outreach ops
`/author <query>` — Draft reports, proposals, posts
`/counsel <query>` — Legal intelligence & compliance

Plain messages → CZAR-SCOUT

*/brief* — Morning brief from all agents
*/status* — Fleet health check
*/help* — This message"""

# ── Auth ──────────────────────────────────────────────────────────────────────

_jwt_token: str = ""
_token_expires: float = 0.0


async def get_jwt_token() -> str:
    global _jwt_token, _token_expires
    now = datetime.now(timezone.utc).timestamp()
    if _jwt_token and _token_expires > now + 300:
        return _jwt_token

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{CZAR_BASE_URL}/api/auth/login",
            json={"username": CZAR_EMAIL, "password": CZAR_PASSWORD},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        _jwt_token = data["access_token"]
        # JWT expires in ~7 days, refresh every 6h to be safe
        _token_expires = now + 6 * 3600
        log.info("[Auth] JWT refreshed")
        return _jwt_token


# ── Telegram helpers ──────────────────────────────────────────────────────────

async def tg_send(chat_id: int, text: str, parse_mode: str = "Markdown"):
    async with httpx.AsyncClient() as client:
        await client.post(
            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": parse_mode},
            timeout=15,
        )


async def tg_send_typing(chat_id: int):
    async with httpx.AsyncClient() as client:
        await client.post(
            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendChatAction",
            json={"chat_id": chat_id, "action": "typing"},
            timeout=5,
        )


# ── Agent chat via WebSocket ──────────────────────────────────────────────────

async def chat_with_agent(agent_id: str, message: str, session_id: str) -> str:
    token = await get_jwt_token()
    ws_url = f"{CZAR_WS_URL}/ws/chat/{agent_id}?token={token}&session_id={session_id}"

    collected: list[str] = []
    timeout = 90.0

    try:
        async with websockets.connect(ws_url, ping_interval=20, ping_timeout=30) as ws:
            # Send the message
            await ws.send(json.dumps({"content": message}))

            # Collect streaming response
            deadline = asyncio.get_event_loop().time() + timeout
            async for raw in ws:
                remaining = deadline - asyncio.get_event_loop().time()
                if remaining <= 0:
                    log.warning("[WS] Response timeout")
                    break
                try:
                    data = json.loads(raw)
                except Exception:
                    continue

                msg_type = data.get("type", "")
                if msg_type == "chunk":
                    collected.append(data.get("content", ""))
                elif msg_type == "done":
                    if data.get("content"):
                        collected.append(data["content"])
                    break
                elif msg_type == "error":
                    return f"⚠️ Agent error: {data.get('content', 'unknown')}"

    except websockets.exceptions.WebSocketException as e:
        log.error(f"[WS] Error: {e}")
        return "⚠️ Could not connect to CZAR agent. Try again in a moment."

    return "".join(collected).strip() or "⚠️ No response received."


# ── Status check ─────────────────────────────────────────────────────────────

async def get_fleet_status() -> str:
    token = await get_jwt_token()
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{CZAR_BASE_URL}/api/agents/",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
        )
        agents = resp.json()
        if not isinstance(agents, list):
            agents = agents.get("items", [])

    lines = ["🦅 *CZAR Fleet Status*\n"]
    name_to_icon = {
        "CZAR-SCOUT": "🔭",
        "CZAR-INTEL": "🕵️",
        "CZAR-CLOSER": "🤝",
        "CZAR-AUTHOR": "✍️",
        "CZAR-COUNSEL": "⚖️",
    }
    for a in agents:
        name = a.get("name", "?")
        status = a.get("status", "?")
        icon = name_to_icon.get(name, "🤖")
        emoji = "🟢" if status == "running" else "🟡"
        lines.append(f"{emoji} {icon} *{name}* — {status}")

    return "\n".join(lines)


# ── Message router ────────────────────────────────────────────────────────────

async def route_message(chat_id: int, text: str, user_id: int):
    text = text.strip()
    session_id = f"tg_{user_id}"

    # Commands
    if text in ("/help", "/start"):
        await tg_send(chat_id, HELP_TEXT)
        return

    if text == "/status":
        await tg_send_typing(chat_id)
        status = await get_fleet_status()
        await tg_send(chat_id, status)
        return

    if text == "/brief":
        await tg_send_typing(chat_id)
        brief = await chat_with_agent(
            AGENT_MAP["scout"],
            "Give me a morning brief: top 3 opportunities you're tracking right now with payout estimates and next action.",
            f"tg_{user_id}_brief",
        )
        await tg_send(chat_id, f"🔭 *CZAR-SCOUT Brief*\n\n{brief}")
        return

    # Slash-routed agents: /scout, /intel, /closer, /author, /counsel
    match = re.match(r"^/(\w+)\s*(.*)", text, re.DOTALL)
    if match:
        cmd = match.group(1).lower()
        query = match.group(2).strip()
        if cmd in AGENT_MAP and query:
            await tg_send_typing(chat_id)
            agent_id = AGENT_MAP[cmd]
            response = await chat_with_agent(agent_id, query, session_id)
            icons = {"scout": "🔭", "intel": "🕵️", "closer": "🤝", "author": "✍️", "counsel": "⚖️"}
            header = f"{icons.get(cmd, '🤖')} *CZAR-{cmd.upper()}*\n\n"
            # Telegram max 4096 chars per message
            full = header + response
            for chunk in [full[i:i+4000] for i in range(0, len(full), 4000)]:
                await tg_send(chat_id, chunk)
            return

    # Default: route to SCOUT
    await tg_send_typing(chat_id)
    response = await chat_with_agent(AGENT_MAP[DEFAULT_AGENT], text, session_id)
    for chunk in [response[i:i+4000] for i in range(0, len(response), 4000)]:
        await tg_send(chat_id, chunk)


# ── Main poll loop ────────────────────────────────────────────────────────────

async def run_bridge():
    log.info("[Bridge] CZAR Telegram Bridge starting...")
    offset = 0
    backoff = 1

    async with httpx.AsyncClient(timeout=35) as client:
        while True:
            try:
                resp = await client.get(
                    f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/getUpdates",
                    params={"offset": offset, "timeout": 30, "allowed_updates": ["message"]},
                )
                data = resp.json()
                if not data.get("ok"):
                    log.warning(f"[Telegram] getUpdates error: {data}")
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 60)
                    continue

                backoff = 1
                updates = data.get("result", [])
                for update in updates:
                    offset = update["update_id"] + 1
                    msg = update.get("message", {})
                    text = msg.get("text", "").strip()
                    chat_id = msg.get("chat", {}).get("id")
                    user_id = msg.get("from", {}).get("id", chat_id)
                    if text and chat_id:
                        asyncio.create_task(route_message(chat_id, text, user_id))

            except httpx.TimeoutException:
                pass  # Long poll timeout is normal
            except Exception as e:
                log.error(f"[Bridge] Loop error: {e}")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)


if __name__ == "__main__":
    asyncio.run(run_bridge())
