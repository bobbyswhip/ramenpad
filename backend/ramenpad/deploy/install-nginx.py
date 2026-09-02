from datetime import datetime, timezone
from pathlib import Path
import shutil

target = Path("/etc/nginx/conf.d/api-yougotcoined.conf")
include_line = "    include /etc/nginx/ramenpad-locations.inc;\n"
needle = "    location /api/v1/ {\n"
text = target.read_text()

if include_line not in text:
    if text.count(needle) != 1:
        raise RuntimeError("Expected exactly one /api/v1 location in api-yougotcoined.conf")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    shutil.copy2(target, target.with_name(f"{target.name}.bak-ramenpad-{stamp}"))
    target.write_text(text.replace(needle, include_line + "\n" + needle, 1))
