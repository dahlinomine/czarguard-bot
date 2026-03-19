"""WeCom (企业微信) Channel API routes.

Provides Config CRUD and webhook-based message handling with AES encryption.
"""

import base64
import hashlib
import struct
import uuid
import xml.etree.ElementTree as ET

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.permissions import check_agent_access, is_agent_creator
from app.core.security import get_current_user
from app.database import get_db
from app.models.channel_config import ChannelConfig
from app.models.user import User
from app.schemas.schemas import ChannelConfigOut

router = APIRouter(tags=["wecom"])
_processed_wecom_events = set()
_processed_kf_msgids = set()

# ─── WeCom AES Crypto ──────────────────────────────────

def _pad(text: bytes) -> bytes:
    BLOCK_SIZE = 32
    pad_len = BLOCK_SIZE - (len(text) % BLOCK_SIZE)
    return text + bytes([pad_len] * pad_len)

def _unpad(text: bytes) -> bytes:
    pad_len = text[-1]
    return text[:-pad_len]

def _decrypt_msg(encrypt_key: str, encrypted_text: str) -> tuple[str, str]:
    from Crypto.Cipher import AES
    aes_key = base64.b64decode(encrypt_key + "=")
    iv = aes_key[:16]
    cipher = AES.new(aes_key, AES.MODE_CBC, iv)
    decrypted = _unpad(cipher.decrypt(base64.b64decode(encrypted_text)))
    msg_len = struct.unpack("!I", decrypted[16:20])[0]
    msg_content = decrypted[20:20 + msg_len].decode("utf-8")
    corp_id = decrypted[20 + msg_len:].decode("utf-8")
    return msg_content, corp_id

def _encrypt_msg(encrypt_key: str, reply_msg: str, corp_id: str) -> str:
    from Crypto.Cipher import AES
    import os
    aes_key = base64.b64decode(encrypt_key + "=")
    iv = aes_key[:16]
    msg_bytes = reply_msg.encode("utf-8")
    buf = os.urandom(16) + struct.pack("!I", len(msg_bytes)) + msg_bytes + corp_id.encode("utf-8")
    cipher = AES.new(aes_key, AES.MODE_CBC, iv)
    encrypted = cipher.encrypt(_pad(buf))
    return base64.b64encode(encrypted).decode("utf-8")

def _verify_signature(token: str, timestamp: str, nonce: str, encrypt: str) -> str:
    items = sorted([token, timestamp, nonce, encrypt])
    return hashlib.sha1("".join(items).encode("utf-8")).hexdigest()

# ─── Config CRUD ────────────────────────────────────────

@router.post("/agents/{agent_id}/wecom-channel", response_model=ChannelConfigOut, status_code=status.HTTP_201_CREATED)
async def configure_wecom_channel(
    agent_id: uuid.UUID,
    data: dict,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    agent, _ = await check_agent_access(db, current_user, agent_id)
    if not is_agent_creator(current_user, agent):
        raise HTTPException(status_code=403, detail="Only creator can configure channel")

    bot_id = data.get("bot_id", "").strip()
    bot_secret = data.get("bot_secret", "").strip()
    corp_id = data.get("corp_id", "").strip()
    secret = data.get("secret", "").strip()
    token = data.get("token", "").strip()
    aes_key = data.get("encoding_aes_key", "").strip()
    wecom_agent_id = data.get("wecom_agent_id", "").strip()

    r = await db.execute(select(ChannelConfig).where(ChannelConfig.agent_id == agent_id, ChannelConfig.channel_type == "wecom"))
    config = r.scalar_one_or_none()

    if not config:
        config = ChannelConfig(agent_id=agent_id, channel_type="wecom", tenant_id=agent.tenant_id)
        db.add(config)

    config.app_id = corp_id or bot_id
    config.app_secret = secret or bot_secret
    config.verification_token = token
    config.encrypt_key = aes_key
    config.extra_config = {"wecom_agent_id": wecom_agent_id}

    await db.commit()
    await db.refresh(config)
    return config

@router.get("/agents/{agent_id}/wecom-channel", response_model=ChannelConfigOut)
async def get_wecom_channel(
    agent_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_agent_access(db, current_user, agent_id)
    r = await db.execute(select(ChannelConfig).where(ChannelConfig.agent_id == agent_id, ChannelConfig.channel_type == "wecom"))
    config = r.scalar_one_or_none()
    if not config:
        raise HTTPException(status_code=404, detail="WeCom channel not configured")
    return config

@router.delete("/agents/{agent_id}/wecom-channel")
async def delete_wecom_channel(
    agent_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_agent_access(db, current_user, agent_id)
    r = await db.execute(select(ChannelConfig).where(ChannelConfig.agent_id == agent_id, ChannelConfig.channel_type == "wecom"))
    config = r.scalar_one_or_none()
    if config:
        await db.delete(config)
        await db.commit()
    return {"status": "deleted"}

# ─── Webhook Handler ────────────────────────────────────

@router.get("/channel/wecom/{agent_id}/webhook")
async def wecom_verify_webhook(
    agent_id: uuid.UUID,
    msg_signature: str,
    timestamp: str,
    nonce: str,
    echostr: str,
    db: AsyncSession = Depends(get_db),
):
    r = await db.execute(select(ChannelConfig).where(ChannelConfig.agent_id == agent_id, ChannelConfig.channel_type == "wecom"))
    config = r.scalar_one_or_none()
    if not config: raise HTTPException(status_code=404)
    if _verify_signature(config.verification_token, timestamp, nonce, echostr) != msg_signature:
        raise HTTPException(status_code=403)
    decrypted_xml, _ = _decrypt_msg(config.encrypt_key, echostr)
    return Response(content=decrypted_xml, media_type="text/plain")

@router.post("/channel/wecom/{agent_id}/webhook")
async def wecom_event_webhook(
    agent_id: uuid.UUID,
    msg_signature: str,
    timestamp: str,
    nonce: str,
    request: Request,
    db_session: AsyncSession = Depends(get_db),
):
    r = await db_session.execute(select(ChannelConfig).where(ChannelConfig.agent_id == agent_id, ChannelConfig.channel_type == "wecom"))
    config = r.scalar_one_or_none()
    if not config: return Response(content="success", media_type="text/plain")

    body = await request.body()
    try:
        root = ET.fromstring(body)
        encrypt_text = root.findtext("Encrypt", "")
    except: return Response(content="success", media_type="text/plain")

    if _verify_signature(config.verification_token, timestamp, nonce, encrypt_text) != msg_signature:
        return Response(content="success", media_type="text/plain")

    decrypted_xml, _ = _decrypt_msg(config.encrypt_key, encrypt_text)
    try:
        msg_root = ET.fromstring(decrypted_xml)
    except: return Response(content="success", media_type="text/plain")

    msg_type = msg_root.findtext("MsgType", "")
    from_user = msg_root.findtext("FromUserName", "")
    msg_id = msg_root.findtext("MsgId", "")
    open_kfid = msg_root.findtext("OpenKfId", "")
    token = msg_root.findtext("Token", "")

    dedup_key = msg_id if msg_id else token
    if dedup_key and dedup_key in _processed_wecom_events: 
        return Response(content="success", media_type="text/plain")
    if dedup_key:
        _processed_wecom_events.add(dedup_key)
        if len(_processed_wecom_events) > 1000: _processed_wecom_events.clear()

    print(f"[WeCom] Webhook received: type={msg_type}, from={from_user}, msgid={msg_id}, open_kfid={open_kfid}, token={token[:10]}...", flush=True)

    import asyncio
    if msg_type == "text":
        user_text = msg_root.findtext("Content", "").strip()
        if user_text:
            asyncio.create_task(_process_wecom_text(agent_id, config, from_user, user_text))
    elif msg_type == "event":
        if msg_root.findtext("Event", "") == "kf_msg_or_event":
            asyncio.create_task(_process_wecom_kf_event(agent_id, config, token, open_kfid))

    return Response(content="success", media_type="text/plain")

async def _process_wecom_kf_event(agent_id: uuid.UUID, config_obj: ChannelConfig, token: str, open_kfid: str = None):
    import httpx, time
    from app.database import async_session
    from sqlalchemy import select as _select
    from app.models.channel_config import ChannelConfig as ChannelConfigModel
    
    try:
        async with async_session() as session:
            r = await session.execute(_select(ChannelConfigModel).where(ChannelConfigModel.agent_id == agent_id, ChannelConfigModel.channel_type == "wecom"))
            config = r.scalar_one_or_none()
            if not config: return

            async with httpx.AsyncClient(timeout=10) as client:
                tok_resp = await client.get("https://qyapi.weixin.qq.com/cgi-bin/gettoken", params={"corpid": config.app_id, "corpsecret": config.app_secret})
                token_data = tok_resp.json()
                access_token = token_data.get("access_token")
                if not access_token: return

                current_cursor = token
                has_more = 1
                current_ts = int(time.time())

                while has_more:
                    payload = {"limit": 20}
                    if open_kfid:
                        payload["open_kfid"] = open_kfid

                    if current_cursor.startswith("ENC"):
                        payload["token"] = current_cursor
                    else:
                        payload["cursor"] = current_cursor
                    
                    print(f"[WeCom KF] Calling sync_msg with payload: {payload}", flush=True)
                    sync_resp = await client.post(f"https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg?access_token={access_token}", json=payload)
                    sync_data = sync_resp.json()
                    if sync_data.get("errcode") != 0:
                        print(f"[WeCom KF] sync_msg error: {sync_data}", flush=True)
                        break
                    
                    has_more = sync_data.get("has_more", 0)
                    current_cursor = sync_data.get("next_cursor", "")
                    
                    for msg in sync_data.get("msg_list", []):
                        if msg.get("origin") == 3 and msg.get("msgtype") == "text":
                            mid = msg.get("msgid")
                            if mid in _processed_kf_msgids: continue
                            if msg.get("send_time", 0) > 0 and (current_ts - msg.get("send_time", 0) > 86400): continue
                            _processed_kf_msgids.add(mid)
                            text = msg.get("text", {}).get("content", "").strip()
                            if text:
                                print(f"[WeCom KF] Found msg from {msg.get('external_userid')}: {text[:20]}...", flush=True)
                                await _process_wecom_text(agent_id, config, msg.get("external_userid"), text, is_kf=True, open_kfid=msg.get("open_kfid"), kf_msg_id=mid)
                    if not has_more: break
    except Exception as e: 
        print(f"[WeCom KF] Error in background task: {e}", flush=True)
        import traceback
        traceback.print_exc()

async def _process_wecom_text(agent_id: uuid.UUID, config: ChannelConfig, from_user: str, user_text: str, is_kf: bool = False, open_kfid: str = None, kf_msg_id: str = None):
    import httpx
    from datetime import datetime, timezone
    from sqlalchemy import select as _select
    from app.database import async_session
    from app.models.agent import Agent as AgentModel
    from app.models.audit import ChatMessage
    from app.models.user import User as UserModel
    from app.core.security import hash_password
    from app.services.channel_session import find_or_create_channel_session
    from app.api.feishu import _call_agent_llm

    async with async_session() as db:
        agent_r = await db.execute(_select(AgentModel).where(AgentModel.id == agent_id))
        agent_obj = agent_r.scalar_one_or_none()
        if not agent_obj: return
        
        wc_username = f"wecom_{from_user}"
        u_r = await db.execute(_select(UserModel).where(UserModel.username == wc_username))
        platform_user = u_r.scalar_one_or_none()
        if not platform_user:
            platform_user = UserModel(username=wc_username, email=f"{wc_username}@wecom.local", password_hash=hash_password(str(uuid.uuid4())), display_name=f"WeCom User", role="member", tenant_id=agent_obj.tenant_id)
            db.add(platform_user)
            await db.flush()

        sess = await find_or_create_channel_session(db=db, agent_id=agent_id, user_id=platform_user.id, external_conv_id=f"wecom_p2p_{from_user}", source_channel="wecom", first_message_title=user_text[:50])
        db.add(ChatMessage(agent_id=agent_id, user_id=platform_user.id, role="user", content=user_text, conversation_id=str(sess.id)))
        await db.commit()

        print(f"[WeCom] Start calling LLM...", flush=True)
        reply_text = await _call_agent_llm(db, agent_id, user_text, history=[], user_id=platform_user.id)
        print(f"[WeCom] LLM finished! Start sending reply...", flush=True)
        
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                tok_resp = await client.get("https://qyapi.weixin.qq.com/cgi-bin/gettoken", params={"corpid": config.app_id, "corpsecret": config.app_secret})
                access_token = tok_resp.json().get("access_token")
                if access_token:
                    if is_kf and open_kfid:
                        res_state = await client.post(f"https://qyapi.weixin.qq.com/cgi-bin/kf/service_state/trans?access_token={access_token}", json={"open_kfid": open_kfid, "external_userid": from_user, "service_state": 1})
                        print(f"[WeCom KF] trans state result: {res_state.json()}", flush=True)
                        res_send = await client.post(f"https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg?access_token={access_token}", json={"touser": from_user, "open_kfid": open_kfid, "msgtype": "text", "text": {"content": reply_text}})
                        print(f"[WeCom KF] send_msg result: {res_send.json()}", flush=True)
                    else:
                        wecom_agent_id = (config.extra_config or {}).get("wecom_agent_id")
                        res = await client.post(f"https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token={access_token}", json={"touser": from_user, "msgtype": "text", "agentid": int(wecom_agent_id) if wecom_agent_id else 0, "text": {"content": reply_text}})
                        print(f"[WeCom] send message/send: {res.json()}", flush=True)
        except Exception as e:
            print(f"[WeCom KF] Error sending reply to user: {e}", flush=True)

        db.add(ChatMessage(agent_id=agent_id, user_id=platform_user.id, role="assistant", content=reply_text, conversation_id=str(sess.id)))
        await db.commit()
