import { useCallback, useEffect, useState } from 'react'
import type { IpcResult } from '@shared/ipc'

/**
 * renderer 数据获取：统一解包 IpcResult，提供 loading/error/reload。
 */

export class ApiError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ApiError'
  }
}

/** 解包 IpcResult：失败抛 ApiError（调用方 catch 或由 hook 呈现） */
export async function unwrap<T>(p: Promise<IpcResult<T>>): Promise<T> {
  const res = await p
  if (!res.ok) throw new ApiError(res.code, res.message)
  return res.data
}

export interface AsyncState<T> {
  data: T | null
  loading: boolean
  error: string | null
  reload: () => void
}

/** 首次挂载/依赖变化时自动加载（筛选变化时保留旧数据渐进刷新） */
export function useApiData<T>(fn: () => Promise<IpcResult<T>>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    unwrap(fn())
      .then((d) => {
        if (alive) {
          setData(d)
          setLoading(false)
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e))
          setLoading(false)
        }
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  const reload = useCallback(() => {
    setError(null)
    setTick((t) => t + 1)
  }, [])
  return { data, loading, error, reload }
}
