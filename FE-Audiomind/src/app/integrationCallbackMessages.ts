export const resolveZoomCallbackMessage = (reason: string | null): string => {
  switch ((reason || '').toLowerCase()) {
    case 'provider_error':
      return 'Zoom từ chối yêu cầu. Hãy thử lại hoặc kiểm tra app OAuth trên Zoom Marketplace.'
    case 'missing_code':
      return 'Không nhận được mã xác thực từ Zoom. Hãy thử kết nối lại.'
    case 'zoom_account_already_linked':
      return 'Tài khoản Zoom này đã được liên kết với người dùng khác.'
    case 'zoom_oauth_not_configured':
      return 'Zoom chưa được cấu hình trên server. Liên hệ quản trị viên.'
    default:
      return 'Kết nối Zoom thất bại. Hãy thử lại.'
  }
}

export const resolveTeamsCallbackMessage = (reason: string | null, kind: 'linked' | 'error'): string => {
  if (kind === 'linked') {
    return 'Đã kết nối Microsoft Teams thành công. Chọn cloud recording để import.'
  }

  switch ((reason || '').toLowerCase()) {
    case 'provider_error':
      return 'Microsoft từ chối yêu cầu. Hãy thử lại hoặc kiểm tra app Azure AD.'
    case 'missing_code':
      return 'Không nhận được mã xác thực từ Microsoft. Hãy thử kết nối lại.'
    case 'teams_account_already_linked':
      return 'Tài khoản Microsoft này đã được liên kết với người dùng khác.'
    case 'teams_oauth_not_configured':
      return 'Teams chưa được cấu hình trên server. Liên hệ quản trị viên.'
    default:
      return 'Kết nối Teams thất bại. Hãy thử lại.'
  }
}

export const resolveGoogleLoginError = (errorCode: string | null): string => {
  switch (errorCode) {
    case 'GOOGLE_EMAIL_CONFLICT':
      return 'Email này đã tồn tại. Hãy đăng nhập bằng mật khẩu rồi kết nối Google.'
    case 'GOOGLE_OAUTH_STATE_INVALID':
      return 'Phiên xác thực Google không hợp lệ. Vui lòng thử lại.'
    default:
      return 'Đăng nhập Google thất bại. Vui lòng thử lại.'
  }
}
