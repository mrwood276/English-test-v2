"""A pretend server for the browser tests: answers the question-bank and auth-me endpoints from memory."""
import json
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
        self.saved = []; self.dup_calls = []
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
                "passage": {"id": "p1", "title": "The Lost Wallet", "body": "Dina found a <u>brown</u> wallet."} if q["has_passage"] else None,
                "media": [{"id": "m1", "kind": "audio", "mime_type": "audio/mpeg", "size_bytes": 1000, "source": "question", "position": 0}] if q["has_audio"] else [],
                "class_labels": q["class_labels"]}
    def passages_list(self):
        return [{"id": x["id"], "title": x["title"], "excerpt": x["body"][:60], "question_count": x["question_count"]} for x in self.passages]
    def handle(self, route):
        req = route.request
        if req.method == "OPTIONS": return route.fulfill(status=204, body="")
        url = req.url
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
        if a == "passages": return ok({"passages": self.passages_list()})
        if a == "passage_get":
            pa = next((x for x in self.passages if x["id"] == body["id"]), None)
            return ok({"passage": {**pa, "question_count": pa["question_count"], "media": []}}) if pa else route.fulfill(status=404, content_type="application/json", body=json.dumps({"error": "That reading text no longer exists.", "code": "not_found"}))
        if a == "passage_save":
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

