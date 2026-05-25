type StatusToastProps = {
  message: string
}

export default function StatusToast({ message }: StatusToastProps) {
  return (
    <div className="status-toast" role="status">
      {message}
    </div>
  )
}
