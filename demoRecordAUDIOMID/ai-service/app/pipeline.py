from pathlib import Path, PureWindowsPath
from typing import Dict, List, Optional
from datetime import datetime
import json
import re
from loguru import logger
from sqlalchemy.orm import Session

from app.services.audio_processor import AudioProcessor
from app.services.speech_recognizer import SpeechRecognizer
from app.services.ai_analyzer import AIAnalyzer
from app.models import Transcript, Analysis
from app.config import get_settings, get_runtime_device

settings = get_settings()
BASELINE_MEETING_ID = 1774519878


class ProcessingPipeline:
    """
    Main processing pipeline orchestrating all services
    """
    
    def __init__(self):
        """Initialize all processing components"""
        
        logger.info("Initializing Processing Pipeline")
        
        # Lightweight components are initialized immediately.
        self.audio_processor = AudioProcessor(target_sr=16000)

        self.speech_recognizer = None
        self.speaker_diarizer = None
        self.ai_analyzer = None
        self.diarization_available = True

        if not settings.lazy_load_models:
            self._ensure_models_loaded()
        
        logger.info("Processing Pipeline initialized successfully")

    def _ensure_models_loaded(self):
        """Load heavy models only when needed."""
        runtime_device = get_runtime_device()

        if self.speech_recognizer is None:
            self.speech_recognizer = SpeechRecognizer(
                model_name=settings.whisper_model,
                device=runtime_device,
                no_speech_threshold=settings.whisper_no_speech_threshold,
                logprob_threshold=settings.whisper_logprob_threshold,
                cpu_chunk_duration_seconds=settings.whisper_cpu_chunk_seconds,
                gpu_chunk_duration_seconds=settings.whisper_gpu_chunk_seconds,
            )

        if self.ai_analyzer is None:
            self.ai_analyzer = AIAnalyzer(
                api_key=settings.openai_api_key,
                model=settings.ollama_model,
                provider="ollama",
                ollama_base_url=settings.ollama_base_url,
                timeout_seconds=settings.ollama_timeout_seconds,
            )

        diarization_enabled = self._should_enable_diarization(runtime_device)
        if diarization_enabled and self.speaker_diarizer is None:
            try:
                from app.services.speaker_diarizer import SpeakerDiarizer

                self.speaker_diarizer = SpeakerDiarizer(
                    hf_token=settings.huggingface_token,
                    device=runtime_device
                )
                self.diarization_available = True
            except Exception as e:
                # Fallback gracefully to single-speaker mode when model/token is unavailable.
                self.diarization_available = False
                self.speaker_diarizer = None
                logger.warning(f"Speaker diarization auto-disabled due to initialization failure: {repr(e)}")

    def _should_enable_diarization(self, runtime_device: str) -> bool:
        # GPU defaults to diarization enabled; CPU follows config toggle.
        if runtime_device == "cuda":
            return True
        return settings.enable_speaker_diarization

    def _record_baseline_snapshot(self, meeting_id: int, runtime_device: str) -> None:
        payload = {
            "meeting_id": meeting_id,
            "runtime_device": runtime_device,
            "whisper_model": settings.whisper_model,
            "enable_speaker_diarization": self._should_enable_diarization(runtime_device),
            "diarization_available": self.diarization_available,
            "ollama_timeout_seconds": settings.ollama_timeout_seconds,
            "timestamp": datetime.utcnow().isoformat(),
        }

        logger.info(f"Processing baseline snapshot: {payload}")

        logs_dir = Path(__file__).resolve().parent.parent / "logs"
        logs_dir.mkdir(parents=True, exist_ok=True)
        baseline_path = logs_dir / f"baseline_{meeting_id}.json"
        baseline_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def _normalize_speaker_labels(self, segments: List[Dict]) -> List[Dict]:
        speaker_map: Dict[str, str] = {}
        normalized = []

        for seg in segments:
            raw_speaker = str(seg.get("speaker", "UNKNOWN")).strip() or "UNKNOWN"
            canonical = speaker_map.get(raw_speaker)
            if canonical is None:
                canonical = f"SPEAKER_{len(speaker_map) + 1}"
                speaker_map[raw_speaker] = canonical

            normalized.append(
                {
                    "speaker": canonical,
                    "start": seg.get("start"),
                    "end": seg.get("end"),
                    "text": seg.get("text", ""),
                }
            )

        return normalized

    def _deduplicate_repeated_segments(
        self,
        segments: List[Dict],
        repeat_threshold: int = 3,
        max_short_text_len: int = 40,
        max_time_gap_seconds: float = 2.5,
    ) -> List[Dict]:
        if not segments:
            return segments

        # Collapse runs like "Chuyên là..." repeated many short consecutive segments.
        deduped: List[Dict] = []
        idx = 0
        total_removed = 0

        while idx < len(segments):
            current = segments[idx]
            current_text = str(current.get("text", "")).strip()
            normalized_text = re.sub(r"\s+", " ", current_text.lower())

            run_end = idx
            while run_end + 1 < len(segments):
                nxt = segments[run_end + 1]
                next_text = re.sub(r"\s+", " ", str(nxt.get("text", "")).strip().lower())
                time_gap = float(nxt.get("start", 0.0)) - float(segments[run_end].get("end", 0.0))
                if next_text != normalized_text or time_gap > max_time_gap_seconds:
                    break
                run_end += 1

            run_length = run_end - idx + 1
            is_short_loop = bool(normalized_text) and len(normalized_text) <= max_short_text_len

            if is_short_loop and run_length > repeat_threshold:
                deduped.append(current)
                total_removed += run_length - 1
            else:
                deduped.extend(segments[idx:run_end + 1])

            idx = run_end + 1

        if total_removed > 0:
            logger.warning(f"Removed {total_removed} repeated transcript segments before DB save")

        return deduped

    def _resolve_audio_path(self, audio_path: str) -> str:
        """Resolve incoming path from other services to an existing local file path."""
        def _decode_mojibake(value: str) -> str:
            try:
                return value.encode("latin-1").decode("utf-8")
            except UnicodeError:
                return value

        path_variants = [audio_path]
        repaired_audio_path = _decode_mojibake(audio_path)
        if repaired_audio_path != audio_path:
            path_variants.append(repaired_audio_path)

        raw_paths = [Path(item) for item in path_variants]

        windows_raw_paths = [PureWindowsPath(item) for item in path_variants]

        project_root = Path(__file__).resolve().parent.parent
        workspace_root = project_root.parent

        candidates: list[Path] = []
        for raw_path in raw_paths:
            if raw_path.is_absolute():
                candidates.append(raw_path)
            else:
                candidates.extend([
                    project_root / raw_path,
                    workspace_root / raw_path,
                    Path.cwd() / raw_path,
                ])

        upload_roots = [
            Path("/app/uploads"),
            Path.cwd() / "uploads",
            project_root / "uploads",
            workspace_root / "uploads",
            workspace_root / "meeting-service" / "uploads",
        ]

        # Fallback lookup: keep only filename and search common upload locations.
        audio_names = list(
            {
                name
                for name in (
                    [path.name for path in raw_paths]
                    + [path.name for path in windows_raw_paths]
                )
                if name
            }
        )
        for audio_name in audio_names:
            for root in upload_roots:
                candidates.append(root / audio_name)

        checked = []
        seen = set()
        for candidate in candidates:
            candidate_str = str(candidate)
            if candidate_str in seen:
                continue
            seen.add(candidate_str)
            checked.append(candidate_str)
            if candidate.exists() and candidate.is_file():
                resolved = str(candidate.resolve())
                logger.info(f"Resolved audio path: {audio_path} -> {resolved}")
                return resolved

        raise FileNotFoundError(
            f"Audio file not found for input path '{audio_path}'. Checked: {checked}"
        )

    def _build_initial_prompt(
        self,
        topic: Optional[str] = None,
        glossary_terms: Optional[List[str]] = None,
    ) -> str:
        """Build a concise prompt to bias Whisper toward domain terms."""
        topic_key = (topic or "").strip().lower()
        topic_defaults: Dict[str, List[str]] = {
            "engineering": [
                "model",
                "module",
                "API",
                "Docker",
                "Kubernetes",
                "SQL",
                "AWS",
                "IAM",
                "S3",
                "EC2",
                "RDS",
                "VPC",
                "EKS",
                "CloudWatch",
                "Lambda",
                "DevOps",
            ],
            "finance": ["invoice", "balance sheet", "VAT", "reconciliation", "cash flow"],
            "hr": ["onboarding", "payroll", "KPI", "OKR", "headcount"],
        }

        merged_terms = []
        seen = set()

        for term in topic_defaults.get(topic_key, []):
            key = term.lower()
            if key not in seen:
                seen.add(key)
                merged_terms.append(term)

        for term in (glossary_terms or []):
            clean_term = str(term).strip()
            if not clean_term:
                continue
            key = clean_term.lower()
            if key not in seen:
                seen.add(key)
                merged_terms.append(clean_term)

        base = (
            "Meeting transcript may contain Vietnamese mixed with English technical terms. "
            "Do not transliterate English terms into Vietnamese phonetics; keep original English spelling."
        )
        if not merged_terms:
            return base

        return f"{base} Keep original spelling for these terms: {', '.join(merged_terms)}."

    def _build_normalization_map(
        self,
        topic: Optional[str] = None,
        glossary_terms: Optional[List[str]] = None,
    ) -> Dict[str, str]:
        """Common Vietnamese phonetic variants mapped to canonical technical terms."""
        topic_key = (topic or "").strip().lower()

        normalization_map: Dict[str, str] = {
            r"\bmo\s*đun\b": "module",
            r"\bmô\s*đun\b": "module",
            r"\bmô\s*đen\b": "model",
            r"\bê\s*pi\s*ai\b": "API",
            r"\bđốc\s*cơ\b": "Docker",
            r"\bxì\s*kiu\s*eo\b": "SQL",
            r"\bxì\s*kiu\s*él\b": "SQL",
            r"\bi\s*w\s*s\b": "AWS",
            r"\biw\.?s\b": "AWS",
            r"\bay\s*đắp\b": "AWS",
            r"\bờ\s*quai\s*ét\s*chờ\b": "CloudWatch",
            r"\bđép\s*ốp\b": "DevOps",
        }

        if topic_key == "finance":
            normalization_map.update(
                {
                    r"\bin\s*voi\s*xe\b": "invoice",
                    r"\bva\s*ti\b": "VAT",
                }
            )

        for term in (glossary_terms or []):
            clean = str(term).strip()
            if not clean:
                continue
            # Keep explicit canonical terms safe against accidental spacing in transcript.
            letters_spaced_pattern = r"\\b" + r"\\s*".join(re.escape(ch) for ch in clean) + r"\\b"
            normalization_map.setdefault(letters_spaced_pattern, clean)

        return normalization_map

    def _normalize_transcript_segments(
        self,
        segments: List[Dict],
        topic: Optional[str] = None,
        glossary_terms: Optional[List[str]] = None,
    ) -> List[Dict]:
        """Normalize common misrecognized terms while preserving timestamps/speakers."""
        replacements = self._build_normalization_map(topic=topic, glossary_terms=glossary_terms)
        normalized = []

        for seg in segments:
            text = str(seg.get("text", ""))
            for pattern, target in replacements.items():
                text = re.sub(pattern, target, text, flags=re.IGNORECASE)

            normalized.append(
                {
                    "start": seg.get("start"),
                    "end": seg.get("end"),
                    "text": text,
                    "words": seg.get("words", []),
                }
            )

        return normalized
    
    def process_meeting(
        self,
        audio_path: str,
        meeting_id: int,
        db: Session,
        topic: Optional[str] = None,
        glossary_terms: Optional[List[str]] = None,
        language: Optional[str] = "vi",
    ) -> Dict:
        """
        Complete processing pipeline for a meeting
        
        Pipeline:
        1. Load and preprocess audio
        2. Speech-to-text transcription
        3. Speaker diarization
        4. Align transcript with speakers
        5. AI analysis
        6. Save to database
        
        Args:
            audio_path: Path to audio file
            meeting_id: Meeting ID from meeting-service
            db: Database session
            
        Returns:
            Processing result dictionary
        """
        try:
            logger.info(f"Starting processing pipeline for meeting {meeting_id}")
            runtime_device = get_runtime_device()
            self._ensure_models_loaded()
            resolved_audio_path = self._resolve_audio_path(audio_path)

            self._record_baseline_snapshot(meeting_id, runtime_device)
            if meeting_id == BASELINE_MEETING_ID:
                logger.info(f"Baseline test meeting detected: {BASELINE_MEETING_ID}")
            
            # Step 1: Load audio
            logger.info("Step 1: Loading audio")
            try:
                self.audio_processor.load_audio(resolved_audio_path)
            except Exception as e:
                logger.warning(
                    f"Step 1 failed but pipeline will continue with Whisper direct input: {repr(e)}"
                )
            
            # Step 2: Speech-to-text
            logger.info("Step 2: Speech recognition")
            initial_prompt = self._build_initial_prompt(topic=topic, glossary_terms=glossary_terms)
            logger.info(f"Using Whisper initial prompt: {initial_prompt}")

            transcript_result = self.speech_recognizer.transcribe(
                resolved_audio_path,
                language=language,
                initial_prompt=initial_prompt,
            )
            transcript_segments = self.speech_recognizer.format_transcript(transcript_result)
            transcript_segments = self._normalize_transcript_segments(
                transcript_segments,
                topic=topic,
                glossary_terms=glossary_terms,
            )
            
            logger.info(f"Transcription complete: {len(transcript_segments)} segments")
            
            diarization_enabled = self._should_enable_diarization(runtime_device) and self.diarization_available
            if diarization_enabled and self.speaker_diarizer is not None:
                # Step 3: Speaker diarization
                logger.info("Step 3: Speaker diarization")
                diarization = self.speaker_diarizer.diarize(resolved_audio_path)
                speaker_segments = self.speaker_diarizer.format_diarization(diarization)

                speaker_count = self.speaker_diarizer.get_speaker_count(diarization)
                logger.info(f"Diarization complete: {speaker_count} speakers detected")

                # Step 4: Align transcript with speakers
                logger.info("Step 4: Aligning transcript with speakers")
                aligned_segments = self.speaker_diarizer.align_transcript_with_speakers(
                    transcript_segments,
                    speaker_segments
                )
                aligned_segments = self._normalize_speaker_labels(aligned_segments)
            else:
                logger.info("Step 3/4: Speaker diarization disabled (low-memory mode)")
                speaker_count = 1
                aligned_segments = [
                    {
                        "speaker": "SPEAKER_1",
                        "start": seg["start"],
                        "end": seg["end"],
                        "text": seg["text"],
                    }
                    for seg in transcript_segments
                ]

            aligned_segments = self._deduplicate_repeated_segments(aligned_segments)
            
            # Step 5: AI Analysis
            logger.info("Step 5: AI analysis")
            formatted_transcript = self.ai_analyzer.format_transcript_for_analysis(aligned_segments)
            analysis_result = self.ai_analyzer.analyze_meeting(formatted_transcript)
            
            # Step 6: Save to database
            logger.info("Step 6: Saving to database")
            self._save_results(meeting_id, aligned_segments, analysis_result, db)
            
            logger.info(f"Processing complete for meeting {meeting_id}")
            
            return {
                "meeting_id": meeting_id,
                "status": "completed",
                "transcript_segments": len(aligned_segments),
                "speaker_count": speaker_count,
                "diarization_enabled": diarization_enabled,
                "analysis": analysis_result
            }
            
        except Exception as e:
            logger.exception(f"Processing pipeline error for meeting {meeting_id}: {repr(e)}")
            raise
    
    def _save_results(
        self, 
        meeting_id: int, 
        aligned_segments: List[Dict],
        analysis_result: Dict,
        db: Session
    ):
        """
        Save processing results to database

        Args:
            meeting_id: Meeting ID
            aligned_segments: Aligned transcript segments
            analysis_result: AI analysis results
            db: Database session
        """
        try:
            def _to_builtin(value):
                if value is None or isinstance(value, (str, int, float, bool, datetime)):
                    return value

                # numpy scalar types support .item()
                if hasattr(value, "item"):
                    try:
                        return _to_builtin(value.item())
                    except Exception:
                        pass

                if isinstance(value, dict):
                    return {str(k): _to_builtin(v) for k, v in value.items()}

                if isinstance(value, (list, tuple)):
                    return [_to_builtin(v) for v in value]

                return str(value)

            # Save transcripts
            for segment in aligned_segments:
                transcript = Transcript(
                    meeting_id=meeting_id,
                    speaker=str(segment.get("speaker", "UNKNOWN")),
                    start_time=float(_to_builtin(segment.get("start", 0.0))),
                    end_time=float(_to_builtin(segment.get("end", 0.0))),
                    text=str(segment.get("text", ""))
                )
                db.add(transcript)

            # Save analysis
            clean_analysis = _to_builtin(analysis_result or {})
            clean_keywords = clean_analysis.get("keywords", [])
            clean_technical_terms = clean_analysis.get("technical_terms", [])
            if self.ai_analyzer is not None:
                clean_technical_terms = self.ai_analyzer.sanitize_technical_terms(
                    transcript="\n".join(str(segment.get("text", "")) for segment in aligned_segments),
                    technical_terms=clean_technical_terms,
                    keywords=clean_keywords,
                )
            analysis = Analysis(
                meeting_id=meeting_id,
                summary=str(clean_analysis.get("summary", "")),
                keywords=clean_keywords,
                technical_terms=clean_technical_terms,
                action_items=clean_analysis.get("action_items", [])
            )
            db.add(analysis)

            # Commit
            db.commit()

            logger.info(f"Saved {len(aligned_segments)} transcript segments and analysis")

        except Exception as e:
            db.rollback()
            logger.error(f"Database save error: {e}")
            raise
    
    def get_transcript(self, meeting_id: int, db: Session) -> List[Transcript]:
        """
        Retrieve transcript for a meeting
        
        Args:
            meeting_id: Meeting ID
            db: Database session
            
        Returns:
            List of transcript segments
        """
        transcripts = db.query(Transcript).filter(
            Transcript.meeting_id == meeting_id
        ).order_by(Transcript.start_time).all()
        
        return transcripts
    
    def get_analysis(self, meeting_id: int, db: Session) -> Analysis:
        """
        Retrieve analysis for a meeting
        
        Args:
            meeting_id: Meeting ID
            db: Database session
            
        Returns:
            Analysis object
        """
        analysis = db.query(Analysis).filter(
            Analysis.meeting_id == meeting_id
        ).first()
        
        return analysis
