import logging
import math
import os
import shutil
import tempfile
import time
from threading import Lock

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from faster_whisper import WhisperModel
from pydantic import BaseModel

router = APIRouter(prefix="/api", tags=["transcribe"])

MODEL_NAME = os.getenv("WHISPER_MODEL", "base")
model = WhisperModel(MODEL_NAME)
logger = logging.getLogger("uvicorn.error")

RTF_ESTIMATE_DEFAULT = float(os.getenv("TRANSCRIBE_RTF_ESTIMATE", "1.0"))
RTF_ESTIMATE_ALPHA = float(os.getenv("TRANSCRIBE_RTF_ALPHA", "0.2"))
_rtf_lock = Lock()
_rtf_avg: float | None = None
_model_log_lock = Lock()
_model_logged = False


def _format_bytes(size: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    readable = float(size)
    for unit in units:
        if readable < 1024.0:
            if unit == "B":
                return f"{int(readable)}{unit}"
            return f"{readable:.1f}{unit}"
        readable /= 1024.0
    return f"{readable:.1f}PB"


def _format_seconds(seconds: float) -> str:
    if seconds <= 0:
        return "0s"
    total = int(round(seconds))
    minutes, secs = divmod(total, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h{minutes:02d}m{secs:02d}s"
    if minutes:
        return f"{minutes}m{secs:02d}s"
    return f"{secs}s"


def _get_hf_cache_dir() -> str:
    cache_dir = os.getenv("HUGGINGFACE_HUB_CACHE") or os.getenv("HF_HUB_CACHE")
    if cache_dir:
        return cache_dir
    hf_home = os.getenv("HF_HOME")
    if hf_home:
        return os.path.join(hf_home, "hub")
    xdg_cache = os.getenv("XDG_CACHE_HOME")
    if xdg_cache:
        return os.path.join(xdg_cache, "huggingface", "hub")
    return os.path.expanduser("~/.cache/huggingface/hub")


def _log_model_details_once() -> None:
    global _model_logged
    with _model_log_lock:
        if _model_logged:
            return
        _model_logged = True

    model_path = os.path.abspath(MODEL_NAME) if os.path.exists(MODEL_NAME) else None
    if model_path:
        logger.info("Whisper model: %s (local path)", model_path)
    else:
        logger.info("Whisper model: %s", MODEL_NAME)
        logger.info("Hugging Face cache dir: %s", _get_hf_cache_dir())


def _get_rtf_estimate() -> float:
    with _rtf_lock:
        return _rtf_avg if _rtf_avg is not None else RTF_ESTIMATE_DEFAULT


def _update_rtf_estimate(rtf: float) -> None:
    global _rtf_avg
    with _rtf_lock:
        if _rtf_avg is None:
            _rtf_avg = rtf
        else:
            _rtf_avg = (RTF_ESTIMATE_ALPHA * rtf) + ((1 - RTF_ESTIMATE_ALPHA) * _rtf_avg)


class TranscriptWord(BaseModel):
    start: float
    end: float
    word: str
    probability: float


class TranscriptSegment(BaseModel):
    start: float
    end: float
    text: str
    confidence: float | None = None
    words: list[TranscriptWord] | None = None


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
    tmp_path = None
    start = time.perf_counter()

    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            shutil.copyfileobj(file.file, tmp)
            tmp.flush()
            tmp_path = tmp.name

        _log_model_details_once()

        file_size = os.path.getsize(tmp_path)
        logger.info(
            "Transcribe request: filename=%s content_type=%s size=%s model=%s language=%s beam_size=%s vad_filter=%s",
            file.filename,
            file.content_type,
            _format_bytes(file_size),
            MODEL_NAME,
            language,
            beam_size,
            vad_filter,
        )

        segments, info = model.transcribe(
            tmp_path,
            language=language,
            beam_size=beam_size,
            vad_filter=vad_filter,
            word_timestamps=True,
        )
        audio_duration = getattr(info, "duration", None)
        if audio_duration:
            rtf_estimate = _get_rtf_estimate()
            estimated_seconds = audio_duration * rtf_estimate
            logger.info(
                "Transcribe estimate: audio_duration=%.2fs rtf_estimate=%.2f estimated_time=%s",
                audio_duration,
                rtf_estimate,
                _format_seconds(estimated_seconds),
            )
        else:
            logger.info("Transcribe estimate: audio_duration unavailable")

        out_segments = []
        texts = []
        for segment in segments:
            text = segment.text.strip()
            if text:
                texts.append(text)
            confidence = None
            avg_logprob = getattr(segment, "avg_logprob", None)
            if isinstance(avg_logprob, (int, float)):
                confidence = math.exp(avg_logprob)
                confidence = max(0.0, min(1.0, confidence))
            else:
                raw_words = getattr(segment, "words", None)
                if raw_words:
                    probs = [
                        getattr(word, "probability", None)
                        for word in raw_words
                        if isinstance(getattr(word, "probability", None), (int, float))
                    ]
                    if probs:
                        confidence = sum(probs) / len(probs)
            word_entries = None
            raw_words = getattr(segment, "words", None)
            if raw_words is not None:
                word_entries = [
                    TranscriptWord(
                        start=word.start,
                        end=word.end,
                        word=word.word,
                        probability=word.probability,
                    )
                    for word in raw_words
                ]
            out_segments.append(
                TranscriptSegment(
                    start=segment.start,
                    end=segment.end,
                    text=text,
                    confidence=confidence,
                    words=word_entries,
                )
            )

        elapsed = time.perf_counter() - start
        if audio_duration:
            rtf = elapsed / audio_duration if audio_duration > 0 else 0.0
            if rtf:
                _update_rtf_estimate(rtf)
            logger.info(
                "Transcribe complete: elapsed=%s rtf=%.2f",
                _format_seconds(elapsed),
                rtf,
            )
        else:
            logger.info("Transcribe complete: elapsed=%s", _format_seconds(elapsed))

        return TranscriptResponse(
            text=" ".join(texts).strip(),
            language=getattr(info, "language", None),
            segments=out_segments,
        )
    except Exception:
        logger.exception("Transcribe failed")
        raise
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)
