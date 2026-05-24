import { describe, expect, it } from 'vitest'
import { highlightTermsInText } from './highlightTerms'

const onlyHighlights = (text: string) => {
  return highlightTermsInText(text)
    .filter((part) => part.type === 'highlight')
    .map((part) => part.text)
}

const onlyCanonical = (text: string) => {
  return highlightTermsInText(text)
    .filter((part) => part.type === 'highlight')
    .map((part) => part.canonical)
}

describe('highlightTermsInText', () => {
  it('highlights exact IT term', () => {
    expect(onlyHighlights('Docker deployment completed')).toEqual(['Docker', 'deployment'])
  })

  it('matches terms case-insensitively', () => {
    expect(onlyHighlights('authentication and AUTHORIZATION passed')).toEqual(['authentication', 'AUTHORIZATION'])
  })

  it('prefers longest term: REST API before API', () => {
    expect(onlyHighlights('The REST API endpoint is stable')).toEqual(['REST API', 'endpoint'])
  })

  it('does not create overlapping highlights', () => {
    expect(onlyHighlights('database migration finished')).toEqual(['database migration'])
  })

  it('supports special characters like CI/CD', () => {
    expect(onlyHighlights('Our CI/CD pipeline is green')).toEqual(['CI/CD', 'pipeline'])
  })

  it('highlights English IT terms in Vietnamese sentence', () => {
    expect(onlyHighlights('Toi dang toi uu WebSocket latency va JWT authentication.')).toEqual([
      'WebSocket latency',
      'JWT',
      'authentication',
    ])
  })

  it('highlights IT terms in English sentence', () => {
    expect(onlyHighlights('The OpenAPI schema defines the API contract.')).toEqual([
      'OpenAPI',
      'schema',
      'API',
      'contract',
    ])
  })

  it('returns plain text part when no term matches', () => {
    const parts = highlightTermsInText('Hom nay troi dep')
    expect(parts).toEqual([{ type: 'text', text: 'Hom nay troi dep' }])
  })

  it('handles empty text safely', () => {
    const parts = highlightTermsInText('')
    expect(parts).toEqual([{ type: 'text', text: '' }])
  })

  it('does not mutate original text', () => {
    const source = 'Docker deployment and JWT authentication'
    const snapshot = `${source}`

    void highlightTermsInText(source)

    expect(source).toBe(snapshot)
  })

  it('does not highlight API inside unrelated longer words', () => {
    const parts = highlightTermsInText('rapidapi and graphapi are vendor names')
    expect(parts).toEqual([{ type: 'text', text: 'rapidapi and graphapi are vendor names' }])
  })

  it('does not highlight terms inside URL and email', () => {
    const parts = highlightTermsInText('See https://api.example.com and contact api@company.com for API docs')
    const highlights = parts.filter((part) => part.type === 'highlight').map((part) => part.text)

    expect(highlights).toEqual(['API'])
    expect(parts.map((part) => part.text).join('')).toBe(
      'See https://api.example.com and contact api@company.com for API docs',
    )
  })

  it('highlights Vietnamese IT overview transcript phrases', () => {
    const text = 'Ngành công nghệ thông tin gồm hệ thống thông tin, kỹ thuật phần mềm, an toàn thông tin và quản trị mạng.'
    expect(onlyCanonical(text)).toEqual([
      'Công nghệ thông tin',
      'hệ thống thông tin',
      'kỹ thuật phần mềm',
      'an toàn thông tin',
      'quản trị mạng',
    ])
  })

  it('prefers longest Vietnamese phrase and avoids nested overlaps', () => {
    const text = 'công nghệ phần mềm và phần mềm'
    expect(onlyHighlights(text)).toEqual(['công nghệ phần mềm', 'phần mềm'])
    expect(onlyCanonical(text)).toEqual(['công nghệ phần mềm', 'phần mềm'])
  })

  it('highlights IT acronym in Vietnamese sentence', () => {
    expect(onlyCanonical('bộ phận IT trong công ty')).toEqual(['IT'])
  })

  it('does not over-highlight generic standalone words', () => {
    const parts = highlightTermsInText('Thông tin tuyển sinh và công nghệ hiện đại')
    expect(parts).toEqual([{ type: 'text', text: 'Thông tin tuyển sinh và công nghệ hiện đại' }])
  })

  it('does not highlight normal English pronoun it', () => {
    const parts = highlightTermsInText("Google says it's something else. It was not what I imagined it.")
    const highlights = parts.filter((part) => part.type === 'highlight').map((part) => part.text)

    expect(highlights).toEqual(['Google'])
  })

  it('highlights uppercase IT acronym only', () => {
    const text = 'The IT department manages the system and bộ phận IT hỗ trợ người dùng.'
    expect(onlyHighlights(text)).toEqual(['IT', 'IT'])
    expect(onlyCanonical(text)).toEqual(['IT', 'IT'])
  })

  it('highlights AI phrases with longest-match priority', () => {
    const text = 'AI agent systems are discussed by OpenAI, Anthropic, and AI labs.'
    expect(onlyHighlights(text)).toEqual(['AI agent', 'OpenAI', 'Anthropic', 'AI labs'])
    expect(onlyCanonical(text)).toEqual(['AI agent', 'OpenAI', 'Anthropic', 'AI labs'])
  })

  it('does not highlight lowercase Vietnamese ai word', () => {
    const parts = highlightTermsInText('Không ai biết chuyện này.')
    expect(parts).toEqual([{ type: 'text', text: 'Không ai biết chuyện này.' }])
  })

  it('highlights english web/backend terms', () => {
    const text = 'The REST API endpoint uses JWT authentication and returns a JSON payload.'
    expect(onlyHighlights(text)).toEqual(['REST API', 'endpoint', 'JWT', 'authentication', 'JSON', 'payload'])
  })

  it('highlights devops and cloud terms', () => {
    const text = 'GitHub Actions runs the CI/CD pipeline and deploy Docker containers to Kubernetes.'
    expect(onlyHighlights(text)).toEqual(['GitHub Actions', 'CI/CD', 'pipeline', 'deploy', 'Docker', 'containers', 'Kubernetes'])
  })

  it('highlights database terms', () => {
    const text = 'The database migration updates the schema and cache.'
    expect(onlyHighlights(text)).toEqual(['database migration', 'schema', 'cache'])
  })

  it('highlights cybersecurity terms', () => {
    const text = 'OAuth, RBAC, MFA and SQL injection are security topics.'
    expect(onlyHighlights(text)).toEqual(['OAuth', 'RBAC', 'MFA', 'SQL injection'])
  })

  it('highlights AI-domain terms with longest phrase match', () => {
    const text = 'OpenAI and Anthropic discuss AI agents and large language model inference.'
    expect(onlyHighlights(text)).toEqual(['OpenAI', 'Anthropic', 'AI agents', 'large language model', 'inference'])
  })

  it('highlights Vietnamese IT terms in sentence', () => {
    const text = 'Ngành công nghệ thông tin học hệ thống thông tin, kỹ thuật phần mềm và an toàn thông tin.'
    expect(onlyHighlights(text)).toEqual([
      'công nghệ thông tin',
      'hệ thống thông tin',
      'kỹ thuật phần mềm',
      'an toàn thông tin',
    ])
  })

  it('highlights Vietnamese technical translation terms', () => {
    const text = 'Hệ thống dùng cơ sở dữ liệu, xác thực, phân quyền, bộ nhớ đệm và điện toán đám mây.'
    expect(onlyHighlights(text)).toEqual([
      'cơ sở dữ liệu',
      'xác thực',
      'phân quyền',
      'bộ nhớ đệm',
      'điện toán đám mây',
    ])
  })

  it('keeps acronym false-positive protection for lowercase it and ai', () => {
    const text = 'it is not AI if không ai dùng nó.'
    expect(onlyHighlights(text)).toEqual(['AI'])
  })

  it('does not highlight ambiguous standalone cautious terms', () => {
    const parts = highlightTermsInText('The client sent a request and got a response with an error log.')
    expect(parts).toEqual([{ type: 'text', text: 'The client sent a request and got a response with an error log.' }])
  })
})
