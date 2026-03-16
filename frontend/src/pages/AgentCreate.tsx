import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { agentApi, channelApi, enterpriseApi, skillApi } from '../services/api';

const STEPS = ['basicInfo', 'personality', 'skills', 'permissions', 'channel'] as const;
const OPENCLAW_STEPS = ['basicInfo', 'permissions'] as const;

export default function AgentCreate() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [step, setStep] = useState(0);
    const [error, setError] = useState('');
    const [agentType, setAgentType] = useState<'native' | 'openclaw'>('native');
    const [createdApiKey, setCreatedApiKey] = useState('');
    // Current company (tenant) selection from layout sidebar
    const [currentTenant] = useState<string | null>(() => localStorage.getItem('current_tenant_id'));

    const [form, setForm] = useState({
        name: '',
        role_description: '',
        personality: '',
        boundaries: '',
        primary_model_id: '' as string,
        fallback_model_id: '' as string,
        permission_scope_type: 'company',
        permission_access_level: 'use',
        template_id: '' as string,
        max_tokens_per_day: '',
        max_tokens_per_month: '',
        feishu_app_id: '',
        feishu_app_secret: '',
        feishu_encrypt_key: '',
        feishu_connection_mode: 'websocket',
        slack_bot_token: '',
        slack_signing_secret: '',
        discord_application_id: '',
        discord_bot_token: '',
        discord_public_key: '',
        skill_ids: [] as string[],
    });
    const [feishuOpen, setFeishuOpen] = useState(false);
    const [slackOpen, setSlackOpen] = useState(false);
    const [discordOpen, setDiscordOpen] = useState(false);

    // Fetch LLM models for step 1
    const { data: models = [] } = useQuery({
        queryKey: ['llm-models'],
        queryFn: enterpriseApi.llmModels,
    });

    // Fetch templates
    const { data: templates = [] } = useQuery({
        queryKey: ['templates'],
        queryFn: enterpriseApi.templates,
    });

    // Fetch global skills for step 3
    const { data: globalSkills = [] } = useQuery({
        queryKey: ['global-skills'],
        queryFn: skillApi.list,
    });

    // Auto-select default skills
    useEffect(() => {
        if (globalSkills.length > 0) {
            const defaultIds = globalSkills.filter((s: any) => s.is_default).map((s: any) => s.id);
            if (defaultIds.length > 0) {
                setForm(prev => ({
                    ...prev,
                    skill_ids: Array.from(new Set([...prev.skill_ids, ...defaultIds]))
                }));
            }
        }
    }, [globalSkills]);

    const createMutation = useMutation({
        mutationFn: async (data: any) => {
            const agent = await agentApi.create(data);
            return agent;
        },
        onSuccess: async (agent) => {
            queryClient.invalidateQueries({ queryKey: ['agents'] });

            // Automatically bind channels if configured in wizard
            if (form.feishu_app_id && form.feishu_app_secret) {
                try {
                    await channelApi.create(agent.id, {
                        channel_type: 'feishu',
                        app_id: form.feishu_app_id,
                        app_secret: form.feishu_app_secret,
                        encrypt_key: form.feishu_encrypt_key || undefined,
                        extra_config: {
                            connection_mode: form.feishu_connection_mode
                        }
                    });
                } catch (err) {
                    console.error('Failed to bind Feishu channel:', err);
                }
            }

            if (form.slack_bot_token && form.slack_signing_secret) {
                try {
                    await channelApi.create(agent.id, {
                        channel_type: 'slack',
                        app_id: form.slack_bot_token,
                        app_secret: form.slack_signing_secret,
                    });
                } catch (err) {
                    console.error('Failed to bind Slack channel:', err);
                }
            }

            if (form.discord_bot_token && form.discord_application_id) {
                try {
                    await channelApi.create(agent.id, {
                        channel_type: 'discord',
                        app_id: form.discord_application_id,
                        app_secret: form.discord_bot_token,
                        encrypt_key: form.discord_public_key || undefined,
                    });
                } catch (err) {
                    console.error('Failed to bind Discord channel:', err);
                }
            }

            if (agent.api_key) {
                setCreatedApiKey(agent.api_key);
            } else {
                navigate(`/agents/${agent.id}`);
            }
        },
        onError: (err: any) => setError(err.message),
    });

    const handleFinish = () => {
        createMutation.mutate({
            name: form.name,
            agent_type: agentType,
            role_description: form.role_description,
            personality: agentType === 'native' ? form.personality : undefined,
            boundaries: agentType === 'native' ? form.boundaries : undefined,
            primary_model_id: agentType === 'native' ? (form.primary_model_id || undefined) : undefined,
            fallback_model_id: agentType === 'native' ? (form.fallback_model_id || undefined) : undefined,
            template_id: form.template_id || undefined,
            permission_scope_type: form.permission_scope_type,
            max_tokens_per_day: form.max_tokens_per_day ? Number(form.max_tokens_per_day) : undefined,
            max_tokens_per_month: form.max_tokens_per_month ? Number(form.max_tokens_per_month) : undefined,
            skill_ids: agentType === 'native' ? form.skill_ids : [],
            permission_access_level: form.permission_access_level,
            tenant_id: currentTenant || undefined,
        });
    };

    const selectedModel = models.find((m: any) => m.id === form.primary_model_id);
    const activeSteps = agentType === 'openclaw' ? OPENCLAW_STEPS : STEPS;

    // If OpenClaw agent just created, show success page with API key
    if (createdApiKey && createMutation.data) {
        const agent = createMutation.data;
        return (
            <div>
                <div className="page-header">
                    <h1 className="page-title">{t('openclaw.created', 'OpenClaw Agent Created')}</h1>
                </div>
                <div className="card" style={{ maxWidth: '640px' }}>
                    <div style={{ textAlign: 'center', padding: '20px 0' }}>
                        <div style={{ fontSize: '32px', marginBottom: '12px' }}>&#x2713;</div>
                        <h3 style={{ fontWeight: 600, marginBottom: '8px' }}>{agent.name}</h3>
                        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '24px' }}>
                            {t('openclaw.createdDesc2', 'Your OpenClaw agent has been registered. Copy the instruction below and send it to your OpenClaw agent to complete the setup.')}
                        </p>
                    </div>

                    {/* Setup Instruction — single block to send to OpenClaw */}
                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: 'var(--text-secondary)' }}>
                            {t('openclaw.setupInstruction', 'Setup Instruction')}
                        </label>
                        <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '8px' }}>
                            {t('openclaw.setupInstructionDesc', 'Copy and send this to your OpenClaw agent. It will configure itself automatically.')}
                        </p>
                        <div style={{ position: 'relative' }}>
                            <pre style={{
                                padding: '12px', background: 'var(--bg-secondary)', borderRadius: '6px',
                                fontSize: '11px', lineHeight: 1.6, overflow: 'auto', maxHeight: '280px',
                                border: '1px solid var(--border-default)', whiteSpace: 'pre-wrap',
                            }}>{`Please create a skill file at skills/clawith_sync.md with the following content, then add "Check Clawith inbox using the clawith_sync skill and process any pending messages" to your HEARTBEAT.md:

---
name: clawith_sync
description: Sync with Clawith platform — check inbox, submit results, and send messages.
---

# Clawith Sync

## When to use
Check for new messages from the Clawith platform during every heartbeat cycle.
You can also proactively send messages to people and agents in your relationships.

## Instructions

### 1. Check inbox
Make an HTTP GET request:
- URL: ${window.location.origin}/api/gateway/poll
- Header: X-Api-Key: ${createdApiKey}

The response contains a \`messages\` array. Each message includes:
- \`id\` — unique message ID (use this for reporting)
- \`content\` — the message text
- \`sender_user_name\` — name of the Clawith user who sent it
- \`sender_user_id\` — unique ID of the sender
- \`conversation_id\` — the conversation this message belongs to
- \`history\` — array of previous messages in this conversation for context

The response also contains a \`relationships\` array describing your colleagues:
- \`name\` — the person or agent name
- \`type\` — "human" or "agent"
- \`role\` — relationship type (e.g. collaborator, supervisor)
- \`channels\` — available communication channels (e.g. ["feishu"], ["agent"])

**IMPORTANT**: Use the \`history\` array to understand conversation context before replying.
Different \`sender_user_name\` values mean different people — address them accordingly.

### 2. Report results
For each completed message, make an HTTP POST request:
- URL: ${window.location.origin}/api/gateway/report
- Header: X-Api-Key: ${createdApiKey}
- Header: Content-Type: application/json
- Body: {"message_id": "<id from the message>", "result": "<your response>"}

### 3. Send a message to someone
To proactively contact a person or agent, make an HTTP POST request:
- URL: ${window.location.origin}/api/gateway/send-message
- Header: X-Api-Key: ${createdApiKey}
- Header: Content-Type: application/json
- Body: {"target": "<name of person or agent>", "content": "<your message>"}

The system auto-detects the best channel. For agents, the reply appears in your next poll.
For humans, the message is delivered via their available channel (e.g. Feishu).`}</pre>
                            <button className="btn btn-ghost" style={{ position: 'absolute', top: '4px', right: '4px', fontSize: '11px' }}
                                onClick={() => {
                                    const text = `Please create a skill file at skills/clawith_sync.md with the following content, then add "Check Clawith inbox using the clawith_sync skill and process any pending messages" to your HEARTBEAT.md:\n\n---\nname: clawith_sync\ndescription: Sync with Clawith platform — check inbox, submit results, and send messages.\n---\n\n# Clawith Sync\n\n## When to use\nCheck for new messages from the Clawith platform during every heartbeat cycle.\nYou can also proactively send messages to people and agents in your relationships.\n\n## Instructions\n\n### 1. Check inbox\nMake an HTTP GET request:\n- URL: ${window.location.origin}/api/gateway/poll\n- Header: X-Api-Key: ${createdApiKey}\n\nThe response contains a \`messages\` array. Each message includes:\n- \`id\` — unique message ID (use this for reporting)\n- \`content\` — the message text\n- \`sender_user_name\` — name of the Clawith user who sent it\n- \`sender_user_id\` — unique ID of the sender\n- \`conversation_id\` — the conversation this message belongs to\n- \`history\` — array of previous messages in this conversation for context\n\nThe response also contains a \`relationships\` array describing your colleagues:\n- \`name\` — the person or agent name\n- \`type\` — "human" or "agent"\n- \`role\` — relationship type (e.g. collaborator, supervisor)\n- \`channels\` — available communication channels (e.g. ["feishu"], ["agent"])\n\n**IMPORTANT**: Use the \`history\` array to understand conversation context before replying.\nDifferent \`sender_user_name\` values mean different people — address them accordingly.\n\n### 2. Report results\nFor each completed message, make an HTTP POST request:\n- URL: ${window.location.origin}/api/gateway/report\n- Header: X-Api-Key: ${createdApiKey}\n- Header: Content-Type: application/json\n- Body: {"message_id": "<id from the message>", "result": "<your response>"}\n\n### 3. Send a message to someone\nTo proactively contact a person or agent, make an HTTP POST request:\n- URL: ${window.location.origin}/api/gateway/send-message\n- Header: X-Api-Key: ${createdApiKey}\n- Header: Content-Type: application/json\n- Body: {"target": "<name of person or agent>", "content": "<your message>"}\n\nThe system auto-detects the best channel. For agents, the reply appears in your next poll.\nFor humans, the message is delivered via their available channel (e.g. Feishu).`;
                                    navigator.clipboard.writeText(text);
                                }}
                            >{t('common.copy', 'Copy')}</button>
                        </div>
                    </div>

                    {/* API Key — collapsed by default */}
                    <details style={{ marginBottom: '24px' }}>
                        <summary style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
                            API Key
                        </summary>
                        <div style={{ marginTop: '8px' }}>
                            <div style={{ display: 'flex', gap: '8px' }}>
                                <code style={{
                                    flex: 1, padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: '6px',
                                    fontSize: '13px', fontFamily: 'monospace', wordBreak: 'break-all',
                                    border: '1px solid var(--border-default)',
                                }}>{createdApiKey}</code>
                                <button className="btn btn-secondary" onClick={() => navigator.clipboard.writeText(createdApiKey)}>
                                    {t('common.copy', 'Copy')}
                                </button>
                            </div>
                            <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '6px' }}>
                                {t('openclaw.keyNote', 'This key is already embedded in the instruction above. Save it separately if needed for manual configuration.')}
                            </p>
                        </div>
                    </details>

                    <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => navigate(`/agents/${agent.id}`)}>
                        {t('openclaw.goToAgent', 'Go to Agent Page')}
                    </button>
                </div>
            </div>
        );
    }

    // ── Type Selector (shared between both modes) ──
    const typeSelector = (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', maxWidth: '640px', marginBottom: '24px' }}>
            <div
                onClick={() => { setAgentType('native'); setStep(0); }}
                style={{
                    padding: '16px', borderRadius: '8px', cursor: 'pointer',
                    border: `1.5px solid ${agentType === 'native' ? 'var(--accent-primary)' : 'var(--border-default)'}`,
                    background: agentType === 'native' ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                }}
            >
                <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '4px' }}>{t('openclaw.nativeTitle', 'Platform Hosted')}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{t('openclaw.nativeDesc', 'Full agent running on Clawith platform')}</div>
            </div>
            <div
                onClick={() => { setAgentType('openclaw'); setStep(0); }}
                style={{
                    padding: '16px', borderRadius: '8px', cursor: 'pointer', position: 'relative',
                    border: `1.5px solid ${agentType === 'openclaw' ? 'var(--accent-primary)' : 'var(--border-default)'}`,
                    background: agentType === 'openclaw' ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                }}
            >
                <span style={{
                    position: 'absolute', top: '8px', right: '8px',
                    fontSize: '10px', padding: '2px 6px', borderRadius: '4px',
                    background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', color: '#fff', fontWeight: 600,
                    letterSpacing: '0.5px',
                }}>Lab</span>
                <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '4px' }}>{t('openclaw.openclawTitle', 'Link OpenClaw')}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{t('openclaw.openclawDesc', 'Connect your existing OpenClaw agent')}</div>
            </div>
        </div>
    );

    // ── OpenClaw mode: completely separate page ──
    if (agentType === 'openclaw') {
        return (
            <div>
                <div className="page-header">
                    <h1 className="page-title">{t('nav.newAgent')}</h1>
                </div>

                {typeSelector}

                {error && (
                    <div style={{ background: 'var(--error-subtle)', color: 'var(--error)', padding: '8px 12px', borderRadius: '6px', fontSize: '13px', marginBottom: '16px', maxWidth: '640px' }}>
                        {error}
                    </div>
                )}

                <div className="card" style={{ maxWidth: '640px' }}>
                    <h3 style={{ marginBottom: '6px', fontWeight: 600, fontSize: '15px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {t('openclaw.basicTitle', 'Link OpenClaw Agent')}
                        <span style={{
                            fontSize: '10px', padding: '2px 6px', borderRadius: '4px',
                            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', color: '#fff', fontWeight: 600,
                        }}>Lab</span>
                    </h3>
                    <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '20px' }}>
                        {t('openclaw.basicDesc', 'Give your OpenClaw agent a name and description. The LLM model, personality, and skills are configured on your OpenClaw instance.')}
                    </p>

                    <div className="form-group">
                        <label className="form-label">{t('agent.fields.name')} *</label>
                        <input className="form-input" value={form.name}
                            onChange={(e) => setForm({ ...form, name: e.target.value })}
                            placeholder={t('openclaw.namePlaceholder', 'e.g. My OpenClaw Bot')} autoFocus />
                    </div>
                    <div className="form-group">
                        <label className="form-label">{t('agent.fields.role')}</label>
                        <input className="form-input" value={form.role_description}
                            onChange={(e) => setForm({ ...form, role_description: e.target.value })}
                            placeholder={t('openclaw.rolePlaceholder', 'e.g. Personal assistant running on my Mac')} />
                    </div>

                    {/* Permissions */}
                    <div className="form-group" style={{ marginTop: '8px' }}>
                        <label className="form-label">{t('wizard.step4.title')}</label>
                        <div style={{ display: 'flex', gap: '8px' }}>
                            {[
                                { value: 'company', label: t('wizard.step4.companyWide'), desc: t('wizard.step4.companyWideDesc') },
                                { value: 'user', label: t('wizard.step4.selfOnly'), desc: t('wizard.step4.selfOnlyDesc') },
                            ].map((scope) => (
                                <label key={scope.value} style={{
                                    flex: 1, display: 'flex', alignItems: 'center', gap: '10px', padding: '12px',
                                    background: form.permission_scope_type === scope.value ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                                    border: `1px solid ${form.permission_scope_type === scope.value ? 'var(--accent-primary)' : 'var(--border-default)'}`,
                                    borderRadius: '8px', cursor: 'pointer',
                                }}>
                                    <input type="radio" name="scope" checked={form.permission_scope_type === scope.value}
                                        onChange={() => setForm({ ...form, permission_scope_type: scope.value })} />
                                    <div>
                                        <div style={{ fontWeight: 500, fontSize: '13px' }}>{scope.label}</div>
                                        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{scope.desc}</div>
                                    </div>
                                </label>
                            ))}
                        </div>
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '24px' }}>
                        <button className="btn btn-secondary" onClick={() => navigate('/')}>{t('common.cancel')}</button>
                        <button className="btn btn-primary" onClick={handleFinish}
                            disabled={createMutation.isPending || !form.name}>
                            {createMutation.isPending ? t('common.loading') : t('openclaw.createBtn', 'Link Agent')}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // ── Native mode: original multi-step wizard ──
    return (
        <div>
            <div className="page-header">
                <h1 className="page-title">{t('nav.newAgent')}</h1>
            </div>

            {typeSelector}

            {/* Stepper */}
            <div className="wizard-steps">
                {STEPS.map((s, i) => (
                    <div key={s} style={{ display: 'contents' }}>
                        <div className={`wizard-step ${i === step ? 'active' : i < step ? 'completed' : ''}`}>
                            <div className="wizard-step-number">{i < step ? '\u2713' : i + 1}</div>
                            <span>{t(`wizard.steps.${s}`)}</span>
                        </div>
                        {i < STEPS.length - 1 && <div className="wizard-connector" />}
                    </div>
                ))}
            </div>

            {/* Navigation — sticky between stepper and card */}
            <div style={{ display: 'flex', justifyContent: 'space-between', maxWidth: '640px', marginBottom: '16px', position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg-primary)', paddingTop: '4px', paddingBottom: '4px' }}>
                <button className="btn btn-secondary" onClick={() => step > 0 ? setStep(step - 1) : navigate('/')}
                    disabled={createMutation.isPending}>
                    {step === 0 ? t('common.cancel') : t('wizard.prev')}
                </button>
                {step < STEPS.length - 1 ? (
                    <button className="btn btn-primary" onClick={() => setStep(step + 1)}
                        disabled={step === 0 && !form.name}>
                        {t('wizard.next')} →
                    </button>
                ) : (
                    <button className="btn btn-primary" onClick={handleFinish}
                        disabled={createMutation.isPending || !form.name}>
                        {createMutation.isPending ? t('common.loading') : t('wizard.finish')}
                    </button>
                )}
            </div>

            {error && (
                <div style={{ background: 'var(--error-subtle)', color: 'var(--error)', padding: '8px 12px', borderRadius: '6px', fontSize: '13px', marginBottom: '16px' }}>
                    {error}
                </div>
            )}

            <div className="card" style={{ maxWidth: '640px' }}>
                {/* Step 1: Basic Info + Model */}
                {step === 0 && (
                    <div>
                        <h3 style={{ marginBottom: '20px', fontWeight: 600, fontSize: '15px' }}>{t('wizard.step1.title')}</h3>

                        {/* Template selector */}
                        {templates.length > 0 && (
                            <div className="form-group">
                                <label className="form-label">{t('wizard.step1.selectTemplate')}</label>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                                    <div
                                        onClick={() => setForm({ ...form, template_id: '' })}
                                        style={{
                                            padding: '12px', borderRadius: '8px', cursor: 'pointer', textAlign: 'center',
                                            border: `1px solid ${!form.template_id ? 'var(--accent-primary)' : 'var(--border-default)'}`,
                                            background: !form.template_id ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                                        }}
                                    >
                                        <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-secondary)' }}>{t('wizard.step1.custom')}</div>
                                        <div style={{ fontSize: '12px', marginTop: '4px' }}>{t('wizard.step1.custom')}</div>
                                    </div>
                                    {templates.map((tmpl: any) => (
                                        <div
                                            key={tmpl.id}
                                            onClick={() => setForm({ ...form, template_id: tmpl.id, role_description: tmpl.description })}
                                            style={{
                                                padding: '12px', borderRadius: '8px', cursor: 'pointer', textAlign: 'center',
                                                border: `1px solid ${form.template_id === tmpl.id ? 'var(--accent-primary)' : 'var(--border-default)'}`,
                                                background: form.template_id === tmpl.id ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                                            }}
                                        >
                                            <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-secondary)' }}>{tmpl.icon || tmpl.name?.[0] || '·'}</div>
                                            <div style={{ fontSize: '12px', marginTop: '4px' }}>{tmpl.name}</div>
                                        </div>
                                    ))}
                                </div>

                                {/* JSON Import */}
                                <div style={{ marginTop: '8px' }}>
                                    <label className="btn btn-ghost" style={{ fontSize: '12px', cursor: 'pointer', color: 'var(--text-tertiary)' }}>
                                        ↑ Import from JSON
                                        <input type="file" accept=".json" style={{ display: 'none' }} onChange={e => {
                                            const file = e.target.files?.[0];
                                            if (!file) return;
                                            const reader = new FileReader();
                                            reader.onload = ev => {
                                                try {
                                                    const data = JSON.parse(ev.target?.result as string);
                                                    setForm(prev => ({
                                                        ...prev,
                                                        name: data.name || prev.name,
                                                        role_description: data.role_description || data.description || prev.role_description,
                                                        template_id: '',
                                                    }));
                                                } catch {
                                                    alert('Invalid JSON file');
                                                }
                                            };
                                            reader.readAsText(file);
                                            e.target.value = '';
                                        }} />
                                    </label>
                                </div>
                            </div>
                        )}

                        <div className="form-group">
                            <label className="form-label">{t('agent.fields.name')} *</label>
                            <input className="form-input" value={form.name}
                                onChange={(e) => setForm({ ...form, name: e.target.value })}
                                placeholder={t("wizard.step1.namePlaceholder")} autoFocus />
                        </div>
                        <div className="form-group">
                            <label className="form-label">{t('agent.fields.role')}</label>
                            <input className="form-input" value={form.role_description}
                                onChange={(e) => setForm({ ...form, role_description: e.target.value })}
                                placeholder={t('wizard.roleHint')} />
                        </div>

                        {/* Model Selection */}
                        <div className="form-group">
                            <label className="form-label">{t('wizard.step1.primaryModel')} *</label>
                            {models.length > 0 ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                    {models.filter((m: any) => m.enabled).map((m: any) => (
                                        <label key={m.id} style={{
                                            display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px',
                                            background: form.primary_model_id === m.id ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                                            border: `1px solid ${form.primary_model_id === m.id ? 'var(--accent-primary)' : 'var(--border-default)'}`,
                                            borderRadius: '8px', cursor: 'pointer',
                                        }}>
                                            <input type="radio" name="model" checked={form.primary_model_id === m.id}
                                                onChange={() => setForm({ ...form, primary_model_id: m.id })} />
                                            <div>
                                                <div style={{ fontWeight: 500, fontSize: '13px' }}>{m.label}</div>
                                                <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{m.provider}/{m.model}</div>
                                            </div>
                                        </label>
                                    ))}
                                </div>
                            ) : (
                                <div style={{ padding: '16px', background: 'var(--bg-elevated)', borderRadius: '8px', fontSize: '13px', color: 'var(--text-tertiary)', textAlign: 'center' }}>
                                    {t('wizard.step1.noModels')} <span style={{ color: 'var(--accent-primary)', cursor: 'pointer' }} onClick={() => navigate('/enterprise')}>{t('wizard.step1.enterpriseSettings')}</span> {t('wizard.step1.addModels')}
                                </div>
                            )}
                        </div>

                        {/* Token limits */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                            <div className="form-group">
                                <label className="form-label">{t('wizard.step1.dailyTokenLimit')}</label>
                                <input className="form-input" type="number" value={form.max_tokens_per_day}
                                    onChange={(e) => setForm({ ...form, max_tokens_per_day: e.target.value })}
                                    placeholder={t("wizard.step1.unlimited")} />
                            </div>
                            <div className="form-group">
                                <label className="form-label">{t('wizard.step1.monthlyTokenLimit')}</label>
                                <input className="form-input" type="number" value={form.max_tokens_per_month}
                                    onChange={(e) => setForm({ ...form, max_tokens_per_month: e.target.value })}
                                    placeholder={t("wizard.step1.unlimited")} />
                            </div>
                        </div>
                    </div>
                )}

                {/* Step 2: Personality */}
                {step === 1 && (
                    <div>
                        <h3 style={{ marginBottom: '20px', fontWeight: 600, fontSize: '15px' }}>{t('wizard.step2.title')}</h3>
                        <div className="form-group">
                            <label className="form-label">{t('agent.fields.personality')}</label>
                            <textarea className="form-textarea" rows={4} value={form.personality}
                                onChange={(e) => setForm({ ...form, personality: e.target.value })}
                                placeholder={t("wizard.step2.personalityPlaceholder")} />
                        </div>
                        <div className="form-group">
                            <label className="form-label">{t('agent.fields.boundaries')}</label>
                            <textarea className="form-textarea" rows={4} value={form.boundaries}
                                onChange={(e) => setForm({ ...form, boundaries: e.target.value })}
                                placeholder={t("wizard.step2.boundariesPlaceholder")} />
                        </div>
                    </div>
                )}

                {/* Step 3: Skills */}
                {step === 2 && (
                    <div>
                        <h3 style={{ marginBottom: '20px', fontWeight: 600, fontSize: '15px' }}>{t('wizard.step3.title')}</h3>
                        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                            {t('wizard.step3.description')}
                        </p>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {globalSkills.map((skill: any) => {
                                const isDefault = skill.is_default;
                                const isChecked = form.skill_ids.includes(skill.id);
                                return (
                                    <label key={skill.id} style={{
                                        display: 'flex', alignItems: 'center', gap: '12px', padding: '12px',
                                        background: isChecked ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                                        border: `1px solid ${isChecked ? 'var(--accent-primary)' : 'var(--border-default)'}`,
                                        borderRadius: '8px', cursor: isDefault ? 'default' : 'pointer',
                                        opacity: isDefault ? 0.85 : 1,
                                    }}>
                                        <input type="checkbox"
                                            checked={isChecked}
                                            disabled={isDefault}
                                            onChange={(e) => {
                                                if (isDefault) return;
                                                if (e.target.checked) {
                                                    setForm({ ...form, skill_ids: [...form.skill_ids, skill.id] });
                                                } else {
                                                    setForm({ ...form, skill_ids: form.skill_ids.filter((id: string) => id !== skill.id) });
                                                }
                                            }}
                                        />
                                        <div style={{ fontSize: '18px' }}>{skill.icon}</div>
                                        <div style={{ flex: 1 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                <span style={{ fontWeight: 500, fontSize: '13px' }}>{skill.name}</span>
                                                {isDefault && <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '4px', background: 'var(--accent-primary)', color: '#fff', fontWeight: 500 }}>Required</span>}
                                            </div>
                                            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{skill.description}</div>
                                        </div>
                                    </label>);
                            })}
                            {globalSkills.length === 0 && (
                                <div style={{ padding: '16px', background: 'var(--bg-elevated)', borderRadius: '8px', fontSize: '13px', color: 'var(--text-tertiary)', textAlign: 'center' }}>
                                    No skills available. Add skills in Enterprise Settings.
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Step 4: Permissions */}
                {step === 3 && (
                    <div>
                        <h3 style={{ marginBottom: '20px', fontWeight: 600, fontSize: '15px' }}>{t('wizard.step4.title')}</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
                            {[
                                { value: 'company', label: t('wizard.step4.companyWide'), desc: t('wizard.step4.companyWideDesc') },
                                { value: 'user', label: t('wizard.step4.selfOnly'), desc: t('wizard.step4.selfOnlyDesc') },
                            ].map((scope) => (
                                <label key={scope.value} style={{
                                    display: 'flex', alignItems: 'center', gap: '12px', padding: '14px',
                                    background: form.permission_scope_type === scope.value ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                                    border: `1px solid ${form.permission_scope_type === scope.value ? 'var(--accent-primary)' : 'var(--border-default)'}`,
                                    borderRadius: '8px', cursor: 'pointer',
                                }}>
                                    <input type="radio" name="scope" checked={form.permission_scope_type === scope.value}
                                        onChange={() => setForm({ ...form, permission_scope_type: scope.value })} />

                                    <div>
                                        <div style={{ fontWeight: 500, fontSize: '13px' }}>{scope.label}</div>
                                        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{scope.desc}</div>
                                    </div>
                                </label>
                            ))}
                        </div>

                        {/* Access Level — only for company scope */}
                        {form.permission_scope_type === 'company' && (
                            <div>
                                <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '10px' }}>
                                    {t('wizard.step4.accessLevel', 'Default Access Level')}
                                </label>
                                <div style={{ display: 'flex', gap: '8px' }}>
                                    {[
                                        { value: 'use', icon: '👁️', label: t('wizard.step4.useLevel', 'Use'), desc: t('wizard.step4.useDesc', 'Can use Task, Chat, Tools, Skills, Workspace') },
                                        { value: 'manage', icon: '⚙️', label: t('wizard.step4.manageLevel', 'Manage'), desc: t('wizard.step4.manageDesc', 'Full access including Settings, Mind, Relationships') },
                                    ].map((lvl) => (
                                        <label key={lvl.value} style={{
                                            flex: 1, display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '12px',
                                            background: form.permission_access_level === lvl.value ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                                            border: `1px solid ${form.permission_access_level === lvl.value ? 'var(--accent-primary)' : 'var(--border-default)'}`,
                                            borderRadius: '8px', cursor: 'pointer',
                                        }}>
                                            <input type="radio" name="access_level" checked={form.permission_access_level === lvl.value}
                                                onChange={() => setForm({ ...form, permission_access_level: lvl.value })} style={{ marginTop: '2px' }} />
                                            <div>
                                                <div style={{ fontWeight: 500, fontSize: '13px' }}>{lvl.icon} {lvl.label}</div>
                                                <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{lvl.desc}</div>
                                            </div>
                                        </label>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* Step 5: Channel */}
                {step === 4 && (
                    <div>
                        <h3 style={{ marginBottom: '20px', fontWeight: 600, fontSize: '15px' }}>{t('wizard.step5.title', 'Channel Configuration')}</h3>
                        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                            {t('wizard.step5.description', 'Connect messaging platforms to enable your agent to communicate through different channels.')}
                        </p>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {/* Slack — expandable */}
                            <div style={{ border: '1px solid var(--border-default)', borderRadius: '8px', overflow: 'hidden' }}>
                                <div
                                    onClick={() => setSlackOpen(!slackOpen)}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: '12px', padding: '14px',
                                        cursor: 'pointer', background: slackOpen ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                                        borderBottom: slackOpen ? '1px solid var(--border-default)' : 'none',
                                    }}
                                >
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6.194 14.644a2.194 2.194 0 110 4.388 2.194 2.194 0 010-4.388zm-2.194 0H0v-2.194a2.194 2.194 0 014.388 0v2.194zm16.612 0a2.194 2.194 0 110 4.388 2.194 2.194 0 010-4.388zm0-2.194a2.194 2.194 0 010-4.388 2.194 2.194 0 010 4.388zm0 0v2.194h2.194A2.194 2.194 0 0024 12.45a2.194 2.194 0 00-2.194-2.194h-1.194zm-16.612 0a2.194 2.194 0 010-4.388 2.194 2.194 0 010 4.388zm0 0v2.194H2A2.194 2.194 0 010 12.45a2.194 2.194 0 012.194-2.194h1.806z" fill="#611F69" opacity=".4" /><path d="M9.388 4.388a2.194 2.194 0 110-4.388 2.194 2.194 0 010 4.388zm0 2.194v-2.194H7.194A2.194 2.194 0 005 6.582a2.194 2.194 0 002.194 2.194h2.194zm0 12.612a2.194 2.194 0 110 4.388 2.194 2.194 0 010-4.388zm0-2.194v2.194H7.194A2.194 2.194 0 005 17.418a2.194 2.194 0 002.194 2.194h.194zm4.224-12.612a2.194 2.194 0 110-4.388 2.194 2.194 0 010 4.388zm2.194 0H13.612V2.194a2.194 2.194 0 014.388 0v2.194zm-2.194 14.806a2.194 2.194 0 110 4.388 2.194 2.194 0 010-4.388zm-2.194 0h2.194v2.194a2.194 2.194 0 01-4.388 0v-2.194z" fill="#611F69" /></svg>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontWeight: 500, fontSize: '13px' }}>Slack</div>
                                        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>Slack Bot</div>
                                    </div>
                                    {form.slack_bot_token && <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '10px', background: 'rgba(16,185,129,0.15)', color: 'rgb(16,185,129)', fontWeight: 500 }}>Configured</span>}
                                    <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', transition: 'transform 0.2s', transform: slackOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
                                </div>
                                {slackOpen && (
                                    <div style={{ padding: '16px' }}>
                                        <details style={{ marginBottom: '8px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                                            <summary style={{ cursor: 'pointer', fontWeight: 500, color: 'var(--text-primary)', userSelect: 'none', listStyle: 'none', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                <span style={{ fontSize: '10px' }}>▶</span> {t('channelGuide.setupGuide')}
                                            </summary>
                                            <ol style={{ paddingLeft: '16px', margin: '8px 0', lineHeight: 1.9 }}>
                                                <li>{t('channelGuide.slack.step1')}</li>
                                                <li>{t('channelGuide.slack.step2')}</li>
                                                <li>{t('channelGuide.slack.step3')}</li>
                                                <li>{t('channelGuide.slack.step4')}</li>
                                                <li>{t('channelGuide.slack.step5')}</li>
                                                <li>{t('channelGuide.slack.step6')}</li>
                                                <li>{t('channelGuide.slack.step7')}</li>
                                                <li>{t('channelGuide.slack.step8')}</li>
                                            </ol>
                                            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', background: 'var(--bg-secondary)', padding: '6px 10px', borderRadius: '6px' }}>💡 {t('channelGuide.slack.note')}</div>
                                        </details>
                                        <div className="form-group">
                                            <label className="form-label">Bot Token</label>
                                            <input className="form-input" value={form.slack_bot_token}
                                                onChange={(e) => setForm({ ...form, slack_bot_token: e.target.value })}
                                                placeholder="xoxb-..." />
                                        </div>
                                        <div className="form-group">
                                            <label className="form-label">Signing Secret</label>
                                            <input className="form-input" type="password" value={form.slack_signing_secret}
                                                onChange={(e) => setForm({ ...form, slack_signing_secret: e.target.value })} />
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Discord — expandable */}
                            <div style={{ border: '1px solid var(--border-default)', borderRadius: '8px', overflow: 'hidden' }}>
                                <div
                                    onClick={() => setDiscordOpen(!discordOpen)}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: '12px', padding: '14px',
                                        cursor: 'pointer', background: discordOpen ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                                        borderBottom: discordOpen ? '1px solid var(--border-default)' : 'none',
                                    }}
                                >
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="#5865F2"><path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028 14.09 14.09 0 001.226-1.994.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" /></svg>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontWeight: 500, fontSize: '13px' }}>Discord</div>
                                        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>Slash Commands (/ask)</div>
                                    </div>
                                    {form.discord_bot_token && <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '10px', background: 'rgba(16,185,129,0.15)', color: 'rgb(16,185,129)', fontWeight: 500 }}>Configured</span>}
                                    <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', transition: 'transform 0.2s', transform: discordOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
                                </div>
                                {discordOpen && (
                                    <div style={{ padding: '16px' }}>
                                        <details style={{ marginBottom: '8px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                                            <summary style={{ cursor: 'pointer', fontWeight: 500, color: 'var(--text-primary)', userSelect: 'none', listStyle: 'none', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                <span style={{ fontSize: '10px' }}>▶</span> {t('channelGuide.setupGuide')}
                                            </summary>
                                            <ol style={{ paddingLeft: '16px', margin: '8px 0', lineHeight: 1.9 }}>
                                                <li>{t('channelGuide.discord.step1')}</li>
                                                <li>{t('channelGuide.discord.step2')}</li>
                                                <li>{t('channelGuide.discord.step3')}</li>
                                                <li>{t('channelGuide.discord.step4')}</li>
                                                <li>{t('channelGuide.discord.step5')}</li>
                                                <li>{t('channelGuide.discord.step6')}</li>
                                                <li>{t('channelGuide.discord.step7')}</li>
                                            </ol>
                                            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', background: 'var(--bg-secondary)', padding: '6px 10px', borderRadius: '6px' }}>💡 {t('channelGuide.discord.note')}</div>
                                        </details>
                                        <div className="form-group">
                                            <label className="form-label">Application ID</label>
                                            <input className="form-input" value={form.discord_application_id}
                                                onChange={(e) => setForm({ ...form, discord_application_id: e.target.value })}
                                                placeholder="1234567890" />
                                        </div>
                                        <div className="form-group">
                                            <label className="form-label">Bot Token</label>
                                            <input className="form-input" type="password" value={form.discord_bot_token}
                                                onChange={(e) => setForm({ ...form, discord_bot_token: e.target.value })} />
                                        </div>
                                        <div className="form-group">
                                            <label className="form-label">Public Key</label>
                                            <input className="form-input" value={form.discord_public_key}
                                                onChange={(e) => setForm({ ...form, discord_public_key: e.target.value })} />
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Feishu — expandable */}
                            <div style={{ border: '1px solid var(--border-default)', borderRadius: '8px', overflow: 'hidden' }}>
                                <div
                                    onClick={() => setFeishuOpen(!feishuOpen)}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: '12px', padding: '14px',
                                        cursor: 'pointer', background: feishuOpen ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                                        borderBottom: feishuOpen ? '1px solid var(--border-default)' : 'none',
                                    }}
                                >
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M3.64 7.2c.83 2.33 2.52 4.36 4.76 5.53L19.2 3.2c-.32-.09-.67-.11-1.03-.04L3.64 7.2z" fill="#00D6B9"/><path d="M8.4 12.73c.68.35 1.41.6 2.16.73l10.2-7.52c-.26-.56-.72-1.02-1.36-1.24L8.4 12.73z" fill="#3370FF"/><path d="M10.56 13.46c1.18.19 2.39.09 3.5-.3l6.86-5.06-.12-.14L10.56 13.46z" fill="#3370FF"/><path d="M14.06 13.16a8.1 8.1 0 002.62-1.67l4.24-3.13-.12-.42L14.06 13.16z" fill="#3370FF"/><path d="M16.68 11.49a8 8 0 001.7-2.15l2.54-1.87-.12-.53-4.12 4.55z" fill="#3370FF"/><path d="M3.64 7.2l-.24.7c-.94 2.82-.37 5.6 1.36 7.7L16.68 3.96 3.64 7.2z" fill="#00D6B9"/><path d="M4.76 15.6a8.02 8.02 0 003.64 3.94V12.73l-3.64 2.87z" fill="#3370FF"/><path d="M8.4 19.54c.68.35 1.41.56 2.16.64v-6.72l-2.16 6.08z" fill="#3370FF"/></svg>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontWeight: 500, fontSize: '13px' }}>{t('wizard.step5.feishu', 'Feishu / Lark')}</div>
                                        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{t('wizard.step5.feishuDesc', 'Connect via Feishu Open Platform bot')}</div>
                                    </div>
                                    {form.feishu_app_id && <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '10px', background: 'rgba(16,185,129,0.15)', color: 'rgb(16,185,129)', fontWeight: 500 }}>Configured</span>}
                                    <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', transition: 'transform 0.2s', transform: feishuOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
                                </div>
                                {feishuOpen && (
                                    <div style={{ padding: '16px' }}>
                                        <div style={{ background: 'var(--bg-elevated)', borderRadius: '8px', padding: '12px', marginBottom: '14px', fontSize: '12px', lineHeight: '1.8' }}>
                                            <strong>{t('wizard.step5.configSteps')}</strong>
                                            <ol style={{ paddingLeft: '16px', margin: '6px 0 0' }}>
                                                <li>{t('wizard.step5.step1Feishu')} <a href="https://open.feishu.cn" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-primary)' }}>{t('wizard.step5.feishuPlatform')}</a></li>
                                                <li>{t('wizard.step5.step2Feishu')}</li>
                                                <li>{t('wizard.step5.step3Feishu')}</li>
                                                <li>{t('wizard.step5.step4Feishu')}</li>
                                            </ol>
                                        </div>
                                        <details style={{ marginBottom: '8px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                                            <summary style={{ cursor: 'pointer', fontWeight: 500, color: 'var(--text-primary)', userSelect: 'none', listStyle: 'none', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                <span style={{ fontSize: '10px' }}>▶</span> {t('channelGuide.setupGuide')}
                                            </summary>
                                            <ol style={{ paddingLeft: '16px', margin: '8px 0', lineHeight: 1.9 }}>
                                                {form.feishu_connection_mode === 'websocket' ? (<>
                                                    <li>{t('channelGuide.feishu.ws_step1')}</li>
                                                    <li>{t('channelGuide.feishu.ws_step2')}</li>
                                                    <li>{t('channelGuide.feishu.ws_step3')}</li>
                                                    <li>{t('channelGuide.feishu.ws_step4')}</li>
                                                    <li>{t('channelGuide.feishu.ws_step5')}</li>
                                                    <li>{t('channelGuide.feishu.ws_step6')}</li>
                                                    <li>{t('channelGuide.feishu.ws_step7')}</li>
                                                    <li>{t('channelGuide.feishu.ws_step8')}</li>
                                                </>) : (<>
                                                    <li>{t('channelGuide.feishu.step1')}</li>
                                                    <li>{t('channelGuide.feishu.step2')}</li>
                                                    <li>{t('channelGuide.feishu.step3')}</li>
                                                    <li>{t('channelGuide.feishu.step4')}</li>
                                                    <li>{t('channelGuide.feishu.step5')}</li>
                                                    <li>{t('channelGuide.feishu.step6')}</li>
                                                    <li>{t('channelGuide.feishu.step7')}</li>
                                                    <li>{t('channelGuide.feishu.step8')}</li>
                                                </>)}
                                            </ol>
                                            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', background: 'var(--bg-secondary)', padding: '6px 10px', borderRadius: '6px' }}>💡 {t('channelGuide.feishu.note')}</div>
                                        </details>
                                        <div className="form-group" style={{ marginBottom: '16px' }}>
                                            <label className="form-label">{t('wizard.step5.connectionMode')}</label>
                                            <div style={{ display: 'flex', gap: '16px', marginTop: '8px', marginBottom: '8px' }}>
                                                <label style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                                                    <input type="radio" name="feishu_mode" value="websocket"
                                                        checked={form.feishu_connection_mode === 'websocket'}
                                                        onChange={() => setForm({ ...form, feishu_connection_mode: 'websocket' })} />
                                                    {t('wizard.step5.modeWebsocket')}
                                                </label>
                                                <label style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                                                    <input type="radio" name="feishu_mode" value="webhook"
                                                        checked={form.feishu_connection_mode === 'webhook'}
                                                        onChange={() => setForm({ ...form, feishu_connection_mode: 'webhook' })} />
                                                    {t('wizard.step5.modeWebhook')}
                                                </label>
                                            </div>
                                        </div>
                                        <div className="form-group">
                                            <label className="form-label">App ID</label>
                                            <input className="form-input" value={form.feishu_app_id}
                                                onChange={(e) => setForm({ ...form, feishu_app_id: e.target.value })}
                                                placeholder="cli_xxxxxxxxxxxxxxxx" />
                                        </div>
                                        <div className="form-group">
                                            <label className="form-label">App Secret</label>
                                            <input className="form-input" type="password" value={form.feishu_app_secret}
                                                onChange={(e) => setForm({ ...form, feishu_app_secret: e.target.value })}
                                                placeholder="xxxxxxxxxxxxxxxxxxxxxxxx" />
                                        </div>
                                        {form.feishu_connection_mode === 'webhook' && (
                                            <div className="form-group">
                                                <label className="form-label">{t('wizard.step5.encryptKeyOptional')}</label>
                                                <input className="form-input" value={form.feishu_encrypt_key}
                                                    onChange={(e) => setForm({ ...form, feishu_encrypt_key: e.target.value })}
                                                    placeholder={t('wizard.step5.encryptKeyPlaceholder')} />
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* Other channels — configurable in Settings after creation */}
                            {[
                                { icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="4" fill="#7B83EB"/><path d="M14.5 7a2 2 0 100-4 2 2 0 000 4zm-5 2a2.5 2.5 0 100-5 2.5 2.5 0 000 5zm5.5 1.5c0-.3.2-.5.5-.5h3a2 2 0 012 2v3.5a1 1 0 01-2 0V12h-3a.5.5 0 01-.5-.5zM4 11.5A1.5 1.5 0 015.5 10h5A1.5 1.5 0 0112 11.5V17a3 3 0 01-6 0v-1H5.5A1.5 1.5 0 014 14.5v-3z" fill="white"/></svg>, name: t('common.channels.teams', 'Microsoft Teams'), desc: 'Teams Bot' },
                                { icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#07C160"/><path d="M7.5 9.5a1 1 0 110-2 1 1 0 010 2zm4 0a1 1 0 110-2 1 1 0 010 2zm4 0a1 1 0 110-2 1 1 0 010 2zM6 13h5l2 3h-3l-1 2-1-2H6v-3z" fill="white"/></svg>, name: t('common.channels.wecom', 'WeCom'), desc: 'WebSocket / Webhook' },
                                { icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="4" fill="#007FFF"/><path d="M8.5 6.5l7.5 1.3-3.5 3.7 3.5 3.7L8.5 16.5v-10z" fill="white"/></svg>, name: t('common.channels.dingtalk', 'DingTalk'), desc: 'Stream Mode' },
                                { icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#0052CC"/><path d="M7 13l3-6 2 4 2-4 3 6H7z" fill="white"/></svg>, name: 'Atlassian', desc: 'Jira / Confluence / Compass (Rovo MCP)' },
                            ].map((ch) => (
                                <div key={typeof ch.name === 'string' ? ch.name : ch.desc} style={{
                                    display: 'flex', alignItems: 'center', gap: '12px', padding: '14px',
                                    background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                                    borderRadius: '8px', opacity: 0.7,
                                }}>
                                    {ch.icon}
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontWeight: 500, fontSize: '13px' }}>{ch.name}</div>
                                        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{ch.desc}</div>
                                    </div>
                                    <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '10px', background: 'var(--bg-secondary)', color: 'var(--text-tertiary)', fontWeight: 500 }}>Configure in Settings</span>
                                </div>
                            ))}
                        </div>

                        {!form.feishu_app_id && !form.slack_bot_token && !form.discord_bot_token && (
                            <div style={{ padding: '12px', background: 'var(--bg-secondary)', borderRadius: '8px', fontSize: '12px', color: 'var(--text-tertiary)', textAlign: 'center', marginTop: '12px' }}>
                                {t('wizard.step5.skipHint')}
                            </div>
                        )}
                    </div>
                )}


            </div>

            {/* Summary sidebar */}
            {selectedModel && (
                <div style={{ marginTop: '16px', padding: '12px', background: 'var(--bg-elevated)', borderRadius: '8px', fontSize: '12px', color: 'var(--text-secondary)', maxWidth: '640px' }}>
                    <strong>{form.name || t('wizard.summary.unnamed')}</strong> · {t('wizard.summary.model')}: {selectedModel.label}
                    {form.max_tokens_per_day && ` · ${t('wizard.summary.dailyLimit')}: ${Number(form.max_tokens_per_day).toLocaleString()}`}
                </div>
            )}
        </div>
    );
}
