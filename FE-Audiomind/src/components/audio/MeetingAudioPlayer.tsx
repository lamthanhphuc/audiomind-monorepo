import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchMeetingAudioBlob } from '../../services/api'
import { formatAudioClock } from '../../utils/formatAudioClock'
import { StudioWaveform } from '../ui/StudioWaveform'
import './meeting-audio-player.css'

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2] as const

type MeetingAudioPlayerProps = {
  label: string
  meetingId?: number | null
  audioFile?: File | null
  seekToTime?: number | null
}

type PlayerStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unavailable'

export default function MeetingAudioPlayer({
  label,
  meetingId = null,
  audioFile = null,
  seekToTime = null,
}: MeetingAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const objectUrlRef = useRef<string | null>(null)
  const [status, setStatus] = useState<PlayerStatus>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)

  const revokeObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
  }, [])

  const resetAudioElement = useCallback(() => {
    const audio = audioRef.current
    if (!audio) {
      return
    }
    audio.pause()
    audio.removeAttribute('src')
    try {
      audio.load()
    } catch {
      // jsdom does not implement HTMLMediaElement.load
    }
    setIsPlaying(false)
    setCurrentTime(0)
    setDuration(0)
  }, [])

  const assignAudioSource = useCallback((audio: HTMLAudioElement, source: string) => {
    audio.src = source
    try {
      audio.load()
    } catch {
      // jsdom does not implement HTMLMediaElement.load
    }
  }, [])

  useEffect(() => {
    let active = true
    revokeObjectUrl()
    resetAudioElement()

    if (audioFile) {
      let objectUrl: string
      try {
        objectUrl = URL.createObjectURL(audioFile)
      } catch {
        setStatus('error')
        setErrorMessage('Không thể phát file âm thanh trên trình duyệt này.')
        return () => {
          active = false
        }
      }
      objectUrlRef.current = objectUrl
      const audio = audioRef.current
      if (audio) {
        assignAudioSource(audio, objectUrl)
      }
      setStatus('ready')
      setErrorMessage(null)
      return () => {
        active = false
        revokeObjectUrl()
      }
    }

    if (meetingId == null) {
      setStatus('unavailable')
      setErrorMessage('Chưa có file âm thanh cho cuộc họp này.')
      return undefined
    }

    setStatus('loading')
    setErrorMessage(null)

    void fetchMeetingAudioBlob(meetingId)
      .then(({ blob }) => {
        if (!active) {
          return
        }
        const objectUrl = URL.createObjectURL(blob)
        objectUrlRef.current = objectUrl
        const audio = audioRef.current
        if (audio) {
          assignAudioSource(audio, objectUrl)
        }
        setStatus('ready')
      })
      .catch((cause) => {
        if (!active) {
          return
        }
        setStatus('error')
        setErrorMessage(cause instanceof Error ? cause.message : 'Không thể tải file âm thanh.')
      })

    return () => {
      active = false
      revokeObjectUrl()
    }
  }, [audioFile, meetingId, assignAudioSource, resetAudioElement, revokeObjectUrl])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || seekToTime == null || !Number.isFinite(seekToTime)) {
      return
    }
    audio.currentTime = Math.max(0, seekToTime)
    setCurrentTime(audio.currentTime)
  }, [seekToTime])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) {
      return undefined
    }

    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime)
    }
    const onLoadedMetadata = () => {
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
    }
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onEnded = () => setIsPlaying(false)

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
    }
  }, [status])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) {
      return
    }
    audio.volume = muted ? 0 : volume
    audio.playbackRate = playbackRate
  }, [muted, volume, playbackRate, status])

  const togglePlay = async () => {
    const audio = audioRef.current
    if (!audio || status !== 'ready') {
      return
    }

    if (audio.paused) {
      try {
        await audio.play()
      } catch {
        setErrorMessage('Trình duyệt chặn phát âm thanh. Hãy thử bấm Phát lại.')
        setStatus('error')
      }
      return
    }

    audio.pause()
  }

  const toggleMute = () => {
    setMuted((value) => !value)
  }

  const handleVolumeChange = (nextVolume: number) => {
    const clamped = Math.min(1, Math.max(0, nextVolume))
    setMuted(clamped === 0)
    setVolume(clamped)
  }

  const handlePlaybackRateChange = (nextRate: number) => {
    setPlaybackRate(nextRate)
  }

  const disabled = status === 'loading' || status === 'unavailable' || status === 'error'
  const timeLabel = duration > 0
    ? `${formatAudioClock(currentTime)} / ${formatAudioClock(duration)}`
    : formatAudioClock(currentTime)

  return (
    <div className="audio-player-card meeting-audio-player studio-reveal studio-reveal--delay-1" data-testid="meeting-audio-player">
      <audio ref={audioRef} preload="metadata" data-testid="meeting-audio-element" />
      <StudioWaveform className="studio-waveform--lg" bars={36} active={isPlaying && !muted && status === 'ready'} />
      <div className="audio-controls">
        <button
          type="button"
          className="play-btn"
          aria-label={isPlaying ? 'Tạm dừng' : 'Phát'}
          data-testid="meeting-audio-play"
          disabled={disabled}
          onClick={() => void togglePlay()}
        >
          {status === 'loading' ? '…' : isPlaying ? '❚❚' : '▶'}
        </button>
        <div className="time-info">
          <span className="time-title">{label}</span>
          <span className="time-duration" data-testid="meeting-audio-clock">{timeLabel}</span>
          {errorMessage && <span className="meeting-audio-player__error">{errorMessage}</span>}
        </div>
        <div className="audio-options">
          <button
            type="button"
            className="audio-options__icon-btn"
            aria-label={muted || volume === 0 ? 'Bật tiếng' : 'Tắt tiếng'}
            data-testid="meeting-audio-mute"
            disabled={disabled}
            onClick={toggleMute}
          >
            {muted || volume === 0 ? '🔇' : '🔊'}
          </button>
          <input
            type="range"
            className="audio-volume-slider"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            aria-label="Âm lượng"
            data-testid="meeting-audio-volume"
            disabled={disabled}
            onChange={(event) => handleVolumeChange(Number(event.target.value))}
          />
          <select
            aria-label="Tốc độ phát"
            data-testid="meeting-audio-rate"
            disabled={disabled}
            value={playbackRate}
            onChange={(event) => handlePlaybackRateChange(Number(event.target.value))}
          >
            {PLAYBACK_RATES.map((rate) => (
              <option key={rate} value={rate}>{rate}x</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  )
}
