import { StudioAmbientBackground } from '../ui/StudioAmbientBackground'
import { StudioWaveform } from '../ui/StudioWaveform'
import { GoogleAuthButton } from './GoogleAuthButton'

type AuthRoute = 'login' | 'register'

type StudioAuthPageProps = {
  authRoute: AuthRoute
  onNavigate: (route: AuthRoute) => void
  username: string
  password: string
  onUsernameChange: (value: string) => void
  onPasswordChange: (value: string) => void
  onLogin: () => void
  onGoogleLogin: () => void
  googleLoginEnabled: boolean
  authError: string
  authNotice: string
  inviteMeetingId?: number | null
  registerUsername: string
  registerEmail: string
  registerPassword: string
  registerConfirmPassword: string
  onRegisterUsernameChange: (value: string) => void
  onRegisterEmailChange: (value: string) => void
  onRegisterPasswordChange: (value: string) => void
  onRegisterConfirmPasswordChange: (value: string) => void
  onRegister: () => void
  registerBusy: boolean
  registerError: string
}

export default function StudioAuthPage({
  authRoute,
  onNavigate,
  username,
  password,
  onUsernameChange,
  onPasswordChange,
  onLogin,
  onGoogleLogin,
  googleLoginEnabled,
  authError,
  authNotice,
  inviteMeetingId,
  registerUsername,
  registerEmail,
  registerPassword,
  registerConfirmPassword,
  onRegisterUsernameChange,
  onRegisterEmailChange,
  onRegisterPasswordChange,
  onRegisterConfirmPasswordChange,
  onRegister,
  registerBusy,
  registerError,
}: StudioAuthPageProps) {
  const isLogin = authRoute === 'login'

  return (
    <div className="studio-auth app--studio">
      <section className="studio-auth__hero" aria-hidden="false">
        <StudioAmbientBackground variant="auth" />
        <div className="studio-auth__hero-top">
          <span className="studio-auth__crumb">audiomind / studio</span>
          <div className="studio-auth__brand-row">
            <span className="studio-auth__logo-mark" aria-hidden="true" />
            <span className="studio-auth__brand-name">AudioMind</span>
          </div>
          <p className="studio-auth__engine-badge">
            <span className="studio-auth__pulse" />
            Neural pipeline · online
          </p>
        </div>

        <div className="studio-auth__hero-copy">
          <h1>
            Ghi âm. Phân tích.
            <br />
            <span className="studio-auth__hero-accent">AI lo phần còn lại.</span>
          </h1>
          <p>
            Ghi âm, chuyển transcript và tóm tắt bài giảng với pipeline studio —
            nhận diện người nói, đa ngôn ngữ và phân tích Gemini trong vài phút.
          </p>
        </div>

        <div className="studio-auth__demo-card">
          <StudioWaveform className="studio-waveform--lg" bars={32} />
          <div className="studio-auth__rec">
            <span className="studio-auth__rec-dot" />
            REC · 00:42:19
          </div>
          <p className="studio-auth__transcribe-label">ai transcribing</p>
          <p className="studio-auth__transcript-preview">
            → &quot;Hôm nay chúng ta sẽ đi qua kiến trúc transformer và cách fine-tune mô hình cho tiếng Việt—&quot;
          </p>
        </div>

        <ul className="studio-auth__stats">
          <li>Realtime STT</li>
          <li>Vi + En</li>
          <li>E2E encrypted</li>
        </ul>

        <p className="studio-auth__footer">© 2026 AudioMind · made with sound waves</p>
      </section>

      <section className="studio-auth__panel">
        <StudioAmbientBackground variant="panel" />
        <div className="studio-auth__panel-inner">
          <div className="studio-auth__panel-brand">
            <span className="studio-auth__logo-mark studio-auth__logo-mark--sm" aria-hidden="true" />
            <span>AudioMind</span>
          </div>
          <p className="studio-auth__terminal">／ access terminal</p>

          <h2>{isLogin ? 'Welcome back' : 'Create studio account'}</h2>
          <p className="studio-auth__subtitle">
            {isLogin
              ? 'Đăng nhập studio và tiếp tục từ nơi giọng nói của bạn dừng lại.'
              : 'Tạo tài khoản để upload audio, ghi âm realtime và nhận phân tích AI.'}
          </p>

          {authNotice && <p className="studio-auth__notice">{authNotice}</p>}

          {inviteMeetingId != null && (
            <p className="studio-auth__notice" data-testid="invite-meeting-banner">
              Bạn được mời xem một cuộc họp. Hãy đăng ký hoặc đăng nhập bằng đúng email trong lời mời.
            </p>
          )}

          {isLogin ? (
            <form
              className="studio-auth__form"
              onSubmit={(event) => {
                event.preventDefault()
                onLogin()
              }}
            >
              <label className="studio-auth__field">
                <span>Username</span>
                <input
                  type="text"
                  placeholder="username"
                  autoComplete="username"
                  data-testid="e2e-login-username"
                  value={username}
                  onChange={(event) => onUsernameChange(event.target.value)}
                />
              </label>
              <label className="studio-auth__field">
                <span>Password</span>
                <input
                  type="password"
                  placeholder="••••••••"
                  autoComplete="current-password"
                  data-testid="e2e-login-password"
                  value={password}
                  onChange={(event) => onPasswordChange(event.target.value)}
                />
              </label>
              <button type="submit" className="studio-auth__submit" data-testid="e2e-login-submit">
                Enter studio
              </button>
              {googleLoginEnabled && (
                <GoogleAuthButton onClick={onGoogleLogin} />
              )}
              <button
                type="button"
                className="studio-auth__link"
                data-testid="e2e-auth-switch-register"
                onClick={() => onNavigate('register')}
              >
                New to AudioMind? Create a studio account
              </button>
              {authError && <p className="studio-auth__error" role="alert">{authError}</p>}
            </form>
          ) : (
            <form
              className="studio-auth__form"
              onSubmit={(event) => {
                event.preventDefault()
                onRegister()
              }}
            >
              <label className="studio-auth__field">
                <span>Username</span>
                <input
                  type="text"
                  placeholder="username"
                  data-testid="e2e-register-username"
                  value={registerUsername}
                  onChange={(event) => onRegisterUsernameChange(event.target.value)}
                />
              </label>
              <label className="studio-auth__field">
                <span>Email</span>
                <input
                  type="email"
                  placeholder="you@studio.local"
                  data-testid="e2e-register-email"
                  value={registerEmail}
                  onChange={(event) => onRegisterEmailChange(event.target.value)}
                />
              </label>
              <label className="studio-auth__field">
                <span>Password</span>
                <input
                  type="password"
                  placeholder="••••••••"
                  data-testid="e2e-register-password"
                  value={registerPassword}
                  onChange={(event) => onRegisterPasswordChange(event.target.value)}
                />
              </label>
              <label className="studio-auth__field">
                <span>Confirm password</span>
                <input
                  type="password"
                  placeholder="••••••••"
                  data-testid="e2e-register-confirm-password"
                  value={registerConfirmPassword}
                  onChange={(event) => onRegisterConfirmPasswordChange(event.target.value)}
                />
              </label>
              <button
                type="submit"
                className="studio-auth__submit"
                data-testid="e2e-register-submit"
                disabled={registerBusy}
              >
                {registerBusy ? 'Đang đăng ký...' : 'Create account'}
              </button>
              {googleLoginEnabled && (
                <GoogleAuthButton onClick={onGoogleLogin} testId="e2e-google-register" />
              )}
              <button
                type="button"
                className="studio-auth__link"
                data-testid="e2e-auth-switch-login"
                onClick={() => onNavigate('login')}
              >
                Đã có tài khoản? Đăng nhập
              </button>
              {registerError && <p className="studio-auth__error" role="alert">{registerError}</p>}
            </form>
          )}

          <p className="studio-auth__secure">Protected by studio-grade encryption · v1.0</p>
        </div>
      </section>
    </div>
  )
}
