import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type {
  AdminApi,
  CodexConnectionStatus,
  CodexDeviceAuthorization,
  CodexDevicePollResult,
} from '@gadgets/workshop-shared/api'
import { ArrowClockwise, CheckCircle, LinkBreak, WarningCircle } from '@phosphor-icons/react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { WorkshopButton } from './components/WorkshopControls'

type Props = {
  adminApi: RpcStub<AdminApi> | null
  onConnectionChange: () => void | Promise<void>
}

type PendingAttempt = CodexDeviceAuthorization & { nextPollAt: number }

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

/** Admin-only lifecycle UI for the deployment-wide Codex subscription connection. */
export default function CodexConnectionCard({ adminApi, onConnectionChange }: Props) {
  const toasts = useKumoToastManager()
  const [status, setStatus] = useState<CodexConnectionStatus | null>(null)
  const [attempt, setAttempt] = useState<PendingAttempt | null>(null)
  const [busy, setBusy] = useState(false)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollGeneration = useRef(0)

  const clearPolling = useCallback(() => {
    pollGeneration.current += 1
    if (pollTimer.current !== null) clearTimeout(pollTimer.current)
    pollTimer.current = null
  }, [])

  const refresh = useCallback(async () => {
    if (!adminApi) return
    const next = await adminApi.getCodexConnectionStatus()
    setStatus(next)
    return next
  }, [adminApi])

  const finishAttempt = useCallback(async (result: CodexDevicePollResult) => {
    clearPolling()
    setAttempt(null)
    await refresh()
    await onConnectionChange()
    if (result.state === 'ready') {
      toasts.add({ title: 'Codex subscription connected', variant: 'success' })
    } else if (result.state === 'denied') {
      toasts.add({ title: 'Codex sign-in was denied', variant: 'error' })
    } else if (result.state === 'expired') {
      toasts.add({ title: 'Codex sign-in expired', variant: 'error' })
    } else if (result.state === 'superseded') {
      toasts.add({ title: 'A newer Codex sign-in replaced this attempt', variant: 'error' })
    }
  }, [clearPolling, onConnectionChange, refresh, toasts])

  const schedulePoll = useCallback((attemptId: string, nextPollAt: number) => {
    if (!adminApi) return
    clearPolling()
    const generation = pollGeneration.current
    pollTimer.current = setTimeout(async () => {
      if (generation !== pollGeneration.current) return
      pollTimer.current = null
      try {
        const result = await adminApi.pollCodexLogin(attemptId)
        if (generation !== pollGeneration.current) return
        if (result.state === 'pending') {
          setAttempt((current) => current?.attemptId === attemptId
            ? { ...current, nextPollAt: result.nextPollAt, expiresAt: result.expiresAt }
            : current)
          schedulePoll(attemptId, result.nextPollAt)
        } else {
          await finishAttempt(result)
        }
      } catch (error) {
        if (generation !== pollGeneration.current) return
        console.error('Failed to poll Codex sign-in:', error)
        clearPolling()
        toasts.add({ title: 'Could not check Codex sign-in', variant: 'error' })
        await refresh().catch(() => {})
      }
    }, Math.max(0, nextPollAt - Date.now()))
  }, [adminApi, clearPolling, finishAttempt, refresh, toasts])

  useEffect(() => {
    if (!adminApi) {
      setStatus(null)
      return
    }
    let cancelled = false
    refresh().then((next) => {
      if (!cancelled && next?.state === 'pending') {
        schedulePoll(next.attemptId, next.nextPollAt)
      }
    }).catch((error) => {
      if (!cancelled) {
        console.error('Failed to load Codex connection:', error)
        toasts.add({ title: 'Could not load Codex connection', variant: 'error' })
      }
    })
    return () => {
      cancelled = true
      clearPolling()
    }
  }, [adminApi, clearPolling, refresh, schedulePoll, toasts])

  const startLogin = async () => {
    if (!adminApi || busy) return
    setBusy(true)
    clearPolling()
    try {
      const authorization = await adminApi.startCodexLogin()
      const pending = {
        ...authorization,
        nextPollAt: Date.now() + authorization.pollIntervalMs,
      }
      setAttempt(pending)
      const nextStatus = await refresh()
      schedulePoll(authorization.attemptId,
        nextStatus?.state === 'pending' && nextStatus.attemptId === authorization.attemptId
          ? nextStatus.nextPollAt
          : pending.nextPollAt)
    } catch (error) {
      console.error('Failed to start Codex sign-in:', error)
      toasts.add({ title: 'Could not start Codex sign-in', variant: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    if (!adminApi || busy || !confirm('Disconnect the shared Codex subscription for everyone?')) return
    setBusy(true)
    clearPolling()
    try {
      await adminApi.disconnectCodex()
      setAttempt(null)
      await refresh()
      await onConnectionChange()
      toasts.add({ title: 'Codex subscription disconnected', variant: 'success' })
    } catch (error) {
      console.error('Failed to disconnect Codex:', error)
      toasts.add({ title: 'Could not disconnect Codex', variant: 'error' })
    } finally {
      setBusy(false)
    }
  }

  if (!adminApi || status === null || status.state === 'disabled') return null

  const activeAttemptId = attempt?.attemptId ?? (status.state === 'pending' ? status.attemptId : null)

  return (
    <section className="mx-3 mb-3 rounded-xl border border-kumo-line bg-kumo-base p-4" aria-label="Codex subscription connection">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-kumo-default">Codex subscription</h2>
          <p className="mt-1 text-[13px] leading-[18px] text-kumo-subtle">
            One administrator-managed connection is shared by every authenticated user.
          </p>
        </div>
        {status.state === 'ready' ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-kumo-success">
            <CheckCircle size={14} weight="fill" /> Connected
          </span>
        ) : status.state === 'pending' ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-kumo-brand">
            <ArrowClockwise size={14} className="animate-spin" /> Waiting
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-kumo-subtle">
            <LinkBreak size={14} /> Not connected
          </span>
        )}
      </div>

      {attempt && (
        <div className="mt-3 rounded-lg bg-kumo-tint p-3 text-[13px] leading-[18px] text-kumo-subtle">
          <p>
            Open <a className="font-medium text-kumo-brand underline" href={attempt.verificationUri}
              target="_blank" rel="noreferrer">{attempt.verificationUri}</a> and enter this code:
          </p>
          <p className="mt-2 font-mono text-lg font-semibold tracking-widest text-kumo-default">
            {attempt.userCode}
          </p>
          <p className="mt-1 text-xs">Expires {formatTime(attempt.expiresAt)}. This page checks automatically.</p>
        </div>
      )}

      {status.state === 'pending' && !attempt && (
        <p className="mt-3 text-[13px] leading-[18px] text-kumo-subtle">
          A sign-in is already in progress and expires {formatTime(status.expiresAt)}. Restart it to
          display a new device code.
        </p>
      )}

      {status.state === 'ready' && (
        <p className="mt-3 text-[13px] leading-[18px] text-kumo-subtle">
          Current authorization expires {formatTime(status.expiresAt)}.
        </p>
      )}

      {(status.state === 'reauth-required' || status.state === 'credential-state-unknown') && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-kumo-warning-tint p-3 text-[13px] leading-[18px] text-kumo-subtle">
          <WarningCircle size={15} className="mt-px shrink-0 text-kumo-warning" />
          <span>{status.reason}</span>
        </div>
      )}

      <div className="mt-4 flex gap-2">
        {status.state === 'ready' ? (
          <>
            <WorkshopButton onClick={startLogin} disabled={busy}>Reconnect</WorkshopButton>
            <WorkshopButton tone="danger" onClick={disconnect} disabled={busy}>Disconnect</WorkshopButton>
          </>
        ) : (
          <WorkshopButton tone="primary" onClick={startLogin} disabled={busy}>
            {activeAttemptId ? 'Restart sign-in' : 'Connect Codex'}
          </WorkshopButton>
        )}
      </div>
    </section>
  )
}
