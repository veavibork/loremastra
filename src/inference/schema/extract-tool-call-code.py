import json
import re
import sys


def extract(stream_file, valid: bool) -> tuple[str, str]:
    text = open(stream_file, "r", encoding="utf-8").read()
    chunks = re.findall(r"data:\s*(\{.*?\})\n", text)
    tool_deltas = []
    for c in chunks:
        try:
            d = json.loads(c)
        except Exception:
            continue
        for choice in d.get("choices", []):
            delta = choice.get("delta", {})
            for tc in delta.get("tool_calls", []):
                fn = tc.get("function", {})
                if "arguments" in fn:
                    tool_deltas.append(fn["arguments"])

    full = "".join(tool_deltas)
    if valid:
        args = json.loads(full)
        return full, args["content"]
    else:
        return full, full


if __name__ == "__main__":
    k_args, k_code = extract("k2-toolcall-stream.txt", True)
    d_args, d_code = extract("ds-toolcall-stream.txt", False)

    print(f"=== Kimi args length: {len(k_args)}")
    print(f"=== Kimi code lines: {len(k_code.splitlines())} chars: {len(k_code)}")
    print(k_code)
    print()
    print(f"=== DeepSeek args length: {len(d_args)}")
    print(f"=== DeepSeek code (partial) lines: {len(d_code.splitlines())} chars: {len(d_code)}")
    print(d_code)
