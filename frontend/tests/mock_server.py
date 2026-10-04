"""A pretend server for the browser tests: answers the question-bank, exams, session and auth-me endpoints from memory.

The student session endpoints mirror the rules that decide what a student's browser sees. The authority is
`supabase/migrations/` (`save_session_answers` and `exam_join` in `20260923000000_session_functions.sql`;
`log_session_event` as last replaced by `20261002000001_leave_count_only_tab_hidden.sql`, DEC-039) with
`backend/functions/session/parse.ts` in front of it; when those change, change this too.
Deliberate simplifications, so that no test passes for the wrong reason:

  * no rate limits, no trigram similarity, no clock skew, no storage signing;
  * one attempt per code+name+class, like `exam_join`, but retakes and manual grades live in memory;
  * `save` refuses the whole batch on one bad answer, exactly as the real edge parser and
    `save_session_answers` do (a `reopened` session still accepts answers, like the live function);
  * an answer is checked here only for the 1,000/20,000 character caps and the 200-answers-per-call
    limit; the essay/non-essay rules the question bank owns are not re-derived;
  * only a hidden page counts as a page leave (`tab_hidden`) — a `blur` is recorded but never counts
    (DEC-039) — and leaves count only while the session is `in_progress` here, where the live function
    also counts a `reopened` session;
  * exam codes: `check_code` answers who holds a code (`open` / `draft` / null) like
    `public.exam_code_used_by`, and `set_status` refuses opening a code an open exam holds in words
    (TASK-031), like the current `public.set_exam_status`;
  * templates: `save` refuses `is_template` unless the exam is a draft nobody has joined and
    `set_status` refuses to open a template (TASK-032), like `public.save_exam` and
    `public.set_exam_status` after `20261002000003_template_only_when_safe.sql`.
"""
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
            "class_labels": ["XII TKJ B", "XII TKJ A"] if i % 3 == 0 else (["XI TKJ A"] if i == 2 else (["XII TKJ A"] if i % 2 else [])),
            "has_audio": i % 5 == 0, "has_image": i % 7 == 0, "has_passage": i % 2 == 0, "used_in_exams": i % 4,
            "is_archived": False, "weight": 2 if i % 4 == 0 else 1, "created": 31 - i,
            # teacher data isolation (TASK-048, DEC-041): the admin (u1) owns every third question,
            # the teacher (u2) the rest — the isolation section of question_bank_e2e depends on it
            "created_by": "u1" if i % 3 == 0 else "u2",
        })
    return out

class Server:
    def __init__(self):
        self.qs = make_questions(); self.calls = []; self.fail_list = 0; self.status_all = None
        self.saved = []; self.dup_calls = []; self.media = {}; self.media_calls = []; self.register_error = None; self.last_upload_size = None
        # the whole-bank duplicate scan behind the list banner (TASK-020): one exact group and one pair that reads alike
        self.dup_scans = []; self.fail_duplicates = False
        # bulk changes (F-05): what was asked for, whether the server refuses, ids that are "gone", and a
        # pretend total so the "more than one change may touch" guard can be reached with a small bank
        self.bulk_calls = []; self.fail_bulk = False; self.bulk_forget = set(); self.fake_total = None
        qid = lambda n: f"00000000-0000-4000-8000-{n:012d}"
        qbody = lambda n: f"Question number {n} about {'Narrative Text' if n <= 15 else 'Simple Past'}"
        self.dup_groups = {
            "question_count": 4,
            "exact_groups": [{"kind": "exact", "questions": [
                {"id": qid(7), "body": qbody(7), "used_in_exams": 3},
                {"id": qid(11), "body": qbody(11), "used_in_exams": 3}]}],
            "similar_pairs": [{"kind": "similar", "similarity": 0.87, "questions": [
                {"id": qid(2), "body": qbody(2), "used_in_exams": 2},
                {"id": qid(22), "body": qbody(22), "used_in_exams": 0}]}],
        }
        self.import_checks = []; self.imports = []
        self.exam_calls = []; self.exams = {}; self.exam_codes_used = {"TAKEN1"}
        # F-18: putting questions on an exam from the bank, and a way to make the server refuse.
        self.exam_bulk_calls = []; self.fail_bulk_questions = None
        self.role = "admin"   # suites switch this to "teacher" to check the role-dependent screens
        # student side (session function)
        self.session_exams = {}; self.sessions = {}; self.taken = set(); self.session_calls = []
        self.session_events = []; self.session_seconds = None; self.session_media_urls = {}
        # teacher side (results function)
        self.manual_grades = {}; self.retakes = {}; self.result_calls = []; self.class_aliases = {}
        # admin side (audit function)
        self.audit_rows = []; self.audit_calls = []
        # the notification bell (every staff role; TASK-015, DEC-017): unread until the bell is opened
        self.notif_calls = []; self.notif_read = False
        # admin side (backups function): one nightly copy with bytes in it and one made by hand, so the list has both kinds
        self.backup_calls = []
        self.backups = [
            {"id": "bk-1", "kind": "automatic", "storage_path": "20260926T024100Z_automatic_1111aaaa.zip",
             "size_bytes": 3412000, "created_by": None, "created_by_name": None, "created_at": "2026-09-26T02:41:00Z"},
            {"id": "bk-2", "kind": "manual", "storage_path": "20260925T091500Z_manual_2222bbbb.zip",
             "size_bytes": 43920, "created_by": "u1", "created_by_name": "Admin", "created_at": "2026-09-25T09:15:00Z"},
        ]
        self.fail_backup = False; self.backup_note = None; self.backup_pruned = 0
        # admin side (accounts function): the signed-in admin, one teacher, and one account that was deactivated
        self.account_calls = []
        self.accounts = [
            {"id": "u1", "email": "admin@example.com", "full_name": "Admin", "role": "admin", "is_active": True,
             "created_at": "2026-09-20T10:11:54Z", "last_sign_in_at": "2026-09-26T01:39:56Z"},
            {"id": "u2", "email": "rina@example.com", "full_name": "Ms. Rina", "role": "teacher", "is_active": True,
             "created_at": "2026-09-24T12:00:40Z", "last_sign_in_at": "2026-09-25T07:02:00Z"},
            {"id": "u3", "email": "old.teacher@example.com", "full_name": "Mr. Budi", "role": "teacher", "is_active": False,
             "created_at": "2026-09-21T08:00:00Z", "last_sign_in_at": None},
        ]
        self.fail_account = False; self.account_passwords = []
        self.passages = [{"id": "pa1", "title": "The Lost Wallet", "body": "Dina found a <u>brown</u> wallet.", "question_count": 3, "created_by": "u1"}, {"id": "pa2", "title": "The Smart Monkey", "body": "A clever monkey sat on a branch.", "question_count": 1, "created_by": "u2"}]
    # ---------- teacher data isolation (TASK-048, DEC-041) ----------
    # The signed-in person (self.role) sees only their own questions and reading texts; the admin
    # (u1) sees the whole school. A foreign id behaves exactly like a missing one.
    def actor_id(self):
        return "u1" if self.role == "admin" else "u2"

    def own_visible(self, mid):
        """Whether the question with this id exists for the signed-in person."""
        if self.role == "admin":
            return True
        q = next((q for q in self.qs if q["id"] == mid), None)
        return q is not None and q.get("created_by") == "u2"

    def own_qs(self, rows):
        return rows if self.role == "admin" else [q for q in rows if q.get("created_by") == "u2"]

    def not_found(self, route, text):
        return route.fulfill(status=404, content_type="application/json", body=json.dumps({"error": text, "code": "not_found"}))

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
        rows = self.passages if self.role == "admin" else [x for x in self.passages if x.get("created_by") == "u2"]
        return [{"id": x["id"], "title": x["title"], "excerpt": x["body"][:60], "question_count": x["question_count"]} for x in rows]

    def own_passages(self):
        return self.passages if self.role == "admin" else [x for x in self.passages if x.get("created_by") == "u2"]
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
        if "/functions/v1/audit" in url:
            return self.handle_audit(route, req)
        if "/functions/v1/notifications" in url:
            return self.handle_notifications(route, req)
        if "/functions/v1/backups" in url:
            return self.handle_backups(route, req)
        if "/functions/v1/accounts" in url:
            return self.handle_accounts(route, req)
        if "/auth-me" in url:
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"user": {"id": "u1", "fullName": "Admin" if self.role == "admin" else "Ms. Rina", "role": self.role}}))
        body = json.loads(req.post_data or "{}"); a = body.get("action"); self.calls.append(body)
        if self.status_all:
            return route.fulfill(status=self.status_all, content_type="application/json", body=json.dumps({"error": "Your session has expired. Please sign in again.", "code": "unauthorized"}))
        def ok(data): route.fulfill(status=200, content_type="application/json", body=json.dumps(data))
        if a == "list":
            if self.fail_list > 0:
                self.fail_list -= 1
                return route.fulfill(status=500, content_type="application/json", body=json.dumps({"error": "Something went wrong. Please try again.", "code": "internal_error"}))
            rows = self.own_qs([q for q in self.qs if q["is_archived"] == bool(body.get("archived"))])
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
            return ok({"items": [self.item(q) for q in rows[(page - 1) * size: page * size]], "total": self.fake_total if self.fake_total is not None else len(rows), "page": page, "page_size": size})
        if a == "get":
            q = next((q for q in self.own_qs(self.qs) if q["id"] == body["id"]), None)
            return ok({"question": self.full(q)}) if q else route.fulfill(status=404, content_type="application/json", body=json.dumps({"error": "That question no longer exists.", "code": "not_found"}))
        if a == "save":
            self.saved.append(body)
            if not str(body.get("body", "")).strip(): return route.fulfill(status=400, content_type="application/json", body=json.dumps({"error": "The question text is required.", "code": "bad_request"}))
            if "FORCE_SERVER_ERROR" in body.get("body", ""): return route.fulfill(status=400, content_type="application/json", body=json.dumps({"error": "Choose exactly one correct answer.", "code": "bad_request"}))
            if body.get("id"):
                q = next((q for q in self.own_qs(self.qs) if q["id"] == body["id"]), None)
                if q is None: return self.not_found(route, "That question no longer exists.")
                q.update(type=body["type"], difficulty=body["difficulty"], topic=body.get("topic") or "", body=body["body"], class_labels=body.get("class_labels", []))
                return ok({"id": q["id"]})
            n = len(self.qs) + 100
            nid = f"00000000-0000-4000-8000-{n:012d}"
            self.qs.append({"id": nid, "n": n, "type": body["type"], "difficulty": body["difficulty"], "topic": body.get("topic") or "", "body": body["body"], "class_labels": body.get("class_labels", []), "has_audio": False, "has_image": False, "has_passage": bool(body.get("passage_id")), "used_in_exams": 0, "is_archived": False, "weight": body.get("weight", 1), "created": 100 + len(self.qs), "created_by": self.actor_id()})
            return ok({"id": nid})
        if a == "check_duplicates":
            self.dup_calls.append(body)
            text = body.get("body", "")
            matches = []
            if "EXACT" in text:
                matches.append({"id": "00000000-0000-4000-8000-00000000000a", "body": "What did Dina do first?", "similarity": 1.0, "exact": True, "is_archived": False, "used_in_exams": 1})
            elif "wallet" in text.lower():
                matches.append({"id": "00000000-0000-4000-8000-000000000009", "body": "What did Dina do first when she found the wallet?", "similarity": 0.91, "exact": False, "is_archived": False, "used_in_exams": 2})
            return ok({"matches": [m for m in matches if self.own_visible(m["id"])]})
        if a == "duplicate_groups":
            self.dup_scans.append(body)
            if self.fail_duplicates:
                return route.fulfill(status=500, content_type="application/json", body=json.dumps({"error": "Something went wrong. Please try again.", "code": "internal_error"}))
            if self.role == "admin": return ok(self.dup_groups)
            out = {"question_count": 0, "exact_groups": [], "similar_pairs": []}
            for key in ("exact_groups", "similar_pairs"):
                for g in self.dup_groups.get(key, []):
                    qs = [x for x in g.get("questions", []) if self.own_visible(x["id"])]
                    if len(qs) >= 2:
                        kept = dict(g); kept["questions"] = qs
                        out[key].append(kept); out["question_count"] += len(qs)
            return ok(out)
        if a == "bulk_update":
            self.bulk_calls.append(body)
            def bad(msg): return route.fulfill(status=400, content_type="application/json", body=json.dumps({"error": msg, "code": "bad_request"}))
            if self.fail_bulk:
                return route.fulfill(status=500, content_type="application/json", body=json.dumps({"error": "Something went wrong. Please try again.", "code": "internal_error"}))
            selected = list(dict.fromkeys(body.get("ids") or []))
            ids = [i for i in selected if i not in self.bulk_forget]
            ch = body.get("changes") or {}
            if not selected: return bad("Select at least one question.")
            if len(selected) > 500: return bad("Change at most 500 questions at once.")
            if not ch: return bad("Choose at least one thing to change.")
            if "difficulty" in ch and ch["difficulty"] not in DIFFS: return bad("Choose Easy, Medium, or HOTS.")
            weight = None
            if "weight" in ch:
                try: weight = float(ch["weight"])
                except (TypeError, ValueError): return bad("Points must be a number.")
                if not 0 < weight <= 100: return bad("Points must be more than 0 and at most 100.")
            if "class_labels" in ch:
                mode = (ch["class_labels"] or {}).get("mode")
                if mode not in ("add", "remove", "replace"): return bad("Choose what to do with the class labels.")
                if not [x for x in (ch["class_labels"].get("labels") or []) if str(x).strip()] and mode != "remove":
                    return bad("Add at least one class label.")
            rows = [q for q in self.own_qs(self.qs) if q["id"] in ids]
            if not rows: return bad("Those questions no longer exist. Refresh the list and try again.")
            norm = lambda t: " ".join(str(t).split()).lower()
            changed = set()
            for q in rows:
                if "topic" in ch and q["topic"] != (ch["topic"] or ""):
                    q["topic"] = ch["topic"] or ""; changed.add(q["id"])
                if "difficulty" in ch and q["difficulty"] != ch["difficulty"]:
                    q["difficulty"] = ch["difficulty"]; changed.add(q["id"])
                if weight is not None and float(q["weight"]) != weight:
                    q["weight"] = weight; changed.add(q["id"])
                if "class_labels" in ch:
                    want = []
                    for l in ch["class_labels"].get("labels") or []:
                        if str(l).strip() and norm(l) not in [norm(x) for x in want]: want.append(str(l).strip())
                    have = list(q["class_labels"])
                    if mode == "add": after = have + [l for l in want if norm(l) not in [norm(x) for x in have]]
                    elif mode == "remove": after = [l for l in have if norm(l) not in [norm(x) for x in want]]
                    else: after = want
                    if len(after) > 10: return bad("A question can have at most 10 class labels.")
                    if [norm(x) for x in after] != [norm(x) for x in have]:
                        q["class_labels"] = after; changed.add(q["id"])
            if "archived" in ch:
                want = bool(ch["archived"])
                for q in rows:
                    if q["is_archived"] != want:
                        q["is_archived"] = want; changed.add(q["id"])
            return ok({"matched": len(rows), "updated": len(changed), "unchanged": len(rows) - len(changed), "missing": len(selected) - len(rows)})
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
                matches = [m for m in matches if self.own_visible(m["id"])]
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
                self.qs.append({"id": f"00000000-0000-4000-8000-{n:012d}", "n": n, "type": it["type"], "difficulty": it.get("difficulty", "medium"), "topic": it.get("topic") or "", "body": it["body"], "class_labels": it.get("class_labels", []), "has_audio": False, "has_image": False, "has_passage": bool(it.get("passage")), "used_in_exams": 0, "is_archived": False, "weight": it.get("weight", 1), "created": 200 + len(self.qs), "created_by": self.actor_id()})
            new_passages = {it["passage"]["title"] for it in items if isinstance(it.get("passage"), dict) and it["passage"].get("body")}
            return ok({"created": len(items), "passages_created": len(new_passages), "ids": [f"00000000-0000-4000-8000-{n0 + 100 + k + 1:012d}" for k in range(len(items))]})
        if a == "passages": return ok({"passages": self.passages_list()})
        if a == "passage_get":
            pa = next((x for x in self.own_passages() if x["id"] == body["id"]), None)
            return ok({"passage": {**pa, "question_count": pa["question_count"], "media": []}}) if pa else route.fulfill(status=404, content_type="application/json", body=json.dumps({"error": "That reading text no longer exists.", "code": "not_found"}))
        if a == "passage_save":
            self.saved_passages = getattr(self, "saved_passages", []) + [body]
            if body.get("id"):
                pa = next((x for x in self.own_passages() if x["id"] == body["id"]), None)
                if pa is None: return self.not_found(route, "That reading text no longer exists.")
                pa.update(title=body["title"], body=body["body"]); return ok({"id": pa["id"]})
            pid = f"pa{len(self.passages) + 1}"
            self.passages.append({"id": pid, "title": body["title"], "body": body["body"], "question_count": 0, "created_by": self.actor_id()})
            return ok({"id": pid})
        if a == "topics":
            own = [q for q in self.own_qs(self.qs) if not q["is_archived"]]
            names = sorted({q["topic"] for q in own if q["topic"]})
            return ok({"topics": [{"id": f"t{i + 1}", "name": n, "question_count": sum(1 for q in own if q["topic"] == n)} for i, n in enumerate(names)]})
        if a == "class_labels":
            own = [q for q in self.own_qs(self.qs) if not q["is_archived"]]
            counts = {}
            for q in own:
                for l in q["class_labels"]:
                    counts[l] = counts.get(l, 0) + 1
            labels = sorted(({"label": l, "question_count": c} for l, c in counts.items()), key=lambda x: (-x["question_count"], x["label"]))
            pre = " ".join(str(body.get("prefix") or "").lower().split())
            return ok({"labels": [l for l in labels if l["label"].lower().startswith(pre)]})
        q = next((q for q in self.own_qs(self.qs) if q["id"] == body.get("id")), None)
        if a == "archive":
            if q is None: return self.not_found(route, "That question no longer exists.")
            q["is_archived"] = True; return ok({"ok": True})
        if a == "restore":
            if q is None: return self.not_found(route, "That question no longer exists.")
            q["is_archived"] = False; return ok({"ok": True})
        if a == "remove":
            if q is None: return self.not_found(route, "That question no longer exists.")
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
            # A finished attempt refuses answers; a `reopened` one accepts them again, like save_session_answers.
            if s["status"] not in ("in_progress", "reopened"):
                return ok({"accepted": False, "saved": 0, "reason": "already_submitted", "status": s["status"], "server_time": iso(now), "ends_at": iso(s["ends_at"])})
            if now > s["ends_at"] + 120:
                self.session_grade(sid, "auto_submitted")
                return ok({"accepted": False, "saved": 0, "reason": "time_up", "status": "auto_submitted", "server_time": iso(now), "ends_at": iso(s["ends_at"])})
            items = body.get("answers", [])
            if len(items) > 200:
                return err(400, "Answers can have at most 200 items.")
            by_id = {q["question_id"]: q for q in exam["questions"]}
            for item in items:
                qid = item.get("question_id")
                if qid not in by_id: return err(400, "That question is not part of this test.")
                text = (item.get("answer") or {}).get("text", "")
                # The live caps: an essay may hold 20,000 characters, everything else 1,000. One bad
                # answer refuses the whole batch (save_session_answers raises and rolls it back).
                if len(text) > (20000 if by_id[qid]["type"] == "essay" else 1000):
                    return err(400, "That answer is too long.")
            for item in items:
                qid = item.get("question_id")
                s["answers"][qid] = {"text": (item.get("answer") or {}).get("text", ""),
                                     "is_flagged": bool(item.get("is_flagged")),
                                     "client_saved_at": item.get("client_saved_at")}
            return ok({"accepted": True, "saved": len(items), "status": s["status"],
                       "server_time": iso(now), "ends_at": iso(s["ends_at"]), "remaining_seconds": max(0, int(s["ends_at"] - now))})
        if a == "heartbeat":
            if s["status"] == "in_progress" and now > s["ends_at"] + 120: self.session_grade(sid, "auto_submitted")
            return ok({"status": s["status"], "server_time": iso(now), "ends_at": iso(s["ends_at"]),
                       "remaining_seconds": max(0, int(s["ends_at"] - now)), "tab_switch_count": s["tab_switch_count"]})
        if a == "event":
            kind = body.get("event_type")
            self.session_events.append({"session": sid, "type": kind, "meta": body.get("meta")})
            if kind == "tab_hidden" and s["status"] == "in_progress":
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

    def open_exam_row(self, code):
        """Mirrors a session exam into the exams store, open, so screens that read `exams.list`
        (the dashboard) see the same exam the session/results functions serve."""
        exam = self.session_exams[code]
        self.exams[exam["id"]] = {"id": exam["id"], "title": exam["title"], "description": None,
                                  "status": "open", "duration_minutes": exam["duration_minutes"],
                                  "passing_grade": exam["passing_grade"], "availability_mode": "manual",
                                  "starts_at": None, "ends_at": None, "late_start_policy": "full_duration",
                                  "access_code": exam["code"], "selection_mode": "manual",
                                  "is_template": False, "questions": exam["questions"],
                                  "created_at": "2026-09-24T01:00:00Z"}
        return exam

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
                              "passed": len([x for x in finished if x["pass_status"] == "passed"]),
                              "failed": len([x for x in finished if x["pass_status"] == "failed"]),
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

    # ---------- admin side: the audit log (TASK-015) ----------

    def audit_seed(self):
        """Six recorded actions: mixed actions and entities, one system row, one 40 days old."""
        t = time.time()
        self.audit_rows = [
            {"id": 1, "created_at": iso(t - 55 * 60), "actor_id": "u1", "actor_name": "Admin", "action": "question.create", "entity_type": "question", "entity_id": "q-1", "changes": {"body": "Past simple of go"}},
            {"id": 2, "created_at": iso(t - 44 * 60), "actor_id": None, "actor_name": None, "action": "grade", "entity_type": "exam_session", "entity_id": "s-1", "changes": {"points": 3}},
            {"id": 3, "created_at": iso(t - 33 * 60), "actor_id": "u2", "actor_name": "Ms. Rina", "action": "grade", "entity_type": "exam_session", "entity_id": "s-2", "changes": {}},
            {"id": 4, "created_at": iso(t - 22 * 60), "actor_id": "u1", "actor_name": "Admin", "action": "add_time", "entity_type": "exam_session", "entity_id": "s-2", "changes": {"minutes": 5}},
            {"id": 5, "created_at": iso(t - 11 * 60), "actor_id": "u1", "actor_name": "Admin", "action": "passage.update", "entity_type": "passage", "entity_id": "p-9", "changes": {}},
            {"id": 6, "created_at": iso(t - 40 * 86400), "actor_id": "u1", "actor_name": "Admin", "action": "retake_grant", "entity_type": "exam_session", "entity_id": "s-1", "changes": {}},
        ]

    def handle_audit(self, route, req):
        body = json.loads(req.post_data or "{}"); a = body.get("action")
        self.audit_calls.append(body)
        def ok(data): route.fulfill(status=200, content_type="application/json", body=json.dumps(data))
        def err(status, msg): route.fulfill(status=status, content_type="application/json", body=json.dumps({"error": msg, "code": "bad_request"}))

        if a == "list":
            limit = body.get("limit") or 50
            offset = body.get("offset") or 0
            rows = self.audit_rows
            if body.get("filter_action"):
                rows = [r for r in rows if r["action"] == body["filter_action"]]
            if body.get("entity_type"):
                rows = [r for r in rows if r["entity_type"] == body["entity_type"]]
            if body.get("days"):
                since = time.time() - int(body["days"]) * 86400
                rows = [r for r in rows if datetime.datetime.fromisoformat(r["created_at"].replace("Z", "+00:00")).timestamp() >= since]
            rows = sorted(rows, key=lambda r: r["created_at"], reverse=True)
            return ok({"logs": {"total": len(rows), "rows": rows[offset:offset + limit]}})
        return err(400, "Unknown action")

    # ---------- the notification bell (TASK-015, DEC-017) ----------

    def notif_payload(self):
        """What the bell answers: essays and suspicious events for everybody, backup and new accounts for admins.
        Everything unread until the bell has been opened (which the real server records per person)."""
        essays = [{"exam_id": "e-1", "title": "Past Tense Quiz", "access_code": "PAST01",
                   "waiting": 2, "student_name": "Dina", "student_class": "XII TKJ A",
                   "session_id": "s-1", "updated_at": iso(time.time() - 40 * 60)}]
        suspicious = [{"exam_id": "e-2", "title": "Narrative Test", "access_code": "NARR22",
                       "events": 3, "sessions": 2, "last_at": iso(time.time() - 25 * 60)}]
        backup = None
        accounts = []
        if self.role == "admin":
            backup = {"kind": "automatic", "created_at": iso(time.time() - 3 * 3600),
                      "size_bytes": 3412000, "created_by_name": None}
            accounts = [{"email": "dewi@example.com", "full_name": "Ms. Dewi", "role": "teacher",
                         "created_at": iso(time.time() - 2 * 86400)}]
        total = len(essays) + len(suspicious) + len(accounts) + (1 if backup else 0)
        return {"kinds": {"essays": essays, "suspicious": suspicious, "backup": backup, "accounts": accounts},
                "essays": sum(e["waiting"] for e in essays), "suspicious": len(suspicious),
                "account": len(accounts), "backup": 1 if backup else 0,
                "total": total, "unread": 0 if self.notif_read else total,
                "read_at": iso(time.time()) if self.notif_read else None}

    def handle_notifications(self, route, req):
        body = json.loads(req.post_data or "{}"); a = body.get("action")
        self.notif_calls.append(body)
        def ok(data): route.fulfill(status=200, content_type="application/json", body=json.dumps(data))
        def err(status, msg): route.fulfill(status=status, content_type="application/json", body=json.dumps({"error": msg, "code": "bad_request"}))

        # The bell is for every signed-in staff member; only a dead session is refused.
        if self.status_all:
            return route.fulfill(status=self.status_all, content_type="application/json",
                                 body=json.dumps({"error": "Your session has expired. Please sign in again.", "code": "unauthorized"}))
        if a == "list":
            return ok({"notifications": self.notif_payload()})
        if a == "mark_read":
            self.notif_read = True
            return ok({"notifications": self.notif_payload()})
        return err(400, "Unknown action")

    def handle_backups(self, route, req):
        body = json.loads(req.post_data or "{}"); a = body.get("action")
        self.backup_calls.append(body)
        def ok(data): route.fulfill(status=200, content_type="application/json", body=json.dumps(data))
        def err(status, msg): route.fulfill(status=status, content_type="application/json", body=json.dumps({"error": msg, "code": "forbidden"}))

        # Backups are an admin job (design.md 1.2): the mock refuses a teacher exactly like the real function.
        if self.role != "admin":
            return err(403, "You do not have access to this.")

        if a == "create":
            if self.fail_backup:
                return route.fulfill(status=500, content_type="application/json",
                                     body=json.dumps({"error": "Something went wrong. Please try again.", "code": "internal_error"}))
            row = {"id": f"bk-{len(self.backups) + 1}", "kind": "manual",
                   "storage_path": "20260926T032000Z_manual_3333cccc.zip", "size_bytes": 44512,
                   "created_by": "u1", "created_by_name": "Admin", "created_at": "2026-09-26T03:20:00Z"}
            self.backups.insert(0, row)
            return ok({"backup": row, "files": 3, "media_included": self.backup_note is None,
                       "media_note": self.backup_note, "pruned": self.backup_pruned})
        if a == "list":
            limit = body.get("limit") or 50
            offset = body.get("offset") or 0
            return ok({"backups": {"total": len(self.backups), "rows": self.backups[offset:offset + limit]}})
        if a == "download":
            row = next((b for b in self.backups if b["id"] == body.get("id")), None)
            if row is None:
                return err(400, "That backup no longer exists.")
            return ok({"url": f"https://storage.test/signed/{row['storage_path']}?token=t",
                       "name": f"english-test-v2_{row['storage_path']}", "expires_in": 3600})
        if a == "delete":
            row = next((b for b in self.backups if b["id"] == body.get("id")), None)
            if row is None:
                return err(400, "That backup no longer exists.")
            self.backups.remove(row)
            return ok({"id": row["id"], "removed": 1})
        return err(400, "Unknown action")

    def handle_accounts(self, route, req):
        body = json.loads(req.post_data or "{}"); a = body.get("action")
        self.account_calls.append(body)
        def ok(data): route.fulfill(status=200, content_type="application/json", body=json.dumps(data))
        def err(status, msg): route.fulfill(status=status, content_type="application/json", body=json.dumps({"error": msg, "code": "bad_request"}))

        # Managing accounts is an admin job (design.md 1.2): the mock refuses a teacher exactly like the real function.
        if self.role != "admin":
            return route.fulfill(status=403, content_type="application/json", body=json.dumps({"error": "You do not have access to this.", "code": "forbidden"}))

        row = next((x for x in self.accounts if x["id"] == body.get("id")), None)
        if a == "list":
            return ok({"accounts": {"total": len(self.accounts), "rows": self.accounts}})
        if a == "create":
            if self.fail_account:
                return route.fulfill(status=500, content_type="application/json",
                                     body=json.dumps({"error": "Something went wrong. Please try again.", "code": "internal_error"}))
            email = str(body.get("email", "")).lower()
            if any(x["email"].lower() == email for x in self.accounts):
                return err(400, "An account with this email address already exists.")
            made = {"id": f"u{len(self.accounts) + 1}", "email": email, "full_name": body.get("full_name"),
                    "role": body.get("role"), "is_active": True,
                    "created_at": "2026-09-26T02:20:00Z", "last_sign_in_at": None}
            self.accounts.append(made)
            return ok({"account": made})
        if a == "update":
            if row is None:
                return err(400, "That account no longer exists.")
            if row["id"] == "u1" and ((body.get("role") and body["role"] != row["role"]) or body.get("is_active") is False):
                return err(400, "You cannot change your own role or deactivate your own account.")
            for key in ("full_name", "role", "is_active"):
                if body.get(key) is not None:
                    row[key] = body[key]
            return ok({"account": {k: row[k] for k in ("id", "full_name", "role", "is_active")}})
        if a == "password":
            if row is None:
                return err(400, "That account no longer exists.")
            self.account_passwords.append(body.get("password"))
            return ok({"id": row["id"], "changed": True})
        return err(400, "Unknown action")

    def exam_row(self, e):
        qs = e["questions"]
        return {"id": e["id"], "title": e["title"], "description": e.get("description"), "status": e["status"],
                "duration_minutes": e["duration_minutes"], "passing_grade": e["passing_grade"],
                "availability_mode": e["availability_mode"], "starts_at": e.get("starts_at"), "ends_at": e.get("ends_at"),
                "late_start_policy": e["late_start_policy"], "access_code": e["access_code"],
                "selection_mode": e["selection_mode"], "is_template": e["is_template"],
                "question_count": len(qs), "total_points": sum(q.get("weight", 1) for q in qs),
                "session_count": e.get("session_count", 0),
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
            # TASK-032: the same gate public.save_exam applies — a template is a draft nobody has
            # joined, so `exam_join` (which refuses templates) can never be the surprise.
            if body.get("is_template"):
                if body.get("status", "draft") != "draft":
                    return err(400, "A template must be saved as a draft.")
                if (prev or {}).get("status") == "open":
                    return err(400, "An open exam cannot become a template. Close it first.")
                if (prev or {}).get("session_count", 0) > 0:
                    return err(400, "This exam already has attempts, so it cannot become a template. Duplicate it and save the copy as a template.")
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
                               "session_count": (prev or {}).get("session_count", 0),
                               "questions": [{"question_id": q["question_id"], "position": i, "weight": q.get("weight", 1), "body": next((qq["body"] for qq in self.qs if qq["id"] == q["question_id"]), f"Question {i + 1}"), "type": "multiple_choice"} for i, q in enumerate(body.get("questions", []))],
                               "created_at": (prev or {}).get("created_at", "2026-09-21T00:00:00Z")}
            return ok({"id": eid})
        if a == "remove":
            e = self.exams.get(body.get("id"))
            if not e: return err(400, "That exam no longer exists.")
            # Same rule as remove_exam: attempts block a delete unless the caller asked for it explicitly.
            if e.get("session_count", 0) > 0 and not body.get("hard"):
                e["status"] = "closed"; return ok({"result": "closed"})
            self.exams.pop(body["id"]); return ok({"result": "deleted"})
        if a == "set_status":
            e = self.exams.get(body.get("id"))
            if not e: return err(400, "That exam no longer exists.")
            if body.get("status") == "open":
                # TASK-032: an open template is a live exam nobody can join.
                if e.get("is_template"):
                    return err(400, "A template cannot be opened. Duplicate it and open the copy.")
                if e["selection_mode"] == "manual" and len(e["questions"]) == 0:
                    return err(400, "Add questions before opening the exam.")
                # TASK-031: the rule public.set_exam_status applies — a code an open exam holds cannot be
                # opened on a second exam; the refusal names it instead of letting a unique index 500.
                conflict = any(x["id"] != e["id"] and x["access_code"] == e["access_code"] and x["status"] == "open"
                               for x in self.exams.values())
                if conflict or e["access_code"] in self.exam_codes_used:
                    return err(400, f"The test code {e['access_code']} is already used by an open exam. Close that exam or give this one a different code.")
            e["status"] = body.get("status"); return ok({"ok": True})
        if a == "regenerate_code":
            e = self.exams.get(body.get("id"))
            if not e: return err(400, "That exam no longer exists.")
            e["access_code"] = f"NEW{len(self.exam_calls) % 100:02d}"; return ok({"code": e["access_code"]})
        if a == "check_code":
            code = str(body.get("code", "")).strip().upper()
            others = [e for e in self.exams.values() if e["id"] != body.get("exclude_id")]
            if code in self.exam_codes_used or any(e["access_code"] == code and e["status"] == "open" for e in others):
                return ok({"available": False, "used_by": "open"})
            if any(e["access_code"] == code and e["status"] == "draft" for e in others):
                return ok({"available": True, "used_by": "draft"})
            return ok({"available": True, "used_by": None})
        if a == "bulk_questions":
            # The same guards public.bulk_exam_questions makes, said the same way.
            self.exam_bulk_calls.append(body)
            if self.fail_bulk_questions: return err(400, self.fail_bulk_questions)
            e = self.exams.get(body.get("exam_id"))
            if not e: return err(400, "That exam no longer exists.")
            mode = body.get("mode")
            if mode not in ("add", "remove"): return err(400, "Choose whether to add or remove questions.")
            ids = list(dict.fromkeys(body.get("ids") or []))
            if not ids: return err(400, "Select at least one question.")
            if len(ids) > 500: return err(400, "Change at most 500 questions at once.")
            if e.get("selection_mode") != "manual":
                return err(400, "This exam draws its questions by a filter, so it has no fixed question list.")
            if e["status"] == "open": return err(400, "Close the exam before changing its questions.")
            if e.get("session_count", 0) > 0:
                return err(400, "This exam already has attempts, so its questions stay as they were. Duplicate the exam to change them.")
            known = {q["id"]: q for q in self.qs}
            found = [i for i in ids if i in known]
            if not found: return err(400, "Those questions no longer exist. Refresh the list and try again.")
            missing = len(ids) - len(found)
            have = {q["question_id"] for q in e["questions"]}
            if mode == "add":
                if any(known[i]["is_archived"] for i in found):
                    return err(400, "Some of those questions are archived. Restore them first, or leave them out.")
                to_add = [i for i in found if i not in have]
                if len(e["questions"]) + len(to_add) > 200: return err(400, "An exam can hold at most 200 questions.")
                for n, i in enumerate(to_add):
                    q = known[i]
                    e["questions"].append({"question_id": i, "position": len(e["questions"]) + 1, "weight": q["weight"],
                                           "body": q["body"], "type": q["type"]})
                    q["used_in_exams"] = q.get("used_in_exams", 0) + 1
                return ok({"result": {"matched": len(found), "updated": len(to_add),
                                      "unchanged": len(found) - len(to_add), "missing": missing}})
            on = [i for i in found if i in have]
            gone = set(on)
            e["questions"] = [q for q in e["questions"] if q["question_id"] not in gone]
            for n, q in enumerate(e["questions"]): q["position"] = n + 1
            for i in gone:
                known[i]["used_in_exams"] = max(0, known[i].get("used_in_exams", 0) - 1)
            return ok({"result": {"matched": len(on), "updated": len(on),
                                  "unchanged": len(found) - len(on), "missing": missing}})
        if a == "duplicate":
            src = self.exams.get(body.get("id"))
            if not src: return err(400, "That exam no longer exists.")
            nid = f"00000000-0000-4000-8000-{len(self.exams) + 1:012d}"
            import copy
            # A copy is a fresh draft: it has no attempts (`duplicate_exam` copies question rows only).
            dup = copy.deepcopy(src); dup.update(id=nid, status="draft", title=src["title"] + " (copy)", access_code=f"DUP{len(self.exams) % 100:02d}", session_count=0, created_at="2026-09-22T00:00:00Z")
            self.exams[nid] = dup; return ok({"id": nid})
        return err(400, "Unknown action")
