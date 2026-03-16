import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { adminApi } from '../services/api';
import { useAuthStore } from '../stores';

// Format large token numbers with K/M/B suffixes
function formatTokens(n: number | null | undefined): string {
    if (n == null) return '-';
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'K';
    if (n < 1_000_000_000) return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0) + 'M';
    return (n / 1_000_000_000).toFixed(1) + 'B';
}

// Format datetime to locale string
function formatDate(dt: string | null | undefined): string {
    if (!dt) return '-';
    return new Date(dt).toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

type SortKey = 'name' | 'user_count' | 'agent_count' | 'total_tokens' | 'created_at' | 'is_active';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 15;

// Platform Admin company management page
export default function AdminCompanies() {
    const { t } = useTranslation();
    const user = useAuthStore((s) => s.user);
    const [companies, setCompanies] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    // Sorting
    const [sortKey, setSortKey] = useState<SortKey>('created_at');
    const [sortDir, setSortDir] = useState<SortDir>('desc');

    // Pagination
    const [page, setPage] = useState(0);

    // Platform settings
    const [settings, setSettings] = useState<any>({});
    const [settingsLoading, setSettingsLoading] = useState(false);

    // Create company
    const [showCreate, setShowCreate] = useState(false);
    const [newName, setNewName] = useState('');
    const [creating, setCreating] = useState(false);
    const [createdCode, setCreatedCode] = useState('');

    // Toast
    const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
    const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
        setToast({ msg, type });
        setTimeout(() => setToast(null), 3000);
    };

    const loadCompanies = async () => {
        setLoading(true);
        try {
            const data = await adminApi.listCompanies();
            setCompanies(data);
        } catch (e: any) {
            setError(e.message);
        }
        setLoading(false);
    };

    const loadSettings = async () => {
        try {
            const data = await adminApi.getPlatformSettings();
            setSettings(data);
        } catch { }
    };

    useEffect(() => {
        loadCompanies();
        loadSettings();
    }, []);

    // Guard: only platform_admin
    if (user?.role !== 'platform_admin') {
        return (
            <div style={{ padding: '60px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
                {t('common.noPermission', 'You do not have permission to access this page.')}
            </div>
        );
    }

    // Sorting logic
    const handleSort = (key: SortKey) => {
        if (sortKey === key) {
            setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        } else {
            setSortKey(key);
            setSortDir(key === 'name' ? 'asc' : 'desc');
        }
        setPage(0);
    };

    const sorted = useMemo(() => {
        const list = [...companies];
        list.sort((a, b) => {
            let av = a[sortKey], bv = b[sortKey];
            if (sortKey === 'name') {
                av = (av || '').toLowerCase();
                bv = (bv || '').toLowerCase();
            }
            if (sortKey === 'created_at') {
                av = av ? new Date(av).getTime() : 0;
                bv = bv ? new Date(bv).getTime() : 0;
            }
            if (sortKey === 'is_active') {
                av = av ? 1 : 0;
                bv = bv ? 1 : 0;
            }
            if (av < bv) return sortDir === 'asc' ? -1 : 1;
            if (av > bv) return sortDir === 'asc' ? 1 : -1;
            return 0;
        });
        return list;
    }, [companies, sortKey, sortDir]);

    // Pagination
    const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
    const paged = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    const handleCreate = async () => {
        if (!newName.trim()) return;
        setCreating(true);
        try {
            const result = await adminApi.createCompany({ name: newName.trim() });
            setCreatedCode(result.admin_invitation_code || '');
            setNewName('');
            loadCompanies();
            showToast(t('admin.companyCreated', 'Company created'));
        } catch (e: any) {
            showToast(e.message || 'Failed', 'error');
        }
        setCreating(false);
    };

    const handleToggle = async (id: string, currentlyActive: boolean) => {
        const action = currentlyActive ? 'disable' : 'enable';
        if (currentlyActive && !confirm(t('admin.confirmDisable', 'Disable this company? All users and agents will be paused.'))) return;
        try {
            await adminApi.toggleCompany(id);
            loadCompanies();
            showToast(`Company ${action}d`);
        } catch (e: any) {
            showToast(e.message || 'Failed', 'error');
        }
    };

    const handleToggleSetting = async (key: string, value: boolean) => {
        setSettingsLoading(true);
        try {
            await adminApi.updatePlatformSettings({ [key]: value });
            setSettings((s: any) => ({ ...s, [key]: value }));
            showToast('Setting updated');
        } catch (e: any) {
            showToast(e.message || 'Failed', 'error');
        }
        setSettingsLoading(false);
    };

    // Sort indicator arrow
    const SortArrow = ({ col }: { col: SortKey }) => {
        if (sortKey !== col) return <span style={{ opacity: 0.3, marginLeft: '2px' }}>&#x2195;</span>;
        return <span style={{ marginLeft: '2px' }}>{sortDir === 'asc' ? '\u2191' : '\u2193'}</span>;
    };

    // Column header style
    const thStyle: React.CSSProperties = {
        cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: '2px',
    };

    const columns: { key: SortKey; label: string; flex: string }[] = [
        { key: 'name', label: t('admin.company', 'Company'), flex: '2fr' },
        { key: 'user_count', label: t('admin.users', 'Users'), flex: '80px' },
        { key: 'agent_count', label: t('admin.agents', 'Agents'), flex: '80px' },
        { key: 'total_tokens', label: t('admin.tokens', 'Token Usage'), flex: '100px' },
        { key: 'created_at', label: t('admin.createdAt', 'Created'), flex: '100px' },
        { key: 'is_active', label: t('admin.status', 'Status'), flex: '120px' },
    ];

    const gridCols = columns.map(c => c.flex).join(' ');

    return (
        <div style={{ maxWidth: '1040px', margin: '0 auto', padding: '32px 24px' }}>
            {toast && (
                <div style={{
                    position: 'fixed', top: '20px', right: '20px', padding: '10px 20px',
                    borderRadius: '8px', background: toast.type === 'success' ? 'var(--success)' : 'var(--error)',
                    color: '#fff', fontSize: '13px', zIndex: 9999, boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                }}>{toast.msg}</div>
            )}

            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
                <div>
                    <h1 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '4px' }}>
                        {t('admin.title', 'Company Management')}
                    </h1>
                    <p style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>
                        {t('admin.desc', 'Manage all companies, create new ones, and configure platform settings.')}
                    </p>
                </div>
                <button className="btn btn-primary" onClick={() => { setShowCreate(true); setCreatedCode(''); }}>
                    + {t('admin.createCompany', 'Create Company')}
                </button>
            </div>

            {/* Platform Settings */}
            <div className="card" style={{ padding: '16px', marginBottom: '16px' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '12px', color: 'var(--text-secondary)' }}>
                    {t('admin.platformSettings', 'Platform Settings')}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {[
                        { key: 'allow_self_create_company', label: t('admin.allowSelfCreate', 'Allow users to create their own companies'), desc: t('admin.allowSelfCreateDesc', 'When disabled, only platform admins can create companies.') },
                        { key: 'invitation_code_enabled', label: t('admin.inviteCodeRequired', 'Require invitation code for registration'), desc: t('admin.inviteCodeRequiredDesc', 'When enabled, new users must provide a valid invitation code to register.') },
                    ].map(s => (
                        <div key={s.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
                            <div>
                                <div style={{ fontSize: '13px', fontWeight: 500 }}>{s.label}</div>
                                <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{s.desc}</div>
                            </div>
                            <label style={{ position: 'relative', display: 'inline-block', width: '40px', height: '22px', cursor: settingsLoading ? 'not-allowed' : 'pointer', flexShrink: 0 }}>
                                <input type="checkbox" checked={!!settings[s.key]} onChange={(e) => handleToggleSetting(s.key, e.target.checked)} disabled={settingsLoading}
                                    style={{ opacity: 0, width: 0, height: 0 }} />
                                <span style={{ position: 'absolute', inset: 0, background: settings[s.key] ? '#22c55e' : 'var(--bg-tertiary)', borderRadius: '11px', transition: 'background 0.2s' }}>
                                    <span style={{ position: 'absolute', left: settings[s.key] ? '20px' : '2px', top: '2px', width: '18px', height: '18px', background: '#fff', borderRadius: '50%', transition: 'left 0.2s' }} />
                                </span>
                            </label>
                        </div>
                    ))}
                </div>
            </div>

            {/* Create Company Dialog */}
            {showCreate && (
                <div className="card" style={{ padding: '16px', marginBottom: '16px', border: '1px solid var(--accent-primary)' }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '12px' }}>
                        {t('admin.createCompany', 'Create Company')}
                    </div>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                        <input className="form-input" value={newName} onChange={e => setNewName(e.target.value)}
                            placeholder={t('admin.companyNamePlaceholder', 'Company name')}
                            onKeyDown={e => e.key === 'Enter' && handleCreate()}
                            style={{ flex: 1 }} autoFocus />
                        <button className="btn btn-primary" onClick={handleCreate} disabled={creating || !newName.trim()}>
                            {creating ? '...' : t('common.create', 'Create')}
                        </button>
                        <button className="btn btn-secondary" onClick={() => { setShowCreate(false); setCreatedCode(''); }}>
                            {t('common.cancel', 'Cancel')}
                        </button>
                    </div>
                    {createdCode && (
                        <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)' }}>
                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                                {t('admin.adminInviteCode', 'Admin invite code (single-use, first user becomes org_admin):')}
                            </div>
                            <div style={{ fontFamily: 'monospace', fontSize: '18px', fontWeight: 700, letterSpacing: '3px', color: 'var(--success)' }}>
                                {createdCode}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Company List */}
            <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
                {/* Table Header */}
                <div style={{
                    display: 'grid', gridTemplateColumns: gridCols,
                    gap: '12px', padding: '10px 16px', fontSize: '11px', fontWeight: 600,
                    color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em',
                    borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)',
                }}>
                    {columns.map(col => (
                        <div key={col.key} style={thStyle} onClick={() => handleSort(col.key)}>
                            {col.label}<SortArrow col={col.key} />
                        </div>
                    ))}
                </div>

                {loading && (
                    <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-tertiary)', fontSize: '13px' }}>
                        {t('common.loading', 'Loading...')}
                    </div>
                )}

                {error && (
                    <div style={{ textAlign: 'center', padding: '24px', color: 'var(--error)', fontSize: '13px' }}>
                        {error}
                    </div>
                )}

                {!loading && paged.map((c: any) => (
                    <div key={c.id} style={{
                        display: 'grid', gridTemplateColumns: gridCols,
                        gap: '12px', padding: '12px 16px', alignItems: 'center',
                        borderBottom: '1px solid var(--border-subtle)', fontSize: '13px',
                        opacity: c.is_active ? 1 : 0.5,
                    }}>
                        <div>
                            <div style={{ fontWeight: 500 }}>{c.name}</div>
                            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: 'monospace' }}>{c.slug}</div>
                        </div>
                        <div>{c.user_count ?? '-'}</div>
                        <div>{c.agent_count ?? '-'}</div>
                        <div style={{ fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
                            {formatTokens(c.total_tokens)}
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            {formatDate(c.created_at)}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span className={`badge ${c.is_active ? 'badge-success' : 'badge-error'}`} style={{ fontSize: '10px' }}>
                                {c.is_active ? t('admin.active', 'Active') : t('admin.disabled', 'Disabled')}
                            </span>
                            <button
                                className="btn btn-ghost"
                                style={{ padding: '2px 6px', fontSize: '10px', color: c.is_active ? 'var(--error)' : 'var(--success)' }}
                                onClick={() => handleToggle(c.id, c.is_active)}
                            >
                                {c.is_active ? t('admin.disable', 'Disable') : t('admin.enable', 'Enable')}
                            </button>
                        </div>
                    </div>
                ))}

                {!loading && companies.length === 0 && !error && (
                    <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-tertiary)', fontSize: '13px' }}>
                        {t('common.noData', 'No data')}
                    </div>
                )}

                {/* Pagination */}
                {!loading && totalPages > 1 && (
                    <div style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '10px 16px', borderTop: '1px solid var(--border-subtle)',
                        fontSize: '12px', color: 'var(--text-tertiary)', background: 'var(--bg-secondary)',
                    }}>
                        <span>
                            {t('admin.showing', '{{start}}-{{end}} of {{total}}', {
                                start: page * PAGE_SIZE + 1,
                                end: Math.min((page + 1) * PAGE_SIZE, sorted.length),
                                total: sorted.length,
                            })}
                        </span>
                        <div style={{ display: 'flex', gap: '4px' }}>
                            <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: '12px' }}
                                disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                                &lsaquo; {t('admin.prev', 'Prev')}
                            </button>
                            <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: '12px' }}
                                disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
                                {t('admin.next', 'Next')} &rsaquo;
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
