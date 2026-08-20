import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { Lightning } from '@phosphor-icons/react'

const CODEX_MODEL_PREFIX = 'openai-codex/'

export function isSharedCodexModel(modelId: string): boolean {
  return modelId.startsWith(CODEX_MODEL_PREFIX)
}

export function providerModelManagement(
  modelId: string,
  isBuiltIn: boolean,
): 'built-in' | 'shared' | 'custom' {
  if (isSharedCodexModel(modelId)) return 'shared'
  return isBuiltIn ? 'built-in' : 'custom'
}

/** Mint and own the existing admin capability only while this admin page surface is mounted. */
export function useCodexAdminCapability(
  authenticatedApi: RpcStub<AuthenticatedApi>,
  isAdmin: boolean,
): RpcStub<AdminApi> | null {
  const [admin, setAdmin] = useState<{ api: RpcStub<AdminApi> } | null>(null)

  useEffect(() => {
    if (!isAdmin) {
      setAdmin(null)
      return
    }
    let cancelled = false
    let stub: RpcStub<AdminApi> | null = null
    authenticatedApi.getAdminApi().then((api) => {
      if (cancelled) {
        api?.[Symbol.dispose]?.()
        return
      }
      if (api) {
        stub = api
        setAdmin({ api })
      }
    }).catch((error) => {
      if (!cancelled) console.error('Failed to load Codex admin capability:', error)
    })
    return () => {
      cancelled = true
      stub?.[Symbol.dispose]?.()
    }
  }, [authenticatedApi, isAdmin])

  return admin?.api ?? null
}

export function SharedCodexNotice() {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-kumo-line bg-kumo-tint px-4 py-3 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
      <Lightning size={15} className="mt-px shrink-0 text-kumo-brand" />
      <span>
        <strong className="font-medium text-kumo-default">Shared Codex subscription:</strong>{' '}
        these models use the deployment administrator's connection for every authenticated user.
        Subscription usage and cost are not shown in AgentOS.
      </span>
    </div>
  )
}
