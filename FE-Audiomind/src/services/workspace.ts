import { getAccessToken } from './auth'
import { USER_API_BASE } from './config'

export type WorkspaceMember = {
  id?: number
  workspaceId?: number
  userId: number
  username?: string
  email?: string
  role: string
  createdAt?: string
}

export type WorkspaceInvite = {
  id?: number
  workspaceId?: number
  email: string
  role: string
  status?: string
  createdAt?: string
}

export type WorkspaceSummary = {
  workspace?: { id: number; name: string; ownerUserId: number; createdAt?: string }
  ownedMeetingCount?: number
  sharedWithMeCount?: number
  members: WorkspaceMember[]
  pendingInvites: WorkspaceInvite[]
  myPendingInvites?: WorkspaceInvite[]
  sharedMeetings: Array<{ meetingId: number; title?: string; shareCount?: number; createdAt?: string }>
  meetingShareMembers?: Array<{ userId: number; role: string; meetingId: number; createdAt?: string }>
  meetingShareInvites?: Array<{ email: string; role: string; meetingId: number; createdAt?: string }>
  error?: string
  meetingShareError?: string
}

const authHeaders = (): HeadersInit => {
  const token = getAccessToken()
  if (!token) throw new Error('Phiên đăng nhập đã hết hạn')
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

const readMessage = async (response: Response, fallback: string) => {
  try {
    const body = await response.json() as { message?: string; error?: string }
    return body.message || body.error || fallback
  } catch {
    return fallback
  }
}

export const getWorkspaceSummary = async (): Promise<WorkspaceSummary> => {
  const response = await fetch(`${USER_API_BASE}/api/workspaces/me`, {
    headers: authHeaders(),
  })
  if (!response.ok) throw new Error(await readMessage(response, 'Không tải được workspace'))
  return response.json() as Promise<WorkspaceSummary>
}

export const renameWorkspace = async (
  workspaceId: number,
  name: string,
): Promise<WorkspaceSummary['workspace']> => {
  const response = await fetch(`${USER_API_BASE}/api/workspaces/${workspaceId}`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ name }),
  })
  if (!response.ok) throw new Error(await readMessage(response, 'Không đổi được tên workspace'))
  return response.json() as Promise<WorkspaceSummary['workspace']>
}

export const inviteWorkspaceMember = async (
  workspaceId: number,
  payload: { email: string; role: string },
): Promise<{ member: WorkspaceMember | null; invite: WorkspaceInvite | null }> => {
  const response = await fetch(`${USER_API_BASE}/api/workspaces/${workspaceId}/members`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(await readMessage(response, 'Không thêm được thành viên'))
  return response.json()
}

export const updateWorkspaceMemberRole = async (
  workspaceId: number,
  memberUserId: number,
  role: string,
): Promise<WorkspaceMember> => {
  const response = await fetch(`${USER_API_BASE}/api/workspaces/${workspaceId}/members/${memberUserId}`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ role }),
  })
  if (!response.ok) throw new Error(await readMessage(response, 'Không đổi được quyền thành viên'))
  return response.json() as Promise<WorkspaceMember>
}

export const removeWorkspaceMember = async (workspaceId: number, memberUserId: number): Promise<void> => {
  const response = await fetch(`${USER_API_BASE}/api/workspaces/${workspaceId}/members/${memberUserId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (!response.ok) throw new Error(await readMessage(response, 'Không xoá được thành viên'))
}

export const transferWorkspaceOwnership = async (
  workspaceId: number,
  nextOwnerUserId: number,
): Promise<WorkspaceSummary['workspace']> => {
  const response = await fetch(`${USER_API_BASE}/api/workspaces/${workspaceId}/transfer-ownership`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ nextOwnerUserId }),
  })
  if (!response.ok) throw new Error(await readMessage(response, 'Không chuyển được chủ sở hữu'))
  return response.json() as Promise<WorkspaceSummary['workspace']>
}

export const acceptWorkspaceInvite = async (workspaceId: number, inviteId: number): Promise<WorkspaceMember> => {
  const response = await fetch(`${USER_API_BASE}/api/workspaces/${workspaceId}/invites/${inviteId}/accept`, {
    method: 'POST',
    headers: authHeaders(),
  })
  if (!response.ok) throw new Error(await readMessage(response, 'Không nhận được lời mời workspace'))
  return response.json() as Promise<WorkspaceMember>
}

export const rejectWorkspaceInvite = async (workspaceId: number, inviteId: number): Promise<WorkspaceInvite> => {
  const response = await fetch(`${USER_API_BASE}/api/workspaces/${workspaceId}/invites/${inviteId}/reject`, {
    method: 'POST',
    headers: authHeaders(),
  })
  if (!response.ok) throw new Error(await readMessage(response, 'Không từ chối được lời mời workspace'))
  return response.json() as Promise<WorkspaceInvite>
}
