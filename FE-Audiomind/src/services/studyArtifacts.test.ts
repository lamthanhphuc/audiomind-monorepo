import { describe, expect, it } from 'vitest'
import { pickRegeneratedArtifact } from './studyArtifacts'
import type { StudyArtifact, StudyArtifactsCreateResponse } from '../types/studyArtifacts'

const buildArtifact = (overrides: Partial<StudyArtifact>): StudyArtifact => ({
  id: 1,
  subjectId: 10,
  artifactType: 'FLASHCARDS',
  status: 'QUEUED',
  version: 1,
  ...overrides,
})

const buildResponse = (
  overrides: Partial<StudyArtifactsCreateResponse>,
): StudyArtifactsCreateResponse => ({
  artifactIds: [],
  artifacts: [],
  status: 'QUEUED',
  ...overrides,
})

describe('pickRegeneratedArtifact', () => {
  it('returns the artifact and marks it for polling when still QUEUED', () => {
    const artifact = buildArtifact({ id: 42, status: 'QUEUED' })
    const response = buildResponse({ artifactIds: [42], artifacts: [artifact], status: 'QUEUED' })

    const result = pickRegeneratedArtifact(response)

    expect(result.artifact).toEqual(artifact)
    expect(result.pollIds).toEqual([42])
  })

  it('marks the artifact for polling when still PROCESSING', () => {
    const artifact = buildArtifact({ id: 7, status: 'PROCESSING' })
    const response = buildResponse({ artifactIds: [7], artifacts: [artifact], status: 'PROCESSING' })

    const result = pickRegeneratedArtifact(response)

    expect(result.pollIds).toEqual([7])
  })

  it('does not mark a terminal (cache-hit) artifact for polling', () => {
    const artifact = buildArtifact({ id: 5, status: 'COMPLETED', content: { cards: [] } })
    const response = buildResponse({ artifactIds: [5], artifacts: [artifact], status: 'COMPLETED' })

    const result = pickRegeneratedArtifact(response)

    expect(result.artifact).toEqual(artifact)
    expect(result.pollIds).toEqual([])
  })

  it('treats an artifactId missing from artifacts[] as needing polling', () => {
    const response = buildResponse({ artifactIds: [99], artifacts: [], status: 'QUEUED' })

    const result = pickRegeneratedArtifact(response)

    expect(result.artifact).toBeNull()
    expect(result.pollIds).toEqual([99])
  })

  it('returns a null artifact and empty pollIds for an empty batch response', () => {
    const response = buildResponse({})

    const result = pickRegeneratedArtifact(response)

    expect(result.artifact).toBeNull()
    expect(result.pollIds).toEqual([])
  })
})
