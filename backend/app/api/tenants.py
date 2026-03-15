"""Tenant (Company) management API — platform_admin only."""

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user, require_role
from app.database import get_db
from app.models.tenant import Tenant
from app.models.user import User

router = APIRouter(prefix="/tenants", tags=["tenants"])


class TenantCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    slug: str = Field(min_length=2, max_length=50, pattern=r"^[a-z0-9_-]+$")
    im_provider: str = "web_only"


class TenantOut(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    im_provider: str
    timezone: str = "UTC"
    is_active: bool
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


class TenantUpdate(BaseModel):
    name: str | None = None
    im_provider: str | None = None
    timezone: str | None = None
    is_active: bool | None = None


@router.get("/", response_model=list[TenantOut])
async def list_tenants(
    current_user: User = Depends(require_role("platform_admin")),
    db: AsyncSession = Depends(get_db),
):
    """List all tenants (platform_admin only)."""
    result = await db.execute(select(Tenant).order_by(Tenant.created_at.desc()))
    return [TenantOut.model_validate(t) for t in result.scalars().all()]


@router.post("/", response_model=TenantOut, status_code=status.HTTP_201_CREATED)
async def create_tenant(
    data: TenantCreate,
    current_user: User = Depends(require_role("platform_admin")),
    db: AsyncSession = Depends(get_db),
):
    """Create a new tenant/company (platform_admin only)."""
    # Check slug uniqueness
    existing = await db.execute(select(Tenant).where(Tenant.slug == data.slug))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Slug '{data.slug}' already exists")

    tenant = Tenant(name=data.name, slug=data.slug, im_provider=data.im_provider)
    db.add(tenant)
    await db.flush()
    return TenantOut.model_validate(tenant)


@router.get("/{tenant_id}", response_model=TenantOut)
async def get_tenant(
    tenant_id: uuid.UUID,
    current_user: User = Depends(require_role("platform_admin")),
    db: AsyncSession = Depends(get_db),
):
    """Get tenant details."""
    result = await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    tenant = result.scalar_one_or_none()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return TenantOut.model_validate(tenant)


@router.put("/{tenant_id}", response_model=TenantOut)
async def update_tenant(
    tenant_id: uuid.UUID,
    data: TenantUpdate,
    current_user: User = Depends(require_role("platform_admin")),
    db: AsyncSession = Depends(get_db),
):
    """Update tenant settings."""
    result = await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    tenant = result.scalar_one_or_none()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(tenant, field, value)
    await db.flush()
    return TenantOut.model_validate(tenant)


@router.put("/{tenant_id}/assign-user/{user_id}")
async def assign_user_to_tenant(
    tenant_id: uuid.UUID,
    user_id: uuid.UUID,
    role: str = "member",
    current_user: User = Depends(require_role("platform_admin")),
    db: AsyncSession = Depends(get_db),
):
    """Assign a user to a tenant with a specific role."""
    # Verify tenant
    t_result = await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    if not t_result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Tenant not found")

    # Verify user
    u_result = await db.execute(select(User).where(User.id == user_id))
    user = u_result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if role not in ("org_admin", "agent_admin", "member"):
        raise HTTPException(status_code=400, detail="Invalid role")

    user.tenant_id = tenant_id
    user.role = role
    await db.flush()
    return {"status": "ok", "user_id": str(user_id), "tenant_id": str(tenant_id), "role": role}


@router.delete("/{tenant_id}")
async def delete_tenant(
    tenant_id: uuid.UUID,
    current_user: User = Depends(require_role("platform_admin")),
    db: AsyncSession = Depends(get_db),
):
    """Delete a tenant and all its associated data (platform_admin only)."""
    from app.models.agent import Agent
    from app.models.audit import AuditLog, ApprovalRequest
    from app.models.llm import LLMModel
    from app.models.tool import Tool
    from app.models.skill import Skill
    from sqlalchemy import delete as sql_delete

    result = await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    tenant = result.scalar_one_or_none()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    # Prevent deleting the last tenant
    count_r = await db.execute(select(Tenant.id))
    if len(count_r.all()) <= 1:
        raise HTTPException(status_code=400, detail="Cannot delete the last tenant")

    # Find a fallback tenant for reassigning users
    fallback_r = await db.execute(
        select(Tenant).where(Tenant.id != tenant_id).order_by(Tenant.created_at.asc()).limit(1)
    )
    fallback_tenant = fallback_r.scalar_one()

    # Delete agents belonging to this tenant
    agent_ids_q = select(Agent.id).where(Agent.tenant_id == tenant_id)
    # Delete approval requests for these agents
    await db.execute(sql_delete(ApprovalRequest).where(ApprovalRequest.agent_id.in_(agent_ids_q)))
    # Delete audit logs for these agents
    await db.execute(sql_delete(AuditLog).where(AuditLog.agent_id.in_(agent_ids_q)))
    # Delete agents
    await db.execute(sql_delete(Agent).where(Agent.tenant_id == tenant_id))

    # Delete tenant-specific resources
    await db.execute(sql_delete(LLMModel).where(LLMModel.tenant_id == tenant_id))
    await db.execute(sql_delete(Tool).where(Tool.tenant_id == tenant_id))
    await db.execute(sql_delete(Skill).where(Skill.tenant_id == tenant_id))

    # Reassign users from this tenant to fallback
    affected_users_r = await db.execute(select(User).where(User.tenant_id == tenant_id))
    for u in affected_users_r.scalars().all():
        u.tenant_id = fallback_tenant.id

    # Delete the tenant itself
    await db.delete(tenant)
    await db.flush()
    return {"ok": True, "fallback_tenant_id": str(fallback_tenant.id)}


class TenantSimple(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    model_config = {"from_attributes": True}


@router.get("/public/list", response_model=list[TenantSimple])
async def list_tenants_public(db: AsyncSession = Depends(get_db)):
    """List active tenants for registration page (no auth required)."""
    result = await db.execute(
        select(Tenant).where(Tenant.is_active == True).order_by(Tenant.name)
    )
    return [TenantSimple.model_validate(t) for t in result.scalars().all()]
