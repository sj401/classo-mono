from fastapi import FastAPI

app = FastAPI()


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/hello")
def hello(name: str = "world"):
    return {"message": f"hello, {name}"}
