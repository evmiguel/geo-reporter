import React from 'react'
import { scoreBandClass } from '../../scoring/letter.ts'

export interface GradeLetterProps {
  letter: string
  overall: number
}

export function GradeLetter(props: GradeLetterProps): JSX.Element {
  const color = scoreBandClass(props.overall)
  return (
    <div className="flex items-baseline gap-4">
      <div className={`text-6xl font-mono font-bold ${color}`}>{props.letter}</div>
      <div className="text-xl font-mono text-[var(--color-fg-dim)]">{props.overall}/100</div>
    </div>
  )
}
