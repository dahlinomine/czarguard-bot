"""
czar_llm_seed.py — Pre-seed ChatAnywhere LLM model pool on startup.
Reads CZAR_LLM_* env vars so Railway users do not need to configure LLM manually.
"""
import asyncio, os, sys
sys.path.insert(0, ".")

from app.database import async_session
from app.models.llm import LLMModel
from app.models.tenant import Tenant
from sqlalchemy import select


async def seed_llm():
    api_key = os.environ.get("CZAR_LLM_API_KEY", "")
    base_url = os.environ.get("CZAR_LLM_BASE_URL", "https://api.chatanywhere.tech/v1")
    fast_model = os.environ.get("CZAR_LLM_FAST_MODEL", "gpt-4o-mini-ca")
    reason_model = os.environ.get("CZAR_LLM_REASON_MODEL", "deepseek-v3")
    deep_model = os.environ.get("CZAR_LLM_DEEP_MODEL", "deepseek-r1-0528")

    if not api_key or api_key.startswith("sk-your"):
        print("[LLM Seed] CZAR_LLM_API_KEY not set — skipping LLM pre-seed")
        return

    async with async_session() as db:
        # Get default tenant
        tenant_result = await db.execute(select(Tenant).where(Tenant.slug == "default"))
        tenant = tenant_result.scalar_one_or_none()
        tenant_id = tenant.id if tenant else None

        models_to_seed = [
            {"model": fast_model, "label": f"ChatAnywhere Fast ({fast_model})",
             "max_output_tokens": 4096},
            {"model": reason_model, "label": f"ChatAnywhere Reasoning ({reason_model})",
             "max_output_tokens": 4096},
            {"model": deep_model, "label": f"ChatAnywhere Deep ({deep_model})",
             "max_output_tokens": 8192},
        ]

        seeded = 0
        for m in models_to_seed:
            existing = await db.execute(
                select(LLMModel).where(LLMModel.model == m["model"])
            )
            if existing.scalar_one_or_none():
                continue

            # api_key_encrypted stores key plaintext for now (enterprise.py same pattern)
            db.add(LLMModel(
                tenant_id=tenant_id,
                provider="openai",
                model=m["model"],
                api_key_encrypted=api_key,
                base_url=base_url,
                label=m["label"],
                enabled=True,
                max_output_tokens=m["max_output_tokens"],
            ))
            seeded += 1

        if seeded:
            await db.commit()
            print(f"[LLM Seed] Pre-seeded {seeded} ChatAnywhere models")
        else:
            print("[LLM Seed] LLM models already present")


if __name__ == "__main__":
    asyncio.run(seed_llm())

