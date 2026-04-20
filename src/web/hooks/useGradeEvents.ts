import { useEffect, useReducer, useState } from 'react'
import { initialGradeState, reduceGradeEvents } from '../lib/grade-reducer.ts'
import type { GradeAction, GradeEvent, GradeState } from '../lib/types.ts'

export interface UseGradeEventsResult {
  state: GradeState
  connected: boolean
  dispatch: (action: GradeAction) => void
}

export function useGradeEvents(gradeId: string): UseGradeEventsResult {
  const [state, dispatch] = useReducer(
    (s: GradeState, e: GradeAction) => reduceGradeEvents(s, e, performance.now()),
    undefined,
    initialGradeState,
  )
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const es = new EventSource(`/grades/${gradeId}/events`, { withCredentials: true })
    es.onopen = (): void => setConnected(true)
    es.onerror = (): void => setConnected(false)
    es.onmessage = (ev: MessageEvent<string>): void => {
      try {
        dispatch(JSON.parse(ev.data) as GradeEvent)
      } catch {
        // Ignore malformed; server-side invariants are tight
      }
    }
    return () => {
      es.close()
    }
  }, [gradeId])

  return { state, connected, dispatch }
}
