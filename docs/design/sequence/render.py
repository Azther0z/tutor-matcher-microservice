#!/usr/bin/env python3
"""Usage: render.py <name.mmd>  -> writes <name>.png next to it (2000 px wide, fitted height)."""
import sys, re, subprocess, pathlib, tempfile
CH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
src = pathlib.Path(sys.argv[1]).resolve()
mmd = src.read_text()
html = """<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#fff;font-family:Helvetica,Arial,sans-serif}</style></head><body>
<pre class="mermaid">%s</pre>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script>
<script>mermaid.initialize({startOnLoad:true,theme:'base',themeVariables:{primaryColor:'#f4f4f4',primaryBorderColor:'#d32f2f',lineColor:'#333',actorBkg:'#f4f4f4',actorBorder:'#d32f2f',noteBkgColor:'#fffbe6',noteBorderColor:'#999',fontSize:'15px'},sequence:{mirrorActors:false,useMaxWidth:true,messageFontSize:14,actorMargin:20,width:130,noteMargin:8}});</script>
</body></html>""" % mmd
tmp = pathlib.Path(tempfile.mkdtemp()) / "r.html"
tmp.write_text(html)
dom = subprocess.run([CH,"--headless","--disable-gpu","--window-size=2000,3000","--virtual-time-budget=15000","--dump-dom",f"file://{tmp}"],capture_output=True,text=True).stdout
if "Syntax error" in dom or "<svg" not in dom:
    print("RENDER FAILED: mermaid syntax error or no svg"); sys.exit(1)
m = re.search(r'<svg[^>]*viewBox="([\d.\- ]+)"', dom)
x,y,w,h = map(float, m.group(1).split())
height = int(2000*h/w) + 30
out = src.with_suffix(".png")
subprocess.run([CH,"--headless","--disable-gpu","--hide-scrollbars",f"--window-size=2000,{height}","--force-device-scale-factor=1","--virtual-time-budget=15000",f"--screenshot={out}",f"file://{tmp}"],capture_output=True)
print("wrote", out, f"2000x{height}")
