"""A pretend server for the browser tests: answers the question-bank and auth-me endpoints from memory."""
import json

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
