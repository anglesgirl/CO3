#!/usr/bin/env python3
"""检查 JS/JSX 的具名 import 是否真的被目标模块导出。

起因（真机实测）：remoteLog.js 的真实导出名是 rlog，而调用方 import { remoteLog } ——
RN 的 bundle 编译期**不校验具名导入**，运行时调用就变成 "TypeError: undefined is not a function"，
App 启动即崩（用户连续看到闪退）。把这类错误挡在构建之前，比再出一轮包便宜得多。
"""
import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
MAIN = ROOT / "main"
if not MAIN.exists():
    print("没有 main/ 目录，跳过")
    sys.exit(0)

IMPORT = re.compile(r"import\s*\{([^}]+)\}\s*from\s*'([^']+)'")
EXPORT_FN = re.compile(r"export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)")
EXPORT_LIST = re.compile(r"export\s*\{([^}]*)\}")
SUFFIXES = (".js", ".jsx", ".ts", ".tsx")

bad = []
for f in sorted(MAIN.rglob("*")):
    if f.suffix not in SUFFIXES or "node_modules" in str(f):
        continue
    src = f.read_text(encoding="utf-8", errors="ignore")
    for names, rel in IMPORT.findall(src):
        if not rel.startswith("."):
            continue
        base = (f.parent / rel)
        cands = [base.with_suffix(s) for s in SUFFIXES] + [base / ("index" + s) for s in SUFFIXES]
        target = next((c for c in cands if c.exists()), None)
        if target is None:
            continue
        ts = target.read_text(encoding="utf-8", errors="ignore")
        exports = set(EXPORT_FN.findall(ts))
        for m in EXPORT_LIST.finditer(ts):
            for part in m.group(1).split(","):
                n = part.strip().split(" as ")[-1].strip()
                if n:
                    exports.add(n)
        for raw in names.split(","):
            name = raw.strip().split(" as ")[0].strip()
            if name and name not in exports:
                bad.append(f"{f.relative_to(ROOT)}: import {{ {name} }} ← {target.relative_to(ROOT)} 没有导出")

if bad:
    print("✗ 具名 import 对不上（会在运行时崩）：")
    print("\n".join("  " + b for b in bad))
    sys.exit(1)
print("✓ JS 具名 import 全部对得上")
