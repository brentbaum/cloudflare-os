// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AdminApi,
  CodexConnectionStatus,
  CodexDevicePollResult,
} from '@gadgets/workshop-shared/api'

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

import CodexConnectionCard, { codexStatusReasonCopy } from './CodexConnectionCard'

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

async function render(
  api: RpcStub<AdminApi>,
  onConnectionChange: () => void | Promise<void> = vi.fn<() => void>(),
) {
  await act(async () => root.render(
    <CodexConnectionCard adminApi={api} onConnectionChange={onConnectionChange} />,
  ))
  return onConnectionChange
}

describe('CodexConnectionCard', () => {
  it('maps sanitized credential reason codes to actionable admin copy', () => {
    const cases = [
      [
        'authorization_code_exchange_failed',
        'OpenAI did not complete the sign-in. Start a new Codex connection.',
      ],
      [
        'credential_encryption_failed',
        'Codex could not securely save the new authorization. Check the wrapping-key configuration, then reconnect.',
      ],
      [
        'credential_commit_failed',
        'Codex could not finish saving the new authorization. Start a new connection before using the shared subscription.',
      ],
    ] as const
    for (const [reason, copy] of cases) {
      expect(codexStatusReasonCopy({
        state: 'reauth-required', connectionEpoch: 'epoch', reason,
      })).toBe(copy)
    }
    expect(codexStatusReasonCopy({
      state: 'credential-state-unknown', connectionEpoch: 'epoch', reason: 'sanitized_future_code',
    })).toBe(
      'The saved Codex credential state cannot be verified safely. Reconnect before using it.',
    )
  })

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
      state: 'credential-state-unknown', connectionEpoch: 'epoch-2',
      reason: 'credential_encryption_failed',
    }
    await act(async () => root.render(
      <CodexConnectionCard adminApi={api} onConnectionChange={() => {}} />,
    ))
    // A new status read happens only on lifecycle changes, so remount to model a fresh visit.
    await act(async () => root.unmount())
    root = createRoot(container)
    await render(api)
    expect(container.textContent).toContain('Codex could not securely save')
    expect(container.textContent).not.toContain('credential_encryption_failed')
    expect(container.textContent).toContain('Reconnect Codex')
  })

  it('shows the device code, polls one attempt, and refreshes models when ready', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'))
    const now = Date.now()
    let status: CodexConnectionStatus = { state: 'disconnected', connectionEpoch: 'epoch-0' }
    const onConnectionChange = vi.fn<() => Promise<void>>(async () => {})
    const poll = vi.fn<AdminApi['pollCodexLogin']>(async () => {
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

  it.each([
    {
      label: 'denied',
      result: { state: 'denied' },
      status: { state: 'disconnected', connectionEpoch: 'epoch-1' },
      toast: 'Codex sign-in was denied',
    },
    {
      label: 'expired',
      result: { state: 'expired' },
      status: { state: 'disconnected', connectionEpoch: 'epoch-1' },
      toast: 'Codex sign-in expired',
    },
    {
      label: 'superseded',
      result: { state: 'superseded' },
      status: { state: 'pending', connectionEpoch: 'epoch-1', attemptId: 'newer-attempt',
        expiresAt: 60_000, nextPollAt: 50_000 },
      toast: 'A newer Codex sign-in replaced this attempt',
    },
  ] satisfies Array<{
    label: string
    result: CodexDevicePollResult
    status: CodexConnectionStatus
    toast: string
  }>)('handles a $label terminal poll result distinctly', async ({ result, status, toast }) => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const getStatus = vi.fn<AdminApi['getCodexConnectionStatus']>()
      .mockResolvedValueOnce({
        state: 'pending', connectionEpoch: 'epoch-0', attemptId: 'attempt-1',
        expiresAt: 60_000, nextPollAt: 100,
      })
      .mockResolvedValueOnce(status)
    const poll = vi.fn<AdminApi['pollCodexLogin']>(async () => result)
    const onConnectionChange = vi.fn<() => Promise<void>>(async () => {})
    await render(adminApi({ getCodexConnectionStatus: getStatus, pollCodexLogin: poll }),
      onConnectionChange)

    await act(async () => { await vi.advanceTimersByTimeAsync(100) })

    expect(poll).toHaveBeenCalledOnce()
    expect(onConnectionChange).toHaveBeenCalledOnce()
    expect(mocks.toast).toHaveBeenCalledWith({ title: toast, variant: 'error' })
  })

  it('handles a sanitized failed result as reconnect-required', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const getStatus = vi.fn<AdminApi['getCodexConnectionStatus']>()
      .mockResolvedValueOnce({
        state: 'pending', connectionEpoch: 'epoch-0', attemptId: 'attempt-1',
        expiresAt: 60_000, nextPollAt: 100,
      })
      .mockResolvedValueOnce({
        state: 'reauth-required', connectionEpoch: 'epoch-1',
        reason: 'authorization_code_exchange_failed',
      })
    const poll = vi.fn<AdminApi['pollCodexLogin']>(async () => ({
      state: 'failed', reconnectRequired: true,
    }))
    const onConnectionChange = vi.fn<() => Promise<void>>(async () => {})
    await render(adminApi({ getCodexConnectionStatus: getStatus, pollCodexLogin: poll }),
      onConnectionChange)

    await act(async () => { await vi.advanceTimersByTimeAsync(100) })

    expect(poll).toHaveBeenCalledOnce()
    expect(onConnectionChange).toHaveBeenCalledOnce()
    expect(mocks.toast).toHaveBeenCalledWith({
      title: 'Codex sign-in failed. Start a new connection.', variant: 'error',
    })
    expect(container.textContent).toContain('Reconnect required')
    expect(container.textContent).toContain('OpenAI did not complete the sign-in')
    expect(container.textContent).not.toContain('authorization_code_exchange_failed')
  })

  it('refreshes and reschedules a pending attempt after a transient poll rejection', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const getStatus = vi.fn<AdminApi['getCodexConnectionStatus']>()
      .mockResolvedValueOnce({
        state: 'pending', connectionEpoch: 'epoch-0', attemptId: 'attempt-1',
        expiresAt: 60_000, nextPollAt: 100,
      })
      .mockResolvedValueOnce({
        state: 'pending', connectionEpoch: 'epoch-0', attemptId: 'attempt-1',
        expiresAt: 60_000, nextPollAt: 300,
      })
      .mockResolvedValueOnce({
        state: 'ready', connectionEpoch: 'epoch-1', expiresAt: 60_000,
      })
    const poll = vi.fn<AdminApi['pollCodexLogin']>()
      .mockRejectedValueOnce(new Error('unmistakably transient poll failure'))
      .mockResolvedValueOnce({
        state: 'ready', connectionEpoch: 'epoch-1', expiresAt: 60_000,
      })
    const onConnectionChange = vi.fn<() => Promise<void>>(async () => {})
    await render(adminApi({ getCodexConnectionStatus: getStatus, pollCodexLogin: poll }),
      onConnectionChange)

    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(poll).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Waiting')
    expect(mocks.toast).toHaveBeenCalledWith({
      title: 'Codex sign-in check was interrupted. Retrying automatically.',
      variant: 'error',
    })
    expect(vi.getTimerCount()).toBe(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(poll).toHaveBeenCalledTimes(2)
    expect(onConnectionChange).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Connected')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a pending start from an admin stub that has been replaced', async () => {
    const started = deferred<Awaited<ReturnType<AdminApi['startCodexLogin']>>>()
    const oldStatus = vi.fn<AdminApi['getCodexConnectionStatus']>(async () => ({
      state: 'disconnected' as const, connectionEpoch: 'old-epoch',
    }))
    const oldApi = adminApi({
      getCodexConnectionStatus: oldStatus,
      startCodexLogin: () => started.promise,
    })
    const newApi = adminApi({
      getCodexConnectionStatus: async () => ({
        state: 'disconnected', connectionEpoch: 'new-epoch',
      }),
    })
    await render(oldApi)
    const connect = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Connect Codex')!
    act(() => connect.click())

    await act(async () => root.render(
      <CodexConnectionCard adminApi={newApi} onConnectionChange={() => {}} />,
    ))
    await act(async () => started.resolve({
      attemptId: 'stale-attempt',
      userCode: 'STALE-CODE',
      verificationUri: 'https://example.invalid/stale',
      expiresAt: Date.now() + 60_000,
      pollIntervalMs: 1_000,
    }))

    expect(oldStatus).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain('STALE-CODE')
    expect(container.textContent).toContain('Connect Codex')
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('ignores a pending status refresh from an admin stub that has been replaced', async () => {
    const oldStatus = deferred<CodexConnectionStatus>()
    const oldApi = adminApi({ getCodexConnectionStatus: () => oldStatus.promise })
    const newApi = adminApi({
      getCodexConnectionStatus: async () => ({
        state: 'disconnected', connectionEpoch: 'new-epoch',
      }),
    })
    await render(oldApi)
    await act(async () => root.render(
      <CodexConnectionCard adminApi={newApi} onConnectionChange={() => {}} />,
    ))
    await act(async () => oldStatus.resolve({
      state: 'ready', connectionEpoch: 'old-epoch', expiresAt: Date.now() + 60_000,
    }))

    expect(container.textContent).toContain('Not connected')
    expect(container.textContent).not.toContain('Connected')
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('does not continue a pending start after unmount', async () => {
    const started = deferred<Awaited<ReturnType<AdminApi['startCodexLogin']>>>()
    const getStatus = vi.fn<AdminApi['getCodexConnectionStatus']>(async () => ({
      state: 'disconnected' as const, connectionEpoch: 'epoch-0',
    }))
    await render(adminApi({
      getCodexConnectionStatus: getStatus,
      startCodexLogin: () => started.promise,
    }))
    const connect = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Connect Codex')!
    act(() => connect.click())
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => started.resolve({
      attemptId: 'unmounted-attempt',
      userCode: 'UNMOUNTED-CODE',
      verificationUri: 'https://example.invalid/unmounted',
      expiresAt: Date.now() + 60_000,
      pollIntervalMs: 1_000,
    }))

    expect(getStatus).toHaveBeenCalledOnce()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('does not finish a terminal refresh after unmount', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const refreshed = deferred<CodexConnectionStatus>()
    const getStatus = vi.fn<AdminApi['getCodexConnectionStatus']>()
      .mockResolvedValueOnce({
        state: 'pending', connectionEpoch: 'epoch-0', attemptId: 'attempt-1',
        expiresAt: now + 60_000, nextPollAt: now + 100,
      })
      .mockImplementationOnce(() => refreshed.promise)
    const poll = vi.fn<AdminApi['pollCodexLogin']>(async () => ({
      state: 'ready' as const, connectionEpoch: 'epoch-1', expiresAt: now + 60_000,
    }))
    const onConnectionChange = vi.fn<() => Promise<void>>(async () => {})
    await render(adminApi({ getCodexConnectionStatus: getStatus, pollCodexLogin: poll }),
      onConnectionChange)

    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(poll).toHaveBeenCalledOnce()
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => refreshed.resolve({
      state: 'ready', connectionEpoch: 'epoch-1', expiresAt: now + 60_000,
    }))

    expect(onConnectionChange).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('tears down a pending poll timer when the admin stub changes', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const stalePoll = vi.fn<AdminApi['pollCodexLogin']>()
    const oldApi = adminApi({
      getCodexConnectionStatus: async () => ({
        state: 'pending', connectionEpoch: 'old', attemptId: 'old-attempt',
        expiresAt: now + 60_000, nextPollAt: now + 1_000,
      }),
      pollCodexLogin: stalePoll,
    })
    const newApi = adminApi({
      getCodexConnectionStatus: async () => ({ state: 'disconnected', connectionEpoch: 'new' }),
    })
    await render(oldApi)
    await act(async () => root.render(
      <CodexConnectionCard adminApi={newApi} onConnectionChange={() => {}} />,
    ))
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })

    expect(stalePoll).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
