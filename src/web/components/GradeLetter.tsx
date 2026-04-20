import React from 'react'

export interface GradeLetterProps {
  letter: string
  overall: number
}

export function GradeLetter(props: GradeLetterProps): JSX.Element {
  return (
    <div className="flex items-baseline gap-4">
      <div className="text-6xl font-mono font-bold text-[var(--color-brand)]">{props.letter}</div>
      <div className="text-xl font-mono text-[var(--color-fg-dim)]">{props.overall}/100</div>
    </div>
  )
}
