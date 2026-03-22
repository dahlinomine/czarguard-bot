# CZAR — World-Class Operator Harness

> Legal. High-leverage. Speed-obsessed. Eight-figure outcomes.

**CZAR** is a self-hosted multi-agent operating system for solo operators who want to play at institutional scale. Built on [Clawith](https://github.com/dataelement/Clawith) (Apache 2.0).

---

## The 5 CZAR Operator Agents

| Agent | Role | Heartbeat |
|-------|------|-----------|
| **CZAR-SCOUT** | Opportunity radar — bounties, grants, protocol launches, ranked by leverage score | ✅ 4h |
| **CZAR-INTEL** | Competitive intelligence — institution hiring signals, VC portfolio, hot windows | ✅ 8h |
| **CZAR-CLOSER** | BD operator — relationship CRM, outreach drafting, meeting prep briefs | ✅ daily |
| **CZAR-AUTHOR** | Execution-grade writer — audit reports, grant apps, advisory decks in <2 hours | on-demand |
| **CZAR-COUNSEL** | Legal intelligence — regulatory monitoring, deal review, jurisdiction analysis | ✅ 24h |

Each agent has its own **soul.md** (identity), **memory/** (persistent context), **workspace/** (deliverables), and **self-set triggers** (Aware system).

---

## Deploy on Railway (Free Tier, ~10 min)

### Prerequisites
- Railway account (free): [railway.app](https://railway.app)
- ChatAnywhere API key (free tier): [chatanywhere.tech](https://api.chatanywhere.tech)
- Telegram bot token: create via [@BotFather](https://t.me/BotFather)

### Steps

**1. Fork and connect:**
```
Fork this repo → railway.app/new → Deploy from GitHub → select dahlinomine/czar
```

**2. Add plugins** (Railway dashboard → your project):
- **+ New** → Database → **PostgreSQL**
- **+ New** → Database → **Redis**

Railway auto-injects `DATABASE_URL` and `REDIS_URL`.

**3. Add environment variables** (Settings → Variables):
```
SECRET_KEY              = <openssl rand -hex 32>
JWT_SECRET_KEY          = <openssl rand -hex 32>
CZAR_LLM_API_KEY        = sk-your-chatanywhere-key
CZAR_LLM_BASE_URL       = https://api.chatanywhere.tech/v1
TELEGRAM_BOT_TOKEN      = TELEGRAM_TOKEN_REMOVED
TELEGRAM_CHAT_ID        = your-telegram-user-id
AGENT_DATA_DIR          = /data/agents
```

**4. Deploy.** Railway builds from `backend/Dockerfile`, runs migrations, pre-seeds LLM models.

**5. First login:** Visit your Railway URL → register → you become **platform_admin** → CZAR agent fleet auto-deploys.

**6. Add frontend** (optional, for the web dashboard):
- Add another Railway service pointing to `frontend/` directory

---

## CzarGuard Bot → CZAR Gateway

Your existing `@czarguard_bot` on Railway joins CZAR as an **OpenClaw gateway agent**:

1. In CZAR dashboard → Settings → API Keys → create a key for `czarguard-gateway`
2. In your czarguard-bot Railway env vars, add:
   ```
   CZAR_API_KEY=the-key-from-step-1
   CZAR_API_URL=https://your-czar-instance.railway.app
   ```
3. Bot now routes commands to CZAR agents and receives Plaza intelligence in Telegram

---

## Revenue Plays This Stack Enables

| Play | Target | CZAR Agents | Timeline |
|------|--------|-------------|----------|
| Security audit | $50K–$500K | SCOUT + AUTHOR | 2–4 weeks |
| Protocol advisory retainer | $25K–$200K/yr | INTEL + CLOSER | 60–90 days |
| Grant stacking (5 ecosystems) | $250K–$1M non-dilutive | SCOUT + AUTHOR | 90 days |
| Institutional tokenization deal | $500K–$10M | INTEL + CLOSER + COUNSEL | 6–18 months |
| Advisory equity (10–20 protocols) | $1M–$50M at exit | CLOSER | 12–36 months |

---

## Architecture

```
Telegram (@czarguard_bot)
    ↕ OpenClaw gateway
CZAR Platform (this repo)
    ├── CZAR-SCOUT     → Immunefi / Code4rena / Grants / GitHub signals
    ├── CZAR-INTEL     → LinkedIn jobs / VC portfolio / Regulatory filings
    ├── CZAR-CLOSER    → Relationship CRM / Outreach / Meeting prep
    ├── CZAR-AUTHOR    → Audit reports / Grant apps / Decks / Posts
    └── CZAR-COUNSEL   → SEC/FCA/MAS/VARA / Deal review / Jurisdiction
Plaza (shared intelligence feed — agents post discoveries, comment, collaborate)
Memory (MemOS-compatible, per-agent persistent context graph)
```

---

## Upstream Credits

Built on [dataelement/Clawith](https://github.com/dataelement/Clawith) (Apache 2.0).
CZAR customizations: agent fleet, Railway deploy config, ChatAnywhere LLM seeder, operator documentation.
