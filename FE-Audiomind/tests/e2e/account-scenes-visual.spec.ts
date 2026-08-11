import { expect, test, type Page } from '@playwright/test'

const makeJwt = () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    userId: 1,
    sub: '1',
    role: 'ADMIN',
    plan: 'PRO',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.signature`
}

const analysisPayload = {
  meetingId: 101,
  status: 'COMPLETED',
  domainMode: 'business',
  summary: 'Cuoc hop thong nhat uu tien san pham, quota, va ke hoach ra mat.',
  keyPoints: [
    'Workspace members co the xem meeting trong cung workspace.',
    'API key da co scope read/write/admin va can audit theo key.',
    'Admin can quan ly user, giao dich va API key tai mot noi.',
  ],
  actionItems: [
    { task: 'Kiem tra visual light/dark tren mobile', owner: 'QA', deadline: '2026-07-24' },
    { task: 'Xac minh invite workspace het han dung policy', owner: 'Backend', deadline: '2026-07-25' },
  ],
  decisions: ['Dung workspace permission lam lop xem meeting bo sung cho meeting share.'],
  transcriptHighlights: [
    { text: 'Can giu UI khong lo ID ky thuat.', start: 12, end: 22 },
  ],
}

const transcriptPayload = {
  meeting_id: 101,
  transcript: 'Speaker 1: Chung ta can kiem tra giao dien admin, team, profile va ket qua phan tich tren mobile.',
  segments: Array.from({ length: 18 }, (_, index) => ({
    id: `seg-${index + 1}`,
    speaker: `Speaker ${(index % 3) + 1}`,
    text: `Noi dung kiem thu visual dong ${index + 1}: dam bao co cuon va khong tran ngang.`,
    start: index * 8,
    end: index * 8 + 6,
  })),
}

const workspaceSummary = {
  workspace: { id: 44, name: 'AudioMind Product Workspace', ownerUserId: 1, createdAt: '2026-07-20T09:00:00Z' },
  ownedMeetingCount: 18,
  sharedWithMeCount: 7,
  members: [
    { userId: 1, username: 'admin', email: 'admin@audiomind.local', role: 'OWNER' },
    { userId: 2, username: 'product', email: 'product@audiomind.local', role: 'ADMIN' },
    { userId: 3, username: 'qa', email: 'qa@audiomind.local', role: 'EDITOR' },
    { userId: 4, username: 'viewer', email: 'viewer@audiomind.local', role: 'VIEWER' },
  ],
  pendingInvites: [
    { id: 501, workspaceId: 44, email: 'new-user@audiomind.local', role: 'VIEWER', status: 'PENDING' },
  ],
  myPendingInvites: [
    { id: 502, workspaceId: 45, email: 'admin@audiomind.local', role: 'ADMIN', status: 'PENDING' },
  ],
  sharedMeetings: [
    { meetingId: 101, title: 'Weekly product review', shareCount: 3, createdAt: '2026-07-21T10:00:00Z' },
    { meetingId: 102, title: 'Quota planning', shareCount: 2, createdAt: '2026-07-22T10:00:00Z' },
  ],
}

const users = [
  { id: 1, username: 'admin', email: 'admin@audiomind.local', plan: 'PRO', role: 'ADMIN', createdAt: '2026-07-01T00:00:00Z' },
  { id: 2, username: 'student', email: 'student@audiomind.local', plan: 'FREE', role: 'USER', createdAt: '2026-07-02T00:00:00Z' },
  { id: 3, username: 'operator', email: 'operator@audiomind.local', plan: 'PRO', role: 'USER', createdAt: '2026-07-03T00:00:00Z' },
]

async function installMockApi(page: Page) {
  await page.route(/http:\/\/localhost:(8081|8082|8083|8000|8001)\/.*/, async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const method = route.request().method()

    if (path === '/api/users/me') {
      await route.fulfill({ json: { userId: 1, username: 'admin', email: 'admin@audiomind.local', plan: 'PRO', role: 'ADMIN', domainMode: 'business' } })
      return
    }
    if (path.includes('/integrations/status')) {
      await route.fulfill({ json: { google: { linked: true }, zoom: { linked: false }, teams: { linked: false } } })
      return
    }
    if (path === '/api/workspaces/me') {
      await route.fulfill({ json: workspaceSummary })
      return
    }
    if (path === '/subjects' || path === '/meetings/unclassified') {
      await route.fulfill({ json: { items: [], page: 1, pageSize: 10, totalItems: 0, totalPages: 0 } })
      return
    }
    if (path === '/study-folders/tree') {
      await route.fulfill({ json: { folders: [], rootSubjects: [] } })
      return
    }
    if (path === '/study-folders') {
      await route.fulfill({ json: [] })
      return
    }
    if (path === '/api/users/refresh-token') {
      await route.fulfill({ json: { userId: 1, accessToken: makeJwt(), expiresInSeconds: 3600 } })
      return
    }
    if (path === '/api/users/me/jobs') {
      await route.fulfill({ json: { items: [] } })
      return
    }
    if (path === '/api/users/me/notifications/unread-count') {
      await route.fulfill({ json: { unreadCount: 0 } })
      return
    }
    if (path === '/api/billing/me') {
      await route.fulfill({ json: { plan: 'PRO', status: 'ACTIVE', quota: { sttSecondsUsed: 3720, sttSecondsLimit: 18000, geminiInputCharsUsed: 160000, geminiInputCharsLimit: 1000000 } } })
      return
    }
    if (path === '/api/users/me/notifications/stream') {
      await route.fulfill({ status: 204 })
      return
    }
    if (path === '/api/admin/users') {
      await route.fulfill({ json: users })
      return
    }
    if (path === '/api/admin/kpis') {
      await route.fulfill({ json: { registeredUsers: 35, activeUsers: 12, fullWorkflowCompletion: 8, payingCustomers: 7, revenue: 553000, currency: 'VND', activeUsersWindowDays: 30 } })
      return
    }
    if (path === '/api/admin/analytics/website-traffic') {
      await route.fulfill({ json: {
        visits: 11,
        uniqueVisitors: 9,
        todayVisits: 3,
        todayUniqueVisitors: 2,
        observationStart: '2026-08-08T21:05:42+07:00',
        observationEnd: '2026-08-11T11:30:00+07:00',
        source: 'nginx_access_log',
        partialHistory: true,
        timezone: 'Asia/Ho_Chi_Minh',
        daily: [
          { date: '2026-08-08', visits: 1, uniqueVisitors: 1 },
          { date: '2026-08-09', visits: 6, uniqueVisitors: 6 },
          { date: '2026-08-10', visits: 1, uniqueVisitors: 1 },
          { date: '2026-08-11', visits: 3, uniqueVisitors: 2 },
        ],
      } })
      return
    }
    if (path.includes('/api-keys')) {
      await route.fulfill({ json: { items: [{ id: 91, userId: 1, name: 'CI smoke key', prefix: 'ak_live', suffix: '9xyz', scopes: 'read,write', lastUsedAt: '2026-07-22T10:00:00Z' }] } })
      return
    }
    if (path === '/api/admin/billing/transactions') {
      await route.fulfill({ json: { items: [
        { id: 71, userId: 1, username: 'admin', email: 'admin@audiomind.local', provider: 'PAYOS', orderCode: 2026072301, amountVnd: 79000, currency: 'VND', status: 'PAID', createdAt: '2026-07-23T07:00:00Z', paidAt: '2026-07-23T07:05:00Z' },
        { id: 72, userId: 2, username: 'student', email: 'student@audiomind.local', provider: 'PAYOS', orderCode: 2026072302, amountVnd: 79000, currency: 'VND', status: 'PENDING', createdAt: '2026-07-23T08:00:00Z' },
      ] } })
      return
    }
    if (path === '/api/admin/audit-events') {
      await route.fulfill({ json: { items: [{ id: 1, eventType: 'API_KEY_USED', summary: 'API key used by meeting-service', createdAt: '2026-07-23T08:00:00Z' }] } })
      return
    }
    if (path === '/api/users/me/usage') {
      await route.fulfill({ json: {
        snapshot: { plan: 'PRO', periodYyyymm: '202607', sttSecondsUsed: 3720, sttSecondsLimit: 18000, geminiInputCharsUsed: 160000, geminiInputCharsLimit: 1000000 },
        daily: Array.from({ length: 14 }, (_, index) => ({ day: `2026-07-${String(index + 9).padStart(2, '0')}`, sttSeconds: 240 + index * 30, geminiChars: 8000 + index * 1200, deniedCount: index % 5 === 0 ? 1 : 0 })),
        events: Array.from({ length: 18 }, (_, index) => ({ id: index + 1, createdAt: '2026-07-23T08:00:00Z', quotaType: index % 2 === 0 ? 'STT' : 'GEMINI', status: 'CONSUMED', sttSecondsDelta: 80, geminiCharsDelta: 1500 })),
      } })
      return
    }
    if (path === '/meetings' || path === '/meetings/recent') {
      await route.fulfill({ json: [{ id: 101, title: 'Weekly product review', ownerUserId: 1, status: 'completed', createdAt: '2026-07-23T07:00:00Z' }] })
      return
    }
    if (path === '/meetings/101') {
      await route.fulfill({ json: { id: 101, title: 'Weekly product review', ownerUserId: 1, status: 'completed', createdAt: '2026-07-23T07:00:00Z' } })
      return
    }
    if (/\/processing\/101\/analysis(\/saved)?$/.test(path)) {
      await route.fulfill({ json: analysisPayload })
      return
    }
    if (path === '/processing/101/transcript') {
      await route.fulfill({ json: transcriptPayload })
      return
    }
    if (path === '/processing/101/status') {
      await route.fulfill({ json: { meeting_id: 101, status: 'COMPLETED', updated_at: '2026-07-23T08:00:00Z' } })
      return
    }
    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204 })
      return
    }
    await route.fulfill({ json: {} })
  })
}

async function authenticate(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript(({ token, mode }) => {
    window.localStorage.setItem('audiomind.access_token', token)
    window.localStorage.setItem('audiomind.theme', mode)
  }, { token: makeJwt(), mode: theme })
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => Math.max(
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
    document.body.scrollWidth - document.body.clientWidth,
  ))
  expect(overflow).toBeLessThanOrEqual(2)
}

async function expectScrollable(page: Page) {
  const scrollable = await page.evaluate(() => {
    if (document.documentElement.scrollHeight > document.documentElement.clientHeight + 8) {
      return true
    }
    return Array.from(document.querySelectorAll<HTMLElement>('body *')).some((element) => (
      element.scrollHeight > element.clientHeight + 8
      && window.getComputedStyle(element).overflowY !== 'hidden'
    ))
  })
  expect(scrollable).toBeTruthy()
}

test.describe('Account and analysis visual QA', () => {
  const scenes = [
    { name: 'profile', url: '/studio/profile', selector: '[data-testid="profile-scene"]', shouldScrollOnMobile: false },
    { name: 'team', url: '/studio/team', selector: '[data-testid="team-workspace-scene"]', shouldScrollOnMobile: true },
    { name: 'admin', url: '/studio/admin', selector: '[data-testid="admin-dashboard-scene"]', shouldScrollOnMobile: true },
    { name: 'usage', url: '/studio/usage', selector: '[data-testid="usage-scene"]', shouldScrollOnMobile: true },
    { name: 'analysis', url: '/studio/analysis?meetingId=101', selector: '[data-testid="e2e-transcript"]', shouldScrollOnMobile: true },
  ]

  for (const theme of ['light', 'dark'] as const) {
    for (const scene of scenes) {
      test(`${scene.name} renders in ${theme} mode`, async ({ page }, testInfo) => {
        await installMockApi(page)
        await authenticate(page, theme)
        await page.goto(scene.url, { waitUntil: 'domcontentloaded' })
        await expect(page.locator(scene.selector).first()).toBeVisible({ timeout: 30_000 })
        await expectNoHorizontalOverflow(page)
        await testInfo.attach(`${scene.name}-${theme}-desktop`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
      })
    }
  }

  for (const scene of scenes.filter((item) => item.shouldScrollOnMobile)) {
    test(`${scene.name} supports mobile vertical scroll`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 390, height: 520 })
      await installMockApi(page)
      await authenticate(page, 'light')
      await page.goto(scene.url, { waitUntil: 'domcontentloaded' })
      await expect(page.locator(scene.selector).first()).toBeVisible({ timeout: 30_000 })
      await expectNoHorizontalOverflow(page)
      await expectScrollable(page)
      await testInfo.attach(`${scene.name}-mobile-light`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      })
    })
  }
})
