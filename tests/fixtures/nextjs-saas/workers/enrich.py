import os
from openai import OpenAI

client = OpenAI()

def enrich(records):
    out = []
    for r in records:
        resp = client.chat.completions.create(
            model=os.getenv("ENRICH_MODEL", "gpt-5.6-terra"),
            messages=[{"role": "user", "content": f"Extract company name and industry from: {r['text']}"}],
            max_tokens=200,
        )
        out.append(resp.choices[0].message.content)
    return out
