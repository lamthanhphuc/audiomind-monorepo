import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowDownUp, CreditCard, RefreshCw, Save, Search, Server, UsersRound, X } from 'lucide-react'
import {
  deployRuntimeConfig,
  getRuntimeConfig,
  listAdminAdvertisements,
  listAdminPlans,
  listAdminTransactions,
  listAdminUsers,
  markBillingOrderPaid,
  saveAdminAdvertisement,
  saveAdminPlan,
  updateRuntimeConfig,
  updateAdminUserPlan,
  updateAdminUserRole,
  updateAdminAdvertisementStatus,
  updateAdminPlanStatus,
  type AdminAdvertisementPayload,
  type AdminPlanPayload,
  type AdminTransaction,
  type AdminUser,
  type AdminPlan,
  type RuntimeConfigItem,
  type RuntimeConfigView,
  type RuntimeDeployResult,
} from '../../services/admin'
import { LoadingState } from '../ui/LoadingState'
import type { SubscriptionPlan } from '../../services/billing'
import type { AdvertisementItem } from '../../services/advertisements'
import './account-scenes.css'

type Props = {
  role?: string
}

type AdminTab = 'users' | 'plans' | 'advertisements' | 'runtimeConfig' | 'billing'
type UserSortOrder = 'NEWEST' | 'OLDEST' | 'NAME_ASC' | 'NAME_DESC'

const formatMoney = (amount: number, currency = 'VND') => (
  currency.toUpperCase() === 'VND'
    ? `${amount.toLocaleString('vi-VN')}đ`
    : `${amount.toLocaleString('vi-VN')} ${currency}`
)

const emptyPlanDraft = (): AdminPlanPayload => ({
  code: '',
  name: '',
  description: '',
  priceVnd: 0,
  currency: 'VND',
  billingPeriod: 'MONTHLY',
  advertisementEnabled: true,
  recordingMinutesLimit: 0,
  aiAnalysisLimit: 0,
  uploadLimit: 0,
  flashcardLimit: 0,
  quizLimit: 0,
  mindmapLimit: 0,
  exportLimit: 0,
  featuresJson: '{}',
  active: true,
  sortOrder: 0,
})

const emptyAdDraft = (): AdminAdvertisementPayload & { id?: number } => ({
  brandName: '',
  title: '',
  description: '',
  mediaUrl: '',
  thumbnailUrl: '',
  targetUrl: '',
  type: 'BANNER',
  placement: 'DASHBOARD',
  duration: null,
  status: 'DRAFT',
  targetPlans: ['FREE'],
  startAt: null,
  endAt: null,
})

const upsertById = <T extends { id: number | string }>(items: T[], item: T): T[] => {
  const id = String(item.id)
  return items.some((current) => String(current.id) === id)
    ? items.map((current) => (String(current.id) === id ? item : current))
    : [item, ...items]
}

const planToDraft = (plan: SubscriptionPlan): AdminPlanPayload => ({ ...plan })

const adToDraft = (ad: AdvertisementItem): AdminAdvertisementPayload & { id?: number } => ({
  id: Number(ad.id),
  brandName: ad.brandName || ad.label || '',
  title: ad.title || '',
  description: ad.body || '',
  mediaUrl: ad.mediaUrl || '',
  thumbnailUrl: ad.thumbnailUrl || '',
  targetUrl: ad.targetUrl || '',
  type: ad.type || 'BANNER',
  placement: ad.placement || 'DASHBOARD',
  duration: ad.duration ?? null,
  status: ad.status || 'DRAFT',
  targetPlans: ad.targetPlans?.length ? ad.targetPlans : ['FREE'],
  startAt: null,
  endAt: null,
})

const getAdvertisementActivationIssue = (ad: Pick<AdvertisementItem, 'brandName' | 'title' | 'mediaUrl' | 'type' | 'duration'>): string => {
  if (!(ad.brandName || '').trim()) return 'Cannot activate: Brand Name is required.'
  if (!(ad.title || '').trim()) return 'Cannot activate: Title is required.'
  if (!(ad.mediaUrl || '').trim()) return 'Cannot activate: Media URL is required.'
  if ((ad.type || '').toUpperCase() === 'VIDEO' && (!ad.duration || ad.duration <= 0)) {
    return 'Cannot activate: Video duration must be greater than 0.'
  }
  return ''
}

function PlanDraftForm({
  draft,
  onChange,
}: {
  draft: AdminPlanPayload
  onChange: (draft: AdminPlanPayload) => void
}) {
  const set = (patch: Partial<AdminPlanPayload>) => onChange({ ...draft, ...patch })
  return (
    <div className="account-config-grid">
      <label className="account-config-field"><span>Plan Name</span><input className="account-input" value={draft.name} onChange={(event) => set({ name: event.target.value })} /></label>
      <label className="account-config-field"><span>Plan Code</span><input className="account-input" value={draft.code} onChange={(event) => set({ code: event.target.value.toUpperCase() })} /></label>
      <label className="account-config-field"><span>Description</span><textarea className="account-textarea" value={draft.description || ''} onChange={(event) => set({ description: event.target.value })} /></label>
      <label className="account-config-field"><span>Price</span><input className="account-input" type="number" min={0} value={draft.priceVnd} onChange={(event) => set({ priceVnd: Number(event.target.value) })} /></label>
      <label className="account-config-field"><span>Currency</span><input className="account-input" value={draft.currency} onChange={(event) => set({ currency: event.target.value.toUpperCase() })} /></label>
      <label className="account-config-field"><span>Billing Period</span><select className="account-select" value={draft.billingPeriod} onChange={(event) => set({ billingPeriod: event.target.value })}><option>MONTHLY</option><option>YEARLY</option><option>ONCE</option></select></label>
      <label className="account-config-field"><span>Advertisement</span><label className="account-inline-control"><input type="checkbox" checked={draft.advertisementEnabled} onChange={(event) => set({ advertisementEnabled: event.target.checked })} /> Allow Advertisement</label></label>
      <label className="account-config-field"><span>Recording minutes</span><input className="account-input" type="number" min={0} value={draft.recordingMinutesLimit} onChange={(event) => set({ recordingMinutesLimit: Number(event.target.value) })} /></label>
      <label className="account-config-field"><span>AI analysis chars</span><input className="account-input" type="number" min={0} value={draft.aiAnalysisLimit} onChange={(event) => set({ aiAnalysisLimit: Number(event.target.value) })} /></label>
      <label className="account-config-field"><span>Upload</span><input className="account-input" type="number" min={0} value={draft.uploadLimit} onChange={(event) => set({ uploadLimit: Number(event.target.value) })} /></label>
      <label className="account-config-field"><span>Flashcard</span><input className="account-input" type="number" min={0} value={draft.flashcardLimit} onChange={(event) => set({ flashcardLimit: Number(event.target.value) })} /></label>
      <label className="account-config-field"><span>Quiz</span><input className="account-input" type="number" min={0} value={draft.quizLimit} onChange={(event) => set({ quizLimit: Number(event.target.value) })} /></label>
      <label className="account-config-field"><span>Mindmap</span><input className="account-input" type="number" min={0} value={draft.mindmapLimit} onChange={(event) => set({ mindmapLimit: Number(event.target.value) })} /></label>
      <label className="account-config-field"><span>Export</span><input className="account-input" type="number" min={0} value={draft.exportLimit} onChange={(event) => set({ exportLimit: Number(event.target.value) })} /></label>
      <label className="account-config-field"><span>Features JSON</span><textarea className="account-textarea" value={draft.featuresJson || '{}'} onChange={(event) => set({ featuresJson: event.target.value })} /></label>
      <label className="account-config-field"><span>Status</span><select className="account-select" value={draft.active ? 'true' : 'false'} onChange={(event) => set({ active: event.target.value === 'true' })}><option value="true">Active</option><option value="false">Inactive</option></select></label>
      <label className="account-config-field"><span>Sort order</span><input className="account-input" type="number" min={0} value={draft.sortOrder} onChange={(event) => set({ sortOrder: Number(event.target.value) })} /></label>
    </div>
  )
}

function AdvertisementDraftForm({
  draft,
  onChange,
  plans,
}: {
  draft: AdminAdvertisementPayload & { id?: number }
  onChange: (draft: AdminAdvertisementPayload & { id?: number }) => void
  plans: SubscriptionPlan[]
}) {
  const set = (patch: Partial<AdminAdvertisementPayload>) => onChange({ ...draft, ...patch })
  const togglePlan = (code: string, checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...draft.targetPlans, code]))
      : draft.targetPlans.filter((item) => item !== code)
    set({ targetPlans: next })
  }
  return (
    <div className="account-config-grid">
      <label className="account-config-field"><span>Brand Name</span><input className="account-input" value={draft.brandName} onChange={(event) => set({ brandName: event.target.value })} /></label>
      <label className="account-config-field"><span>Title</span><input className="account-input" value={draft.title} onChange={(event) => set({ title: event.target.value })} /></label>
      <label className="account-config-field"><span>Description</span><textarea className="account-textarea" value={draft.description || ''} onChange={(event) => set({ description: event.target.value })} /></label>
      <label className="account-config-field"><span>Advertisement Type</span><select className="account-select" value={draft.type} onChange={(event) => set({ type: event.target.value })}><option>BANNER</option><option>VIDEO</option><option>SPONSORED_CONTENT</option></select></label>
      <label className="account-config-field"><span>Placement</span><select className="account-select" value={draft.placement} onChange={(event) => set({ placement: event.target.value })}><option>DASHBOARD</option><option>MEETING_DETAIL</option><option>POST_ANALYSIS</option><option>EXPORT</option></select></label>
      <label className="account-config-field"><span>Media URL</span><input className="account-input" value={draft.mediaUrl || ''} onChange={(event) => set({ mediaUrl: event.target.value })} /></label>
      <label className="account-config-field"><span>Thumbnail URL</span><input className="account-input" value={draft.thumbnailUrl || ''} onChange={(event) => set({ thumbnailUrl: event.target.value })} /></label>
      <label className="account-config-field"><span>Target URL</span><input className="account-input" value={draft.targetUrl || ''} onChange={(event) => set({ targetUrl: event.target.value })} /></label>
      <label className="account-config-field"><span>Duration</span><input className="account-input" type="number" min={0} value={draft.duration ?? 0} onChange={(event) => set({ duration: Number(event.target.value) || null })} /></label>
      <label className="account-config-field"><span>Status</span><select className="account-select" value={draft.status} onChange={(event) => set({ status: event.target.value })}><option>DRAFT</option><option>ACTIVE</option><option>PAUSED</option><option>EXPIRED</option></select></label>
      <label className="account-config-field"><span>Start At</span><input className="account-input" type="datetime-local" value={draft.startAt || ''} onChange={(event) => set({ startAt: event.target.value || null })} /></label>
      <label className="account-config-field"><span>End At</span><input className="account-input" type="datetime-local" value={draft.endAt || ''} onChange={(event) => set({ endAt: event.target.value || null })} /></label>
      <div className="account-config-field">
        <span>Target Plans</span>
        {plans.map((plan) => (
          <label className="account-inline-control" key={plan.code}>
            <input type="checkbox" checked={draft.targetPlans.includes(plan.code)} onChange={(event) => togglePlan(plan.code, event.target.checked)} />
            {plan.name || plan.code}
          </label>
        ))}
      </div>
    </div>
  )
}

export default function AdminDashboardScene({ role = 'USER' }: Props) {
  const isAdmin = role.toUpperCase() === 'ADMIN'
  const [activeTab, setActiveTab] = useState<AdminTab>('users')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [transactions, setTransactions] = useState<AdminTransaction[]>([])
  const [plans, setPlans] = useState<SubscriptionPlan[]>([])
  const [advertisements, setAdvertisements] = useState<AdvertisementItem[]>([])
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfigView | null>(null)
  const [planDraft, setPlanDraft] = useState<AdminPlanPayload>(() => emptyPlanDraft())
  const [adDraft, setAdDraft] = useState<AdminAdvertisementPayload & { id?: number }>(() => emptyAdDraft())
  const [configDrafts, setConfigDrafts] = useState<Record<string, string>>({})
  const [deployTarget, setDeployTarget] = useState<'local' | 'vps'>('local')
  const [deployResult, setDeployResult] = useState<RuntimeDeployResult | null>(null)
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [planFilter, setPlanFilter] = useState('')
  const [userSortOrder, setUserSortOrder] = useState<UserSortOrder>('NEWEST')
  const [selectedUserId, setSelectedUserId] = useState('')
  const [transactionStatus, setTransactionStatus] = useState('')
  const [orderCode, setOrderCode] = useState('')
  const [manualNote, setManualNote] = useState('')
  const [loading, setLoading] = useState(isAdmin)
  const [busyUserId, setBusyUserId] = useState<number | null>(null)
  const [deploying, setDeploying] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const loadUsers = useCallback(async () => {
    if (!isAdmin) return
    setLoading(true)
    setError('')
    try {
      const [loadedUsers, loadedPlans] = await Promise.all([
        listAdminUsers(),
        listAdminPlans(),
      ])
      setUsers(loadedUsers)
      setPlans(loadedPlans)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được danh sách user')
    } finally {
      setLoading(false)
    }
  }, [isAdmin])

  const loadBilling = useCallback(async () => {
    if (!isAdmin) return
    setLoading(true)
    setError('')
    try {
      const parsedUserId = Number(selectedUserId)
      setTransactions(await listAdminTransactions({
        userId: Number.isFinite(parsedUserId) && parsedUserId > 0 ? parsedUserId : undefined,
        status: transactionStatus || undefined,
        limit: 100,
      }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được billing')
    } finally {
      setLoading(false)
    }
  }, [isAdmin, selectedUserId, transactionStatus])

  const loadPlans = useCallback(async () => {
    if (!isAdmin) return
    setLoading(true)
    setError('')
    try {
      setPlans(await listAdminPlans())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được danh sách gói')
    } finally {
      setLoading(false)
    }
  }, [isAdmin])

  const loadAdvertisements = useCallback(async () => {
    if (!isAdmin) return
    setLoading(true)
    setError('')
    try {
      setAdvertisements(await listAdminAdvertisements())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được danh sách quảng cáo')
    } finally {
      setLoading(false)
    }
  }, [isAdmin])

  const loadRuntimeConfig = useCallback(async () => {
    if (!isAdmin) return
    setLoading(true)
    setError('')
    try {
      setRuntimeConfig(await getRuntimeConfig())
      setConfigDrafts({})
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được cấu hình runtime')
    } finally {
      setLoading(false)
    }
  }, [isAdmin])

  const loadCurrentTab = useCallback(async () => {
    if (activeTab === 'runtimeConfig') {
      await loadRuntimeConfig()
      return
    }
    if (activeTab === 'billing') {
      await loadBilling()
      return
    }
    if (activeTab === 'plans') {
      await loadPlans()
      return
    }
    if (activeTab === 'advertisements') {
      await loadAdvertisements()
      return
    }
    await loadUsers()
  }, [activeTab, loadAdvertisements, loadBilling, loadPlans, loadRuntimeConfig, loadUsers])

  useEffect(() => {
    void loadUsers()
  }, [loadUsers])

  useEffect(() => {
    if (activeTab === 'runtimeConfig') void loadRuntimeConfig()
    if (activeTab === 'billing') void loadBilling()
    if (activeTab === 'plans') void loadPlans()
    if (activeTab === 'advertisements') void loadAdvertisements()
  }, [activeTab, loadAdvertisements, loadBilling, loadPlans, loadRuntimeConfig])

  const filteredUsers = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const filtered = users.filter((user) => {
      const matchesQuery = !normalized
        || user.username.toLowerCase().includes(normalized)
        || String(user.email || '').toLowerCase().includes(normalized)
        || String(user.id).includes(normalized)
      const matchesRole = !roleFilter || user.role.toUpperCase() === roleFilter
      const matchesPlan = !planFilter || user.plan.toUpperCase() === planFilter
      return matchesQuery && matchesRole && matchesPlan
    })
    return [...filtered].sort((left, right) => {
      if (userSortOrder === 'NAME_ASC' || userSortOrder === 'NAME_DESC') {
        const result = (left.username || left.email || '').localeCompare(
          right.username || right.email || '',
          'vi',
          { sensitivity: 'base' },
        )
        return userSortOrder === 'NAME_ASC' ? result : -result
      }
      const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0
      const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0
      const result = (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0)
      if (result === 0) return left.id - right.id
      return userSortOrder === 'OLDEST' ? result : -result
    })
  }, [planFilter, query, roleFilter, userSortOrder, users])

  const userPlanOptions = useMemo(() => Array.from(new Set([
    ...plans.map((plan) => plan.code.toUpperCase()),
    ...users.map((user) => user.plan.toUpperCase()),
  ])).filter(Boolean).sort(), [plans, users])

  const resetUserFilters = () => {
    setQuery('')
    setRoleFilter('')
    setPlanFilter('')
    setUserSortOrder('NEWEST')
  }

  const userSummary = useMemo(() => {
    const total = users.length
    const paid = users.filter((user) => user.plan.toUpperCase() !== 'FREE').length
    const admins = users.filter((user) => user.role.toUpperCase() === 'ADMIN').length
    return {
      total,
      visible: filteredUsers.length,
      paid,
      admins,
    }
  }, [filteredUsers.length, users])

  const applyUserUpdate = (updated: AdminUser) => {
    setUsers((items) => items.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)))
  }

  const handlePlanChange = async (user: AdminUser, plan: AdminPlan) => {
    if (!window.confirm(`Xác nhận đổi gói user "${user.username || user.email || user.id}" sang ${plan}?`)) return
    setBusyUserId(user.id)
    setError('')
    setNotice('')
    try {
      applyUserUpdate(await updateAdminUserPlan(user.id, plan))
      setNotice('Đã cập nhật gói người dùng.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không cập nhật được gói')
    } finally {
      setBusyUserId(null)
    }
  }

  const handleRoleChange = async (user: AdminUser, nextRole: 'USER' | 'ADMIN') => {
    if (!window.confirm(`Thao tác nhạy cảm: xác nhận đổi quyền user "${user.username || user.email || user.id}" sang ${nextRole}?`)) return
    setBusyUserId(user.id)
    setError('')
    setNotice('')
    try {
      applyUserUpdate(await updateAdminUserRole(user.id, nextRole))
      setNotice('Đã cập nhật quyền người dùng.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không cập nhật được quyền')
    } finally {
      setBusyUserId(null)
    }
  }

  const handleConfigDraftChange = (key: string, value: string) => {
    setConfigDrafts((current) => ({ ...current, [key]: value }))
  }

  const handleSavePlan = async () => {
    setError('')
    setNotice('')
    try {
      const saved = await saveAdminPlan(planDraft)
      setPlans((items) => upsertById(items, saved))
      setPlanDraft(emptyPlanDraft())
      setNotice('Đã lưu gói subscription.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không lưu được gói')
    }
  }

  const handlePlanStatus = async (plan: SubscriptionPlan, active: boolean) => {
    setError('')
    setNotice('')
    try {
      const saved = await updateAdminPlanStatus(plan.id, active)
      setPlans((items) => upsertById(items, saved))
      setNotice(active ? 'Đã kích hoạt gói.' : 'Đã tắt gói.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không cập nhật được gói')
    }
  }

  const handleSaveAdvertisement = async () => {
    setError('')
    setNotice('')
    if ((adDraft.status || '').toUpperCase() === 'ACTIVE') {
      const issue = getAdvertisementActivationIssue(adDraft)
      if (issue) {
        setError(issue)
        return
      }
    }
    try {
      const saved = await saveAdminAdvertisement(adDraft)
      setAdvertisements((items) => upsertById(items, saved))
      setAdDraft(emptyAdDraft())
      setNotice('Đã lưu quảng cáo.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không lưu được quảng cáo')
    }
  }

  const handleAdvertisementStatus = async (ad: AdvertisementItem, status: string) => {
    setError('')
    setNotice('')
    if (status.toUpperCase() === 'ACTIVE') {
      const issue = getAdvertisementActivationIssue(ad)
      if (issue) {
        setError(issue)
        return
      }
    }
    try {
      const saved = await updateAdminAdvertisementStatus(Number(ad.id), status)
      setAdvertisements((items) => upsertById(items, saved))
      setNotice('Đã cập nhật trạng thái quảng cáo.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không cập nhật được quảng cáo')
    }
  }

  const nonEmptyConfigDrafts = () => Object.fromEntries(
    Object.entries(configDrafts).filter(([, value]) => value.trim().length > 0),
  )

  const handleSaveRuntimeConfig = async (deploy: boolean) => {
    const values = nonEmptyConfigDrafts()
    if (Object.keys(values).length === 0) {
      setError('Nhập ít nhất một giá trị cấu hình cần cập nhật.')
      return
    }
    if (deploy && !window.confirm(`Lưu cấu hình và deploy lại ${deployTarget.toUpperCase()} cho ai-api/celery-worker?`)) return
    setDeploying(deploy)
    setError('')
    setNotice('')
    setDeployResult(null)
    try {
      const result = await updateRuntimeConfig({ values, deploy, deployTarget })
      setRuntimeConfig(result.config)
      setConfigDrafts({})
      if (result.deploy) {
        setDeployResult(result.deploy)
      }
      setNotice(deploy ? 'Đã lưu cấu hình và chạy deploy.' : 'Đã lưu cấu hình runtime.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không lưu được cấu hình runtime')
    } finally {
      setDeploying(false)
    }
  }

  const handleDeployRuntimeConfig = async () => {
    if (!window.confirm(`Deploy lại ${deployTarget.toUpperCase()} cho ai-api/celery-worker?`)) return
    setDeploying(true)
    setError('')
    setNotice('')
    setDeployResult(null)
    try {
      const result = await deployRuntimeConfig({ target: deployTarget, services: ['ai-api', 'celery-worker'] })
      setDeployResult(result)
      setNotice(result.success ? 'Deploy hoàn tất.' : 'Deploy thất bại, xem log bên dưới.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không deploy được cấu hình runtime')
    } finally {
      setDeploying(false)
    }
  }

  const groupedRuntimeConfig = useMemo(() => {
    const groups = new Map<string, RuntimeConfigItem[]>()
    runtimeConfig?.items.forEach((item) => {
      const current = groups.get(item.group) ?? []
      current.push(item)
      groups.set(item.group, current)
    })
    return Array.from(groups.entries())
  }, [runtimeConfig])

  const handleManualPaid = async () => {
    const parsed = Number(orderCode)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('OrderCode không hợp lệ.')
      return
    }
    if (!window.confirm(`Xác nhận manual paid cho orderCode ${parsed}? Hành động này sẽ được audit.`)) return
    setError('')
    setNotice('')
    try {
      const result = await markBillingOrderPaid(parsed, manualNote.trim() || 'Manual paid from admin UI')
      setNotice(result.message || `Đã ghi nhận thanh toán thủ công cho orderCode ${result.orderCode}.`)
      setOrderCode('')
      setManualNote('')
      await loadBilling()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không ghi nhận được thanh toán thủ công')
    }
  }

  if (!isAdmin) {
    return (
      <section className="feature-scene account-scene admin-console">
        <div className="account-warning">
          <strong>Không có quyền admin.</strong> Màn này chỉ hiển thị cho tài khoản có JWT role ADMIN.
        </div>
      </section>
    )
  }

  return (
    <section className="feature-scene account-scene admin-console" data-testid="admin-dashboard-scene">
      <header className="account-scene__hero">
        <div>
          <p className="account-scene__eyebrow">Admin console</p>
          <h1>Quản trị vận hành</h1>
          <p className="account-scene__subtitle">Quản lý người dùng, cấu hình runtime Deepgram/Gemini và billing.</p>
        </div>
        <button type="button" className="btn btn--secondary" onClick={() => void loadCurrentTab()} disabled={loading}>
          <RefreshCw size={16} aria-hidden /> Làm mới
        </button>
      </header>

      <div className="account-warning">
        <AlertTriangle size={16} aria-hidden /> Các thao tác role, plan, cấu hình và billing là thao tác nhạy cảm. Backend đã ghi audit log lâu dài.
      </div>
      {notice && <div className="account-notice" role="status">{notice}</div>}
      {error && <div className="account-error" role="alert">{error}</div>}

      <div className="account-tabs" role="tablist" aria-label="Admin sections">
        <button type="button" className="account-tab" data-active={activeTab === 'users'} onClick={() => setActiveTab('users')}>
          <UsersRound size={16} aria-hidden /> Người dùng
        </button>
        <button type="button" className="account-tab" data-active={activeTab === 'plans'} onClick={() => setActiveTab('plans')}>
          <CreditCard size={16} aria-hidden /> Plans
        </button>
        <button type="button" className="account-tab" data-active={activeTab === 'advertisements'} onClick={() => setActiveTab('advertisements')}>
          <CreditCard size={16} aria-hidden /> Advertisements
        </button>
        <button type="button" className="account-tab" data-active={activeTab === 'runtimeConfig'} onClick={() => setActiveTab('runtimeConfig')}>
          <Server size={16} aria-hidden /> Cấu hình & deploy
        </button>
        <button type="button" className="account-tab" data-active={activeTab === 'billing'} onClick={() => setActiveTab('billing')}>
          <CreditCard size={16} aria-hidden /> Billing
        </button>
      </div>

      {activeTab === 'users' && (
        <article className="account-card account-card--wide">
          <h2>Danh sách người dùng</h2>
          <div className="account-summary-row" aria-label="Tổng quan người dùng">
            <div className="account-summary-item">
              <span className="account-summary-item__value">{userSummary.total.toLocaleString('vi-VN')}</span>
              <span className="account-summary-item__label">Tổng user</span>
            </div>
            <div className="account-summary-item">
              <span className="account-summary-item__value">{userSummary.visible.toLocaleString('vi-VN')}</span>
              <span className="account-summary-item__label">Đang hiển thị</span>
            </div>
            <div className="account-summary-item">
              <span className="account-summary-item__value">{userSummary.paid.toLocaleString('vi-VN')}</span>
              <span className="account-summary-item__label">Gói trả phí</span>
            </div>
            <div className="account-summary-item">
              <span className="account-summary-item__value">{userSummary.admins.toLocaleString('vi-VN')}</span>
              <span className="account-summary-item__label">Admin</span>
            </div>
          </div>
          <div className="account-filter-row">
            <label className="account-filter-search">
              <Search size={16} aria-hidden />
              <input
                className="account-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Tìm theo tên, email hoặc mã user"
                aria-label="Tìm người dùng"
              />
            </label>
            <label className="account-filter-control">
              <span>Vai trò</span>
              <select className="account-select" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
                <option value="">Tất cả</option>
                <option value="USER">User</option>
                <option value="ADMIN">Admin</option>
              </select>
            </label>
            <label className="account-filter-control">
              <span>Gói</span>
              <select className="account-select" value={planFilter} onChange={(event) => setPlanFilter(event.target.value)}>
                <option value="">Tất cả</option>
                {userPlanOptions.map((plan) => <option key={plan} value={plan}>{plan}</option>)}
              </select>
            </label>
            <label className="account-filter-control">
              <span><ArrowDownUp size={14} aria-hidden /> Sắp xếp</span>
              <select className="account-select" value={userSortOrder} onChange={(event) => setUserSortOrder(event.target.value as UserSortOrder)}>
                <option value="NEWEST">Mới đăng ký</option>
                <option value="OLDEST">Đăng ký lâu nhất</option>
                <option value="NAME_ASC">Tên A-Z</option>
                <option value="NAME_DESC">Tên Z-A</option>
              </select>
            </label>
            <button
              type="button"
              className="btn btn--secondary account-filter-reset"
              onClick={resetUserFilters}
              aria-label="Xóa bộ lọc"
              title="Xóa bộ lọc"
            >
              <X size={16} aria-hidden />
            </button>
            <span className="account-muted">
              {userSummary.visible.toLocaleString('vi-VN')} / {userSummary.total.toLocaleString('vi-VN')} người dùng
            </span>
          </div>
          {loading ? (
            <LoadingState message="Đang tải danh sách user..." />
          ) : (
            <div className="account-table-wrap">
              <table className="account-table">
                <thead><tr><th>#</th><th>User</th><th>Email</th><th>Đăng ký</th><th>Role</th><th>Plan</th><th>Thao tác</th></tr></thead>
                <tbody>
                  {filteredUsers.map((user, index) => (
                    <tr key={user.id}>
                      <td className="account-table__index">{index + 1}</td>
                      <td>{user.username || `User #${user.id}`}</td>
                      <td>{user.email || 'Chưa có email'}</td>
                      <td>{user.createdAt ? new Date(user.createdAt).toLocaleString('vi-VN') : 'Không rõ'}</td>
                      <td><span className="account-badge">{user.role}</span></td>
                      <td><span className="account-badge">{user.plan}</span></td>
                      <td>
                        <div className="account-actions">
                          <select
                            className="account-input account-input--compact"
                            value={user.plan}
                            disabled={busyUserId === user.id}
                            onChange={(event) => void handlePlanChange(user, event.target.value)}
                            aria-label={`Đổi gói cho ${user.username || user.email || user.id}`}
                          >
                            {(plans.length > 0 ? plans : [{ code: user.plan, name: user.plan }]).map((plan) => (
                              <option key={plan.code} value={plan.code}>{plan.name}</option>
                            ))}
                          </select>
                          <button type="button" className="btn btn--secondary" disabled={busyUserId === user.id || user.role === 'ADMIN'} onClick={() => void handleRoleChange(user, 'ADMIN')}>Make Admin</button>
                          <button type="button" className="btn btn--secondary" disabled={busyUserId === user.id || user.role === 'USER'} onClick={() => void handleRoleChange(user, 'USER')}>Make User</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredUsers.length === 0 && <div className="account-empty">Không có user phù hợp.</div>}
            </div>
          )}
        </article>
      )}

      {activeTab === 'plans' && (
        <div className="account-grid">
          <article className="account-card">
            <h2>{planDraft.id ? 'Sửa plan' : 'Tạo plan'}</h2>
            <PlanDraftForm draft={planDraft} onChange={setPlanDraft} />
            <div className="account-actions">
              <button type="button" className="btn btn--secondary" onClick={() => setPlanDraft(emptyPlanDraft())}>Mới</button>
              <button type="button" className="btn btn--primary" onClick={() => void handleSavePlan()}>Lưu plan</button>
            </div>
          </article>
          <article className="account-card account-card--wide">
            <h2>Subscription Plans</h2>
            {loading ? <LoadingState message="Đang tải plans..." /> : (
              <div className="account-table-wrap">
                <table className="account-table">
                  <thead><tr><th>Name</th><th>Code</th><th>Price</th><th>Ads</th><th>Quota</th><th>Status</th><th>Action</th></tr></thead>
                  <tbody>
                    {plans.map((plan) => (
                      <tr key={plan.id}>
                        <td>{plan.name}</td>
                        <td><span className="account-badge">{plan.code}</span></td>
                        <td>{formatMoney(plan.priceVnd, plan.currency)}</td>
                        <td>{plan.advertisementEnabled ? 'Yes' : 'No'}</td>
                        <td>{plan.recordingMinutesLimit} phút / {plan.aiAnalysisLimit.toLocaleString('vi-VN')} chars</td>
                        <td><span className="account-badge">{plan.active ? 'Active' : 'Inactive'}</span></td>
                        <td>
                          <div className="account-actions">
                            <button type="button" className="btn btn--secondary" onClick={() => setPlanDraft(planToDraft(plan))}>Edit</button>
                            <button type="button" className="btn btn--secondary" onClick={() => void handlePlanStatus(plan, !plan.active)}>
                              {plan.active ? 'Deactivate' : 'Activate'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </article>
        </div>
      )}

      {activeTab === 'advertisements' && (
        <div className="account-grid">
          <article className="account-card">
            <h2>{adDraft.id ? 'Sửa quảng cáo' : 'Tạo quảng cáo'}</h2>
            <AdvertisementDraftForm draft={adDraft} onChange={setAdDraft} plans={plans.length ? plans : [
              { code: 'FREE', name: 'Free' } as SubscriptionPlan,
              { code: 'STANDARD', name: 'Standard' } as SubscriptionPlan,
              { code: 'PREMIUM', name: 'Premium' } as SubscriptionPlan,
            ]} />
            <div className="account-actions">
              <button type="button" className="btn btn--secondary" onClick={() => setAdDraft(emptyAdDraft())}>Mới</button>
              <button type="button" className="btn btn--primary" onClick={() => void handleSaveAdvertisement()}>Lưu quảng cáo</button>
            </div>
          </article>
          <article className="account-card account-card--wide">
            <h2>Advertisements</h2>
            {loading ? <LoadingState message="Đang tải advertisements..." /> : (
              <div className="account-table-wrap">
                <table className="account-table">
                  <thead><tr><th>Brand</th><th>Title</th><th>Type</th><th>Placement</th><th>Target</th><th>Status</th><th>Actions</th></tr></thead>
                  <tbody>
                    {advertisements.map((ad) => (
                      <tr key={ad.id}>
                        <td>{ad.brandName || ad.label}</td>
                        <td>{ad.title}</td>
                        <td>{ad.type}</td>
                        <td>{ad.placement}</td>
                        <td>{ad.targetPlans?.join(', ')}</td>
                        <td><span className="account-badge">{ad.status}</span></td>
                        <td>
                          <div className="account-actions">
                            <button type="button" className="btn btn--secondary" onClick={() => setAdDraft(adToDraft(ad))}>Edit</button>
                            <button type="button" className="btn btn--secondary" onClick={() => void handleAdvertisementStatus(ad, 'ACTIVE')}>Activate</button>
                            <button type="button" className="btn btn--secondary" onClick={() => void handleAdvertisementStatus(ad, 'PAUSED')}>Pause</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {advertisements.length === 0 && <div className="account-empty">Chưa có quảng cáo.</div>}
              </div>
            )}
          </article>
        </div>
      )}

      {activeTab === 'runtimeConfig' && (
        <article className="account-card account-card--wide">
          <h2><Server size={18} aria-hidden /> Cấu hình runtime</h2>
          <p className="account-muted">
            Lưu vào {runtimeConfig?.envFile || 'infra/.env'} rồi deploy lại đúng container nhận Deepgram/Gemini.
          </p>
          <div className="account-filter-row">
            <label className="account-inline-control">
              <span>Môi trường</span>
              <select className="account-select" value={deployTarget} onChange={(event) => setDeployTarget(event.target.value as 'local' | 'vps')}>
                <option value="local">Local</option>
                <option value="vps">VPS</option>
              </select>
            </label>
            <button type="button" className="btn btn--secondary" onClick={() => void loadRuntimeConfig()} disabled={loading || deploying}>
              <RefreshCw size={16} aria-hidden /> Tải lại
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => void handleSaveRuntimeConfig(false)} disabled={loading || deploying}>
              <Save size={16} aria-hidden /> Lưu env
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void handleSaveRuntimeConfig(true)} disabled={loading || deploying}>
              Lưu & deploy
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => void handleDeployRuntimeConfig()} disabled={loading || deploying}>
              Deploy lại
            </button>
          </div>
          {loading ? <LoadingState message="Đang tải cấu hình runtime..." /> : (
            <div className="account-config-groups">
              {groupedRuntimeConfig.map(([group, items]) => (
                <section key={group} className="account-config-group">
                  <h3>{group === 'STT' ? 'Deepgram / STT' : 'Gemini / AI'}</h3>
                  <div className="account-config-grid">
                    {items.map((item) => (
                      <label key={item.key} className="account-config-field">
                        <span>{item.label}</span>
                        <input
                          className="account-input"
                          type={item.secret ? 'password' : 'text'}
                          value={configDrafts[item.key] ?? ''}
                          onChange={(event) => handleConfigDraftChange(item.key, event.target.value)}
                          placeholder={item.secret && item.configured ? item.value : (item.value || item.key)}
                        />
                        <small>{item.key}{item.configured ? ' - đang có cấu hình' : ' - chưa cấu hình'}</small>
                      </label>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
          {deployResult && (
            <div className="account-deploy-log" data-success={deployResult.success}>
              <strong>{deployResult.success ? 'Deploy thành công' : 'Deploy chưa thành công'}: {deployResult.services.join(', ')}</strong>
              {deployResult.commands.map((command, index) => (
                <pre key={`${command.exitCode}-${index}`}>{`$ ${command.command.join(' ')}\nexit ${command.exitCode}\n${command.output || ''}`}</pre>
              ))}
            </div>
          )}
        </article>
      )}

      {activeTab === 'billing' && (
        <div className="account-grid">
          <article className="account-card">
            <h2><CreditCard size={18} aria-hidden /> Manual paid</h2>
            <label className="account-setting">
              <span>OrderCode</span>
              <input className="account-input" value={orderCode} onChange={(event) => setOrderCode(event.target.value)} inputMode="numeric" />
            </label>
            <label className="account-setting">
              <span>Ghi chú audit</span>
              <textarea className="account-textarea" value={manualNote} onChange={(event) => setManualNote(event.target.value)} />
            </label>
            <button type="button" className="btn btn--primary" onClick={() => void handleManualPaid()}>
              Xác nhận paid
            </button>
          </article>
          <article className="account-card account-card--wide">
            <h2>Giao dịch / hóa đơn</h2>
            <div className="account-filter-row">
              <select className="account-select" value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)}>
                <option value="">Tất cả billing</option>
                {users.map((user) => <option key={user.id} value={user.id}>{user.username || user.email || `User #${user.id}`}</option>)}
              </select>
              <select className="account-select" value={transactionStatus} onChange={(event) => setTransactionStatus(event.target.value)}>
                <option value="">Tất cả trạng thái</option>
                <option value="PENDING">Pending</option>
                <option value="PAID">Paid</option>
                <option value="CANCELLED">Cancelled</option>
                <option value="EXPIRED">Expired</option>
              </select>
              <button type="button" className="btn btn--secondary" onClick={() => void loadBilling()} disabled={loading}>Lọc</button>
            </div>
            {loading ? <LoadingState message="Đang tải billing..." /> : (
              <div className="account-table-wrap">
                <table className="account-table">
                  <thead><tr><th>Order</th><th>User</th><th>Số tiền</th><th>Trạng thái</th><th>Provider</th><th>Tạo lúc</th><th>Paid</th><th>Ghi chú</th></tr></thead>
                  <tbody>
                    {transactions.map((tx) => (
                      <tr key={tx.id}>
                        <td>#{tx.orderCode}</td>
                        <td>{tx.userId}</td>
                        <td>{formatMoney(tx.amountVnd, tx.currency)}</td>
                        <td><span className="account-badge">{tx.status}</span></td>
                        <td>{tx.provider}</td>
                        <td>{tx.createdAt ? new Date(tx.createdAt).toLocaleString('vi-VN') : ''}</td>
                        <td>{tx.paidAt ? new Date(tx.paidAt).toLocaleString('vi-VN') : ''}</td>
                        <td>{tx.manualNote || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {transactions.length === 0 && <div className="account-empty">Không có giao dịch phù hợp.</div>}
              </div>
            )}
          </article>
        </div>
      )}

    </section>
  )
}

