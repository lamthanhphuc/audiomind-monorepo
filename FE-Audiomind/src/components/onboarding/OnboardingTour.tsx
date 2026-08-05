import { dismissOnboarding } from '../../utils/userPreferences'

type OnboardingTourProps = {
  onNavigateUpload: () => void
  onNavigateRealtime: () => void
  onDismiss: () => void
}

const STEPS = [
  {
    title: 'Upload file âm thanh',
    body: 'Tải file ghi âm (.mp3, .wav, .m4a...) để transcribe và phân tích AI. Phù hợp khi đã có bản ghi sẵn.',
    action: 'upload' as const,
    cta: 'Thử upload',
  },
  {
    title: 'Ghi âm realtime',
    body: 'Ghi trực tiếp từ microphone hoặc tab trình duyệt. Transcript hiển thị live qua Deepgram.',
    action: 'realtime' as const,
    cta: 'Mở ghi âm',
  },
  {
    title: 'Xem lại kết quả',
    body: 'Sau khi xử lý, mở Lịch sử để kiểm tra transcript, phân tích, export hoặc chia sẻ.',
    action: 'upload' as const,
    cta: 'Ở lại upload',
  },
]

export default function OnboardingTour({
  onNavigateUpload,
  onNavigateRealtime,
  onDismiss,
}: OnboardingTourProps) {
  const handleAction = (action: 'upload' | 'realtime') => {
    dismissOnboarding()
    onDismiss()
    if (action === 'upload') {
      onNavigateUpload()
      return
    }
    if (action === 'realtime') {
      onNavigateRealtime()
      return
    }
  }

  const handleDismiss = () => {
    dismissOnboarding()
    onDismiss()
  }

  return (
    <section className="onboarding-tour studio-card" data-testid="onboarding-tour">
      <header className="onboarding-tour__header">
        <div>
          <p className="onboarding-tour__eyebrow">Bắt đầu nhanh</p>
          <h2>Chào mừng đến AudioMind</h2>
          <p className="studio-muted-text">
            Chọn cách bạn muốn ghi và phân tích cuộc họp. Bạn có thể đổi bất cứ lúc nào từ menu bên trái.
          </p>
        </div>
        <button type="button" className="onboarding-tour__dismiss" onClick={handleDismiss} data-testid="onboarding-dismiss">
          Bỏ qua
        </button>
      </header>
      <div className="onboarding-tour__grid">
        {STEPS.map((step) => (
          <article key={step.title} className="onboarding-tour__card">
            <h3>{step.title}</h3>
            <p>{step.body}</p>
            <button
              type="button"
              className="btn btn--primary btn--compact"
              onClick={() => handleAction(step.action)}
              data-testid={`onboarding-${step.action}`}
            >
              {step.cta}
            </button>
          </article>
        ))}
      </div>
    </section>
  )
}
