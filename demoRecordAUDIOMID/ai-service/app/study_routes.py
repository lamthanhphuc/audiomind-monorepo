"""Internal FastAPI routes for Phase 2 subject synthesis and study artifacts."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.services.internal_service_auth import (
    FinalAudioAuthError,
    raise_http_for_auth_error,
    require_internal_service_token,
)
from app.services.study import (
    StudyAuthorizationError,
    StudySourceNotReadyError,
    StudyValidationError,
)
from app.services.study import service as study_service
from app.services.study.source_resolve import resolve_study_sources

router = APIRouter(tags=["study-internal"])


def _require_internal(request: Request) -> None:
    try:
        require_internal_service_token(request)
    except FinalAudioAuthError as exc:
        raise_http_for_auth_error(exc)


class ResolveSourcesRequest(BaseModel):
    ownerUserId: int
    meetingIds: list[int] = Field(default_factory=list)


class PrepareSynthesisRequest(BaseModel):
    ownerUserId: int
    subjectId: int
    meetingIds: list[int] = Field(default_factory=list)
    sourceSelectionMode: str = "ALL_READY"
    language: str = "vi"
    force: bool = False


class PrepareArtifactsRequest(BaseModel):
    ownerUserId: int
    subjectId: int
    meetingIds: list[int] = Field(default_factory=list)
    artifactTypes: list[str] = Field(default_factory=list)
    sourceSelectionMode: str = "ALL_READY"
    options: dict[str, Any] = Field(default_factory=dict)
    synthesisId: int | None = None
    force: bool = False


class DispatchRequest(BaseModel):
    ownerUserId: int
    synthesisIds: list[int] = Field(default_factory=list)
    artifactIds: list[int] = Field(default_factory=list)


class QuotaFailRequest(BaseModel):
    ownerUserId: int
    synthesisIds: list[int] = Field(default_factory=list)
    artifactIds: list[int] = Field(default_factory=list)


class StaleContext(BaseModel):
    meetingIds: list[int] = Field(default_factory=list)


@router.post("/api/internal/study-sources/resolve")
def resolve_sources(
    body: ResolveSourcesRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_internal(request)
    items = resolve_study_sources(
        db, owner_user_id=body.ownerUserId, meeting_ids=body.meetingIds
    )
    return {"items": items}


@router.post("/api/internal/subjects/{subject_id}/synthesis/prepare")
def prepare_synthesis(
    subject_id: int,
    body: PrepareSynthesisRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_internal(request)
    if body.subjectId != subject_id:
        raise HTTPException(status_code=400, detail={"error_code": "SUBJECT_MISMATCH"})
    try:
        return study_service.prepare_synthesis(
            db,
            owner_user_id=body.ownerUserId,
            subject_id=subject_id,
            meeting_ids=body.meetingIds,
            source_selection_mode=body.sourceSelectionMode,
            language=body.language,
            force=body.force,
        )
    except StudySourceNotReadyError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": exc.code,
                "meetingIds": exc.meeting_ids,
                "message": "Source meetings not ready",
            },
        ) from exc
    except StudyValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error_code": exc.code, "message": exc.message, **exc.details},
        ) from exc


@router.post("/api/internal/study-artifacts/prepare")
def prepare_artifacts(
    body: PrepareArtifactsRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_internal(request)
    try:
        return study_service.prepare_artifacts(
            db,
            owner_user_id=body.ownerUserId,
            subject_id=body.subjectId,
            meeting_ids=body.meetingIds,
            artifact_types=body.artifactTypes,
            source_selection_mode=body.sourceSelectionMode,
            options=body.options,
            synthesis_id=body.synthesisId,
            force=body.force,
        )
    except StudySourceNotReadyError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": exc.code,
                "meetingIds": exc.meeting_ids,
                "message": "Source meetings not ready",
            },
        ) from exc
    except StudyValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error_code": exc.code, "message": exc.message, **exc.details},
        ) from exc


@router.post("/api/internal/study/dispatch")
def dispatch_jobs(
    body: DispatchRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_internal(request)
    try:
        return study_service.dispatch_study_jobs(
            db,
            owner_user_id=body.ownerUserId,
            synthesis_ids=body.synthesisIds,
            artifact_ids=body.artifactIds,
        )
    except StudyValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error_code": exc.code, "message": exc.message, **exc.details},
        ) from exc


@router.post("/api/internal/study/reconcile")
def reconcile_jobs(
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_internal(request)
    return study_service.reconcile_study_generation_jobs(db)


@router.post("/api/internal/study/quota-failed")
def quota_failed(
    body: QuotaFailRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, str]:
    _require_internal(request)
    if body.artifactIds:
        study_service.mark_reserved_quota_exceeded(
            db, body.artifactIds, body.ownerUserId
        )
    for sid in body.synthesisIds:
        study_service.mark_synthesis_quota_exceeded(db, sid, body.ownerUserId)
    return {"status": "ok"}


@router.get("/api/internal/subjects/{subject_id}/synthesis")
def get_synthesis(
    subject_id: int,
    request: Request,
    ownerUserId: int,
    meetingIds: str = "",
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_internal(request)
    meeting_ids = [int(x) for x in meetingIds.split(",") if x.strip().isdigit()]
    result = study_service.get_synthesis_for_owner(
        db,
        subject_id=subject_id,
        owner_user_id=ownerUserId,
        meeting_ids_for_stale=meeting_ids,
    )
    if result is None:
        raise HTTPException(status_code=404, detail={"error_code": "NOT_FOUND"})
    return result


@router.get("/api/internal/study-artifacts/{artifact_id}")
def get_artifact(
    artifact_id: int,
    request: Request,
    ownerUserId: int,
    meetingIds: str = "",
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_internal(request)
    meeting_ids = [int(x) for x in meetingIds.split(",") if x.strip().isdigit()]
    try:
        return study_service.get_artifact_for_owner(
            db,
            artifact_id=artifact_id,
            owner_user_id=ownerUserId,
            meeting_ids_for_stale=meeting_ids if meeting_ids else None,
        )
    except StudyAuthorizationError as exc:
        raise HTTPException(status_code=404, detail={"error_code": "NOT_FOUND"}) from exc


@router.get("/api/internal/subjects/{subject_id}/study-artifacts")
def list_artifacts(
    subject_id: int,
    request: Request,
    ownerUserId: int,
    artifactType: str | None = None,
    status: str | None = None,
    page: int = 1,
    size: int | None = None,
    sort: str = "updated_at_desc",
    meetingIds: str = "",
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_internal(request)
    meeting_ids = [int(x) for x in meetingIds.split(",") if x.strip().isdigit()]
    return study_service.list_artifacts_for_subject(
        db,
        subject_id=subject_id,
        owner_user_id=ownerUserId,
        artifact_type=artifactType,
        status=status,
        page=page,
        size=size,
        sort=sort,
        meeting_ids_for_stale=meeting_ids,
    )


@router.delete("/api/internal/study-artifacts/{artifact_id}")
def delete_artifact(
    artifact_id: int,
    request: Request,
    ownerUserId: int,
    db: Session = Depends(get_db),
) -> dict[str, str]:
    _require_internal(request)
    try:
        study_service.soft_delete_artifact(
            db, artifact_id=artifact_id, owner_user_id=ownerUserId
        )
    except StudyAuthorizationError as exc:
        raise HTTPException(status_code=404, detail={"error_code": "NOT_FOUND"}) from exc
    return {"status": "deleted"}
