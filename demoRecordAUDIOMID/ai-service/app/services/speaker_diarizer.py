from pyannote.audio import Pipeline
from pyannote.core import Annotation, Segment
from typing import List, Dict
from loguru import logger
import torch


class SpeakerDiarizer:
    """
    Speaker diarization using pyannote.audio
    """
    
    def __init__(self, hf_token: str, device: str = "cpu"):
        """
        Initialize pyannote pipeline
        
        Args:
            hf_token: Hugging Face token for accessing pyannote models
            device: Device to run on (cpu, cuda)
        """
        self.device = device
        
        logger.info("Loading pyannote speaker diarization pipeline")
        
        try:
            # Load pretrained pipeline from Hugging Face with modern token API.
            self.pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                token=hf_token
            )
            
            # Move to device
            if device == "cuda" and torch.cuda.is_available():
                self.pipeline.to(torch.device("cuda"))
            
            logger.info("Pyannote pipeline loaded successfully")
            
        except Exception as e:
            logger.error(f"Failed to load pyannote pipeline: {e}")
            logger.warning("Make sure you have accepted the user agreement at:")
            logger.warning("https://huggingface.co/pyannote/speaker-diarization-3.1")
            raise
    
    def diarize(self, audio_path: str) -> Annotation:
        """
        Perform speaker diarization on audio file
        
        Args:
            audio_path: Path to audio file
            
        Returns:
            pyannote Annotation object
        """
        try:
            logger.info(f"Performing speaker diarization: {audio_path}")
            
            # Run diarization pipeline
            diarization = self.pipeline(audio_path)
            
            # Count speakers
            speakers = set()
            for turn, _, speaker in diarization.itertracks(yield_label=True):
                speakers.add(speaker)
            
            logger.info(f"Diarization completed. Detected {len(speakers)} speakers")
            
            return diarization
            
        except Exception as e:
            logger.error(f"Diarization error: {e}")
            raise
    
    def format_diarization(self, diarization: Annotation) -> List[Dict]:
        """
        Format diarization results to structured list
        
        Args:
            diarization: pyannote Annotation
            
        Returns:
            List of speaker segments
        """
        segments = []
        
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            segments.append({
                "speaker": speaker,
                "start": turn.start,
                "end": turn.end
            })
        
        # Sort by start time
        segments.sort(key=lambda x: x["start"])
        
        return segments
    
    def align_transcript_with_speakers(
        self,
        transcript_segments: List[Dict],
        speaker_segments: List[Dict]
    ) -> List[Dict]:
        """
        Align transcript segments with speaker labels
        
        Args:
            transcript_segments: List of transcript segments with start/end times
            speaker_segments: List of speaker segments from diarization
            
        Returns:
            List of aligned segments with speaker labels
        """
        aligned = []
        
        for trans_seg in transcript_segments:
            trans_start = trans_seg["start"]
            trans_end = trans_seg["end"]
            trans_mid = (trans_start + trans_end) / 2
            
            # Find speaker at the middle of transcript segment
            speaker = "UNKNOWN"
            
            for spk_seg in speaker_segments:
                if spk_seg["start"] <= trans_mid <= spk_seg["end"]:
                    speaker = spk_seg["speaker"]
                    break
            
            aligned.append({
                "speaker": speaker,
                "start": trans_start,
                "end": trans_end,
                "text": trans_seg["text"]
            })
        
        logger.info(f"Aligned {len(aligned)} transcript segments with speakers")
        
        return aligned
    
    def get_speaker_count(self, diarization: Annotation) -> int:
        """
        Get number of unique speakers
        
        Args:
            diarization: pyannote Annotation
            
        Returns:
            Number of speakers
        """
        speakers = set()
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            speakers.add(speaker)
        
        return len(speakers)
