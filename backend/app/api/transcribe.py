import os
import shutil
import tempfile

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from faster_whisper import WhisperModel
from pydantic import BaseModel

router = APIRouter(prefix="/api", tags=["transcribe"])

MODEL_NAME = os.getenv("WHISPER_MODEL", "base")
model = WhisperModel(MODEL_NAME)


class TranscriptSegment(BaseModel):
    start: float
    end: float
    text: str


class TranscriptResponse(BaseModel):
    text: str
    language: str | None
    segments: list[TranscriptSegment]


@router.post("/transcribe/segment", response_model=TranscriptResponse)
async def transcribe_segment(
    file: UploadFile = File(...),
    language: str | None = Query(None, description="Optional language code, e.g. en"),
    beam_size: int = Query(5, ge=1, le=10),
    vad_filter: bool = Query(True),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    await file.seek(0)
    suffix = os.path.splitext(file.filename)[1] or ".audio"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp.flush()
        tmp_path = tmp.name

    try:
        segments, info = model.transcribe(
            tmp_path,
            language=language,
            beam_size=beam_size,
            vad_filter=vad_filter,
        )
        out_segments = []
        texts = []
        for segment in segments:
            text = segment.text.strip()
            if text:
                texts.append(text)
            out_segments.append(
                TranscriptSegment(
                    start=segment.start,
                    end=segment.end,
                    text=text,
                )
            )
        return TranscriptResponse(
            text=" ".join(texts).strip(),
            language=getattr(info, "language", None),
            segments=out_segments,
        )
    finally:
        os.remove(tmp_path)
