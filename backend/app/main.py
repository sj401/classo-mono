from fastapi import FastAPI

from app.api.transcribe import router as transcribe_router

app = FastAPI()
app.include_router(transcribe_router)


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/hello")
def hello(name: str = "world"):
    return {"message": f"hello, {name}"}
