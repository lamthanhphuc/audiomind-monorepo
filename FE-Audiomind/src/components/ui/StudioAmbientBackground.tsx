import type { CSSProperties } from 'react'

type StudioAmbientVariant = 'auth' | 'dashboard' | 'panel'

type StudioAmbientBackgroundProps = {
  variant?: StudioAmbientVariant
}

const PARTICLE_COUNT = 10

export function StudioAmbientBackground({ variant = 'dashboard' }: StudioAmbientBackgroundProps) {
  return (
    <div className={`studio-ambient studio-ambient--${variant}`} aria-hidden="true">
      <div className="studio-ambient__orb studio-ambient__orb--1" />
      <div className="studio-ambient__orb studio-ambient__orb--2" />
      <div className="studio-ambient__orb studio-ambient__orb--3" />
      <div className="studio-ambient__grid" />
      <div className="studio-ambient__noise" />
      {variant === 'auth' && (
        <div className="studio-ambient__particles">
          {Array.from({ length: PARTICLE_COUNT }, (_, index) => (
            <span
              key={index}
              className="studio-ambient__particle"
              style={{ '--particle-i': index } as CSSProperties}
            />
          ))}
        </div>
      )}
      <div className="studio-ambient__scanline" />
    </div>
  )
}
