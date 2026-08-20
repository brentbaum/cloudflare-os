// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import {
  providerModelManagement,
  SharedCodexNotice,
  useCodexAdminCapability,
} from './CodexProviderPolicy'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function authenticatedApi(overrides: Partial<AuthenticatedApi>): RpcStub<AuthenticatedApi> {
  return overrides as unknown as RpcStub<AuthenticatedApi>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function CapabilityProbe({ api, isAdmin }: {
  api: RpcStub<AuthenticatedApi>
  isAdmin: boolean
}) {
  const admin = useCodexAdminCapability(api, isAdmin)
  return <div>{admin ? 'admin-codex-card' : 'no-admin-card'}</div>
}

describe('shared Codex provider policy', () => {
  it('shows the shared warning and classifies shared rows as non-deletable', async () => {
    await act(async () => root.render(<SharedCodexNotice />))
    expect(container.textContent).toContain('Shared Codex subscription:')
    expect(container.textContent).toContain('Subscription usage and cost are not shown')
    expect(providerModelManagement('openai-codex/gpt-5.6-sol', false)).toBe('shared')
    expect(providerModelManagement('openai-codex/gpt-5.6-sol', false)).not.toBe('custom')
  })

  it('does not mint an admin capability for a non-admin user', async () => {
    const getAdminApi = vi.fn()
    await act(async () => root.render(
      <CapabilityProbe api={authenticatedApi({ getAdminApi })} isAdmin={false} />,
    ))
    expect(container.textContent).toBe('no-admin-card')
    expect(getAdminApi).not.toHaveBeenCalled()
  })

  it('disposes the minted admin capability on unmount', async () => {
    const dispose = vi.fn()
    const admin = { [Symbol.dispose]: dispose } as unknown as RpcStub<AdminApi>
    await act(async () => root.render(
      <CapabilityProbe api={authenticatedApi({ getAdminApi: async () => admin })} isAdmin />,
    ))
    expect(container.textContent).toBe('admin-codex-card')
    await act(async () => root.unmount())
    root = createRoot(container)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('disposes a capability that resolves after its owner unmounts', async () => {
    const minted = deferred<RpcStub<AdminApi> | null>()
    const dispose = vi.fn()
    await act(async () => root.render(
      <CapabilityProbe
        api={authenticatedApi({ getAdminApi: () => minted.promise })}
        isAdmin
      />,
    ))
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => minted.resolve({ [Symbol.dispose]: dispose } as unknown as RpcStub<AdminApi>))

    expect(dispose).toHaveBeenCalledOnce()
    expect(container.textContent).toBe('')
  })

  it('clears and disposes the old capability while a replacement is pending', async () => {
    const oldDispose = vi.fn()
    const oldAdmin = { [Symbol.dispose]: oldDispose } as unknown as RpcStub<AdminApi>
    const replacement = deferred<RpcStub<AdminApi> | null>()
    const oldApi = authenticatedApi({ getAdminApi: async () => oldAdmin })
    const newApi = authenticatedApi({ getAdminApi: () => replacement.promise })

    await act(async () => root.render(<CapabilityProbe api={oldApi} isAdmin />))
    expect(container.textContent).toBe('admin-codex-card')
    await act(async () => root.render(<CapabilityProbe api={newApi} isAdmin />))

    expect(oldDispose).toHaveBeenCalledOnce()
    expect(container.textContent).toBe('no-admin-card')
    await act(async () => replacement.resolve(null))
    expect(container.textContent).toBe('no-admin-card')
  })
})
