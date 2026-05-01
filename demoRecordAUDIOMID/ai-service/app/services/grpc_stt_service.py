"""gRPC service for streaming STT processing using Deepgram adapter."""

from uuid import uuid4

import grpc
from loguru import logger

# Make generated imports work from the current directory
import sys
from pathlib import Path

# Add generated directory to path for imports
_generated_path = Path(__file__).parent.parent / "generated"
sys.path.insert(0, str(_generated_path))

import ai_stream_pb2 as ai__stream__pb2  # noqa: E402
import ai_stream_pb2_grpc as ai__stream__pb2__grpc  # noqa: E402
import realtime_events_pb2 as realtime__events__pb2  # noqa: E402

from app.services.stt_adapter import DeepgramSTTAdapter  # noqa: E402


class AiStreamServicer(ai__stream__pb2__grpc.AiStreamServiceServicer):
    """gRPC service for AI stream processing with Deepgram STT adapter."""

    def __init__(self, stt_adapter: DeepgramSTTAdapter):
        """Initialize the service with an STT adapter instance.

        Args:
            stt_adapter: DeepgramSTTAdapter instance for speech-to-text processing.
        """
        self.stt_adapter = stt_adapter
        logger.info("AiStreamServicer initialized with DeepgramSTTAdapter")

    def ProcessMeeting(self, request, context):
        """Process a meeting synchronously (placeholder for future batch processing).

        Args:
            request: ProcessMeetingRequest with meeting_id, audio_path, language, glossary_version.
            context: gRPC context.

        Returns:
            ProcessMeetingResponse with status and job_id.
        """
        try:
            logger.info(
                f"ProcessMeeting request: meeting_id={request.meeting_id}, "
                f"language={request.language}, glossary_version={request.glossary_version}"
            )

            job_id = str(uuid4())
            response = ai__stream__pb2.ProcessMeetingResponse(
                meeting_id=request.meeting_id,
                status="queued",
                message=f"Meeting queued with job_id: {job_id}",
            )
            return response

        except Exception as e:
            logger.error(f"ProcessMeeting error: {e}", exc_info=True)
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(f"Internal server error: {str(e)}")
            raise

    async def StreamAudio(self, request_iterator, context):
        """Handle bidirectional audio streaming with Deepgram STT adapter.

        Args:
            request_iterator: Async iterator of StreamEnvelope requests from client.
            context: gRPC context.

        Yields:
            StreamEnvelope responses with partial transcript events.
        """
        session_id = None
        meeting_id = None

        try:
            # Process incoming audio chunks and emit responses
            async for request in request_iterator:
                # First envelope should contain metadata or audio_chunk
                if request.HasField("audio_chunk"):
                    audio_chunk = request.audio_chunk
                    meeting_id = audio_chunk.meeting_id

                    # Open session on first chunk
                    if session_id is None:
                        session_id = await self.stt_adapter.open_session(
                            meeting_id=meeting_id,
                            language="vi",  # TODO: get from first envelope or request
                        )
                        logger.info(
                            f"Opened STT session {session_id} for meeting {meeting_id}"
                        )

                    # Push chunk to adapter
                    await self.stt_adapter.push_audio_chunk(
                        session_id=session_id,
                        pcm_chunk=bytes(audio_chunk.pcm_chunk),
                        ts_ms=audio_chunk.ts_ms,
                    )

                    partial_events = self.stt_adapter.drain_partial_events(session_id)
                    if not partial_events:
                        partial_events = [
                            {
                                "text": "[processing...]",
                                "ts_ms": audio_chunk.ts_ms,
                                "confidence": None,
                            }
                        ]

                    for partial_event in partial_events:
                        emitted_at_ms = int(partial_event.get("ts_ms") or audio_chunk.ts_ms)
                        response = realtime__events__pb2.StreamEnvelope(
                            event_id=str(uuid4()),
                            event_type="transcript.partial",
                            trace_id=request.trace_id or "",
                            emitted_at_ms=emitted_at_ms,
                        )
                        response.transcript_partial.CopyFrom(
                            realtime__events__pb2.TranscriptPartialEvent(
                                meeting_id=meeting_id,
                                segment_id=str(uuid4()),
                                start_time=emitted_at_ms / 1000.0,
                                end_time=emitted_at_ms / 1000.0,
                                speaker=str(partial_event.get("speaker") or "unknown"),
                                text=str(partial_event.get("text") or "").strip(),
                                language="vi",
                                version_hash="",
                            )
                        )
                        yield response

            # Close session when stream ends
            if session_id:
                await self.stt_adapter.close_session(session_id)
                transcript = self.stt_adapter.get_transcript(session_id)
                logger.info(
                    f"Closed STT session {session_id}: transcript length = {len(transcript)} chars"
                )

                # Emit final transcript event
                response = realtime__events__pb2.StreamEnvelope(
                    event_id=str(uuid4()),
                    event_type="transcript.final",
                    trace_id="",
                    emitted_at_ms=0,
                )
                response.transcript_partial.CopyFrom(
                    realtime__events__pb2.TranscriptPartialEvent(
                        meeting_id=meeting_id or 0,
                        segment_id=str(uuid4()),
                        start_time=0.0,
                        end_time=0.0,
                        speaker="system",
                        text=transcript,
                        language="vi",
                        version_hash="",
                    )
                )
                yield response

        except grpc.RpcError:
            # Client disconnected
            logger.warning(
                f"Client disconnected from StreamAudio for session {session_id}"
            )
            if session_id:
                try:
                    await self.stt_adapter.close_session(session_id)
                except Exception as e:
                    logger.warning(f"Error closing session during disconnect: {e}")
        except Exception as e:
            logger.error(f"StreamAudio error: {e}", exc_info=True)
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(f"Streaming error: {str(e)}")
            raise


def create_grpc_server(
    servicer: AiStreamServicer,
    host: str = "0.0.0.0",
    port: int = 50051,
    max_workers: int = 10,
) -> grpc.Server:
    """Create and configure a gRPC server with the AI stream service.

    Args:
        servicer: AiStreamServicer instance.
        host: Server host address.
        port: Server port.
        max_workers: Maximum number of concurrent workers.

    Returns:
        Configured gRPC server ready to serve.
    """
    # Create server with thread pool executor
    from concurrent.futures import ThreadPoolExecutor

    executor = ThreadPoolExecutor(max_workers=max_workers)
    server = grpc.server(
        executor,
        options=[
            ("grpc.max_send_message_length", -1),
            ("grpc.max_receive_message_length", -1),
        ],
    )

    # Add service to server
    ai__stream__pb2__grpc.add_AiStreamServiceServicer_to_server(servicer, server)

    # Add address and port
    server.add_insecure_port(f"{host}:{port}")

    logger.info(f"gRPC server configured to listen on {host}:{port}")
    return server
