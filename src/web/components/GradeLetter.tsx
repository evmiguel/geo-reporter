import React from 'react'
import { scoreBandClass, letterDescriptor } from '../../scoring/letter.ts'

export interface GradeLetterProps {
  letter: string
  overall: number
}

export function GradeLetter(props: GradeLetterProps): JSX.Element {
  const color = scoreBandClass(props.overall)
  const desc = letterDescriptor(props.overall)
  return (
    <div>
      <div className="flex items-baseline gap-4">
        <div className={`text-6xl font-mono font-bold ${color}`}>{props.letter}</div>
        <div className="text-xl font-mono text-[var(--color-fg-dim)]">{props.overall}/100</div>
      </div>
      {desc !== null && (
        <div className={`text-xs tracking-wider uppercase mt-2 ${color}`}>
          {desc.label} · {desc.range}
        </div>
      )}
    </div>
  )
}
