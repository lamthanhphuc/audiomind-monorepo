import type { CSSProperties } from 'react'

type StudioWaveformProps = {
  bars?: number
  className?: string
  active?: boolean
}

export function StudioWaveform({ bars = 28, className = '', active = true }: StudioWaveformProps) {
  return (
    <div
      className={`studio-waveform${active ? ' studio-waveform--active' : ''} ${className}`.trim()}
      aria-hidden="true"
    >
      {Array.from({ length: bars }, (_, index) => (
        <span
          key={index}
          className="studio-waveform__bar"
          style={{ '--bar-i': index % 9 } as CSSProperties}
        />
      ))}
    </div>
  )
}
