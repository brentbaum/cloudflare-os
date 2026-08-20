// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AdminApi, CodexConnectionStatus } from '@gadgets/workshop-shared/api'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => {
  const toast = vi.fn<(toast: unknown) => void>()
  return { toast, toastManager: { add: toast } }
})

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => mocks.toastManager,
}))

vi.mock('@phosphor-icons/react', () => ({
  ArrowClockwise: () => <span />,
  CheckCircle: () => <span />,
  LinkBreak: () => <span />,
  WarningCircle: () => <span />,
}))

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

import CodexConnectionCard from './CodexConnectionCard'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.toast.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function adminApi(overrides: Partial<AdminApi>): RpcStub<AdminApi> {
  return overrides as unknown as RpcStub<AdminApi>
}

async function render(api: RpcStub<AdminApi>, onConnectionChange = vi.fn()) {
  await act(async () => root.render(
    <CodexConnectionCard adminApi={api} onConnectionChange={onConnectionChange} />,
  ))
  return onConnectionChange
}

describe('CodexConnectionCard', () => {
  it('stays absent when the deployment feature is disabled', async () => {
    await render(adminApi({
      getCodexConnectionStatus: async () => ({ state: 'disabled' }),
    }))
    expect(container.textContent).toBe('')
  })

  it('shows ready and unknown-credential lifecycle states', async () => {
    let status: CodexConnectionStatus = {
      state: 'ready', connectionEpoch: 'epoch-1', expiresAt: Date.now() + 60_000,
    }
    const api = adminApi({ getCodexConnectionStatus: async () => status })
    await render(api)
    expect(container.textContent).toContain('Connected')
    expect(container.textContent).toContain('Reconnect')
    expect(container.textContent).toContain('Disconnect')

    status = {
      state: 'credential-state-unknown', connectionEpoch: 'epoch-2', reason: 'Reconnect required.',
    }
    await act(async () => root.render(
      <CodexConnectionCard adminApi={api} onConnectionChange={() => {}} />,
    ))
    // A new status read happens only on lifecycle changes, so remount to model a fresh visit.
    await act(async () => root.unmount())
    root = createRoot(container)
    await render(api)
    expect(container.textContent).toContain('Reconnect required.')
    expect(container.textContent).toContain('Connect Codex')
  })

  it('shows the device code, polls one attempt, and refreshes models when ready', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'))
    const now = Date.now()
    let status: CodexConnectionStatus = { state: 'disconnected', connectionEpoch: 'epoch-0' }
    const onConnectionChange = vi.fn(async () => {})
    const poll = vi.fn(async () => {
      status = { state: 'ready', connectionEpoch: 'epoch-1', expiresAt: now + 60_000 }
      return { state: 'ready' as const, connectionEpoch: 'epoch-1', expiresAt: now + 60_000 }
    })
    const api = adminApi({
      getCodexConnectionStatus: async () => status,
      startCodexLogin: async () => ({
        attemptId: 'attempt-1',
        userCode: 'FAKE-CODE',
        verificationUri: 'https://example.invalid/device',
        expiresAt: now + 60_000,
        pollIntervalMs: 1_000,
      }),
      pollCodexLogin: poll,
    })
    await render(api, onConnectionChange)

    const connect = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Connect Codex')!
    await act(async () => connect.click())
    expect(container.textContent).toContain('FAKE-CODE')
    expect(poll).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(poll).toHaveBeenCalledOnce()
    expect(onConnectionChange).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Connected')
    expect(container.textContent).not.toContain('FAKE-CODE')
  })
})
