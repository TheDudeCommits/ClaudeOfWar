#!/usr/bin/env python3
"""Regenerate progress/index.html from state.json. Idempotent; safe to run often."""
import html, json, os, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(ROOT, "state.json")
OUT = os.path.join(ROOT, "progress", "index.html")

STATUS = {
    "queued":   ("#6b7280", "queued"),
    "building": ("#3b82f6", "building"),
    "review":   ("#a855f7", "in review"),
    "rejected": ("#ef4444", "sent back"),
    "passed":   ("#22c55e", "WON BLIND TEST"),
    "blocked":  ("#f59e0b", "blocked"),
}

CSS = """
*{box-sizing:border-box}
body{margin:0;background:#0b0d10;color:#e6e8eb;font:14px/1.55 ui-sans-serif,-apple-system,'SF Pro Text',system-ui,sans-serif}
a{color:#7dd3fc}
header{padding:22px 28px;border-bottom:1px solid #1c2027;position:sticky;top:0;background:#0b0d10ee;backdrop-filter:blur(8px);z-index:5}
h1{margin:0;font-size:19px;letter-spacing:.2px;font-weight:650}
.sub{color:#8b929c;font-size:12.5px;margin-top:5px}
.bar{display:flex;gap:5px;margin-top:14px;flex-wrap:wrap}
.pill{font-size:11px;padding:3px 9px;border-radius:999px;border:1px solid #262c35;color:#aab2bd;white-space:nowrap}
main{padding:22px 28px;max-width:1500px}
.piece{border:1px solid #1c2027;border-radius:11px;margin-bottom:16px;overflow:hidden;background:#0e1116}
.ph{display:flex;align-items:center;gap:11px;padding:13px 17px;background:#11151b;flex-wrap:wrap}
.dot{width:9px;height:9px;border-radius:50%;flex:none}
.pn{font-weight:640;font-size:14.5px}
.st{font-size:11px;text-transform:uppercase;letter-spacing:.7px;font-weight:640}
.rd{margin-left:auto;font-size:11.5px;color:#7c848f;font-variant-numeric:tabular-nums}
.pb{padding:15px 17px}
.gap{background:#17120f;border-left:2.5px solid #f59e0b;padding:9px 13px;border-radius:0 7px 7px 0;margin-bottom:13px;font-size:13px}
.gap b{color:#fbbf24;font-weight:620}
.win{background:#0d1710;border-left:2.5px solid #22c55e;padding:9px 13px;border-radius:0 7px 7px 0;margin-bottom:13px;font-size:13px}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:11px}
.shot{border:1px solid #1c2027;border-radius:8px;overflow:hidden;background:#080a0d}
.shot img{width:100%;display:block;aspect-ratio:16/9;object-fit:cover;background:#000}
.cap{padding:6px 9px;font-size:11px;color:#78808b;display:flex;justify-content:space-between;gap:8px}
.hist{margin-top:13px;border-top:1px solid #1a1e25;padding-top:11px}
.hr{display:flex;gap:11px;padding:6px 0;font-size:12.5px;border-bottom:1px solid #14181e;align-items:baseline}
.hr:last-child{border:0}
.hn{flex:none;width:56px;color:#69707a;font-variant-numeric:tabular-nums}
.hv{flex:none;width:70px;font-weight:640;font-size:11px}
.ht{color:#98a0ab}
.empty{color:#5d646e;font-size:12.5px;font-style:italic}
footer{padding:26px 28px;color:#5d646e;font-size:11.5px}
"""


def rel(p):
    return os.path.relpath(p, os.path.join(ROOT, "progress")) if p else ""


def main():
    st = json.load(open(STATE)) if os.path.exists(STATE) else {"pieces": []}
    pieces = st.get("pieces", [])
    done = sum(1 for p in pieces if p.get("status") == "passed")

    h = [f"<meta charset=utf-8><meta http-equiv=refresh content=10>",
         f"<title>ClaudeOfWar — build progress</title><style>{CSS}</style>",
         "<header><h1>ClaudeOfWar</h1>",
         f"<div class=sub>{html.escape(st.get('engine',''))} &nbsp;·&nbsp; "
         f"target: God of War Ragnarök reference plates &nbsp;·&nbsp; "
         f"<b>{done}/{len(pieces)}</b> pieces have won a blind test</div>",
         "<div class=bar>"]
    for p in pieces:
        col, lab = STATUS.get(p.get("status", "queued"), ("#6b7280", "?"))
        h.append(f"<span class=pill style='border-color:{col}44;color:{col}'>"
                 f"{html.escape(p['name'])} · r{p.get('round',0)}</span>")
    h.append("</div></header><main>")

    for p in pieces:
        col, lab = STATUS.get(p.get("status", "queued"), ("#6b7280", "?"))
        h.append(f"<div class=piece><div class=ph>"
                 f"<span class=dot style='background:{col}'></span>"
                 f"<span class=pn>{html.escape(p['name'])}</span>"
                 f"<span class=st style='color:{col}'>{lab}</span>"
                 f"<span class=rd>round {p.get('round',0)}</span></div><div class=pb>")

        if p.get("status") == "passed":
            h.append(f"<div class=win>Beat the reference plate in a blind side-by-side. "
                     f"{html.escape(p.get('win_note',''))}</div>")
        elif p.get("gap"):
            h.append(f"<div class=gap><b>Biggest remaining gap:</b> "
                     f"{html.escape(p['gap'])}</div>")

        shots = p.get("shots", [])
        if shots:
            h.append("<div class=shots>")
            for s in shots:
                src = html.escape(rel(os.path.join(ROOT, s["path"])))
                h.append(f"<div class=shot><a href='{src}' target=_blank>"
                         f"<img src='{src}' loading=lazy></a>"
                         f"<div class=cap><span>{html.escape(s.get('label',''))}</span>"
                         f"<span>r{s.get('round','')}</span></div></div>")
            h.append("</div>")
        else:
            h.append("<div class=empty>no captures yet</div>")

        hist = p.get("history", [])
        if hist:
            h.append("<div class=hist>")
            for e in reversed(hist[-14:]):
                v = e.get("verdict", "")
                vc = "#22c55e" if v == "PASS" else "#ef4444"
                h.append(f"<div class=hr><span class=hn>r{e.get('round','')}</span>"
                         f"<span class=hv style='color:{vc}'>{html.escape(v)}</span>"
                         f"<span class=ht>{html.escape(e.get('note',''))}</span></div>")
            h.append("</div>")
        h.append("</div></div>")

    h.append("</main><footer>auto-refreshes every 10s · generated "
             + time.strftime("%H:%M:%S") + "</footer>")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w").write("\n".join(h))
    print("wrote", OUT)


if __name__ == "__main__":
    main()
