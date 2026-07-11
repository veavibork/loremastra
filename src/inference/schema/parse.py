import json, sys

def parse(fname):
    args = {}
    names = {}
    ids = {}
    reasoning_len = 0
    content = ""
    finish = None
    errors = []
    for line in open(fname):
        line = line.strip()
        if not line.startswith("data:"):
            if line and not line.startswith(":"):
                errors.append("non-SSE line: " + line[:200])
            continue
        payload = line[5:].strip()
        if payload in ("", "[DONE]"):
            continue
        try:
            obj = json.loads(payload)
        except Exception as e:
            errors.append(f"bad JSON chunk: {e}: {payload[:200]}")
            continue
        for ch in obj.get("choices", []):
            d = ch.get("delta") or {}
            if ch.get("finish_reason"):
                finish = ch["finish_reason"]
            if d.get("reasoning_content") or d.get("reasoning"):
                reasoning_len += len(d.get("reasoning_content") or d.get("reasoning") or "")
            if d.get("content"):
                content += d["content"]
            for tc in d.get("tool_calls") or []:
                i = tc.get("index", 0)
                if tc.get("id") is not None:
                    ids.setdefault(i, tc["id"])
                f = tc.get("function", {})
                if f.get("name"):
                    names[i] = names.get(i, "") + f["name"]
                if f.get("arguments"):
                    args[i] = args.get(i, "") + f["arguments"]
    print(f"== {fname} ==")
    print("finish_reason:", finish)
    print("reasoning_content chars:", reasoning_len)
    print("content:", repr(content[:200]))
    print("errors:", errors if errors else "none")
    id_values = list(ids.values())
    dup = len(id_values) >= 2 and len(set(id_values)) < len(id_values)
    print("tool_call ids:", ids, "-- DUPLICATE IDS DETECTED" if dup else "")
    for i in sorted(names):
        print(f"tool[{i}] name: {names[i]}")
    for i in sorted(args):
        raw = args[i]
        print(f"tool[{i}] raw args length: {len(raw)}")
        try:
            parsed = json.loads(raw)
            print(f"tool[{i}] args JSON: VALID, keys={list(parsed)}")
            c = parsed.get("content", "")
            print("--- content field ---")
            print(c)
            print("--- end ---")
        except Exception as e:
            print(f"tool[{i}] args JSON: INVALID ({e})")
            print(raw)
    print()

for f in sys.argv[1:]:
    parse(f)
