import librosa
import soundfile as sf
import numpy as np
from pathlib import Path
import subprocess
import tempfile
from loguru import logger

from app.ffmpeg_utils import ensure_ffmpeg_on_path


class AudioProcessor:
    """
    Audio preprocessing and segmentation
    """
    
    def __init__(self, target_sr: int = 16000):
        self.target_sr = target_sr
    
    def load_audio(self, audio_path: str) -> tuple[np.ndarray, int]:
        """
        Load audio file and resample to target sample rate
        
        Args:
            audio_path: Path to audio file
            
        Returns:
            Tuple of (audio_data, sample_rate)
        """
        path_obj = Path(audio_path)
        if not path_obj.exists() or not path_obj.is_file():
            raise FileNotFoundError(f"Audio file does not exist: {audio_path}")

        try:
            # Load audio with librosa
            audio, sr = librosa.load(audio_path, sr=self.target_sr, mono=True)
            logger.info(f"Loaded audio: {audio_path}, duration: {len(audio)/sr:.2f}s")
            return audio, sr
        except Exception as e:
            logger.warning(f"Direct audio load failed for {audio_path}: {repr(e)}")

            # Fallback: convert to a normalized WAV using ffmpeg, then retry load.
            with tempfile.TemporaryDirectory() as temp_dir:
                fallback_wav = Path(temp_dir) / "fallback.wav"
                self.convert_to_wav(audio_path, str(fallback_wav))
                audio, sr = librosa.load(str(fallback_wav), sr=self.target_sr, mono=True)
                logger.info(
                    f"Loaded audio via ffmpeg fallback: {audio_path}, duration: {len(audio)/sr:.2f}s"
                )
                return audio, sr
    
    def convert_to_wav(self, input_path: str, output_path: str) -> str:
        """
        Convert audio to WAV format using ffmpeg
        
        Args:
            input_path: Input audio file path
            output_path: Output WAV file path
            
        Returns:
            Output file path
        """
        try:
            ffmpeg_executable = ensure_ffmpeg_on_path()
            cmd = [
                ffmpeg_executable,
                '-i', input_path,
                '-ar', str(self.target_sr),
                '-ac', '1',  # mono
                '-y',  # overwrite
                output_path
            ]
            subprocess.run(cmd, check=True, capture_output=True)
            logger.info(f"Converted {input_path} to {output_path}")
            return output_path
        except subprocess.CalledProcessError as e:
            logger.error(f"FFmpeg error: {e.stderr.decode()}")
            raise
        except FileNotFoundError as e:
            logger.error(f"FFmpeg executable not found in PATH: {repr(e)}")
            raise
    
    def save_audio(self, audio: np.ndarray, output_path: str, sr: int = None):
        """
        Save audio to file
        
        Args:
            audio: Audio data
            output_path: Output file path
            sr: Sample rate
        """
        if sr is None:
            sr = self.target_sr
        
        sf.write(output_path, audio, sr)
        logger.info(f"Saved audio to {output_path}")
    
    def segment_audio(
        self, 
        audio: np.ndarray, 
        sr: int, 
        segment_duration: float = 30.0
    ) -> list[tuple[np.ndarray, float, float]]:
        """
        Segment audio into chunks
        
        Args:
            audio: Audio data
            sr: Sample rate
            segment_duration: Duration of each segment in seconds
            
        Returns:
            List of (segment_audio, start_time, end_time)
        """
        segments = []
        segment_samples = int(segment_duration * sr)
        total_samples = len(audio)
        
        for start in range(0, total_samples, segment_samples):
            end = min(start + segment_samples, total_samples)
            segment = audio[start:end]
            start_time = start / sr
            end_time = end / sr
            
            segments.append((segment, start_time, end_time))
        
        logger.info(f"Created {len(segments)} segments")
        return segments
    
    def detect_voice_activity(
        self, 
        audio: np.ndarray, 
        sr: int,
        threshold: float = 0.5
    ) -> list[tuple[float, float]]:
        """
        Simple VAD using energy-based method
        For production, use Silero VAD
        
        Args:
            audio: Audio data
            sr: Sample rate
            threshold: Energy threshold
            
        Returns:
            List of (start_time, end_time) for speech segments
        """
        # Frame-based energy calculation
        frame_length = int(0.025 * sr)  # 25ms
        hop_length = int(0.010 * sr)    # 10ms
        
        frames = librosa.util.frame(audio, frame_length=frame_length, hop_length=hop_length)
        energy = np.sum(frames ** 2, axis=0)
        
        # Normalize energy
        energy = (energy - np.min(energy)) / (np.max(energy) - np.min(energy) + 1e-8)
        
        # Detect speech frames
        is_speech = energy > threshold
        
        # Convert to time segments
        segments = []
        in_speech = False
        start = 0
        
        for i, speech in enumerate(is_speech):
            if speech and not in_speech:
                start = i * hop_length / sr
                in_speech = True
            elif not speech and in_speech:
                end = i * hop_length / sr
                segments.append((start, end))
                in_speech = False
        
        # Handle last segment
        if in_speech:
            segments.append((start, len(audio) / sr))
        
        logger.info(f"Detected {len(segments)} speech segments")
        return segments
