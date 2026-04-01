import whisper
import torch
from typing import List, Dict, Optional
from loguru import logger
import numpy as np

from app.ffmpeg_utils import ensure_ffmpeg_on_path


class SpeechRecognizer:
    """
    Speech-to-text using OpenAI Whisper
    """
    
    def __init__(
        self,
        model_name: str = "large-v3",
        device: str = "cpu",
        no_speech_threshold: float = 0.7,
        logprob_threshold: float = -0.8,
        cpu_chunk_duration_seconds: int = 30,
        gpu_chunk_duration_seconds: int = 60,
    ):
        """
        Initialize Whisper model
        
        Args:
            model_name: Whisper model size (tiny, base, small, medium, large, large-v3)
            device: Device to run model on (cpu, cuda)
        """
        self.device = device
        self.model_name = model_name
        self.no_speech_threshold = no_speech_threshold
        self.logprob_threshold = logprob_threshold
        self.cpu_chunk_duration_seconds = cpu_chunk_duration_seconds
        self.gpu_chunk_duration_seconds = gpu_chunk_duration_seconds
        
        logger.info(f"Loading Whisper model: {model_name} on {device}")
        self.model = whisper.load_model(model_name, device=device)
        logger.info("Whisper model loaded successfully")

    def _get_chunk_duration_seconds(self) -> int:
        # GPU can handle larger chunks with better throughput.
        return self.gpu_chunk_duration_seconds if self.device == "cuda" else self.cpu_chunk_duration_seconds

    def _transcribe_chunk(
        self,
        chunk_audio: np.ndarray,
        language: Optional[str],
        initial_prompt: Optional[str],
        temperature: float,
        beam_size: int,
        best_of: int,
        no_speech_threshold: float,
        logprob_threshold: float,
    ) -> Dict:
        return self.model.transcribe(
            chunk_audio,
            language=language,
            task="transcribe",
            word_timestamps=False,
            initial_prompt=initial_prompt,
            temperature=temperature,
            beam_size=beam_size,
            best_of=best_of,
            condition_on_previous_text=False,
            no_speech_threshold=no_speech_threshold,
            logprob_threshold=logprob_threshold,
            verbose=False,
        )

    def _transcribe_long_audio(
        self,
        audio_path: str,
        language: Optional[str],
        initial_prompt: str,
        temperature: float,
        beam_size: int,
        best_of: int,
        no_speech_threshold: float,
        logprob_threshold: float,
    ) -> Dict:
        audio = whisper.load_audio(audio_path)
        sample_rate = whisper.audio.SAMPLE_RATE
        chunk_seconds = self._get_chunk_duration_seconds()
        chunk_samples = chunk_seconds * sample_rate

        if len(audio) <= chunk_samples:
            return self._transcribe_chunk(
                chunk_audio=audio,
                language=language,
                initial_prompt=initial_prompt,
                temperature=temperature,
                beam_size=beam_size,
                best_of=best_of,
                no_speech_threshold=no_speech_threshold,
                logprob_threshold=logprob_threshold,
            )

        logger.info(
            f"Long-audio mode enabled: duration={len(audio)/sample_rate:.2f}s, chunk_seconds={chunk_seconds}, device={self.device}"
        )

        merged_segments = []
        detected_language = language or "unknown"

        for chunk_idx, start in enumerate(range(0, len(audio), chunk_samples)):
            end = min(start + chunk_samples, len(audio))
            chunk_audio = audio[start:end]
            start_seconds = start / sample_rate

            # Keep prompt context only in the first chunk to reduce loop drift.
            chunk_prompt = initial_prompt if chunk_idx == 0 else None

            chunk_result = self._transcribe_chunk(
                chunk_audio=chunk_audio,
                language=language,
                initial_prompt=chunk_prompt,
                temperature=temperature,
                beam_size=beam_size,
                best_of=best_of,
                no_speech_threshold=no_speech_threshold,
                logprob_threshold=logprob_threshold,
            )

            detected_language = chunk_result.get("language", detected_language)

            for segment in chunk_result.get("segments", []):
                merged_segments.append(
                    {
                        "start": float(segment.get("start", 0.0)) + start_seconds,
                        "end": float(segment.get("end", 0.0)) + start_seconds,
                        "text": str(segment.get("text", "")).strip(),
                        "words": segment.get("words", []),
                    }
                )

        merged_text = " ".join(seg["text"] for seg in merged_segments if seg.get("text")).strip()
        return {
            "text": merged_text,
            "segments": merged_segments,
            "language": detected_language,
        }
    
    def transcribe(
        self, 
        audio_path: str,
        language: str = None,
        initial_prompt: str = """
    Đây là cuộc họp bằng tiếng Việt.
    Các từ thường dùng: chào mừng, sinh viên, bài giảng, dự án, báo cáo.
    """,
        temperature: float = 0.0,
        beam_size: int = 8,
        best_of: int = 8,
        condition_on_previous_text: bool = False,
        no_speech_threshold: Optional[float] = None,
        logprob_threshold: Optional[float] = None,
    ) -> Dict:
        """
        Transcribe audio file to text
        
        Args:
            audio_path: Path to audio file
            language: Language code (e.g., 'en', 'vi'). None for auto-detect
            
        Returns:
            Dictionary with transcription results
        """
        try:
            logger.info(f"Transcribing audio: {audio_path}")
            ensure_ffmpeg_on_path()

            effective_no_speech_threshold = (
                self.no_speech_threshold if no_speech_threshold is None else no_speech_threshold
            )
            effective_logprob_threshold = (
                self.logprob_threshold if logprob_threshold is None else logprob_threshold
            )

            if condition_on_previous_text:
                logger.warning(
                    "condition_on_previous_text=True can increase repetition risk on long audio; overriding to False is recommended."
                )

            # For long files, process in chunks to avoid decoder drift and repeated loops.
            result = self._transcribe_long_audio(
                audio_path=audio_path,
                language=language,
                initial_prompt=initial_prompt,
                temperature=temperature,
                beam_size=beam_size,
                best_of=best_of,
                no_speech_threshold=effective_no_speech_threshold,
                logprob_threshold=effective_logprob_threshold,
            )
            
            logger.info(f"Transcription completed. Detected language: {result.get('language', 'unknown')}")
            return result
            
        except Exception as e:
            logger.error(f"Transcription error: {e}")
            raise
    
    def transcribe_segment(
        self,
        audio: np.ndarray,
        sr: int = 16000,
        language: str = None
    ) -> Dict:
        """
        Transcribe audio segment
        
        Args:
            audio: Audio numpy array
            sr: Sample rate
            language: Language code
            
        Returns:
            Transcription result
        """
        try:
            # Whisper expects float32 audio normalized to [-1, 1]
            if audio.dtype != np.float32:
                audio = audio.astype(np.float32)
            
            # Normalize if needed
            if np.max(np.abs(audio)) > 1.0:
                audio = audio / np.max(np.abs(audio))
            
            # Pad or trim to 30 seconds for Whisper
            target_length = 30 * sr
            if len(audio) < target_length:
                audio = np.pad(audio, (0, target_length - len(audio)))
            else:
                audio = audio[:target_length]
            
            # Transcribe
            result = self.model.transcribe(
                audio,
                language=language,
                task="transcribe",
                word_timestamps=False,
                verbose=False
            )
            
            return result
            
        except Exception as e:
            logger.error(f"Segment transcription error: {e}")
            raise
    
    def format_transcript(self, result: Dict) -> List[Dict]:
        """
        Format Whisper output to structured segments
        
        Args:
            result: Whisper transcription result
            
        Returns:
            List of formatted segments
        """
        segments = []
        
        for segment in result.get("segments", []):
            segments.append({
                "start": segment["start"],
                "end": segment["end"],
                "text": segment["text"].strip(),
                "words": segment.get("words", [])
            })
        
        return segments
    
    def get_full_text(self, result: Dict) -> str:
        """
        Extract full text from transcription result
        
        Args:
            result: Whisper result
            
        Returns:
            Full transcribed text
        """
        return result.get("text", "").strip()
