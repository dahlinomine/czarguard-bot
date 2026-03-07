"""Lightweight asyncio scheduler for agent cron jobs.

Runs as a background task inside the FastAPI process.
Every 30 seconds, checks for schedules whose next_run_at <= now
and executes them by calling the LLM with the schedule's instruction.
"""

import asyncio
import logging
import uuid
from datetime import datetime, timezone

from croniter import croniter
from sqlalchemy import select, update

logger = logging.getLogger(__name__)


def compute_next_run(cron_expr: str, after: datetime | None = None) -> datetime | None:
    """Compute the next run time from a cron expression."""
    try:
        base = after or datetime.now(timezone.utc)
        cron = croniter(cron_expr, base)
        return cron.get_next(datetime).replace(tzinfo=timezone.utc)
    except Exception as e:
        logger.error(f"Invalid cron expression '{cron_expr}': {e}")
        return None


async def _execute_schedule(schedule_id: uuid.UUID, agent_id: uuid.UUID, instruction: str):
    """Execute a single schedule by calling the LLM with the instruction."""
    try:
        from app.database import async_session
        from app.models.agent import Agent
        from app.models.llm import LLMModel

        async with async_session() as db:
            # Load agent + model
            result = await db.execute(select(Agent).where(Agent.id == agent_id))
            agent = result.scalar_one_or_none()
            if not agent:
                logger.warning(f"Schedule {schedule_id}: agent {agent_id} not found")
                return

            if agent.status != "running":
                logger.info(f"Schedule {schedule_id}: agent {agent.name} not running, skipping")
                return

            from app.core.permissions import is_agent_expired
            if is_agent_expired(agent):
                logger.info(f"Schedule {schedule_id}: agent {agent.name} has expired, skipping")
                return

            model_id = agent.primary_model_id or agent.fallback_model_id
            if not model_id:
                logger.warning(f"Schedule {schedule_id}: agent {agent.name} has no LLM model")
                return

            model_result = await db.execute(select(LLMModel).where(LLMModel.id == model_id))
            model = model_result.scalar_one_or_none()
            if not model:
                logger.warning(f"Schedule {schedule_id}: LLM model {model_id} not found")
                return

            # Build context and call LLM
            from app.services.agent_context import build_agent_context
            system_prompt = await build_agent_context(agent_id, agent.name, agent.role_description or "")

            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"[自动调度任务] {instruction}"},
            ]

            # Call LLM with tool loop (reuse websocket logic)
            import json as _json

            from app.services.llm_utils import get_provider_base_url, get_tool_params
            base_url = get_provider_base_url(model.provider, model.base_url)

            url = f"{base_url.rstrip('/')}/chat/completions"
            # Normalize: strip /chat/completions if already included in base_url
            if base_url.rstrip('/').endswith('/chat/completions'):
                url = base_url.rstrip('/')
            api_key = model.api_key_encrypted
            from app.services.agent_tools import execute_tool, get_agent_tools_for_llm

            # Load tools dynamically from DB (respects per-agent config and MCP tools)
            tools_for_llm = await get_agent_tools_for_llm(agent_id)

            # Tool-calling loop (max 50 rounds for scheduled tasks)
            for round_i in range(50):
                payload = {
                    "model": model.model,
                    "messages": messages,
                    "temperature": 0.7,
                    "max_tokens": 40960,
                    "tools": tools_for_llm if tools_for_llm else None,
                    **get_tool_params(model.provider),
                }
                if not payload.get("tools"):
                    payload.pop("tools", None)

                payload_str = _json.dumps(payload, ensure_ascii=False)
                proc = await asyncio.create_subprocess_exec(
                    "curl", "-s", "--max-time", "120",
                    "-X", "POST", url,
                    "-H", f"Authorization: Bearer {api_key}",
                    "-H", "Content-Type: application/json",
                    "-d", payload_str,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, _ = await proc.communicate()

                stdout_text = stdout.decode().strip() if stdout else ""
                if not stdout_text:
                    logger.warning(f"Schedule {schedule_id}: LLM returned empty response")
                    reply = "(LLM 返回空响应)"
                    break

                resp = _json.loads(stdout_text)
                if not isinstance(resp, dict):
                    logger.warning(f"Schedule {schedule_id}: LLM returned non-dict: {stdout_text[:200]}")
                    reply = f"(LLM 返回异常: {stdout_text[:100]})"
                    break

                choice = resp.get("choices", [{}])[0]
                msg = choice.get("message", {})
                finish_reason = choice.get("finish_reason", "stop")

                if finish_reason == "tool_calls" and msg.get("tool_calls"):
                    messages.append(msg)
                    for tc in msg["tool_calls"]:
                        fn = tc["function"]
                        try:
                            args = _json.loads(fn["arguments"])
                        except Exception:
                            args = {}
                        tool_result = await execute_tool(fn["name"], args, agent_id, agent.creator_id)
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tc["id"],
                            "content": str(tool_result),
                        })
                else:
                    reply = msg.get("content", "")
                    break
            else:
                reply = msg.get("content", "(已达到最大工具调用轮数)")

            # Log activity
            from app.services.activity_logger import log_activity
            await log_activity(
                agent_id, "schedule_run",
                f"定时任务执行: {instruction[:60]}",
                detail={"schedule_id": str(schedule_id), "instruction": instruction, "reply": reply[:500]},
            )

            logger.info(f"Schedule {schedule_id} executed for agent {agent.name}: {reply[:80]}")

    except Exception as e:
        logger.error(f"Schedule {schedule_id} execution error: {e}", exc_info=True)


async def _tick():
    """One scheduler tick: find and execute due schedules."""
    from app.database import async_session
    from app.models.schedule import AgentSchedule
    from app.services.audit_logger import write_audit_log

    now = datetime.now(timezone.utc)

    try:
        async with async_session() as db:
            result = await db.execute(
                select(AgentSchedule).where(
                    AgentSchedule.is_enabled == True,
                    AgentSchedule.next_run_at <= now,
                )
            )
            due_schedules = result.scalars().all()

            if due_schedules:
                await write_audit_log("schedule_tick", {"due_count": len(due_schedules)})

            for sched in due_schedules:
                # Update run tracking immediately
                next_run = compute_next_run(sched.cron_expr, now)
                sched.last_run_at = now
                sched.next_run_at = next_run
                sched.run_count = (sched.run_count or 0) + 1
                await db.commit()

                await write_audit_log(
                    "schedule_fire",
                    {"schedule_id": str(sched.id), "name": sched.name, "instruction": sched.instruction[:100], "next_run": str(next_run)},
                    agent_id=sched.agent_id,
                )

                # Fire execution in background (don't block ticker)
                asyncio.create_task(
                    _execute_schedule(sched.id, sched.agent_id, sched.instruction)
                )
                logger.info(f"Triggered schedule '{sched.name}' (next: {next_run})")

    except Exception as e:
        logger.error(f"Scheduler tick error: {e}", exc_info=True)
        await write_audit_log("schedule_error", {"error": str(e)[:300]})


async def start_scheduler():
    """Start the background scheduler loop. Call from FastAPI startup."""
    logger.info("🕐 Agent scheduler started (30s interval)")
    while True:
        await _tick()
        await asyncio.sleep(30)
