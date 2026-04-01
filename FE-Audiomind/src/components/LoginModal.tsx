import { useState } from 'react'

type LoginModalProps = {
  onLogin: (name: string) => void
  onClose?: () => void
}

export default function LoginModal({ onLogin, onClose }: LoginModalProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [loginMethod, setLoginMethod] = useState<'email' | 'phone'>('email')
  const [name, setName] = useState('Nguyễn Văn A')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const handleSubmit = () => {
    const displayName = name.trim() || (loginMethod === 'phone' ? phone : email) || 'Người dùng demo'
    onLogin(displayName)
  }

  return (
    <div
      className="login-modal"
      onClick={() => onClose?.()}
      role="presentation"
    >
      <div className="login-card" onClick={(event) => event.stopPropagation()}>
        {onClose && (
          <button className="login-close" type="button" onClick={onClose}>
            ×
          </button>
        )}
        <div className="auth-tabs">
          <button
            type="button"
            className={`auth-tab ${mode === 'login' ? 'auth-tab--active' : ''}`}
            onClick={() => setMode('login')}
          >
            Đăng nhập
          </button>
          <button
            type="button"
            className={`auth-tab ${mode === 'register' ? 'auth-tab--active' : ''}`}
            onClick={() => setMode('register')}
          >
            Đăng ký
          </button>
        </div>

        <h2>{mode === 'login' ? 'Đăng nhập' : 'Đăng ký'}</h2>
        <p>{mode === 'login' ? 'Sử dụng tài khoản demo để trải nghiệm.' : 'Tạo tài khoản demo mới.'}</p>

        {mode === 'login' ? (
          <>
            <div className="auth-methods">
              <button
                type="button"
                className={`auth-method ${loginMethod === 'email' ? 'auth-method--active' : ''}`}
                onClick={() => setLoginMethod('email')}
              >
                Email
              </button>
              <button
                type="button"
                className={`auth-method ${loginMethod === 'phone' ? 'auth-method--active' : ''}`}
                onClick={() => setLoginMethod('phone')}
              >
                Số điện thoại
              </button>
            </div>

            {loginMethod === 'email' ? (
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="Nhập email"
              />
            ) : (
              <input
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="Nhập số điện thoại"
              />
            )}

            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Nhập mật khẩu"
            />

            <div className="auth-meta">
              <label className="auth-check">
                <input type="checkbox" defaultChecked />
                <span>Ghi nhớ đăng nhập</span>
              </label>
              <button type="button" className="auth-link">Quên mật khẩu?</button>
            </div>
          </>
        ) : (
          <>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Nhập họ tên"
            />
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Nhập email"
            />
            <input
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="Nhập số điện thoại"
            />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Nhập mật khẩu"
            />
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="Nhập lại mật khẩu"
            />
          </>
        )}

        <button type="button" onClick={handleSubmit}>
          {mode === 'login' ? 'Vào hệ thống' : 'Tạo tài khoản'}
        </button>
      </div>
    </div>
  )
}
