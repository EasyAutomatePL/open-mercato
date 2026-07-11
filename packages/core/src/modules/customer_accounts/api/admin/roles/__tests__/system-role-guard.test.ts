/** @jest-environment node */

import { PUT } from '../[id]'

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174001'
const ROLE_ID = '123e4567-e89b-12d3-a456-426614174080'

const mockGetAuthFromRequest = jest.fn()

const mockEm = {
  findOne: jest.fn(),
  count: jest.fn(async () => 0),
  nativeUpdate: jest.fn(async () => undefined),
}

const mockRbacService = { userHasAllFeatures: jest.fn(async () => true) }

const mockContainer = {
  resolve: jest.fn((token: string) => {
    if (token === 'em') return mockEm
    if (token === 'rbacService') return mockRbacService
    return null
  }),
}

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn((req: Request) => mockGetAuthFromRequest(req)),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => mockContainer),
}))

jest.mock('@open-mercato/core/modules/customer_accounts/events', () => ({
  emitCustomerAccountsEvent: jest.fn(async () => undefined),
}))

function request(body: unknown) {
  return new Request(`http://localhost/api/customer_accounts/admin/roles/${ROLE_ID}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const params = { params: { id: ROLE_ID } }

describe('customer_accounts admin role — system role name guard (ISSUE-005)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.OM_OPTIMISTIC_LOCK
    mockGetAuthFromRequest.mockResolvedValue({ sub: 'user-1', tenantId: TENANT_ID, orgId: 'org-1' })
    mockEm.findOne.mockResolvedValue({
      id: ROLE_ID,
      name: 'Participant',
      slug: 'participant',
      isSystem: true,
      updatedAt: new Date('2026-06-01T10:00:00.000Z'),
    })
  })

  it('updates a system role when the unchanged name is echoed back with other fields', async () => {
    const res = await PUT(request({ name: 'Participant', description: 'Updated copy', customerAssignable: true }), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    const updates = mockEm.nativeUpdate.mock.calls[0][2] as Record<string, unknown>
    expect(updates.description).toBe('Updated copy')
    expect(updates.customerAssignable).toBe(true)
  })

  it('updates a system role when name is omitted entirely', async () => {
    const res = await PUT(request({ isDefault: true }), params)
    expect(res.status).toBe(200)
    const updates = mockEm.nativeUpdate.mock.calls[0][2] as Record<string, unknown>
    expect(updates.isDefault).toBe(true)
  })

  it('rejects an actual name change on a system role with 400', async () => {
    const res = await PUT(request({ name: 'Renamed', description: 'x' }), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(mockEm.nativeUpdate).not.toHaveBeenCalled()
  })

  it('allows renaming a non-system role', async () => {
    mockEm.findOne.mockResolvedValueOnce({
      id: ROLE_ID,
      name: 'Reviewer',
      slug: 'reviewer',
      isSystem: false,
      updatedAt: new Date('2026-06-01T10:00:00.000Z'),
    })
    const res = await PUT(request({ name: 'Renamed' }), params)
    expect(res.status).toBe(200)
    const updates = mockEm.nativeUpdate.mock.calls[0][2] as Record<string, unknown>
    expect(updates.name).toBe('Renamed')
  })
})
