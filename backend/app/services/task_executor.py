"""Background task executor — runs LLM to complete tasks automatically.

Uses the same agent context (soul, memory, skills, relationships, tools)
as the chat dialog. Supports tool-calling loop for autonomous execution.
"""

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select

from app.database import async_session
from app.models.agent import Agent
from app.models.llm import LLMModel
from app.models.task import Task, TaskLog

logger = logging.getLogger(__name__)


async def execute_task(task_id: uuid.UUID, agent_id: uuid.UUID) -> None:
    """Execute a task using the agent's configured LLM with full context.

    Uses the same context as chat dialog: build_agent_context for system prompt,
    agent tools for tool-calling, and a multi-round tool loop.

    Flow:
      - todo tasks: pending → doing → done
      - supervision tasks: pending → doing → pending (stays active, just logs result)
    """
    print(f"[TaskExec] Starting task {task_id} for agent {agent_id}")

    # Step 1: Mark as doing
    async with async_session() as db:
        result = await db.execute(select(Task).where(Task.id == task_id))
        task = result.scalar_one_or_none()
        if not task:
            print(f"[TaskExec] Task {task_id} not found")
            return

        task.status = "doing"
        db.add(TaskLog(task_id=task_id, content="🤖 开始执行任务..."))
        await db.commit()
        task_title = task.title
        task_description = task.description or ""
        task_type = task.type  # 'todo' or 'supervision'
        supervision_target = task.supervision_target_name or ""

    # Step 2: Load agent + model
    async with async_session() as db:
        agent_result = await db.execute(select(Agent).where(Agent.id == agent_id))
        agent = agent_result.scalar_one_or_none()
        if not agent:
            await _log_error(task_id, "数字员工未找到")
            if task_type == 'supervision':
                await _restore_supervision_status(task_id)
            return

        model_id = agent.primary_model_id or agent.fallback_model_id
        if not model_id:
            await _log_error(task_id, f"{agent.name} 未配置 LLM 模型，无法执行任务")
            if task_type == 'supervision':
                await _restore_supervision_status(task_id)
            return

        model_result = await db.execute(
            select(LLMModel).where(LLMModel.id == model_id)
        )
        model = model_result.scalar_one_or_none()
        if not model:
            await _log_error(task_id, "配置的模型不存在")
            if task_type == 'supervision':
                await _restore_supervision_status(task_id)
            return

        agent_name = agent.name
        creator_id = agent.creator_id

    # Step 3: Build full agent context (same as chat dialog)
    from app.services.agent_context import build_agent_context
    system_prompt = await build_agent_context(agent_id, agent_name, agent.role_description or "")

    # Add task-execution-specific instructions
    task_addendum = """

## Task Execution Mode

You are now in TASK EXECUTION MODE (not a conversation). A task has been assigned to you.
- Focus on completing the task as thoroughly as possible.
- Break down complex tasks into steps and execute each step.
- Use your tools actively to gather information, send messages, read/write files, etc.
- Provide a detailed execution report at the end.
- If the task involves contacting someone, use `send_feishu_message` to reach them.
- If the task requires data or information, use your tools to fetch it.
- Do NOT ask the user follow-up questions — take initiative and complete the task autonomously.
"""
    system_prompt += task_addendum

    # Build user prompt
    if task_type == 'supervision':
        user_prompt = f"[督办任务] {task_title}"
        if task_description:
            user_prompt += f"\n任务描述: {task_description}"
        if supervision_target:
            user_prompt += f"\n督办对象: {supervision_target}"
        user_prompt += "\n\n请执行此督办任务：联系督办对象，了解进展，并汇报结果。"
    else:
        user_prompt = f"[任务执行] {task_title}"
        if task_description:
            user_prompt += f"\n任务描述: {task_description}"
        user_prompt += "\n\n请认真完成此任务，给出详细的执行结果。"

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    # Step 4: Call LLM with tool loop
    from app.services.llm_utils import get_provider_base_url, get_tool_params
    base_url = get_provider_base_url(model.provider, model.base_url)

    if not base_url:
        await _log_error(task_id, f"未配置 {model.provider} 的 API 地址")
        if task_type == 'supervision':
            await _restore_supervision_status(task_id)
        return

    # Normalize: strip /chat/completions if user accidentally included the full endpoint
    if base_url.rstrip('/').endswith('/chat/completions'):
        base_url = base_url.rstrip('/').rsplit('/chat/completions', 1)[0]
    url = f"{base_url.rstrip('/')}/chat/completions"
    api_key = model.api_key_encrypted

    # Load tools (same as chat dialog)
    from app.services.agent_tools import execute_tool, get_agent_tools_for_llm
    tools_for_llm = await get_agent_tools_for_llm(agent_id)

    try:
        print(f"[TaskExec] Calling LLM with tools for task: {task_title}")
        reply = ""

        # Tool-calling loop (max 50 rounds for task execution)
        for round_i in range(50):
            payload = {
                "model": model.model,
                "messages": messages,
                "temperature": 0.7,
                "max_tokens": 40960,
                "tools": tools_for_llm if tools_for_llm else None,
                **get_tool_params(model.provider),
            }
            # Remove None tools key
            if not payload.get("tools"):
                payload.pop("tools", None)

            payload_str = json.dumps(payload, ensure_ascii=False)
            proc = await asyncio.create_subprocess_exec(
                "curl", "-s", "--max-time", "1200",
                "-X", "POST", url,
                "-H", "Content-Type: application/json",
                "-H", f"Authorization: Bearer {api_key}",
                "-d", payload_str,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await proc.communicate()

            if proc.returncode != 0:
                stderr_msg = stderr.decode().strip()[:200] if stderr else ''
                await _log_error(task_id, f"调用模型失败 (curl exit {proc.returncode}) {stderr_msg}")
                if task_type == 'supervision':
                    await _restore_supervision_status(task_id)
                return

            stdout_text = stdout.decode().strip()
            if not stdout_text:
                await _log_error(task_id, "LLM 返回空响应（可能网络超时或服务不可用）")
                if task_type == 'supervision':
                    await _restore_supervision_status(task_id)
                return

            data = json.loads(stdout_text)
            if not isinstance(data, dict):
                await _log_error(task_id, f"LLM 返回非预期格式: {stdout_text[:300]}")
                if task_type == 'supervision':
                    await _restore_supervision_status(task_id)
                return
            if "error" in data:
                err_msg = data['error'].get('message', str(data['error']))[:200] if isinstance(data['error'], dict) else str(data['error'])[:200]
                await _log_error(task_id, f"LLM 错误: {err_msg}")
                if task_type == 'supervision':
                    await _restore_supervision_status(task_id)
                return

            choices = data.get("choices")
            if not choices or not isinstance(choices, list):
                await _log_error(task_id, f"LLM 响应格式异常: {stdout_text[:300]}")
                if task_type == 'supervision':
                    await _restore_supervision_status(task_id)
                return

            choice = choices[0]
            msg = choice.get("message", {})
            finish_reason = choice.get("finish_reason", "stop")

            # Handle tool calls
            if finish_reason == "tool_calls" and msg.get("tool_calls"):
                messages.append(msg)
                for tc in msg["tool_calls"]:
                    fn = tc["function"]
                    try:
                        args = json.loads(fn["arguments"])
                    except Exception:
                        args = {}

                    print(f"[TaskExec] Round {round_i+1} calling tool: {fn['name']}({json.dumps(args, ensure_ascii=False)[:100]})")
                    tool_result = await execute_tool(fn["name"], args, agent_id, creator_id)
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": str(tool_result),
                    })
                continue  # Next round
            else:
                reply = msg.get("content", "")
                break
        else:
            reply = msg.get("content", "(已达到最大工具调用轮数)")

        print(f"[TaskExec] LLM reply: {reply[:80]}")
    except Exception as e:
        error_msg = str(e) or repr(e)
        print(f"[TaskExec] Error: {error_msg}")
        await _log_error(task_id, f"执行出错: {error_msg[:150]}")
        if task_type == 'supervision':
            await _restore_supervision_status(task_id)
        return

    # Step 5: Save result and update status
    async with async_session() as db:
        result = await db.execute(select(Task).where(Task.id == task_id))
        task = result.scalar_one_or_none()
        if task:
            if task_type == 'supervision':
                # Supervision tasks stay active; just log the result
                task.status = "pending"
                db.add(TaskLog(task_id=task_id, content=f"✅ 督办执行完成\n\n{reply}"))
            else:
                task.status = "done"
                task.completed_at = datetime.now(timezone.utc)
                db.add(TaskLog(task_id=task_id, content=f"✅ 任务完成\n\n{reply}"))
            await db.commit()
            print(f"[TaskExec] Task {task_id} {'logged' if task_type == 'supervision' else 'completed'}!")

    # Log activity
    from app.services.activity_logger import log_activity
    await log_activity(
        agent_id, "task_updated",
        f"{'督办' if task_type == 'supervision' else '任务'}执行: {task_title[:60]}",
        detail={"task_id": str(task_id), "task_type": task_type, "title": task_title, "reply": reply[:500]},
        related_id=task_id,
    )


async def _log_error(task_id: uuid.UUID, message: str) -> None:
    """Add an error log to the task."""
    print(f"[TaskExec] Error for {task_id}: {message}")
    async with async_session() as db:
        db.add(TaskLog(task_id=task_id, content=f"❌ {message}"))
        await db.commit()


async def _restore_supervision_status(task_id: uuid.UUID) -> None:
    """Restore supervision task status back to pending after a failed execution."""
    async with async_session() as db:
        result = await db.execute(select(Task).where(Task.id == task_id))
        task = result.scalar_one_or_none()
        if task and task.status == "doing":
            task.status = "pending"
            await db.commit()
