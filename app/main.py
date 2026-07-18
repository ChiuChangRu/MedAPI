import csv
import io
import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "data" / "exhibitors.json"
DB_FILE = BASE_DIR / "data" / "inquiries.db"

app = FastAPI(title="Medtec China 2026 展商導覽與需求留言 API")


def get_db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS inquiries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exhibitor_id TEXT NOT NULL,
            exhibitor_name TEXT NOT NULL,
            requester_name TEXT NOT NULL,
            department TEXT,
            contact TEXT NOT NULL,
            message TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT '待轉達',
            created_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


init_db()


class InquiryIn(BaseModel):
    exhibitor_id: str
    exhibitor_name: str
    requester_name: str
    department: Optional[str] = ""
    contact: str
    message: str


class InquiryStatusUpdate(BaseModel):
    status: str


@app.get("/api/exhibitors")
def list_exhibitors():
    with open(DATA_FILE, encoding="utf-8") as f:
        return json.load(f)


@app.post("/api/inquiries")
def create_inquiry(inquiry: InquiryIn):
    if not inquiry.requester_name.strip() or not inquiry.contact.strip() or not inquiry.message.strip():
        raise HTTPException(status_code=400, detail="姓名、聯絡方式與需求內容為必填")
    conn = get_db()
    conn.execute(
        """
        INSERT INTO inquiries
            (exhibitor_id, exhibitor_name, requester_name, department, contact, message, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, '待轉達', ?)
        """,
        (
            inquiry.exhibitor_id,
            inquiry.exhibitor_name,
            inquiry.requester_name.strip(),
            (inquiry.department or "").strip(),
            inquiry.contact.strip(),
            inquiry.message.strip(),
            datetime.utcnow().isoformat(timespec="seconds") + "Z",
        ),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/inquiries")
def list_inquiries():
    conn = get_db()
    rows = conn.execute("SELECT * FROM inquiries ORDER BY id DESC").fetchall()
    conn.close()
    return [dict(row) for row in rows]


@app.patch("/api/inquiries/{inquiry_id}")
def update_inquiry_status(inquiry_id: int, update: InquiryStatusUpdate):
    conn = get_db()
    cur = conn.execute(
        "UPDATE inquiries SET status = ? WHERE id = ?", (update.status, inquiry_id)
    )
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="找不到這筆留言")
    return {"ok": True}


@app.get("/api/inquiries/export")
def export_inquiries():
    conn = get_db()
    rows = conn.execute("SELECT * FROM inquiries ORDER BY id DESC").fetchall()
    conn.close()

    buffer = io.StringIO()
    buffer.write("﻿")  # UTF-8 BOM so Excel opens Chinese text correctly
    writer = csv.writer(buffer)
    writer.writerow(
        ["編號", "廠商ID", "廠商名稱", "提出人", "部門", "聯絡方式", "需求內容", "狀態", "建立時間"]
    )
    for row in rows:
        writer.writerow(
            [
                row["id"],
                row["exhibitor_id"],
                row["exhibitor_name"],
                row["requester_name"],
                row["department"],
                row["contact"],
                row["message"],
                row["status"],
                row["created_at"],
            ]
        )
    buffer.seek(0)
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=medtec_inquiries.csv"},
    )


app.mount("/", StaticFiles(directory=BASE_DIR / "static", html=True), name="static")
