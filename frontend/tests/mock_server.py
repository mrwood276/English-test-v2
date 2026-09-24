"""A pretend server for the browser tests: answers the question-bank, exams, session and auth-me endpoints from memory."""
import datetime
import json
import time


def iso(seconds):
    """Postgres hands back timestamps as ISO text, so the fake server does the same."""
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).isoformat().replace("+00:00", "Z")

# tiny real files so <img> and <audio> have something to load in the browser
PNG_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
WAV_URL = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="
TYPES = ["multiple_choice", "true_false", "short_answer", "essay"]
DIFFS = ["easy", "medium", "hots"]

def make_questions():
    out = []
    for i in range(1, 31):
        body = f"Question number {i} about {'Narrative Text' if i <= 15 else 'Simple Past'}"
        if i == 1:
            body = '<b>Bold</b> <script>window.__pwned=1</script><img src=x onerror="window.__pwned=2"> plain text'
        out.append({
            "id": f"00000000-0000-4000-8000-{i:012d}", "n": i, "type": TYPES[(i - 1) % 4], "difficulty": DIFFS[(i - 1) % 3],
            "topic": "Narrative Text" if i <= 15 else "Simple Past", "body": body,
            "class_labels": ["XII TKJ B", "XII TKJ A"] if i % 3 == 0 else (["XII TKJ A"] if i % 2 else []),
            "has_audio": i % 5 == 0, "has_image": i % 7 == 0, "has_passage": i % 2 == 0, "used_in_exams": i % 4,
            "is_archived": False, "weight": 2 if i % 4 == 0 else 1, "created": 31 - i,
        })
    return out

class Server:
    def __init__(self):
        self.qs = make_questions(); self.calls = []; self.fail_list = 0; self.status_all = None
        self.saved = []; self.dup_calls = []; self.media = {}; self.media_calls = []; self.register_error = None; self.last_upload_size = None
        self.import_checks = []; self.imports = []
        self.exam_calls = []; self.exams = {}; self.exam_codes_used = {"TAKEN1"}
        # student side (session function)
        self.session_exams = {}; self.sessions = {}; self.taken = set(); self.session_calls = []
        self.session_events = []; self.session_seconds = None; self.session_media_urls = {}
        # teacher side (results function)
        self.manual_grades = {}; self.retakes = {}; self.result_calls = []; self.class_aliases = {}
        self.passages = [{"id": "pa1", "title": "The Lost Wallet", "body": "Dina found a <u>brown</u> wallet.", "question_count": 3}, {"id": "pa2", "title": "The Smart Monkey", "body": "A clever monkey sat on a branch.", "question_count": 1}]
    def item(self, q):
        return {k: q[k] for k in ["id", "type", "body", "topic", "difficulty", "weight", "class_labels", "has_audio", "has_image", "has_passage", "used_in_exams", "is_archived"]} | {"updated_at": "2026-09-20T00:00:00Z"}
    def full(self, q):
        t = q["type"]
        opts = []
        if t == "multiple_choice":
            opts = [{"position": i + 1, "body": b, "is_correct": i == 1} for i, b in enumerate(["She kept the money.", "She looked around.", "She called the police.", "She left it."])]
        elif t == "true_false":
            opts = [{"position": 1, "body": "True", "is_correct": False}, {"position": 2, "body": "False", "is_correct": True}]
        return {**self.item(q), "options": opts, "accepted_answers": ["past", "simple past"] if t == "short_answer" else [],
                "essay_guidance": "One mark per idea, up to 4." if t == "essay" else None, "explanation": "Because the passage says so.",
                "passage": {"id": "p1", "title": "The Lost Wallet", "body": "Dina found a <u>brown</u> wallet.", "media": [{"id": "mp1", "kind": "image", "mime_type": "image/webp", "size_bytes": 50000, "name": "wallet.webp", "duration_seconds": None, "position": 0}] if q["n"] == 2 else []} if q["has_passage"] else None,
                "media": q.get("media") or ([{"id": "m1", "kind": "audio", "mime_type": "audio/mpeg", "size_bytes": 1000, "name": "story.mp3", "duration_seconds": 135, "position": 0}] if q["has_audio"] else []),
                "class_labels": q["class_labels"]}
    def handle_media(self, route, req):
        body = json.loads(req.post_data or "{}"); a = body.get("action"); self.media_calls.append(body)
        def ok(data): route.fulfill(status=200, content_type="application/json", body=json.dumps(data))
        def err(status, msg): route.fulfill(status=status, content_type="application/json", body=json.dumps({"error": msg, "code": "bad_request"}))
        if a == "create_upload":
            ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "audio/mpeg": "mp3", "audio/mp4": "m4a"}[body["mime_type"]]
            kind = body["mime_type"].split("/")[0]
            n = len(self.media_calls)
            path = f"{kind}/2026/00000000-0000-4000-8000-{n:012d}.{ext}"
            return ok({"path": path, "upload_url": f"https://mock-storage.test/upload/{path}?token=t", "max_bytes": 1500000 if kind == "image" else 10485760, "size_bytes": body["size_bytes"]})
        if a == "register":
            if self.register_error: return err(400, self.register_error)
            path = body["path"]; kind = path.split("/")[0]
            mid = f"55555555-5555-4555-8555-{len(self.media) + 1:012d}"
            m = {"id": mid, "kind": kind, "mime_type": "image/webp" if kind == "image" else "audio/mpeg", "size_bytes": self.last_upload_size or 1000, "name": body.get("name"), "duration_seconds": body.get("duration_seconds")}
            self.media[mid] = m
            return ok({"media": m})
        if a == "signed_urls":
            urls = {}
            for i in body["ids"]:
                m = self.media.get(i) or {"kind": "audio" if i in ("m1",) else "image"}
                urls[i] = PNG_URL if m["kind"] == "image" else WAV_URL
            return ok({"urls": urls, "expires_in": 3600})
        err(400, "Unknown action")

    def passages_list(self):
        return [{"id": x["id"], "title": x["title"], "excerpt": x["body"][:60], "question_count": x["question_count"]} for x in self.passages]
    def handle(self, route):
        req = route.request
        if req.method == "OPTIONS": return route.fulfill(status=204, body="")
        url = req.url
        if "/functions/v1/media" in url:
            return self.handle_media(route, req)
        if "/functions/v1/exams" in url:
            return self.handle_exams(route, req)
        if "/functions/v1/session" in url:
            return self.handle_session(route, req)
        if "/functions/v1/results" in url:
            return self.handle_results(route, req)
        if "/auth-me" in url:
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"user": {"id": "u1", "fullName": "Admin", "role": "admin"}}))
        body = json.loads(req.post_data or "{}"); a = body.get("action"); self.calls.append(body)
        if self.status_all:
            return route.fulfill(status=self.status_all, content_type="application/json", body=json.dumps({"error": "Your session has expired. Please sign in again.", "code": "unauthorized"}))
        def ok(data): route.fulfill(status=200, content_type="application/json", body=json.dumps(data))
        if a == "list":
            if self.fail_list > 0:
                self.fail_list -= 1
                return route.fulfill(status=500, content_type="application/json", body=json.dumps({"error": "Something went wrong. Please try again.", "code": "internal_error"}))
            rows = [q for q in self.qs if q["is_archived"] == bool(body.get("archived"))]
            if body.get("q"): rows = [q for q in rows if body["q"].lower() in q["body"].lower()]
            for k in ["topic", "difficulty", "type"]:
                if body.get(k): rows = [q for q in rows if str(q[k]).lower() == str(body[k]).lower()]
            if body.get("class_label"): rows = [q for q in rows if body["class_label"] in q["class_labels"]]
            if body.get("used") == "unused": rows = [q for q in rows if q["used_in_exams"] == 0]
            if body.get("used") == "used": rows = [q for q in rows if q["used_in_exams"] > 0]
            sort = body.get("sort", "newest")
            if sort == "newest": rows.sort(key=lambda q: -q["created"])
            if sort == "oldest": rows.sort(key=lambda q: q["created"])
            if sort == "body": rows.sort(key=lambda q: q["body"])
            size = body.get("page_size", 25); page = body.get("page", 1)
            return ok({"items": [self.item(q) for q in rows[(page - 1) * size: page * size]], "total": len(rows), "page": page, "page_size": size})
        if a == "get":
            q = next((q for q in self.qs if q["id"] == body["id"]), None)
            return ok({"question": self.full(q)}) if q else route.fulfill(status=404, content_type="application/json", body=json.dumps({"error": "That question no longer exists.", "code": "not_found"}))
        if a == "save":
            self.saved.append(body)
            if not str(body.get("body", "")).strip(): return route.fulfill(status=400, content_type="application/json", body=json.dumps({"error": "The question text is required.", "code": "bad_request"}))
            if "FORCE_SERVER_ERROR" in body.get("body", ""): return route.fulfill(status=400, content_type="application/json", body=json.dumps({"error": "Choose exactly one correct answer.", "code": "bad_request"}))
            if body.get("id"):
                q = next(q for q in self.qs if q["id"] == body["id"])
                q.update(type=body["type"], difficulty=body["difficulty"], topic=body.get("topic") or "", body=body["body"], class_labels=body.get("class_labels", []))
                return ok({"id": q["id"]})
            n = len(self.qs) + 100
            nid = f"00000000-0000-4000-8000-{n:012d}"
            self.qs.append({"id": nid, "n": n, "type": body["type"], "difficulty": body["difficulty"], "topic": body.get("topic") or "", "body": body["body"], "class_labels": body.get("class_labels", []), "has_audio": False, "has_image": False, "has_passage": bool(body.get("passage_id")), "used_in_exams": 0, "is_archived": False, "weight": body.get("weight", 1), "created": 100 + len(self.qs)})
            return ok({"id": nid})
        if a == "check_duplicates":
            self.dup_calls.append(body)
            text = body.get("body", "")
            if "EXACT" in text: return ok({"matches": [{"id": "00000000-0000-4000-8000-00000000000a", "body": "What did Dina do first?", "similarity": 1.0, "exact": True, "is_archived": False, "used_in_exams": 1}]})
            if "wallet" in text.lower(): return ok({"matches": [{"id": "00000000-0000-4000-8000-000000000009", "body": "What did Dina do first when she found the wallet?", "similarity": 0.91, "exact": False, "is_archived": False, "used_in_exams": 2}]})
            return ok({"matches": []})
        if a == "import_check":
            self.import_checks.append(body)
            results = []
            for item in body.get("items", []):
                text = item.get("body", "")
                matches = []
                if "EXACT" in text:
                    matches.append({"id": "00000000-0000-4000-8000-00000000000a", "body": "What did Dina do first?", "similarity": 1.0, "exact": True, "is_archived": False, "used_in_exams": 1})
                elif "similar" in text.lower():
                    matches.append({"id": "00000000-0000-4000-8000-000000000009", "body": "What did Dina do first when she found the wallet?", "similarity": 0.91, "exact": False, "is_archived": False, "used_in_exams": 2})
                if matches:
                    results.append({"i": item.get("i", 0), "matches": matches})
            return ok({"results": results})
        if a == "import":
            self.imports.append(body)
            items = body.get("items", [])
            for it in items:
                if "FORCE_SERVER_ERROR" in it.get("body", ""):
                    return route.fulfill(status=400, content_type="application/json", body=json.dumps({"error": f"Row {it.get('row', 1)}: Choose exactly one correct answer.", "code": "bad_request"}))
            n0 = len(self.qs)
            for k, it in enumerate(items):
                n = n0 + 100 + k + 1
                self.qs.append({"id": f"00000000-0000-4000-8000-{n:012d}", "n": n, "type": it["type"], "difficulty": it.get("difficulty", "medium"), "topic": it.get("topic") or "", "body": it["body"], "class_labels": it.get("class_labels", []), "has_audio": False, "has_image": False, "has_passage": bool(it.get("passage")), "used_in_exams": 0, "is_archived": False, "weight": it.get("weight", 1), "created": 200 + len(self.qs)})
            new_passages = {it["passage"]["title"] for it in items if isinstance(it.get("passage"), dict) and it["passage"].get("body")}
            return ok({"created": len(items), "passages_created": len(new_passages), "ids": [f"00000000-0000-4000-8000-{n0 + 100 + k + 1:012d}" for k in range(len(items))]})
        if a == "passages": return ok({"passages": self.passages_list()})
        if a == "passage_get":
            pa = next((x for x in self.passages if x["id"] == body["id"]), None)
            return ok({"passage": {**pa, "question_count": pa["question_count"], "media": []}}) if pa else route.fulfill(status=404, content_type="application/json", body=json.dumps({"error": "That reading text no longer exists.", "code": "not_found"}))
        if a == "passage_save":
            self.saved_passages = getattr(self, "saved_passages", []) + [body]
            if body.get("id"):
                pa = next(x for x in self.passages if x["id"] == body["id"]); pa.update(title=body["title"], body=body["body"]); return ok({"id": pa["id"]})
            pid = f"pa{len(self.passages) + 1}"
            self.passages.append({"id": pid, "title": body["title"], "body": body["body"], "question_count": 0})
            return ok({"id": pid})
        if a == "topics": return ok({"topics": [{"id": "t1", "name": "Narrative Text", "question_count": 15}, {"id": "t2", "name": "Simple Past", "question_count": 15}]})
        if a == "class_labels":
            labels = [{"label": "XII TKJ A", "question_count": 20}, {"label": "XII TKJ B", "question_count": 10}, {"label": "XI TKJ A", "question_count": 4}]
            pre = " ".join(str(body.get("prefix") or "").lower().split())
            return ok({"labels": [l for l in labels if l["label"].lower().startswith(pre)]})
        q = next((q for q in self.qs if q["id"] == body.get("id")), None)
        if a == "archive": q["is_archived"] = True; return ok({"ok": True})
        if a == "restore": q["is_archived"] = False; return ok({"ok": True})
        if a == "remove":
            if q["used_in_exams"] > 0: q["is_archived"] = True; return ok({"result": "archived"})
            self.qs.remove(q); return ok({"result": "deleted"})
        route.fulfill(status=400, content_type="application/json", body=json.dumps({"error": "Unknown action"}))

    # ---------- student side: the session function ----------
    def session_exam(self, code, **opts):
        """Registers an open exam students can join. The first four bank questions give one of each type."""
        questions = []
        for q in self.qs[:4]:
            full = self.full(q)
            questions.append({
                "question_id": q["id"], "type": q["type"], "body": q["body"], "weight": full["weight"],
                "options": [{"position": o["position"], "body": o["body"], "is_correct": o["is_correct"]} for o in full["options"]],
                "accepted": list(full["accepted_answers"]), "passage": full["passage"],
                "guide": full["essay_guidance"],
            })
        exam = {"id": f"eeeeeeee-0000-4000-8000-{len(self.session_exams) + 1:012d}",
                "code": code, "title": "Narrative Text, Daily Test 3", "duration_minutes": 45, "passing_grade": 70,
                "result_visibility": "score_and_review", "essay_pending_display": "show_partial",
                "tab_switch_warn_limit": 1, "tab_switch_flag_limit": 3, "tab_switch_autosubmit_limit": 5,
                "questions": questions}
        exam.update(opts)
        self.session_exams[code] = exam
        return exam

    def session_questions(self, sid):
        """The snapshot a student receives: no correct answers anywhere (BR-09)."""
        exam = self.session_exams[self.sessions[sid]["exam"]]
        return [{"position": i, "question_id": q["question_id"], "type": q["type"], "body": q["body"],
                 "weight": q["weight"], "passage": q["passage"], "media": [],
                 "options": [{"position": o["position"], "body": o["body"]} for o in q["options"]]}
                for i, q in enumerate(exam["questions"], start=1)]

    def session_payload(self, sid):
        s = self.sessions[sid]
        exam = self.session_exams[s["exam"]]
        now = time.time()
        return {
            "session": {"id": sid, "status": s["status"], "attempt_no": s["attempt_no"],
                        "student_name": s["name"], "student_class": s["class"],
                        "started_at": iso(s["started_at"]), "ends_at": iso(s["ends_at"]),
                        "submitted_at": iso(s["submitted_at"]) if s.get("submitted_at") else None,
                        "tab_switch_count": s["tab_switch_count"], "server_time": iso(now),
                        "remaining_seconds": max(0, int(s["ends_at"] - now)), "grace_seconds": 120,
                        "exam": {"id": "e-session", "title": exam["title"], "duration_minutes": exam["duration_minutes"],
                                 "passing_grade": exam["passing_grade"], "result_visibility": exam["result_visibility"],
                                 "essay_pending_display": exam["essay_pending_display"],
                                 "tab_switch_warn_limit": exam["tab_switch_warn_limit"],
                                 "tab_switch_flag_limit": exam["tab_switch_flag_limit"],
                                 "tab_switch_autosubmit_limit": exam["tab_switch_autosubmit_limit"]}},
            "questions": self.session_questions(sid),
            "answers": [{"question_id": qid, "answer": {"text": a["text"]}, "is_flagged": a["is_flagged"],
                         "client_saved_at": a.get("client_saved_at")} for qid, a in s["answers"].items()],
        }

    def session_grade(self, sid, status):
        """The same rules as public._session_grade: automatic questions are marked, essays wait.

        A grade the teacher saved by hand (self.manual_grades) wins over the automatic one (BR-18), so a
        correction survives a later re-grade after a reopen.
        """
        s = self.sessions[sid]; exam = self.session_exams[s["exam"]]
        total = maximum = correct = wrong = 0
        pending = False; review = []
        for i, q in enumerate(exam["questions"], start=1):
            qid = q["question_id"]
            manual = self.manual_grades.get((sid, qid))
            maximum += q["weight"]
            given = (s["answers"].get(qid) or {}).get("text", "")
            normalized = " ".join(str(given).split()).lower()
            if q["type"] == "essay":
                verdict = None; correct_text = ""
                if manual is None:
                    pending = True; points = 0
                else:
                    points = manual["points"]
            else:
                if q["type"] == "short_answer":
                    verdict = bool(normalized) and normalized in [" ".join(x.split()).lower() for x in q["accepted"]]
                    correct_text = (q["accepted"] or [""])[0]
                else:
                    right = next((o for o in q["options"] if o["is_correct"]), {"body": ""})
                    verdict = bool(normalized) and normalized == right["body"].strip().lower()
                    correct_text = right["body"]
                if manual is None:
                    points = q["weight"] if verdict else 0
                    if verdict: correct += 1
                    else: wrong += 1
                else:
                    points = manual["points"]
                    if points > 0: correct += 1
                    else: wrong += 1
            total += points
            review.append({"position": i, "question_id": qid, "type": q["type"], "weight": q["weight"],
                           "body": q["body"], "options": [{"position": o["position"], "body": o["body"]} for o in q["options"]],
                           "chosen": given, "correct_text": correct_text, "accepted_text": list(q["accepted"]),
                           "is_correct": verdict, "points": points, "max_points": q["weight"],
                           "graded": manual is not None or q["type"] != "essay", "manual": manual is not None,
                           "feedback": (manual or {}).get("feedback"), "guide": q.get("guide")})
        percentage = round(total / maximum * 100, 2) if maximum else 0
        s["status"] = status
        s["submitted_at"] = time.time()
        s["result"] = {"submitted": True, "status": status, "submitted_at": iso(s["submitted_at"]),
                       "visibility": exam["result_visibility"], "pending_review": pending,
                       "pending_essays": 1 if pending else 0,
                       "pass_status": "not_final" if pending else ("passed" if percentage >= exam["passing_grade"] else "failed"),
                       "passing_grade": exam["passing_grade"], "total_points": total, "max_points": maximum,
                       "percentage": percentage, "correct_count": correct, "wrong_count": wrong,
                       "review": review, "time_used_seconds": int(time.time() - s["started_at"])}
        return s["result"]

    def session_result(self, sid):
        s = self.sessions[sid]; exam = self.session_exams[s["exam"]]; r = s.get("result")
        if not r:
            return {"submitted": False, "status": s["status"], "server_time": iso(time.time()), "ends_at": iso(s["ends_at"]),
                    "remaining_seconds": max(0, int(s["ends_at"] - time.time()))}
        hide = r["pending_review"] and exam["essay_pending_display"] == "hide_score"
        out = {k: r[k] for k in ["submitted", "status", "submitted_at", "visibility", "pending_review",
                                 "pending_essays", "pass_status", "passing_grade"]}
        score_ok = exam["result_visibility"] != "none" and not hide
        out["score"] = {"percentage": r["percentage"], "total_points": r["total_points"], "max_points": r["max_points"],
                        "correct_count": r["correct_count"], "wrong_count": r["wrong_count"],
                        "pass_status": r["pass_status"], "time_used_seconds": r["time_used_seconds"]} if score_ok else None
        out["review"] = r["review"] if exam["result_visibility"] == "score_and_review" and not hide else None
        return out

    def handle_session(self, route, req):
        body = json.loads(req.post_data or "{}"); a = body.get("action")
        self.session_calls.append(body)
        def ok(data): route.fulfill(status=200, content_type="application/json", body=json.dumps(data))
        def err(status, msg): route.fulfill(status=status, content_type="application/json", body=json.dumps({"error": msg, "code": "bad_request"}))
        now = time.time()
        if a == "join":
            code = str(body.get("code", "")).strip().upper()
            exam = self.session_exams.get(code)
            if not exam: return err(400, "That test code was not found. Check the code on the board.")
            key = (code, " ".join(str(body.get("name", "")).lower().split()), " ".join(str(body.get("class", "")).lower().split()))
            if key in self.taken: return err(400, "You already took this test. Ask your teacher for another try.")
            sid = f"00000000-0000-4000-8000-{len(self.sessions) + 1:012d}"
            seconds = self.session_seconds if self.session_seconds is not None else exam["duration_minutes"] * 60
            self.sessions[sid] = {"id": sid, "exam": code, "name": str(body.get("name", "")).strip(),
                                  "class": str(body.get("class", "")).strip(), "status": "in_progress",
                                  "started_at": now, "ends_at": now + seconds, "answers": {},
                                  "tab_switch_count": 0, "attempt_no": 1, "key": key, "result": None}
            return ok({"token": sid, **self.session_payload(sid)})
        sid = body.get("token")
        s = self.sessions.get(sid)
        if not s: return route.fulfill(status=401, content_type="application/json", body=json.dumps({"error": "This test session is no longer valid. Please join again.", "code": "unauthorized"}))
        exam = self.session_exams[s["exam"]]
        if a == "get":
            return ok(self.session_payload(sid))
        if a == "save":
            if s["status"] != "in_progress":
                return ok({"accepted": False, "saved": 0, "reason": "already_submitted", "status": s["status"], "server_time": iso(now), "ends_at": iso(s["ends_at"])})
            if now > s["ends_at"] + 120:
                self.session_grade(sid, "auto_submitted")
                return ok({"accepted": False, "saved": 0, "reason": "time_up", "status": "auto_submitted", "server_time": iso(now), "ends_at": iso(s["ends_at"])})
            known = {q["question_id"] for q in exam["questions"]}
            for item in body.get("answers", []):
                qid = item.get("question_id")
                if qid not in known: return err(400, "That question is not part of this test.")
                s["answers"][qid] = {"text": (item.get("answer") or {}).get("text", ""),
                                     "is_flagged": bool(item.get("is_flagged")),
                                     "client_saved_at": item.get("client_saved_at")}
            return ok({"accepted": True, "saved": len(body.get("answers", [])), "status": s["status"],
                       "server_time": iso(now), "ends_at": iso(s["ends_at"]), "remaining_seconds": max(0, int(s["ends_at"] - now))})
        if a == "heartbeat":
            if s["status"] == "in_progress" and now > s["ends_at"] + 120: self.session_grade(sid, "auto_submitted")
            return ok({"status": s["status"], "server_time": iso(now), "ends_at": iso(s["ends_at"]),
                       "remaining_seconds": max(0, int(s["ends_at"] - now)), "tab_switch_count": s["tab_switch_count"]})
        if a == "event":
            kind = body.get("event_type")
            self.session_events.append({"session": sid, "type": kind, "meta": body.get("meta")})
            if kind in ("tab_hidden", "blur") and s["status"] == "in_progress":
                s["tab_switch_count"] += 1
            autosubmit = s["status"] == "in_progress" and s["tab_switch_count"] >= exam["tab_switch_autosubmit_limit"]
            if autosubmit: self.session_grade(sid, "auto_submitted")
            return ok({"status": s["status"], "tab_switch_count": s["tab_switch_count"], "autosubmit": autosubmit,
                       "warn_limit": exam["tab_switch_warn_limit"], "flag_limit": exam["tab_switch_flag_limit"],
                       "autosubmit_limit": exam["tab_switch_autosubmit_limit"]})
        if a == "submit":
            if s["status"] in ("submitted", "auto_submitted", "timed_out"):
                return ok(self.session_result(sid))
            reason = body.get("reason", "student")
            self.session_grade(sid, "submitted" if reason == "student" else "auto_submitted")
            self.taken.add(s["key"])
            return ok(self.session_result(sid))
        if a == "result":
            return ok(self.session_result(sid))
        if a == "media":
            return ok({"urls": dict(self.session_media_urls), "expires_in": 3600})
        return err(400, "Unknown action")

    # ---------- teacher side: the results function ----------
    def results_seed(self, code, name, klass, answers, status="submitted", seconds_used=600, tab_switch_count=1, attempt_no=1):
        """Creates an attempt without the browser. `answers` maps a question id to the text typed."""
        exam = self.session_exams[code]
        sid = f"00000000-0000-4000-8000-{len(self.sessions) + 1:012d}"
        now = time.time()
        typed = {q["question_id"]: {"text": answers[q["question_id"]], "is_flagged": False, "client_saved_at": None}
                 for q in exam["questions"] if answers.get(q["question_id"], "") != ""}
        self.sessions[sid] = {"id": sid, "exam": code, "name": name, "class": klass, "status": "in_progress",
                              "started_at": now - seconds_used, "ends_at": now + 600, "answers": typed,
                              "tab_switch_count": tab_switch_count, "attempt_no": attempt_no,
                              "last_heartbeat_at": now - (90 if tab_switch_count >= 3 else 5),
                              "key": (code, " ".join(name.lower().split()), " ".join(klass.lower().split())), "result": None}
        if status != "in_progress":
            self.session_grade(sid, status)
            self.taken.add(self.sessions[sid]["key"])
        return sid

    def results_exam(self, exam_id):
        return next((e for e in self.session_exams.values() if e["id"] == exam_id), None)

    def results_pending_essays(self, s):
        if not s.get("result"): return 0
        return sum(1 for x in s["result"]["review"]
                   if x["type"] == "essay" and (s["id"], x["question_id"]) not in self.manual_grades)

    def results_row(self, s):
        r = s.get("result")
        exam = self.session_exams[s["exam"]]
        key = (s["exam"], " ".join(s["name"].lower().split()), " ".join(s["class"].lower().split()))
        retake = self.retakes.get(key)
        answered = sum(1 for a in s.get("answers", {}).values() if (a.get("text") or "") != "")
        return {"session_id": s["id"], "student_name": s["name"], "student_class": s["class"],
                "class_display": self.class_aliases.get(" ".join(s["class"].lower().split()), s["class"]),
                "attempt_no": s["attempt_no"], "status": s["status"],
                "started_at": iso(s["started_at"]), "submitted_at": iso(s["submitted_at"]) if s.get("submitted_at") else None,
                "ends_at": iso(s["ends_at"]), "remaining_seconds": max(0, int(s["ends_at"] - time.time())),
                "tab_switch_count": s["tab_switch_count"], "has_result": bool(r),
                "percentage": r["percentage"] if r else None, "total_points": r["total_points"] if r else None,
                "max_points": r["max_points"] if r else None, "pass_status": r["pass_status"] if r else None,
                "result_status": "pending_review" if (r and r["pending_review"]) else ("graded" if r else None),
                "correct_count": r["correct_count"] if r else None, "wrong_count": r["wrong_count"] if r else None,
                "time_used_seconds": r["time_used_seconds"] if r else None,
                "pending_essays": self.results_pending_essays(s),
                "retake_granted": bool(retake), "retake_used": bool(retake and retake["used"]),
                "answered_count": answered if s["status"] in ("in_progress", "reopened") else len(exam["questions"]),
                "question_count": len(exam["questions"]),
                "last_heartbeat_at": iso(s.get("last_heartbeat_at") or time.time()),
                "tab_switch_warn_limit": exam.get("tab_switch_warn_limit", 1),
                "tab_switch_flag_limit": exam.get("tab_switch_flag_limit", 3)}

    def results_overview(self, exam):
        rows = [self.results_row(s) for s in self.sessions.values() if s["exam"] == exam["code"]]
        rows.sort(key=lambda x: (x["class_display"].lower(), x["student_name"].lower()))
        with_result = [x for x in rows if x["has_result"]]
        decided = [x for x in with_result if x["pass_status"] in ("passed", "failed")]
        pcts = [x["percentage"] for x in with_result]
        summary = {"with_result": len(with_result),
                   "in_progress": sum(1 for x in rows if x["status"] in ("in_progress", "reopened")),
                   "average": round(sum(pcts) / len(pcts), 1) if pcts else None,
                   "highest": max(pcts) if pcts else None, "lowest": min(pcts) if pcts else None,
                   "passed": len([x for x in decided if x["pass_status"] == "passed"]),
                   "failed": len([x for x in decided if x["pass_status"] == "failed"]),
                   "not_final": len([x for x in rows if x["pass_status"] == "not_final"]),
                   "pending_essays": sum(x["pending_essays"] for x in rows)}
        return {"exam": {"id": exam["id"], "title": exam["title"], "status": "open", "access_code": exam["code"],
                         "duration_minutes": exam["duration_minutes"], "passing_grade": exam["passing_grade"],
                         "result_visibility": exam["result_visibility"],
                         "essay_pending_display": exam["essay_pending_display"], "starts_at": None, "ends_at": None},
                "summary": summary, "rows": rows}

    def results_report(self, sid):
        s = self.sessions[sid]; exam = self.session_exams[s["exam"]]
        r = s.get("result")
        key = (s["exam"], " ".join(s["name"].lower().split()), " ".join(s["class"].lower().split()))
        retake = self.retakes.get(key)
        events = [{"event_type": "join", "severity": "info", "meta": {}, "occurred_at": iso(s["started_at"])}]
        for i in range(s.get("tab_switch_count") or 0):
            sev = "violation" if i + 1 >= exam.get("tab_switch_autosubmit_limit", 5) else (
                "suspicious" if i + 1 >= exam.get("tab_switch_flag_limit", 3) else "warning")
            events.append({"event_type": "tab_hidden", "severity": sev, "meta": {"n": i + 1},
                           "occurred_at": iso(s["started_at"] + 60 * (i + 1))})
        if r: events.append({"event_type": "submit", "severity": "info", "meta": {}, "occurred_at": iso(s["submitted_at"])})
        for g in self.result_calls:
            if g.get("action") == "grade" and g.get("session_id") == sid:
                events.append({"event_type": "graded", "severity": "info", "meta": {"points": g.get("points")}, "occurred_at": iso(time.time())})
        counts = {}
        for e in events: counts[e["event_type"]] = counts.get(e["event_type"], 0) + 1
        return {"server_time": iso(time.time()),
                "session": {"id": sid, "exam_id": exam["id"], "student_name": s["name"], "student_class": s["class"],
                            "class_display": self.class_aliases.get(" ".join(s["class"].lower().split()), s["class"]),
                            "attempt_no": s["attempt_no"], "status": s["status"], "started_at": iso(s["started_at"]),
                            "submitted_at": iso(s["submitted_at"]) if s.get("submitted_at") else None,
                            "ends_at": iso(s["ends_at"]), "extra_seconds": s.get("extra_seconds", 0),
                            "tab_switch_count": s["tab_switch_count"], "last_heartbeat_at": iso(time.time()),
                            "remaining_seconds": max(0, int(s["ends_at"] - time.time()))},
                "exam": {"id": exam["id"], "title": exam["title"], "passing_grade": exam["passing_grade"],
                         "result_visibility": exam["result_visibility"],
                         "essay_pending_display": exam["essay_pending_display"]},
                "result": ({"percentage": r["percentage"], "total_points": r["total_points"], "max_points": r["max_points"],
                            "status": "pending_review" if r["pending_review"] else "graded", "pass_status": r["pass_status"],
                            "correct_count": r["correct_count"], "wrong_count": r["wrong_count"],
                            "time_used_seconds": r["time_used_seconds"], "updated_at": iso(time.time())} if r else None),
                "review": r["review"] if r else [], "grades": [], "events": events, "event_counts": counts,
                "retake": ({"granted": True, "used": retake["used"], "granted_at": iso(time.time())} if retake else None),
                "actions": {"can_add_time": s["status"] in ("in_progress", "reopened"),
                            "can_reopen": s["status"] in ("submitted", "auto_submitted", "timed_out"),
                            "can_grade": s["status"] not in ("in_progress", "reopened"),
                            "can_grant_retake": s["status"] not in ("in_progress", "reopened") and not (retake and not retake["used"]),
                            "can_revoke_retake": bool(retake and not retake["used"])}}

    def handle_results(self, route, req):
        body = json.loads(req.post_data or "{}"); a = body.get("action")
        self.result_calls.append(body)
        def ok(data): route.fulfill(status=200, content_type="application/json", body=json.dumps(data))
        def err(status, msg): route.fulfill(status=status, content_type="application/json", body=json.dumps({"error": msg, "code": "bad_request"}))

        def exam_or_err():
            exam = self.results_exam(body.get("exam_id"))
            if not exam: err(400, "That exam was not found.")
            return exam

        if a == "activity":
            exams = []
            for exam in self.session_exams.values():
                rows = [self.results_row(s) for s in self.sessions.values() if s["exam"] == exam["code"]]
                finished = [x for x in rows if x["has_result"]]
                pcts = [x["percentage"] for x in finished]
                exams.append({"exam_id": exam["id"], "title": exam["title"], "access_code": exam["code"],
                              "status": "open", "is_template": False, "passing_grade": exam["passing_grade"],
                              "essay_questions": sum(1 for q in exam["questions"] if q["type"] == "essay"),
                              "sessions": len(rows), "finished": len(finished),
                              "in_progress": sum(1 for x in rows if x["status"] in ("in_progress", "reopened")),
                              "pending_essays": sum(x["pending_essays"] for x in rows),
                              "average": round(sum(pcts) / len(pcts), 1) if pcts else None,
                              "last_submitted_at": max([x["submitted_at"] for x in finished], default=None)})
            exams.sort(key=lambda e: (-e["pending_essays"], e["title"]))
            return ok({"exams": exams})
        if a == "pending":
            return ok({"pending": sum(self.results_pending_essays(s) for s in self.sessions.values())})
        if a == "overview":
            exam = exam_or_err()
            return ok({"overview": self.results_overview(exam)}) if exam else None
        if a == "report":
            s = self.sessions.get(body.get("session_id"))
            return ok({"report": self.results_report(body["session_id"])}) if s else err(400, "That test session was not found.")
        if a == "grading_questions":
            exam = exam_or_err()
            if not exam: return
            out = []
            for i, q in enumerate(exam["questions"], start=1):
                if q["type"] != "essay": continue
                taken = [s for s in self.sessions.values() if s["exam"] == exam["code"]
                         and s["status"] in ("submitted", "auto_submitted", "timed_out")
                         and q["question_id"] in [x["question_id"] for x in (s.get("result") or {"review": []})["review"]]]
                graded = [s for s in taken if (s["id"], q["question_id"]) in self.manual_grades]
                out.append({"question_id": q["question_id"], "position": i, "body": q["body"], "weight": q["weight"],
                            "guide": q.get("guide"), "taken": len(taken), "graded": len(graded),
                            "waiting": len(taken) - len(graded)})
            return ok({"questions": out})
        if a == "queue":
            exam = exam_or_err()
            if not exam: return
            qid = body.get("question_id")
            question = next((q for q in exam["questions"] if q["question_id"] == qid), None)
            if not question: return err(400, "That question is not part of this test.")
            students = []
            for s in self.sessions.values():
                if s["exam"] != exam["code"] or s["status"] not in ("submitted", "auto_submitted", "timed_out"): continue
                if qid not in [x["question_id"] for x in (s.get("result") or {"review": []})["review"]]: continue
                manual = self.manual_grades.get((s["id"], qid))
                students.append({"session_id": s["id"], "student_name": s["name"], "student_class": s["class"],
                                 "attempt_no": s["attempt_no"], "status": s["status"],
                                 "submitted_at": iso(s["submitted_at"]) if s.get("submitted_at") else None,
                                 "answer": (s["answers"].get(qid) or {}).get("text", ""),
                                 "is_blank": (s["answers"].get(qid) or {}).get("text", "") == "",
                                 "graded": manual is not None, "points": manual["points"] if manual else None,
                                 "feedback": manual["feedback"] if manual else None, "graded_at": None,
                                 "max_points": question["weight"], "manual": manual is not None})
            students.sort(key=lambda x: (x["student_class"].lower(), x["student_name"].lower(), x["attempt_no"]))
            graded = len([x for x in students if x["graded"]])
            return ok({"queue": {"question": {"question_id": qid, "max_points": question["weight"],
                                                "body": question["body"], "guide": question.get("guide"),
                                                "taken": len(students), "graded": graded,
                                                "waiting": len(students) - graded},
                                 "students": students}})
        if a == "grade":
            s = self.sessions.get(body.get("session_id"))
            if not s: return err(400, "That test session was not found.")
            if s["status"] in ("in_progress", "reopened"):
                return err(400, "That test is still being taken, so it cannot be graded yet.")
            exam = self.session_exams[s["exam"]]
            qid = body.get("question_id")
            question = next((q for q in exam["questions"] if q["question_id"] == qid), None)
            if not question: return err(400, "That question is not part of this test.")
            points = body.get("points")
            if points is None or points < 0 or points > question["weight"]:
                return err(400, f"The most points this question can give is {question['weight']}.")
            self.manual_grades[(body["session_id"], qid)] = {"points": points, "feedback": body.get("feedback")}
            self.session_grade(body["session_id"], s["status"])  # recalculated in the same "transaction"
            r = s["result"]
            waiting = self.results_pending_essays(s)
            return ok({"grade": {"saved": True, "question_id": qid, "points": points,
                                 "max_points": question["weight"], "feedback": body.get("feedback"),
                                 "final": not r["pending_review"], "waiting_essays": waiting,
                                 "percentage": r["percentage"], "total_points": r["total_points"],
                                 "result_max_points": r["max_points"], "pass_status": r["pass_status"]}})
        if a in ("add_time", "reopen"):
            s = self.sessions.get(body.get("session_id"))
            if not s: return err(400, "That test session was not found.")
            seconds = int(body.get("minutes", 0)) * 60
            if seconds < 60 or seconds > 7200: return err(400, "Time must be between 1 minute and 2 hours.")
            if a == "add_time":
                if s["status"] not in ("in_progress", "reopened"):
                    return err(400, "This test is already collected. Reopen it instead of adding time.")
                s["ends_at"] += seconds; s["extra_seconds"] = s.get("extra_seconds", 0) + seconds
            else:
                if s["status"] in ("in_progress", "reopened"):
                    return err(400, "This test is still open, so only its time can be added.")
                s["status"] = "reopened"; s["ends_at"] = time.time() + seconds
                s["extra_seconds"] = s.get("extra_seconds", 0) + seconds
            return ok({"session": {"status": s["status"], "extra_seconds": s["extra_seconds"],
                                   "ends_at": iso(s["ends_at"]),
                                   "remaining_seconds": max(0, int(s["ends_at"] - time.time()))}})
        if a == "add_exam_time":
            # Mirrors public.add_exam_time: every attempt still running gets the seconds, the finished
            # ones are untouched, and it refuses a step outside 1 minute .. 2 hours or nobody working.
            exam = exam_or_err()
            if not exam: return
            seconds = int(body.get("minutes", 0)) * 60
            if seconds < 60 or seconds > 7200:
                return err(400, "Time can be added in steps between 1 minute and 2 hours.")
            working = [x for x in self.sessions.values()
                       if x["exam"] == exam["code"] and x["status"] in ("in_progress", "reopened")]
            if not working:
                return err(400, "Nobody is taking this test right now, so there is no one to give time to.")
            for x in working:
                x["ends_at"] += seconds
                x["extra_seconds"] = x.get("extra_seconds", 0) + seconds
                x["last_heartbeat_at"] = time.time()
            return ok({"added": {"updated": len(working), "added_seconds": seconds,
                                 "remaining_seconds": max(0, int(max(x["ends_at"] for x in working) - time.time()))}})
        if a in ("grant_retake", "revoke_retake"):
            s = self.sessions.get(body.get("session_id"))
            if not s: return err(400, "That test session was not found.")
            key = (s["exam"], " ".join(s["name"].lower().split()), " ".join(s["class"].lower().split()))
            if a == "grant_retake":
                if s["status"] in ("in_progress", "reopened"):
                    return err(400, "Finish this attempt before granting another one.")
                existing = self.retakes.get(key)
                if existing and not existing["used"]:
                    return ok({"retake": {"granted": True, "already": True}})
                self.retakes[key] = {"used": False}
                return ok({"retake": {"granted": True, "already": False}})
            existing = self.retakes.get(key)
            if not existing: return ok({"retake": {"revoked": False, "reason": "no_permission"}})
            if existing["used"]: return err(400, "That retake was already used, so it cannot be taken back.")
            del self.retakes[key]
            return ok({"retake": {"revoked": True}})
        return err(400, "Unknown action")

    def exam_row(self, e):
        qs = e["questions"]
        return {"id": e["id"], "title": e["title"], "description": e.get("description"), "status": e["status"],
                "duration_minutes": e["duration_minutes"], "passing_grade": e["passing_grade"],
                "availability_mode": e["availability_mode"], "starts_at": e.get("starts_at"), "ends_at": e.get("ends_at"),
                "late_start_policy": e["late_start_policy"], "access_code": e["access_code"],
                "selection_mode": e["selection_mode"], "is_template": e["is_template"],
                "question_count": len(qs), "total_points": sum(q.get("weight", 1) for q in qs),
                "created_at": e.get("created_at", "2026-09-21T00:00:00Z")}

    def handle_exams(self, route, req):
        body = json.loads(req.post_data or "{}"); a = body.get("action"); self.exam_calls.append(body)
        def ok(data): route.fulfill(status=200, content_type="application/json", body=json.dumps(data))
        def err(status, msg): route.fulfill(status=status, content_type="application/json", body=json.dumps({"error": msg, "code": "bad_request"}))
        if a == "list":
            rows = list(self.exams.values())
            if body.get("q"): rows = [e for e in rows if body["q"].lower() in e["title"].lower()]
            if body.get("status"): rows = [e for e in rows if e["status"] == body["status"]]
            if body.get("template_only"): rows = [e for e in rows if e["is_template"]]
            sort = body.get("sort", "newest")
            if sort == "newest": rows.sort(key=lambda e: e.get("created_at", ""), reverse=True)
            if sort == "oldest": rows.sort(key=lambda e: e.get("created_at", ""))
            if sort == "title": rows.sort(key=lambda e: e["title"])
            return ok({"exams": [self.exam_row(e) for e in rows]})
        if a == "get":
            e = self.exams.get(body.get("id"))
            if not e: return route.fulfill(status=404, content_type="application/json", body=json.dumps({"error": "That exam no longer exists.", "code": "not_found"}))
            return ok({"exam": {**self.exam_row(e), "questions": e["questions"], "auto_filter": e.get("auto_filter"),
                                "pool_size": e.get("pool_size"), "draw_per_student": e.get("draw_per_student", False),
                                "randomize_questions": e.get("randomize_questions", False), "randomize_options": e.get("randomize_options", False),
                                "result_visibility": e.get("result_visibility", "none"), "essay_pending_display": e.get("essay_pending_display", "hide_score"),
                                "tab_switch_warn_limit": e.get("tab_switch_warn_limit", 1), "tab_switch_flag_limit": e.get("tab_switch_flag_limit", 3),
                                "tab_switch_autosubmit_limit": e.get("tab_switch_autosubmit_limit", 5)}})
        if a == "save":
            code = str(body.get("access_code", "")).strip().upper()
            if not str(body.get("title", "")).strip(): return err(400, "Title is required.")
            if not code: return err(400, "Test code is required.")
            if code == "TAKEN1": return err(400, f"The test code {code} is already used by an open exam.")
            eid = body.get("id") or f"00000000-0000-4000-8000-{len(self.exams) + 1:012d}"
            prev = self.exams.get(eid)
            self.exams[eid] = {"id": eid, "title": body["title"], "description": body.get("description"), "status": body.get("status", "draft"),
                               "duration_minutes": body.get("duration_minutes", 45), "passing_grade": body.get("passing_grade", 0),
                               "availability_mode": body.get("availability_mode", "manual"), "starts_at": body.get("starts_at"), "ends_at": body.get("ends_at"),
                               "late_start_policy": body.get("late_start_policy", "full_duration"), "access_code": code,
                               "selection_mode": body.get("selection_mode", "manual"), "auto_filter": body.get("auto_filter"),
                               "pool_size": body.get("pool_size"), "draw_per_student": bool(body.get("draw_per_student")),
                               "randomize_questions": bool(body.get("randomize_questions")), "randomize_options": bool(body.get("randomize_options")),
                               "result_visibility": body.get("result_visibility", "none"), "essay_pending_display": body.get("essay_pending_display", "hide_score"),
                               "tab_switch_warn_limit": body.get("tab_switch_warn_limit", 1), "tab_switch_flag_limit": body.get("tab_switch_flag_limit", 3),
                               "tab_switch_autosubmit_limit": body.get("tab_switch_autosubmit_limit", 5), "is_template": bool(body.get("is_template")),
                               "questions": [{"question_id": q["question_id"], "position": i, "weight": q.get("weight", 1), "body": next((qq["body"] for qq in self.qs if qq["id"] == q["question_id"]), f"Question {i + 1}"), "type": "multiple_choice"} for i, q in enumerate(body.get("questions", []))],
                               "created_at": (prev or {}).get("created_at", "2026-09-21T00:00:00Z")}
            return ok({"id": eid})
        if a == "remove":
            e = self.exams.pop(body.get("id"), None)
            return ok({"result": "deleted"}) if e else err(400, "That exam no longer exists.")
        if a == "set_status":
            e = self.exams.get(body.get("id"))
            if not e: return err(400, "That exam no longer exists.")
            if body.get("status") == "open" and len(e["questions"]) == 0 and e["selection_mode"] == "manual":
                return err(400, "Add questions before opening the exam.")
            e["status"] = body.get("status"); return ok({"ok": True})
        if a == "regenerate_code":
            e = self.exams.get(body.get("id"))
            if not e: return err(400, "That exam no longer exists.")
            e["access_code"] = f"NEW{len(self.exam_calls) % 100:02d}"; return ok({"code": e["access_code"]})
        if a == "check_code":
            code = str(body.get("code", "")).strip().upper()
            used = self.exam_codes_used | {e["access_code"] for e in self.exams.values() if e["status"] == "open"}
            mine = {e["access_code"] for e in self.exams.values() if e["id"] == body.get("exclude_id")}
            return ok({"available": code not in (used - mine)})
        if a == "duplicate":
            src = self.exams.get(body.get("id"))
            if not src: return err(400, "That exam no longer exists.")
            nid = f"00000000-0000-4000-8000-{len(self.exams) + 1:012d}"
            import copy
            dup = copy.deepcopy(src); dup.update(id=nid, status="draft", title=src["title"] + " (copy)", access_code=f"DUP{len(self.exams) % 100:02d}", created_at="2026-09-22T00:00:00Z")
            self.exams[nid] = dup; return ok({"id": nid})
        return err(400, "Unknown action")
