type GoogleAuthButtonProps = {
  onClick: () => void
  testId?: string
}

export function GoogleAuthButton({ onClick, testId = 'e2e-google-login' }: GoogleAuthButtonProps) {
  return (
    <>
      <div className="studio-auth__divider" role="separator"><span>or</span></div>
      <button
        type="button"
        className="studio-auth__google"
        data-testid={testId}
        onClick={onClick}
      >
        Continue with Google
      </button>
    </>
  )
}
